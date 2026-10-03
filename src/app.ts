import { el } from "./ui/dom.js";
import { applyTheme, currentTheme, toggleTheme } from "./ui/theme.js";
import { createContourStage } from "./ui/contourStage.js";
import { createAnalysisView, type LoopRegion } from "./ui/analysisView.js";
import { PitchWorkerClient } from "./worker/client.js";
import { MicRecorder } from "./audio/recorder.js";
import { loadAudioFile } from "./audio/fileLoader.js";
import { ClipPlayer } from "./audio/playback.js";
import { compareContours, warpedOverlay, type AlignmentResult } from "./core/dtw.js";
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
import { deleteReference, listReferences, saveReference, type StoredReference } from "./storage/db.js";
import type { Spectrogram } from "./core/spectrogram.js";
import type { PitchAlgorithm, PitchContour } from "./core/types.js";

interface ClipState {
  pcm: Float32Array;
  sampleRate: number;
  contour: PitchContour | null;
  spectrogram: Spectrogram | null;
  label: string;
  synthetic: boolean;
}

type FocusRole = "reference" | "attempt";
interface AudioRequest {
  role: FocusRole;
  version: number;
  statusId: number;
}

export function mountApp(root: HTMLElement): void {
  applyTheme(currentTheme());

  const worker = new PitchWorkerClient();
  let algorithm: PitchAlgorithm = "yin";
  let playbackContext: AudioContext | null = null;
  const players: Record<FocusRole, ClipPlayer | null> = { reference: null, attempt: null };
  const clips: Record<FocusRole, ClipState | null> = { reference: null, attempt: null };
  let focus: FocusRole = "attempt";
  const loopRegions: Record<FocusRole, LoopRegion | null> = { reference: null, attempt: null };
  const versions: Record<FocusRole, number> = { reference: 0, attempt: 0 };
  const analyses: Record<FocusRole, number> = { reference: 0, attempt: 0 };
  let statusId = 0;
  let recordingRequest: AudioRequest | null = null;
  let halfSpeed = false;
  let alignment: AlignmentResult | null = null;
  let library: StoredReference[] = [];
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
    el("div", { class: "tm-controls-row" }, [recordBtn, loadBtn, algoSelect, statusLine]),
  ]);

  // ---------------------------------------------------------------- contour stage panel
  const stageCanvas = el("canvas", { class: "tm-canvas" });
  const stage = createContourStage(stageCanvas);
  const scoreEl = el("div", { class: "tm-score" }, ["—"]);
  const feedbackList = el("ul", { class: "tm-feedback-list" });
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
  ]);

  // ---------------------------------------------------------------- analysis view panel
  const analysisCanvas = el("canvas", { class: "tm-canvas" });
  const analysisEmpty = el("div", { class: "tm-stage-empty" }, ["Record or load audio above to see its waveform and spectrogram."]);
  const analysisLabel = el("p", { class: "tm-hint tm-clip-label" });
  const analysis = createAnalysisView(analysisCanvas, (region) => {
    loopRegions[focus] = region;
    players[focus]?.setLoopRegion(region ? { start: region.start, end: region.end } : null);
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
      renderAnalysis();
    },
  }, ["Clear loop"]);

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
  const saveBtn = el("button", { class: "tm-btn", onclick: () => void saveCurrentAttemptAsReference() }, ["Save current attempt"]);
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
    recordingRequest = null;
    void micRecorder.cancel();
    recordBtn.classList.remove("is-recording");
    recordBtn.textContent = "● Record";
    recordBtn.disabled = false;
    players.reference?.pause();
    players.attempt?.pause();
    playbackRequest++;
    cancelAnimationFrame(rafHandle);
    worker.terminate();
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
    renderAnalysis();
  }

  function beginLoad(role: FocusRole): AudioRequest {
    analyses[role]++;
    return { role, version: ++versions[role], statusId: ++statusId };
  }

  function isCurrent(request: AudioRequest): boolean {
    return versions[request.role] === request.version;
  }

  function report(request: AudioRequest, message: string): void {
    if (isCurrent(request) && statusId === request.statusId) statusLine.textContent = message;
  }

  function resetToneResult(): void {
    toneBadge.textContent = "?";
    toneConfBar.style.width = "0%";
    toneReason.textContent = "Record or load a single syllable as your attempt, then click Classify.";
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
      await micRecorder.cancel();
      return;
    }
    if (micRecorder.isRecording()) {
      recordBtn.classList.remove("is-recording");
      recordBtn.textContent = "● Record";
      recordBtn.disabled = true;
      recordingRequest = null;
      try {
        const { pcm, sampleRate } = await micRecorder.stop();
        if (previous) await loadClip(previous.role, pcm, sampleRate, `Recording (${new Date().toLocaleTimeString()})`, false, previous);
      } catch (error) {
        if (previous) report(previous, describeMicError(error));
      } finally {
        recordBtn.disabled = false;
      }
      return;
    }
    const request = beginLoad(focus);
    recordingRequest = request;
    try {
      recordBtn.textContent = "Cancel microphone";
      report(request, "Requesting microphone…");
      await micRecorder.start();
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
    }
  }

  async function handleFileSelected(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    (e.target as HTMLInputElement).value = "";
    const request = beginLoad(focus);
    report(request, `Decoding ${file.name}…`);
    try {
      const { pcm, sampleRate } = await loadAudioFile(file);
      await loadClip(request.role, pcm, sampleRate, file.name, false, request);
    } catch (err) {
      report(request, `Could not decode ${file.name}: ${(err as Error).message}`);
    }
  }

  async function loadSyntheticReference(label: string, contourPoints: Parameters<typeof synthesizeFromContour>[0], baseF0: number): Promise<void> {
    const sampleRate = 22050;
    const pcm = synthesizeFromContour(contourPoints, baseF0, { sampleRate, duration: 0.6, seed: 42 });
    selectFocus("reference");
    await loadClip("reference", pcm, sampleRate, label, true);
  }

  async function loadClip(role: FocusRole, pcm: Float32Array, sampleRate: number, label: string, synthetic: boolean, request = beginLoad(role)): Promise<void> {
    if (!isCurrent(request)) return;
    report(request, `Analyzing ${label}…`);
    const state: ClipState = { pcm, sampleRate, contour: null, spectrogram: null, label, synthetic };
    clips[role] = state;
    players[role]?.stop();
    players[role] = null;
    if (focus === role) playbackRequest++;
    loopRegions[role] = null;
    if (role === "attempt") resetToneResult();
    updateComparison();
    renderAnalysis();
    try {
      const player = new ClipPlayer(getPlaybackContext());
      player.load(pcm, sampleRate);
      players[role] = player;
      if (await analyzeClip(request, state)) {
        report(request, `${label}${synthetic ? " (synthetic)" : ""} — ${pcm.length > 0 ? (pcm.length / sampleRate).toFixed(2) : "0"}s`);
      }
    } catch (error) {
      report(request, `Could not load ${label}: ${(error as Error).message}`);
    }
  }

  async function analyzeClip(request: AudioRequest, clip: ClipState): Promise<boolean> {
    const generation = ++analyses[request.role];
    clip.contour = null;
    clip.spectrogram = null;
    updateComparison();
    renderAnalysis();
    const current = (): boolean => isCurrent(request) && clips[request.role] === clip && analyses[request.role] === generation;
    try {
      const result = await worker.analyze(clip.pcm, clip.sampleRate, algorithm);
      if (!current()) return false;
      clip.contour = result.contour;
      clip.spectrogram = result.spectrogram;
      updateComparison();
      renderAnalysis();
      return true;
    } catch (error) {
      if (current()) report(request, (error as Error).message);
      return false;
    }
  }

  async function reanalyzeAll(): Promise<void> {
    const nextStatus = ++statusId;
    resetToneResult();
    const jobs = (["reference", "attempt"] as FocusRole[]).map(async (role) => {
      const clip = clips[role];
      if (!clip) return true;
      return analyzeClip({ role, version: versions[role], statusId: nextStatus }, clip);
    });
    const results = await Promise.all(jobs);
    if (statusId === nextStatus && results.every(Boolean)) {
      statusLine.textContent = `Pitch analysis updated (${algorithm === "yin" ? "YIN" : "MPM"}).`;
    }
  }

  function updateComparison(): void {
    const ref = clips.reference?.contour;
    const att = clips.attempt?.contour;
    if (ref && att) {
      alignment = compareContours(ref, att);
      scoreEl.textContent = String(alignment.score);
      feedbackList.replaceChildren(...alignment.feedback.map((f) => el("li", {}, [f])));
    } else {
      alignment = null;
      scoreEl.textContent = "—";
      feedbackList.replaceChildren(el("li", {}, ["Load both a reference and an attempt to see a score."]));
    }
    stage.render({ reference: ref ?? null, attempt: att ?? null, warped: alignment ? warpedOverlay(alignment) : null });
    stageEmpty.style.display = ref || att ? "none" : "grid";
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
    saveBtn.disabled = !clips.attempt || savingReference;
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

  async function saveCurrentAttemptAsReference(): Promise<void> {
    const clip = clips.attempt;
    if (!clip) return;
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
        synthetic: false,
        pcm: clip.pcm,
        sampleRate: clip.sampleRate,
        createdAt: Date.now(),
      });
      if (await refreshLibrary()) libraryStatus.textContent = `Saved ${name.trim()} on this device.`;
    } catch (error) {
      libraryStatus.textContent = `Could not save the reference: ${(error as Error).message}`;
    } finally {
      savingReference = false;
      saveBtn.disabled = !clips.attempt;
    }
  }

  async function refreshLibrary(): Promise<boolean> {
    try {
      library = await listReferences();
    } catch {
      libraryStatus.textContent = "Saved references are unavailable in this browser. You can still record, load files, and compare audio.";
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
                el("button", { onclick: () => {
                  selectFocus("reference");
                  void loadClip("reference", ref.pcm, ref.sampleRate, ref.name, ref.synthetic);
                } }, ["Use"]),
                " ",
                el("button", { onclick: () => void removeReference(ref.id) }, ["Delete"]),
              ]),
            ]),
          )),
    );
    return true;
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
