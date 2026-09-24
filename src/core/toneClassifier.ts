/**
 * Heuristic classifier for the four citation tones of Standard Mandarin, plus
 * the (context-dependent) neutral tone, applied to a single syllable's
 * semitone contour.
 *
 * This is a rule-based shape classifier, not a trained model. It uses the
 * canonical tone shapes from Yuen Ren Chao's five-point pitch scale
 * ("A system of 'tone-letters'," Le Maître Phonétique, 45, 24-27, 1930):
 * tone 1 = 55 (high level), tone 2 = 35 (mid-rising), tone 3 = 214
 * (low, dipping), tone 4 = 51 (high-falling). It only looks at the
 * *relative shape* of the contour within the syllable (flat / rising /
 * dipping / falling, plus how monotonic and how large the excursion is) -
 * it does not know the syllable's absolute register, so it cannot by itself
 * distinguish "consistently high" from "consistently low" citation forms;
 * see the README's classifier limitations section.
 */

export type MandarinTone = 1 | 2 | 3 | 4 | "neutral";

export interface ToneSample {
  time: number;
  semitone: number;
}

export interface ToneClassification {
  tone: MandarinTone | null;
  label: string;
  confidence: number;
  reason: string;
}

const TONE_LABELS: Record<MandarinTone, string> = {
  1: "tone 1 (high level)",
  2: "tone 2 (rising)",
  3: "tone 3 (low/dipping)",
  4: "tone 4 (falling)",
  neutral: "neutral tone",
};

function resample(samples: ToneSample[], n: number): number[] {
  const t0 = samples[0]!.time;
  const t1 = samples[samples.length - 1]!.time;
  const duration = t1 - t0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const targetT = duration <= 0 ? t0 : t0 + (i / (n - 1)) * duration;
    // Find the bracketing pair and linearly interpolate.
    let lo = 0;
    while (lo < samples.length - 1 && samples[lo + 1]!.time < targetT) lo++;
    const a = samples[lo]!;
    const b = samples[Math.min(lo + 1, samples.length - 1)]!;
    if (b.time === a.time) {
      out.push(a.semitone);
    } else {
      const frac = (targetT - a.time) / (b.time - a.time);
      out.push(a.semitone + frac * (b.semitone - a.semitone));
    }
  }
  return out;
}

/** Pearson correlation between the resampled contour and a rising ramp
 * (index order); +1 = perfectly monotonic rising, -1 = perfectly falling. */
function monotonicity(values: number[]): number {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  const meanV = values.reduce((a, b) => a + b, 0) / n;
  const meanI = (n - 1) / 2;
  let cov = 0;
  let varV = 0;
  let varI = 0;
  for (let i = 0; i < n; i++) {
    const dv = values[i]! - meanV;
    const di = idx[i]! - meanI;
    cov += dv * di;
    varV += dv * dv;
    varI += di * di;
  }
  if (varV === 0 || varI === 0) return 0;
  return cov / Math.sqrt(varV * varI);
}

export function classifyMandarinTone(samples: ToneSample[]): ToneClassification {
  if (samples.length < 3) {
    return { tone: null, label: "not enough voiced signal", confidence: 0, reason: "fewer than 3 voiced frames" };
  }

  const duration = samples[samples.length - 1]!.time - samples[0]!.time;
  const N = 16;
  const shape = resample(samples, N);
  const min = Math.min(...shape);
  const max = Math.max(...shape);
  const range = max - min;
  const minIdx = shape.indexOf(min);
  const minFrac = minIdx / (N - 1);
  const start = shape[0]!;
  const end = shape[N - 1]!;
  const corr = monotonicity(shape);

  // Very short and very flat: likely an unstressed neutral-tone syllable
  // (its pitch is largely determined by the preceding tone in real speech,
  // so "flat and short" is the most we can say heuristically).
  if (duration < 0.15 && range < 2.0) {
    const confidence = Math.max(0, Math.min(1, 1 - duration / 0.15) * (1 - range / 2.0));
    return { tone: "neutral", label: TONE_LABELS.neutral, confidence, reason: "short duration and small pitch range" };
  }

  // Flat overall: tone 1.
  if (range < 1.5) {
    const confidence = Math.max(0, 1 - range / 1.5);
    return { tone: 1, label: TONE_LABELS[1], confidence, reason: `pitch range only ${range.toFixed(1)} semitones` };
  }

  // Dip in the middle with both ends above the minimum: tone 3.
  const dipDepthStart = start - min;
  const dipDepthEnd = end - min;
  if (minFrac > 0.2 && minFrac < 0.8 && dipDepthStart > 0.3 * range && dipDepthEnd > 0.15 * range) {
    const confidence = Math.max(0, Math.min(1, (dipDepthStart + dipDepthEnd) / (2 * range)));
    return { tone: 3, label: TONE_LABELS[3], confidence, reason: `dips to its minimum ${(minFrac * 100).toFixed(0)}% through the syllable` };
  }

  // Monotonic rise: tone 2. Monotonic fall: tone 4.
  if (corr > 0) {
    return { tone: 2, label: TONE_LABELS[2], confidence: Math.max(0, Math.min(1, corr)), reason: `rising trend (r=${corr.toFixed(2)})` };
  }
  return { tone: 4, label: TONE_LABELS[4], confidence: Math.max(0, Math.min(1, -corr)), reason: `falling trend (r=${corr.toFixed(2)})` };
}
