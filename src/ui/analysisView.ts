import { observeCanvasSize } from "./canvas.js";
import { cssVar } from "./theme.js";
import type { Spectrogram } from "../core/spectrogram.js";
import type { PitchContour } from "../core/types.js";

export interface LoopRegion {
  start: number; // fraction [0,1]
  end: number; // fraction [0,1]
}

export interface AnalysisViewData {
  pcm: Float32Array | null;
  sampleRate: number;
  spectrogram: Spectrogram | null;
  contour: PitchContour | null;
  durationSeconds: number;
  playheadFraction: number | null;
  loopRegion: LoopRegion | null;
  maxDisplayFrequency?: number;
}

const WAVEFORM_HEIGHT = 46;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return [120, 120, 120];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function drawWaveform(ctx: CanvasRenderingContext2D, pcm: Float32Array, width: number, top: number, height: number): void {
  const mid = top + height / 2;
  ctx.save();
  ctx.strokeStyle = cssVar("--color-text-muted");
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const samplesPerPixel = Math.max(1, Math.floor(pcm.length / width));
  for (let x = 0; x < width; x++) {
    const start = x * samplesPerPixel;
    let min = 1;
    let max = -1;
    for (let i = start; i < Math.min(pcm.length, start + samplesPerPixel); i++) {
      const v = pcm[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) {
      min = 0;
      max = 0;
    }
    ctx.moveTo(x, mid + min * (height / 2));
    ctx.lineTo(x, mid + max * (height / 2));
  }
  ctx.stroke();
  ctx.restore();
}

function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  spec: Spectrogram,
  width: number,
  top: number,
  height: number,
  maxFreq: number,
): void {
  const [r, g, b] = hexToRgb(cssVar("--color-text").startsWith("#") ? cssVar("--color-text") : "#888888");
  const maxBin = Math.min(spec.frames[0]?.length ?? 1, Math.ceil(maxFreq / spec.freqStep));
  const off = document.createElement("canvas");
  off.width = spec.frames.length;
  off.height = maxBin;
  const octx = off.getContext("2d")!;
  const imageData = octx.createImageData(off.width, off.height);
  const dbRange = 60; // display range above the floor
  for (let x = 0; x < spec.frames.length; x++) {
    const frame = spec.frames[x]!;
    for (let bin = 0; bin < maxBin; bin++) {
      const db = frame[bin]!;
      const norm = Math.max(0, Math.min(1, (db - (spec.floorDb + (90 - dbRange))) / dbRange));
      const idx = ((maxBin - 1 - bin) * off.width + x) * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = Math.round(norm * 255);
    }
  }
  octx.putImageData(imageData, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, top, width, height);
}

function freqToY(freq: number, top: number, height: number, maxFreq: number): number {
  return top + height * (1 - Math.min(freq, maxFreq) / maxFreq);
}

function drawPitchOverlay(
  ctx: CanvasRenderingContext2D,
  contour: PitchContour,
  durationSeconds: number,
  width: number,
  top: number,
  height: number,
  maxFreq: number,
): void {
  ctx.save();
  ctx.strokeStyle = cssVar("--color-attempt");
  ctx.shadowColor = cssVar("--color-attempt-glow");
  ctx.shadowBlur = 4;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  let drawing = false;
  ctx.beginPath();
  for (const p of contour.points) {
    const x = (p.time / durationSeconds) * width;
    if (!p.voiced || p.f0 === null) {
      drawing = false;
      continue;
    }
    const y = freqToY(p.f0, top, height, maxFreq);
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawPlayhead(ctx: CanvasRenderingContext2D, fraction: number, width: number, height: number): void {
  const x = fraction * width;
  ctx.save();
  ctx.strokeStyle = cssVar("--color-accent");
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.restore();
}

function drawLoopRegion(ctx: CanvasRenderingContext2D, region: LoopRegion, width: number, height: number): void {
  ctx.save();
  ctx.fillStyle = cssVar("--color-accent");
  ctx.globalAlpha = 0.12;
  const x0 = region.start * width;
  const x1 = region.end * width;
  ctx.fillRect(x0, 0, x1 - x0, height);
  ctx.restore();
}

export function createAnalysisView(
  canvas: HTMLCanvasElement,
  onSetLoopRegion: (region: LoopRegion | null) => void,
): {
  render: (data: AnalysisViewData) => void;
  destroy: () => void;
} {
  let latest: AnalysisViewData = {
    pcm: null,
    sampleRate: 44100,
    spectrogram: null,
    contour: null,
    durationSeconds: 0,
    playheadFraction: null,
    loopRegion: null,
  };
  const cssHeight = WAVEFORM_HEIGHT + 200;

  const paint = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
    ctx.clearRect(0, 0, width, height);
    const specTop = WAVEFORM_HEIGHT + 6;
    const specHeight = height - specTop;
    const maxFreq = latest.maxDisplayFrequency ?? 4000;

    if (latest.loopRegion) drawLoopRegion(ctx, latest.loopRegion, width, height);
    if (latest.pcm && latest.pcm.length > 0) drawWaveform(ctx, latest.pcm, width, 0, WAVEFORM_HEIGHT);
    if (latest.spectrogram && latest.spectrogram.frames.length > 0) {
      drawSpectrogram(ctx, latest.spectrogram, width, specTop, specHeight, maxFreq);
    }
    if (latest.contour && latest.durationSeconds > 0) {
      drawPitchOverlay(ctx, latest.contour, latest.durationSeconds, width, specTop, specHeight, maxFreq);
    }
    if (latest.playheadFraction !== null) drawPlayhead(ctx, latest.playheadFraction, width, height);
  };

  let ctxRef: CanvasRenderingContext2D | null = null;
  let widthRef = 0;
  let heightRef = 0;
  const stop = observeCanvasSize(canvas, cssHeight, (ctx, width, height) => {
    ctxRef = ctx;
    widthRef = width;
    heightRef = height;
    paint(ctx, width, height);
  });

  let dragStart: number | null = null;
  const fractionAt = (evt: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  };
  canvas.addEventListener("pointerdown", (evt) => {
    dragStart = fractionAt(evt);
    canvas.setPointerCapture(evt.pointerId);
  });
  canvas.addEventListener("pointermove", (evt) => {
    if (dragStart === null) return;
    const current = fractionAt(evt);
    onSetLoopRegion({ start: Math.min(dragStart, current), end: Math.max(dragStart, current) });
  });
  canvas.addEventListener("pointerup", (evt) => {
    if (dragStart !== null) {
      const current = fractionAt(evt);
      if (Math.abs(current - dragStart) < 0.01) onSetLoopRegion(null); // treat as a click: clear the loop
    }
    dragStart = null;
  });

  return {
    render(data: AnalysisViewData) {
      latest = data;
      if (ctxRef) paint(ctxRef, widthRef, heightRef);
    },
    destroy: stop,
  };
}
