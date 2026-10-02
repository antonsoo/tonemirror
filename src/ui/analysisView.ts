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

/** Lowest and highest sample under each pixel column, as [min0, max0, min1, max1, ...]. */
export function waveformColumns(pcm: Float32Array, width: number): Float32Array {
  const columns = new Float32Array(width * 2);
  for (let x = 0; x < width; x++) {
    const start = Math.floor((x * pcm.length) / width);
    const end = Math.floor(((x + 1) * pcm.length) / width);
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = pcm[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) {
      min = 0;
      max = 0;
    }
    columns[x * 2] = min;
    columns[x * 2 + 1] = max;
  }
  return columns;
}

// The view repaints on every animation frame while a clip plays, to move the playhead. What it
// paints under the playhead does not change from frame to frame, so the waveform's columns and
// the spectrogram's image are kept per clip: recomputed each frame, they cost a pass over every
// sample and every spectrogram cell, and playback of a minute-long clip drops frames.
const waveformCache = new WeakMap<Float32Array, { width: number; columns: Float32Array }>();

function drawWaveform(ctx: CanvasRenderingContext2D, pcm: Float32Array, width: number, top: number, height: number): void {
  const columnCount = Math.max(1, Math.floor(width));
  let cached = waveformCache.get(pcm);
  if (!cached || cached.width !== columnCount) {
    cached = { width: columnCount, columns: waveformColumns(pcm, columnCount) };
    waveformCache.set(pcm, cached);
  }
  const { columns } = cached;

  const mid = top + height / 2;
  ctx.save();
  ctx.strokeStyle = cssVar("--color-text-muted");
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < columnCount; x++) {
    ctx.moveTo(x, mid + columns[x * 2]! * (height / 2));
    ctx.lineTo(x, mid + columns[x * 2 + 1]! * (height / 2));
  }
  ctx.stroke();
  ctx.restore();
}

/** The widest image a spectrogram is rendered to. A longer one (over 43 s at 48 kHz) puts
 * several frames under each column and keeps the loudest value per bin, which is also what
 * keeps the image inside every browser's canvas size limit. */
const MAX_SPECTROGRAM_COLUMNS = 8192;

const spectrogramCache = new WeakMap<Spectrogram, { key: string; image: HTMLCanvasElement }>();

function spectrogramImage(spec: Spectrogram, maxBin: number, rgb: [number, number, number]): HTMLCanvasElement {
  const key = `${rgb.join(",")}/${maxBin}`;
  const cached = spectrogramCache.get(spec);
  if (cached?.key === key) return cached.image;

  const frameCount = spec.frames.length;
  const columnCount = Math.min(frameCount, MAX_SPECTROGRAM_COLUMNS);
  const image = document.createElement("canvas");
  image.width = columnCount;
  image.height = maxBin;
  const ictx = image.getContext("2d")!;
  const imageData = ictx.createImageData(columnCount, maxBin);
  const [r, g, b] = rgb;
  const dbRange = 60; // display range above the floor
  const column = new Float64Array(maxBin);
  for (let x = 0; x < columnCount; x++) {
    const from = Math.floor((x * frameCount) / columnCount);
    const to = Math.max(from + 1, Math.floor(((x + 1) * frameCount) / columnCount));
    column.set(spec.frames[from]!.subarray(0, maxBin));
    for (let f = from + 1; f < to; f++) {
      const frame = spec.frames[f]!;
      for (let bin = 0; bin < maxBin; bin++) {
        if (frame[bin]! > column[bin]!) column[bin] = frame[bin]!;
      }
    }
    for (let bin = 0; bin < maxBin; bin++) {
      const norm = Math.max(0, Math.min(1, (column[bin]! - (spec.floorDb + (90 - dbRange))) / dbRange));
      const idx = ((maxBin - 1 - bin) * columnCount + x) * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = Math.round(norm * 255);
    }
  }
  ictx.putImageData(imageData, 0, 0);
  spectrogramCache.set(spec, { key, image });
  return image;
}

function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  spec: Spectrogram,
  width: number,
  top: number,
  height: number,
  maxFreq: number,
): void {
  const rgb = hexToRgb(cssVar("--color-text").startsWith("#") ? cssVar("--color-text") : "#888888");
  const maxBin = Math.min(spec.frames[0]?.length ?? 1, Math.ceil(maxFreq / spec.freqStep));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(spectrogramImage(spec, maxBin, rgb), 0, top, width, height);
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
