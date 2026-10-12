import { el } from "./ui/dom.js";
import { applyTheme, currentTheme, toggleTheme } from "./ui/theme.js";
import { createContourStage } from "./ui/contourStage.js";
import { createAnalysisView, type LoopRegion } from "./ui/analysisView.js";
import { PitchWorkerClient } from "./worker/client.js";
import { MicRecorder } from "./audio/recorder.js";
import { loadAudioFile } from "./audio/fileLoader.js";
import { MAX_AUDIO_SECONDS, validateAudio } from "./audio/limits.js";
import { ClipPlayer } from "./audio/playback.js";
import { regionSamples } from "./audio/region.js";
import { warpedOverlay, type AlignmentResult } from "./core/dtw.js";
import { classifyMandarinTone } from "./core/toneClassifier.js";
import { ALL_MANDARIN_TONES, mandarinToneChaoNumerals, mandarinToneContour, mandarinToneLabel } from "./core/mandarinTones.js";
import {
  greekAccentContour,
  greekAccentLabel,
  japaneseAccentContour,
  japaneseAccentLabel,
  type GreekAccent,
  type JapanesePattern,
} from "./core/accentTemplates.js";
import { synthesizeFromContour } from "./core/synth.js";
import { deleteReference, getReference, listReferences, saveReference, type ReferenceSummary } from "./storage/db.js";
import type { Spectrogram } from "./core/spectrogram.js";
import type { PitchAlgorithm, PitchContour } from "./core/types.js";

interface ClipSource {
  pcm: Float32Array;
  sampleRate: number;
  label: string;
  synthetic: boolean;
}

interface ClipExcerpt {
  source: ClipSource;
  start: number; // Sample offsets in the full source, including after repeated trims.
  end: number;
}

interface ClipState extends ClipSource {
  contour: PitchContour | null;
  spectrogram: Spectrogram | null;
  algorithm: PitchAlgorithm;
  excerpt: ClipExcerpt | undefined;
}

type FocusRole = "reference" | "attempt";
interface AudioRequest {
  role: FocusRole;
  version: number;
  statusId: number;
  controller: AbortController;
}

export function mountApp(root: HTMLElement): void {
  applyTheme(currentTheme());

  const workers = { reference: new PitchWorkerClient(), attempt: new PitchWorkerClient() };
  const comparisonWorker = new PitchWorkerClient();
  let algorithm: PitchAlgorithm = "yin";
  let playbackContext: AudioContext | null = null;
  const players: Record<FocusRole, ClipPlayer | null> = { reference: null, attempt: null };
  const clips: Record<FocusRole, ClipState | null> = { reference: null, attempt: null };
  let focus: FocusRole = "attempt";
  const loopRegions: Record<FocusRole, LoopRegion | null> = { reference: null, attempt: null };
  const versions: Record<FocusRole, number> = { reference: 0, attempt: 0 };
  const loads: Record<FocusRole, AudioRequest | null> = { reference: null, attempt: null };
  const drafts: Record<FocusRole, ClipState | null> = { reference: null, attempt: null };
  const loadErrors: Record<FocusRole, string | null> = { reference: null, attempt: null };
  let comparison: AbortController | null = null;
  let comparisonPair: [PitchContour, PitchContour] | null = null;
  let statusId = 0;
  let recordingRequest: AudioRequest | null = null;
  let halfSpeed = false;
  let alignment: AlignmentResult | null = null;
  let library: ReferenceSummary[] = [];
  let savingReference = false;
  const micRecorder = new MicRecorder();
  let rafHandle = 0;
  let playbackRequest = 0;

  function getPlaybackContext(): AudioContext {
    playbackContext ??= new AudioContext();
    return playbackContext;
  }

  // ---------------------------------------------------------------- header
  const themeButton = el("button", {
    class: "tm-icon-button",
    "aria-label": "Toggle light/dark theme",
    onclick: () => {
      const next = toggleTheme();
      themeButton.textContent = next === "dark" ? "☀" : "☽";
      stage.render({ reference: clips.reference?.contour ?? null, attempt: clips.attempt?.contour ?? null, warped: alignment ? warpedOverlay(alignment) : null });
      renderAnalysis();
    },
  });
  themeButton.textContent = currentTheme() === "dark" ? "☀" : "☽";

  const header = el("header", { class: "tm-header" }, [
    el("p", { class: "tm-wordmark" }, ["tonemirror", el("small", {}, ["see your intonation"])]),
    el("div", { class: "tm-header-actions" }, [themeButton]),
  ]);

  const hero = el("section", { class: "tm-hero" }, [
    el("h1", {}, ["Overlay your voice on a reference, syllable by syllable."]),
    el(
      "p",
      {},
      [
        "Record or load a clip, compare its pitch contour to a reference with dynamic time warping, and get plain-language feedback on where the shape diverges. Everything runs locally in your browser — nothing is uploaded.",
      ],
    ),
  ]);

  // ---------------------------------------------------------------- source panel
  const statusLine = el("span", { class: "tm-status", role: "status", "aria-live": "polite" }, ["No audio loaded yet."]);
  const recordBtn = el("button", { class: "tm-btn tm-btn-record", onclick: () => void handleRecordClick() }, ["● Record"]);
  const fileInput = el("input", {
    type: "file",
    accept: "audio/*",
    class: "tm-visually-hidden",
    "aria-label": "Choose an audio file to load",
    onchange: (e) => void handleFileSelected(e),
  });
  const loadBtn = el("label", { class: "tm-file-label" }, ["Load file…", fileInput]);
  const cancelBtn = el("button", { class: "tm-btn", hidden: true, onclick: () => cancelWork() }, ["Cancel work"]);
  const retryAudioBtn = el("button", { class: "tm-btn", hidden: true, onclick: () => void reanalyzeAll(true) }, ["Retry audio analysis"]);
  const algoSelect = el(
    "select",
    {
      class: "tm-select",
      "aria-label": "Pitch detection algorithm",
      onchange: (e) => {
        algorithm = (e.target as HTMLSelectElement).value as PitchAlgorithm;
        void reanalyzeAll();
      },
    },
    [el("option", { value: "yin" }, ["YIN"]), el("option", { value: "mpm" }, ["McLeod (MPM)"])],
  );

  const targetTabs = el("div", { class: "tm-source-tabs", role: "tablist", "aria-label": "Load audio as" }, [
    makeTab("attempt", "Your attempt", true),
    makeTab("reference", "Reference", false),
  ]);

  function makeTab(role: FocusRole, label: string, selected: boolean): HTMLButtonElement {
    const btn = el(
      "button",
      {
        class: "tm-tab",
        role: "tab",
        id: `source-${role}`,
        "aria-controls": "audio-analysis",
        tabindex: selected ? "0" : "-1",
        "data-role": role,
        "aria-selected": selected ? "true" : "false",
        onclick: () => {
          selectFocus(role);
        },
        onkeydown: (event) => {
          const key = (event as KeyboardEvent).key;
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
          event.preventDefault();
          const next = key === "Home" ? "attempt" : key === "End" ? "reference" : role === "attempt" ? "reference" : "attempt";
          selectFocus(next);
          targetTabs.querySelector<HTMLButtonElement>(`[data-role="${next}"]`)?.focus();
        },
      },
      [label],
    );
    return btn;
  }

  const sourcePanel = el("section", { class: "tm-panel" }, [
    el("div", { class: "tm-panel-header" }, [el("h2", {}, ["1. Get some audio"]), el("span", { class: "tm-hint" }, ["Recording and file loading use the tab selected when you start."])]),
    targetTabs,
    el("div", { class: "tm-controls-row" }, [recordBtn, loadBtn, algoSelect, cancelBtn, retryAudioBtn, statusLine]),
    el("p", { class: "tm-hint" }, ["Short phrases work best: up to 60 seconds and 25 MiB per file. Recordings stop at 60 seconds. A failed replacement keeps your last loaded clip."]),
  ]);

  // ---------------------------------------------------------------- contour stage panel
  const stageCanvas = el("canvas", { class: "tm-canvas" });
  const stage = createContourStage(stageCanvas);
  const scoreEl = el("div", { class: "tm-score" }, ["—"]);
  const feedbackList = el("ul", { class: "tm-feedback-list" });
  const comparisonNote = el("p", { class: "tm-hint tm-comparison-note", role: "status", "aria-live": "polite" });
  const retryComparisonBtn = el("button", { class: "tm-btn", hidden: true, onclick: () => updateComparison(true) }, ["Retry comparison"]);
  const stageEmpty = el("div", { class: "tm-stage-empty" }, ["Load a reference and an attempt to see their pitch contours overlaid here."]);

  const stagePanel = el("section", { class: "tm-panel" }, [
    el("div", { class: "tm-panel-header" }, [
      el("h2", {}, ["2. Compare contours"]),
      el("div", { class: "tm-legend" }, [
        el("span", { class: "tm-legend-item" }, [el("span", { class: "tm-legend-swatch", style: "background:var(--color-reference)" }), "reference"]),
        el("span", { class: "tm-legend-item" }, [el("span", { class: "tm-legend-swatch", style: "background:var(--color-attempt)" }), "your attempt"]),
      ]),
    ]),
    el("div", { class: "tm-stage-wrap" }, [stageCanvas, stageEmpty]),
    el("div", { class: "tm-score-row" }, [
      el("div", {}, [scoreEl, el("div", { class: "tm-score-label" }, ["similarity score"])]),
      feedbackList,
    ]),
    comparisonNote,
    retryComparisonBtn,
  ]);

  // ---------------------------------------------------------------- analysis view panel
  const analysisCanvas = el("canvas", { class: "tm-canvas" });
  const analysisEmpty = el("div", { class: "tm-stage-empty" }, ["Record or load audio above to see its waveform and spectrogram."]);
  const analysisLabel = el("p", { class: "tm-hint tm-clip-label" });
  const analysis = createAnalysisView(analysisCanvas, (region) => {
    loopRegions[focus] = region;
    players[focus]?.setLoopRegion(region ? { start: region.start, end: region.end } : null);
    syncRegionFields();
    renderAnalysis();
  });
  const playBtn = el("button", { class: "tm-btn tm-btn-primary", onclick: () => void togglePlayback() }, ["▶ Play"]);
  const halfSpeedToggle = el("input", {
    type: "checkbox",
    onchange: (e) => {
      halfSpeed = (e.target as HTMLInputElement).checked;
      players[focus]?.setHalfSpeed(halfSpeed);
    },
  });
  const clearLoopBtn = el("button", {
    class: "tm-btn",
    onclick: () => {
      loopRegions[focus] = null;
      players[focus]?.setLoopRegion(null);
      syncRegionFields();
      renderAnalysis();
    },
  }, ["Clear loop"]);

  const regionStart = el("input", { type: "number", min: "0", step: "any", oninput: () => refreshRegionControls() });
  const regionEnd = el("input", { type: "number", min: "0", step: "any", oninput: () => refreshRegionControls() });
  const regionMessage = el("p", { class: "tm-hint", id: "region-message", role: "status" });
  const loopRegionBtn = el("button", { class: "tm-btn", onclick: () => {
    const clip = clips[focus];
    const bounds = readRegion();
    if (!clip || !bounds || loads[focus]) return;
    const region = { start: bounds.start / clip.pcm.length, end: bounds.end / clip.pcm.length };
    loopRegions[focus] = region;
    players[focus]?.setLoopRegion(region);
    renderAnalysis();
  } }, ["Loop region"]);
  const keepRegionBtn = el("button", { class: "tm-btn", onclick: () => void keepRegion() }, ["Keep region"]);
  const restoreClipBtn = el("button", { class: "tm-btn", hidden: true, onclick: () => void restoreFullClip() }, ["Restore full clip"]);
  const regionControls = el("div", { class: "tm-region-controls", role: "group", "aria-label": "Practice region", "aria-describedby": "region-message" }, [
    el("label", {}, ["Region start (s)", regionStart]),
    el("label", {}, ["Region end (s)", regionEnd]),
    loopRegionBtn, keepRegionBtn, restoreClipBtn,
  ]);

  const analysisPanel = el("section", { class: "tm-panel", id: "audio-analysis", role: "tabpanel", "aria-labelledby": "source-attempt" }, [
    el("div", { class: "tm-panel-header" }, [
      el("h2", {}, ["3. Waveform, spectrogram & pitch"]),
      el("span", { class: "tm-hint" }, ["Drag on the waveform to loop a region."]),
    ]),
    analysisLabel,
    el("div", { class: "tm-stage-wrap" }, [analysisCanvas, analysisEmpty]),
    el("div", { class: "tm-playback-bar" }, [
      playBtn,
      clearLoopBtn,
      el("label", { class: "tm-toggle" }, [halfSpeedToggle, "half-speed"]),
    ]),
    regionControls,
    regionMessage,
  ]);

  // ---------------------------------------------------------------- tone helper panel
  const toneBadge = el("div", { class: "tm-tone-badge" }, ["?"]);
  const toneConfBar = el("div", { class: "tm-confidence-fill", style: "width:0%" });
  const toneReason = el("p", { class: "tm-hint" }, ["Record or load a single syllable as your attempt, then click Classify."]);
  const tonePanel = el("section", { class: "tm-panel" }, [
    el("div", { class: "tm-panel-header" }, [
      el("h2", {}, ["Mandarin tone helper"]),
      el("span", { class: "tm-eyebrow" }, ["heuristic, not ML"]),
    ]),
    el("div", { class: "tm-controls-row" }, [
      el("button", { class: "tm-btn", onclick: () => runToneClassifier() }, ["Classify current attempt"]),
    ]),
    el("div", { class: "tm-tone-result" }, [toneBadge, el("div", { style: "flex:1" }, [el("div", { class: "tm-confidence-bar" }, [toneConfBar]), toneReason])]),
  ]);

  // ---------------------------------------------------------------- built-in references panel
  const allChipButtons: HTMLButtonElement[] = [];
  function selectChip(button: HTMLButtonElement): void {
    for (const b of allChipButtons) b.setAttribute("aria-pressed", String(b === button));
  }

  const referenceChips = el("div", { class: "tm-chip-row" });
  for (const tone of ALL_MANDARIN_TONES) {
    const btn = el(
      "button",
      {
        class: "tm-chip",
        "aria-pressed": "false",
        onclick: () => {
          selectChip(btn);
          void loadSyntheticReference(`Mandarin ${mandarinToneLabel(tone)}`, mandarinToneContour(tone), 180);
        },
      },
      [el("strong", {}, [`${mandarinToneChaoNumerals(tone)}`]), el("span", {}, [mandarinToneLabel(tone)])],
    );
    allChipButtons.push(btn);
    referenceChips.append(btn);
  }
  const greekChips = el("div", { class: "tm-chip-row" });
  for (const accent of ["acute", "circumflex"] as GreekAccent[]) {
    const btn = el(
      "button",
      {
        class: "tm-chip",
        "aria-pressed": "false",
        onclick: () => {
          selectChip(btn);
          void loadSyntheticReference(`Greek ${accent}`, greekAccentContour(accent), 150);
        },
      },
      [el("strong", {}, [accent]), el("span", {}, [greekAccentLabel(accent)])],
    );
    allChipButtons.push(btn);
    greekChips.append(btn);
  }
  const japaneseChips = el("div", { class: "tm-chip-row" });
  for (const pattern of ["heiban", "atamadaka", "nakadaka", "odaka"] as JapanesePattern[]) {
    const btn = el(
      "button",
      {
        class: "tm-chip",
        "aria-pressed": "false",
        onclick: () => {
          selectChip(btn);
          void loadSyntheticReference(`Japanese ${pattern}`, japaneseAccentContour(pattern, 3), 190);
        },
      },
      [el("strong", {}, [pattern]), el("span", {}, [japaneseAccentLabel(pattern)])],
    );
    allChipButtons.push(btn);
    japaneseChips.append(btn);
  }

  const builtInPanel = el("section", { class: "tm-panel" }, [
    el("div", { class: "tm-panel-header" }, [
      el("h2", {}, ["Built-in references"]),
      el("span", { class: "tm-eyebrow" }, ["synthetic voices, not real speakers"]),
    ]),
    el("p", { class: "tm-hint" }, [
      "Generated from the target pitch shapes below — useful for practicing a tone or accent pattern in isolation. Record or load a real native speaker for the best practice.",
    ]),
    el("h3", { class: "tm-eyebrow", style: "margin:14px 0 6px" }, ["Mandarin citation tones (Chao 1930)"]),
    referenceChips,
    el("h3", { class: "tm-eyebrow", style: "margin:14px 0 6px" }, ["Ancient Greek pitch accent (Allen, Vox Graeca)"]),
    greekChips,
    el("h3", { class: "tm-eyebrow", style: "margin:14px 0 6px" }, ["Japanese pitch accent"]),
    japaneseChips,
  ]);

  // ---------------------------------------------------------------- library panel
  const libraryList = el("div", { class: "tm-library-list" });
  const libraryStatus = el("p", { class: "tm-hint", role: "status", "aria-live": "polite" });
  const retryLibraryBtn = el("button", { class: "tm-btn", hidden: true, onclick: () => void refreshLibrary() }, ["Retry saved references"]);
  const saveBtn = el("button", { class: "tm-btn", onclick: () => void saveFocusedClipAsReference() }, ["Save current attempt"]);
  const libraryPanel = el("section", { class: "tm-panel" }, [
    el("div", { class: "tm-panel-header" }, [
      el("h2", {}, ["Your saved references"]),
      saveBtn,
    ]),
    libraryStatus,
    retryLibraryBtn,
    libraryList,
  ]);

  // ---------------------------------------------------------------- footer
  const footer = el("footer", { class: "tm-footer" }, [
    el("span", {}, ["Runs entirely in your browser. No audio ever leaves this device."]),
    el("a", { href: "https://github.com/antonsoo/tonemirror", target: "_blank", rel: "noreferrer" }, ["Source on GitHub"]),
  ]);

  root.append(
    header,
    el("main", { class: "tm-main" }, [
      hero,
      sourcePanel,
      stagePanel,
      el("div", { class: "tm-two-col" }, [analysisPanel, el("div", {}, [tonePanel, builtInPanel])]),
      libraryPanel,
    ]),
    footer,
  );

  void refreshLibrary();
  updateComparison();
  renderAnalysis();

  window.addEventListener("pagehide", () => {
    cancelWork();
    players.reference?.pause();
    players.attempt?.pause();
    playbackRequest++;
    cancelAnimationFrame(rafHandle);
    workers.reference.terminate();
    workers.attempt.terminate();
    comparisonWorker.terminate();
    renderAnalysis();
  });

  // ------------------------------------------------------------ behavior

  function selectFocus(role: FocusRole): void {
    if (focus !== role) {
      playbackRequest++;
      players[focus]?.pause();
      cancelAnimationFrame(rafHandle);
    }
    focus = role;
    for (const child of Array.from(targetTabs.children)) {
      child.setAttribute("aria-selected", String((child as HTMLElement).dataset.role === role));
      (child as HTMLElement).tabIndex = (child as HTMLElement).dataset.role === role ? 0 : -1;
    }
    analysisPanel.setAttribute("aria-labelledby", `source-${role}`);
    syncRegionFields();
    renderAnalysis();
  }

  function refreshBusy(): void {
    cancelBtn.hidden = !loads.reference && !loads.attempt && !comparison;
    retryAudioBtn.hidden = !!loads.reference || !!loads.attempt || (!drafts.reference && !drafts.attempt);
    sourcePanel.setAttribute("aria-busy", String(!!loads.reference || !!loads.attempt));
    stagePanel.setAttribute("aria-busy", String(!!comparison));
    refreshRegionControls();
  }

  function cancelRecording(): void {
    recordingRequest = null;
    void micRecorder.cancel();
    recordBtn.classList.remove("is-recording");
    recordBtn.textContent = "● Record";
    recordBtn.disabled = false;
  }

  function cancelWork(): void {
    for (const role of ["reference", "attempt"] as const) {
      versions[role]++;
      loads[role]?.controller.abort();
      loads[role] = null;
      drafts[role] = null;
    }
    cancelRecording();
    if (comparison) {
      comparison.abort();
      comparison = null;
      comparisonPair = null;
      comparisonNote.textContent = "Comparison cancelled. Loaded audio is kept.";
      retryComparisonBtn.hidden = false;
    }
    statusId++;
    statusLine.textContent = "Cancelled. Your last loaded clips are kept.";
    refreshBusy();
  }

  function beginLoad(role: FocusRole, nextStatus = ++statusId): AudioRequest {
    loads[role]?.controller.abort();
    if (recordingRequest?.role === role) cancelRecording();
    const request = { role, version: ++versions[role], statusId: nextStatus, controller: new AbortController() };
    loads[role] = request;
    drafts[role] = null;
    loadErrors[role] = null;
    refreshBusy();
    return request;
  }

  function finishLoad(request: AudioRequest): void {
    if (loads[request.role] === request) loads[request.role] = null;
    refreshBusy();
  }

  function isCurrent(request: AudioRequest): boolean {
    return versions[request.role] === request.version && !request.controller.signal.aborted;
  }

  function report(request: AudioRequest, message: string): void {
    if (isCurrent(request) && statusId === request.statusId) statusLine.textContent = message;
  }

  function resetToneResult(): void {
    toneBadge.textContent = "?";
    toneConfBar.style.width = "0%";
    toneReason.textContent = "Record or load a single syllable as your attempt, then click Classify.";
  }

  function syncRegionFields(): void {
    const clip = clips[focus];
    const duration = clip ? clip.pcm.length / clip.sampleRate : 0;
    const region = loopRegions[focus];
    regionStart.value = clip ? String(region ? Number((region.start * duration).toFixed(6)) : 0) : "";
    regionEnd.value = clip ? String(region ? Math.min(duration, Number((region.end * duration).toFixed(6))) : duration) : "";
    regionStart.max = regionEnd.max = String(duration);
    refreshRegionControls();
  }

  function readRegion(): { start: number; end: number } | null {
    const clip = clips[focus];
    if (!clip || !regionStart.value.trim() || !regionEnd.value.trim()) return null;
    try { return regionSamples(clip.pcm.length, clip.sampleRate, regionStart.valueAsNumber, regionEnd.valueAsNumber); }
    catch { return null; }
  }

  function refreshRegionControls(): void {
    const clip = clips[focus];
    const bounds = readRegion();
    const busy = !!loads[focus];
    regionStart.disabled = regionEnd.disabled = !clip || busy;
    loopRegionBtn.disabled = !bounds || busy;
    keepRegionBtn.disabled = !bounds || busy || (bounds.start === 0 && bounds.end === clip?.pcm.length);
    restoreClipBtn.hidden = !clip?.excerpt;
    restoreClipBtn.disabled = busy;
    saveBtn.disabled = !clip || savingReference || busy;
    const message = !clip ? "Load or record audio to choose a practice region."
      : !bounds ? "Enter a start and end within the clip, with the end after the start."
      : "Loop region changes playback. Keep region uses only that audio for comparison, classification and saving. Restore full clip is available until you load new audio.";
    if (regionMessage.textContent !== message) regionMessage.textContent = message;
  }

  async function keepRegion(): Promise<void> {
    const role = focus;
    const clip = clips[role];
    const bounds = readRegion();
    if (!clip || !bounds || loads[role] || (bounds.start === 0 && bounds.end === clip.pcm.length)) return;
    const source = clip.excerpt?.source ?? { pcm: clip.pcm, sampleRate: clip.sampleRate, label: clip.label, synthetic: clip.synthetic };
    const offset = clip.excerpt?.start ?? 0;
    const excerpt = { source, start: offset + bounds.start, end: offset + bounds.end };
    const label = `${source.label} [${(excerpt.start / source.sampleRate).toFixed(3)}–${(excerpt.end / source.sampleRate).toFixed(3)}s]`;
    await loadClip(role, source.pcm.slice(excerpt.start, excerpt.end), source.sampleRate, label, source.synthetic, beginLoad(role), excerpt);
  }

  async function restoreFullClip(): Promise<void> {
    const role = focus;
    const source = clips[role]?.excerpt?.source;
    if (!source || loads[role]) return;
    await loadClip(role, source.pcm, source.sampleRate, source.label, source.synthetic);
  }

  function describeMicError(err: unknown): string {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "Microphone access was denied. Allow it in your browser's site settings, or use “Load file…” instead.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "No microphone was found on this device. Try “Load file…” instead.";
    }
    if (name === "NotReadableError") {
      return "The microphone is busy or unavailable (another app may be using it).";
    }
    return `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  async function handleRecordClick(): Promise<void> {
    const previous = recordingRequest;
    if (previous && !micRecorder.isRecording()) {
      recordingRequest = null;
      recordBtn.textContent = "● Record";
      report(previous, "Microphone request cancelled.");
      previous.controller.abort();
      finishLoad(previous);
      await micRecorder.cancel();
      return;
    }
    if (micRecorder.isRecording()) {
      if (previous) await finishRecording(previous);
      return;
    }
    const request = beginLoad(focus);
    recordingRequest = request;
    try {
      recordBtn.textContent = "Cancel microphone";
      report(request, "Requesting microphone…");
      await micRecorder.start(() => { if (recordingRequest === request) void finishRecording(request, true); });
      if (recordingRequest !== request) return;
      recordBtn.classList.add("is-recording");
      recordBtn.textContent = "■ Stop";
      report(request, `Recording ${request.role === "attempt" ? "your attempt" : "reference"}…`);
    } catch (err) {
      if (recordingRequest !== request) return;
      recordingRequest = null;
      recordBtn.classList.remove("is-recording");
      recordBtn.textContent = "● Record";
      report(request, describeMicError(err));
      finishLoad(request);
    }
  }

  async function finishRecording(request: AudioRequest, limited = false): Promise<void> {
    recordingRequest = null;
    recordBtn.classList.remove("is-recording");
    recordBtn.textContent = "● Record";
    recordBtn.disabled = true;
    try {
      const { pcm, sampleRate } = await micRecorder.stop();
      const name = limited ? `Recording (stopped at ${MAX_AUDIO_SECONDS}s limit)` : `Recording (${new Date().toLocaleTimeString()})`;
      await loadClip(request.role, pcm, sampleRate, name, false, request);
    } catch (error) {
      report(request, describeMicError(error));
    } finally {
      recordBtn.disabled = false;
      finishLoad(request);
    }
  }

  async function handleFileSelected(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    (e.target as HTMLInputElement).value = "";
    const request = beginLoad(focus);
    report(request, `Decoding ${file.name}…`);
    try {
      const { pcm, sampleRate } = await loadAudioFile(file, request.controller.signal);
      await loadClip(request.role, pcm, sampleRate, file.name, false, request);
    } catch (err) {
      report(request, `Could not decode ${file.name}: ${(err as Error).message}`);
    } finally {
      finishLoad(request);
    }
  }

  async function loadSyntheticReference(label: string, contourPoints: Parameters<typeof synthesizeFromContour>[0], baseF0: number): Promise<void> {
    const sampleRate = 22050;
    const pcm = synthesizeFromContour(contourPoints, baseF0, { sampleRate, duration: 0.6, seed: 42 });
    selectFocus("reference");
    await loadClip("reference", pcm, sampleRate, label, true);
  }

  async function loadClip(role: FocusRole, pcm: Float32Array, sampleRate: number, label: string, synthetic: boolean, request = beginLoad(role), excerpt?: ClipExcerpt): Promise<boolean> {
    if (!isCurrent(request)) return false;
    report(request, `Analyzing ${label}…`);
    const state: ClipState = { pcm, sampleRate, contour: null, spectrogram: null, label, synthetic, algorithm, excerpt };
    try {
      validateAudio(pcm.length, sampleRate);
      drafts[role] = state;
      const result = await workers[role].analyze(pcm, sampleRate, state.algorithm, request.controller.signal);
      if (!isCurrent(request)) return false;
      const player = new ClipPlayer(getPlaybackContext());
      player.load(pcm, sampleRate);
      players[role]?.stop();
      players[role] = player;
      state.contour = result.contour;
      state.spectrogram = result.spectrogram;
      clips[role] = state;
      drafts[role] = null;
      if (focus === role) playbackRequest++;
      loopRegions[role] = null;
      if (focus === role) syncRegionFields();
      if (role === "attempt") resetToneResult();
      updateComparison();
      renderAnalysis();
      report(request, `${label}${synthetic ? " (synthetic)" : ""} — ${(pcm.length / sampleRate).toFixed(2)}s`);
      return true;
    } catch (error) {
      if (isCurrent(request)) loadErrors[role] = error instanceof Error ? error.message : String(error);
      report(request, `Could not load ${label}: ${(error as Error).message}${clips[role] ? " Previous clip kept." : ""}`);
      return false;
    } finally {
      finishLoad(request);
    }
  }

  async function reanalyzeAll(onlyFailed = false): Promise<void> {
    const nextStatus = ++statusId;
    resetToneResult();
    const jobs = (["reference", "attempt"] as FocusRole[]).map(async (role) => {
      if (onlyFailed && !drafts[role]) return true;
      if (loads[role] && !drafts[role]) return true; // A decode/capture will use the newly selected algorithm.
      const clip = drafts[role] ?? clips[role];
      if (!clip) return true;
      const request = beginLoad(role, nextStatus);
      return loadClip(role, clip.pcm, clip.sampleRate, clip.label, clip.synthetic, request, clip.excerpt);
    });
    const results = await Promise.all(jobs);
    if (statusId === nextStatus && results.every(Boolean)) {
      statusLine.textContent = `Pitch analysis updated (${algorithm === "yin" ? "YIN" : "MPM"}).`;
    } else if (statusId === nextStatus) {
      const errors = (["reference", "attempt"] as const).filter((role) => loadErrors[role]).map((role) => `${role}: ${loadErrors[role]}`).join("; ");
      statusLine.textContent = `Audio update incomplete. Last loaded clips kept. ${errors}`;
    }
  }

  function updateComparison(force = false): void {
    const ref = clips.reference?.contour;
    const att = clips.attempt?.contour;
    if (!force && ref && att && comparisonPair?.[0] === ref && comparisonPair[1] === att) return;
    comparison?.abort();
    comparison = null;
    alignment = null;
    retryComparisonBtn.hidden = true;
    scoreEl.textContent = "—";
    comparisonNote.textContent = "";
    if (ref && att) {
      comparisonPair = [ref, att];
      const controller = new AbortController();
      comparison = controller;
      const current = (): boolean => comparison === controller && !controller.signal.aborted;
      const labels = `Reference: ${clips.reference!.label} (${clips.reference!.algorithm.toUpperCase()}); attempt: ${clips.attempt!.label} (${clips.attempt!.algorithm.toUpperCase()}).`;
      comparisonNote.textContent = `Matching loaded contours. ${labels}`;
      feedbackList.replaceChildren(el("li", {}, ["Matching pitch shapes… You can cancel this work."]));
      void comparisonWorker.compare(ref, att, controller.signal).then(({ alignment: result }) => {
        if (!current()) return;
        alignment = result;
        scoreEl.textContent = result.score === null ? "Unavailable" : String(result.score);
        feedbackList.replaceChildren(...result.feedback.map((f) => el("li", {}, [f])));
        const a = result.sampling.reference;
        const b = result.sampling.attempt;
        const approximate = a.aligned < a.voiced || b.aligned < b.voiced;
        comparisonNote.textContent = `${labels} Voiced frames: ${a.voiced}/${a.frames} reference, ${b.voiced}/${b.frames} attempt. ${approximate ? `Approximate alignment uses ${a.aligned} and ${b.aligned} samples. ` : ""}The score describes pitch shape after alignment; it is not a pronunciation grade.`;
        stage.render({ reference: ref, attempt: att, warped: warpedOverlay(result) });
      }).catch((error: unknown) => {
        if (!current()) return;
        comparisonPair = null;
        comparisonNote.textContent = `Comparison failed: ${error instanceof Error ? error.message : String(error)}`;
        feedbackList.replaceChildren(el("li", {}, ["Your loaded audio is kept. Retry comparison when ready."]));
        retryComparisonBtn.hidden = false;
      }).finally(() => {
        if (current()) { comparison = null; refreshBusy(); }
      });
    } else {
      comparisonPair = null;
      feedbackList.replaceChildren(el("li", {}, ["Load both a reference and an attempt to see a score."]));
    }
    stage.render({ reference: ref ?? null, attempt: att ?? null, warped: null });
    stageEmpty.style.display = ref || att ? "none" : "grid";
    refreshBusy();
  }

  function renderAnalysis(): void {
    const clip = clips[focus];
    const player = players[focus];
    analysis.render({
      pcm: clip?.pcm ?? null,
      sampleRate: clip?.sampleRate ?? 44100,
      spectrogram: clip?.spectrogram ?? null,
      contour: clip?.contour ?? null,
      durationSeconds: player?.duration ?? 0,
      playheadFraction: player && player.duration > 0 ? player.currentPositionSeconds() / player.duration : null,
      loopRegion: loopRegions[focus],
    });
    analysisEmpty.style.display = clip ? "none" : "grid";
    const label = `${focus === "attempt" ? "Your attempt" : "Reference"}: ${clip ? `${clip.label}${clip.synthetic ? " (synthetic)" : ""} · ${(clip.pcm.length / clip.sampleRate).toFixed(2)}s` : "no audio loaded"}`;
    if (analysisLabel.textContent !== label) analysisLabel.textContent = label;
    playBtn.disabled = !clip || !player;
    clearLoopBtn.disabled = !loopRegions[focus];
    saveBtn.disabled = !clip || savingReference || !!loads[focus];
    saveBtn.textContent = focus === "reference" ? "Save current reference" : "Save current attempt";
    refreshRegionControls();
    playBtn.textContent = player?.isPlaying ? "⏸ Pause" : "▶ Play";
  }

  async function togglePlayback(): Promise<void> {
    const role = focus;
    const player = players[focus];
    if (!player) return;
    const request = ++playbackRequest;
    if (player.isPlaying) {
      player.pause();
      cancelAnimationFrame(rafHandle);
    } else {
      try { await getPlaybackContext().resume(); } catch {
        statusLine.textContent = "Playback is unavailable. Try loading the clip again.";
        return;
      }
      if (request !== playbackRequest || focus !== role || players[role] !== player) return;
      player.setHalfSpeed(halfSpeed);
      const loopRegion = loopRegions[role];
      player.setLoopRegion(loopRegion ? { start: loopRegion.start, end: loopRegion.end } : null);
      player.play(player.currentPositionSeconds() >= player.duration - 0.01 ? 0 : player.currentPositionSeconds(), () => renderAnalysis());
      tick();
    }
    renderAnalysis();
  }

  function tick(): void {
    renderAnalysis();
    if (players[focus]?.isPlaying) rafHandle = requestAnimationFrame(tick);
  }

  function runToneClassifier(): void {
    const clip = clips.attempt;
    if (!clip?.contour) {
      toneReason.textContent = "Record or load an attempt first.";
      return;
    }
    const samples = clip.contour.points.filter((p) => p.voiced && p.semitone !== null).map((p) => ({ time: p.time, semitone: p.semitone! }));
    const result = classifyMandarinTone(samples);
    toneBadge.textContent = result.tone === null ? "?" : result.tone === "neutral" ? "0" : String(result.tone);
    toneConfBar.style.width = `${Math.round(result.confidence * 100)}%`;
    toneReason.textContent = result.tone === null ? "Not enough voiced signal to classify." : `Sounds closest to ${result.label} — ${Math.round(result.confidence * 100)}% confidence (${result.reason}).`;
  }

  async function saveFocusedClipAsReference(): Promise<void> {
    const clip = clips[focus];
    if (!clip || loads[focus] || savingReference) return;
    const name = window.prompt("Name this reference:", clip.label);
    if (name === null) return;
    if (!name.trim()) {
      libraryStatus.textContent = "Give the reference a name before saving.";
      return;
    }
    savingReference = true;
    saveBtn.disabled = true;
    try {
      await saveReference({
        id: crypto.randomUUID(),
        name: name.trim(),
        category: "user",
        synthetic: clip.synthetic,
        pcm: clip.pcm,
        sampleRate: clip.sampleRate,
        createdAt: Date.now(),
      });
      if (await refreshLibrary()) libraryStatus.textContent = `Saved ${name.trim()} on this device.`;
    } catch (error) {
      libraryStatus.textContent = `Could not save the reference: ${(error as Error).message}`;
    } finally {
      savingReference = false;
      renderAnalysis();
    }
  }

  async function refreshLibrary(): Promise<boolean> {
    try {
      library = await listReferences();
    } catch (error) {
      libraryStatus.textContent = `Saved references are unavailable in this browser: ${(error as Error).message}. You can still record, load files, and compare audio.`;
      retryLibraryBtn.hidden = false;
      return false;
    }
    libraryStatus.textContent = "";
    retryLibraryBtn.hidden = true;
    libraryList.replaceChildren(
      ...(library.length === 0
        ? [el("p", { class: "tm-hint" }, ["No saved references yet — record a native speaker once, save it, and practice against it anytime."])]
        : library.map((ref) =>
            el("div", { class: "tm-library-item" }, [
              el("span", {}, [ref.name, " ", el("span", { class: "tm-badge" }, [ref.category])]),
              el("span", {}, [
                el("button", { onclick: () => void useReference(ref) }, ["Use"]),
                " ",
                el("button", { onclick: () => void removeReference(ref.id) }, ["Delete"]),
              ]),
            ]),
          )),
    );
    return true;
  }

  async function useReference(summary: ReferenceSummary): Promise<void> {
    selectFocus("reference");
    const request = beginLoad("reference");
    report(request, `Reading ${summary.name}…`);
    try {
      const ref = await getReference(summary.id, request.controller.signal);
      if (!isCurrent(request)) return;
      if (!ref) throw new Error("This saved reference is no longer available. Refresh the library and choose another recording.");
      await loadClip("reference", ref.pcm, ref.sampleRate, ref.name, ref.synthetic, request);
    } catch (error) {
      if (isCurrent(request)) {
        libraryStatus.textContent = `Could not read ${summary.name}: ${(error as Error).message}`;
        retryLibraryBtn.hidden = false;
      }
      report(request, `Could not load ${summary.name}: ${(error as Error).message}${clips.reference ? " Previous clip kept." : ""}`);
    } finally {
      finishLoad(request);
    }
  }

  async function removeReference(id: string): Promise<void> {
    try {
      await deleteReference(id);
      await refreshLibrary();
    } catch (error) {
      libraryStatus.textContent = `Could not delete the reference: ${(error as Error).message}`;
    }
  }
}
