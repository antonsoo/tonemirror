import { yinDetect } from "./yin.js";
import { mpmDetect } from "./mpm.js";
import type { ContourPoint, PitchContour, PitchFrame, PitchTrackOptions } from "./types.js";

const DEFAULTS = {
  algorithm: "yin" as const,
  minFrequency: 60,
  maxFrequency: 1000,
  hopSeconds: 0.01,
  yinThreshold: 0.15,
  mpmClarityThreshold: 0.93,
  silenceRms: 0.003,
  medianWindow: 5,
};

/** Voicing cutoffs on detector confidence, tuned against the synthetic test
 * suite (tests/pitch.test.ts). YIN's confidence is 1 - d'(tau); MPM's is the
 * NSDF peak height. Both approach 1 for a clean periodic signal and degrade
 * under noise, so a single cutoff per algorithm is enough here. */
const YIN_VOICING_CONFIDENCE = 0.5;
const MPM_VOICING_CONFIDENCE = 0.55;

function rms(frame: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Snap frames that are ~2x or ~1/2x their local voiced neighborhood median,
 * a classic YIN/autocorrelation failure mode where the detector locks onto a
 * harmonic or subharmonic of the true period. */
function correctOctaveErrors(
  f0s: (number | null)[],
  windowRadius = 4,
  tolerance = 0.15,
): (number | null)[] {
  const out = [...f0s];
  for (let i = 0; i < f0s.length; i++) {
    const f0 = f0s[i]!;
    if (f0 === null) continue;
    const neighbors: number[] = [];
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(f0s.length - 1, i + windowRadius); j++) {
      if (j === i) continue;
      const v = f0s[j];
      if (v !== null && v !== undefined) neighbors.push(v);
    }
    if (neighbors.length < 2) continue;
    const localMedian = median(neighbors);
    const logRatio = Math.log2(f0 / localMedian);
    if (Math.abs(logRatio - 1) <= tolerance) {
      out[i] = f0 / 2;
    } else if (Math.abs(logRatio + 1) <= tolerance) {
      out[i] = f0 * 2;
    }
  }
  return out;
}

/** Median filter over voiced values only; unvoiced (null) frames pass through
 * untouched so voicing boundaries are not smeared. */
function medianSmooth(f0s: (number | null)[], windowSize: number): (number | null)[] {
  if (windowSize <= 1) return f0s;
  const radius = Math.floor(windowSize / 2);
  const out: (number | null)[] = new Array<number | null>(f0s.length).fill(null);
  for (let i = 0; i < f0s.length; i++) {
    if (f0s[i] === null) {
      out[i] = null;
      continue;
    }
    const window: number[] = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(f0s.length - 1, i + radius); j++) {
      const v = f0s[j];
      if (v !== null && v !== undefined) window.push(v);
    }
    out[i] = median(window);
  }
  return out;
}

/** Run raw per-frame pitch detection with no smoothing/correction. Exposed
 * separately so tests can inspect the detector in isolation. */
export function trackPitchRaw(signal: Float32Array | Float64Array, options: PitchTrackOptions): PitchFrame[] {
  const opts = { ...DEFAULTS, ...options };
  const { sampleRate, algorithm, minFrequency, maxFrequency, hopSeconds, silenceRms } = opts;

  const maxLag = Math.floor(sampleRate / minFrequency);
  const frameSize = maxLag * 2;
  const hopSize = Math.max(1, Math.round(hopSeconds * sampleRate));

  const frames: PitchFrame[] = [];
  if (signal.length < frameSize) return frames;

  const numFrames = Math.floor((signal.length - frameSize) / hopSize) + 1;
  for (let i = 0; i < numFrames; i++) {
    const start = i * hopSize;
    const slice = new Float64Array(frameSize);
    for (let k = 0; k < frameSize; k++) slice[k] = signal[start + k]!;

    const amplitude = rms(slice);
    const time = (start + frameSize / 2) / sampleRate;

    if (amplitude < silenceRms) {
      frames.push({ time, f0: null, confidence: 0, voiced: false, rms: amplitude });
      continue;
    }

    if (algorithm === "mpm") {
      const result = mpmDetect(slice, {
        sampleRate,
        minFrequency,
        maxFrequency,
        clarityThreshold: opts.mpmClarityThreshold,
      });
      const voiced = result.f0 !== null && result.confidence >= MPM_VOICING_CONFIDENCE;
      frames.push({ time, f0: voiced ? result.f0 : null, confidence: result.confidence, voiced, rms: amplitude });
    } else {
      const result = yinDetect(slice, {
        sampleRate,
        minFrequency,
        maxFrequency,
        threshold: opts.yinThreshold,
      });
      const voiced = result.f0 !== null && result.confidence >= YIN_VOICING_CONFIDENCE;
      frames.push({ time, f0: voiced ? result.f0 : null, confidence: result.confidence, voiced, rms: amplitude });
    }
  }
  return frames;
}

/** Full pipeline: per-frame detection, octave-error correction, median
 * smoothing, and semitone normalization relative to the contour's own voiced
 * median F0 (see README "Why semitones" for the rationale). */
export function trackPitch(signal: Float32Array | Float64Array, options: PitchTrackOptions): PitchContour {
  const opts = { ...DEFAULTS, ...options };
  const raw = trackPitchRaw(signal, opts);

  const maxLag = Math.floor(opts.sampleRate / opts.minFrequency);
  const frameSeconds = (maxLag * 2) / opts.sampleRate;

  let f0s: (number | null)[] = raw.map((f) => (f.voiced ? f.f0 : null));
  f0s = correctOctaveErrors(f0s);
  f0s = medianSmooth(f0s, opts.medianWindow);

  const voicedF0s = f0s.filter((v): v is number => v !== null);
  const medianF0 = voicedF0s.length > 0 ? median(voicedF0s) : null;

  const points: ContourPoint[] = raw.map((frame, i) => {
    const f0 = f0s[i]!;
    const voiced = f0 !== null;
    const semitone = voiced && medianF0 !== null ? 12 * Math.log2(f0 / medianF0) : null;
    return { time: frame.time, f0, semitone, voiced, confidence: frame.confidence };
  });

  return {
    points,
    medianF0,
    hopSeconds: opts.hopSeconds,
    frameSeconds,
    sampleRate: opts.sampleRate,
  };
}
