/**
 * Synthetic voiced-signal generator, used for (a) the built-in "synthetic
 * reference" library the app ships with (Mandarin tones, Greek/Japanese
 * accent templates), clearly labeled synthetic in the UI, and (b) test
 * fixtures with exactly known F0 (pure tones, harmonic complexes with a
 * missing fundamental, vibrato, glides, additive noise).
 *
 * The voice model is simple additive/harmonic synthesis: a bank of sine
 * partials at integer multiples of an instantaneous F0(t), each partial's
 * amplitude shaped by a 1/k glottal-ish rolloff and a handful of fixed
 * resonance bumps standing in for a vowel's formants. It is intentionally
 * not a full source-filter vocoder - just enough spectral structure that
 * pitch trackers see something closer to a voice than a pure tone, and that
 * a "missing fundamental" case (h1 removed) is a meaningful test.
 */

import type { ControlPoint } from "./accentTemplates.js";
import { evalControlPoints } from "./accentTemplates.js";

export interface FormantSpec {
  frequency: number;
  bandwidth: number;
  gain: number;
}

/** A generic, vowel-agnostic formant layout (roughly schwa-like) used when
 * the caller doesn't specify one - just enough spectral tilt variation to be
 * non-trivial for the pitch tracker and spectrogram. */
export const DEFAULT_FORMANTS: FormantSpec[] = [
  { frequency: 500, bandwidth: 80, gain: 1.0 },
  { frequency: 1500, bandwidth: 100, gain: 0.6 },
  { frequency: 2500, bandwidth: 120, gain: 0.35 },
];

export interface SynthOptions {
  sampleRate: number;
  duration: number;
  /** Instantaneous F0 in Hz as a function of normalized time [0, 1]. */
  f0AtFraction: (fraction: number) => number;
  numHarmonics?: number;
  /** Drop the fundamental partial (h1) - tests the tracker's ability to
   * recover F0 from harmonics 2..N alone. */
  missingFundamental?: boolean;
  formants?: FormantSpec[];
  vibratoRateHz?: number;
  vibratoDepthCents?: number;
  /** Random walk jitter applied to instantaneous F0, in cents (std dev per second). */
  jitterCents?: number;
  /** If set, adds white noise so the mixed signal has this SNR in dB. */
  noiseSnrDb?: number;
  amplitude?: number;
  /** Deterministic seed for jitter/noise so tests are reproducible. */
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formantGain(freq: number, formants: FormantSpec[]): number {
  let gain = 1;
  for (const f of formants) {
    gain += f.gain / (1 + ((freq - f.frequency) / f.bandwidth) ** 2);
  }
  return gain;
}

/** Raised-cosine (Hann-style) fade in/out to avoid clicks at the edges. */
function edgeFade(i: number, n: number, fadeSamples: number): number {
  if (i < fadeSamples) return 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
  if (i >= n - fadeSamples) return 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fadeSamples);
  return 1;
}

export function synthesizeVoice(opts: SynthOptions): Float32Array {
  const {
    sampleRate,
    duration,
    f0AtFraction,
    numHarmonics = 20,
    missingFundamental = false,
    formants = DEFAULT_FORMANTS,
    vibratoRateHz = 0,
    vibratoDepthCents = 0,
    jitterCents = 0,
    noiseSnrDb,
    amplitude = 0.3,
    seed = 1,
  } = opts;

  const n = Math.max(1, Math.round(duration * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  const nyquist = sampleRate / 2;
  const fadeSamples = Math.min(Math.floor(0.01 * sampleRate), Math.floor(n / 4) || 1);

  // Integrate instantaneous fundamental phase once; harmonic k's phase is
  // just k times the fundamental's phase, since freq_k(t) = k * f0(t).
  const fundPhase = new Float64Array(n);
  let phase = 0;
  let jitterState = 0;
  const jitterStep = jitterCents > 0 ? jitterCents / Math.sqrt(sampleRate) : 0;
  for (let i = 0; i < n; i++) {
    const fraction = n === 1 ? 0 : i / (n - 1);
    let f0 = f0AtFraction(fraction);
    if (vibratoDepthCents > 0 && vibratoRateHz > 0) {
      const t = i / sampleRate;
      const vibCents = vibratoDepthCents * Math.sin(2 * Math.PI * vibratoRateHz * t);
      f0 *= 2 ** (vibCents / 1200);
    }
    if (jitterStep > 0) {
      jitterState += (rand() * 2 - 1) * jitterStep;
      jitterState *= 0.995; // gentle mean reversion so it doesn't wander unboundedly
      f0 *= 2 ** (jitterState / 1200);
    }
    phase += (2 * Math.PI * f0) / sampleRate;
    fundPhase[i] = phase;
  }

  const startK = missingFundamental ? 2 : 1;
  for (let k = startK; k <= numHarmonics; k++) {
    // Skip once the harmonic would alias past Nyquist for any part of the contour.
    let maxF0 = 0;
    for (let i = 0; i <= 10; i++) maxF0 = Math.max(maxF0, f0AtFraction(i / 10));
    if (k * maxF0 * 1.2 > nyquist) break;

    const rolloff = 1 / k; // ~ -6dB/octave glottal-ish spectral tilt
    for (let i = 0; i < n; i++) {
      // Instantaneous fundamental frequency from the local phase slope; this
      // harmonic's frequency is k times that.
      const prev = fundPhase[Math.max(i - 1, 0)]!;
      const next = fundPhase[Math.min(i + 1, n - 1)]!;
      const span = Math.min(i + 1, n - 1) - Math.max(i - 1, 0);
      const instFreqFund = span > 0 ? ((next - prev) * sampleRate) / (2 * Math.PI * span) : 0;
      const gain = rolloff * formantGain(k * instFreqFund, formants);
      out[i]! += gain * Math.sin(k * fundPhase[i]!);
    }
  }

  // Normalize to target peak amplitude, then apply edge fade.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const norm = peak > 0 ? amplitude / peak : 0;
  for (let i = 0; i < n; i++) out[i]! *= norm * edgeFade(i, n, fadeSamples);

  if (noiseSnrDb !== undefined && Number.isFinite(noiseSnrDb)) {
    let signalPower = 0;
    for (let i = 0; i < n; i++) signalPower += out[i]! * out[i]!;
    signalPower /= n;
    const noisePower = signalPower / 10 ** (noiseSnrDb / 10);
    const noiseAmp = Math.sqrt(noisePower);
    for (let i = 0; i < n; i++) {
      out[i]! += (rand() * 2 - 1) * Math.sqrt(3) * noiseAmp; // uniform noise, same power as target
    }
  }

  return out;
}

/** Convenience: synthesize directly from a semitone control-point contour
 * (as used by the Mandarin tone and accent templates) plus a base F0. */
export function synthesizeFromContour(
  points: ControlPoint[],
  baseF0: number,
  opts: Omit<SynthOptions, "f0AtFraction">,
): Float32Array {
  return synthesizeVoice({
    ...opts,
    f0AtFraction: (fraction) => baseF0 * 2 ** (evalControlPoints(points, fraction) / 12),
  });
}

/** Pure sine tone at a fixed frequency - the simplest possible test/reference signal. */
export function synthesizePureTone(frequency: number, opts: Omit<SynthOptions, "f0AtFraction" | "formants">): Float32Array {
  return synthesizeVoice({ ...opts, f0AtFraction: () => frequency, formants: [], numHarmonics: 1 });
}
