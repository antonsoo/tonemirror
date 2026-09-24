/**
 * McLeod Pitch Method (MPM) fundamental frequency estimator.
 *
 * Implements the algorithm of:
 *   P. McLeod and G. Wyvill, "A Smarter Way to Find Pitch," Proceedings of
 *   the International Computer Music Conference (ICMC), 2005, pp. 138-141.
 *
 * MPM normalizes the autocorrelation function by the energy of the two
 * windows being compared (the Normalized Square Difference Function, NSDF)
 * instead of YIN's cumulative-mean normalization, then picks the first "key
 * maximum" that clears a fraction `k` of the strongest maximum - a rule
 * specifically designed to prefer the true fundamental over its octave
 * duplicates in the NSDF. This app offers it as an alternative to YIN so the
 * two independent methods can be cross-checked (see accuracy table in the
 * README).
 */

export interface MpmResult {
  f0: number | null;
  /** Clarity of the chosen peak (NSDF value in ~[0, 1]); higher = more periodic. */
  confidence: number;
}

export interface MpmConfig {
  sampleRate: number;
  minFrequency: number;
  maxFrequency: number;
  /** Fraction of the global peak a key maximum must reach to be chosen. Paper suggests 0.8-0.99. */
  clarityThreshold: number;
}

/** Normalized square difference function, n(tau) for tau in [0, maxLag]. */
function nsdf(frame: Float64Array, maxLag: number): Float64Array {
  const n = new Float64Array(maxLag + 1);
  const len = frame.length;
  for (let tau = 0; tau <= maxLag; tau++) {
    let acf = 0;
    let energy = 0;
    const limit = len - tau;
    for (let j = 0; j < limit; j++) {
      const a = frame[j]!;
      const b = frame[j + tau]!;
      acf += a * b;
      energy += a * a + b * b;
    }
    n[tau] = energy === 0 ? 0 : (2 * acf) / energy;
  }
  return n;
}

interface KeyMax {
  tau: number;
  value: number;
}

/** Key maxima: the largest value of n(tau) within each positive lobe (between
 * a positive-going and the next negative-going zero crossing). */
function findKeyMaxima(n: Float64Array): KeyMax[] {
  const maxima: KeyMax[] = [];
  let inPositiveLobe = false;
  let bestTau = -1;
  let bestValue = -Infinity;
  for (let tau = 1; tau < n.length; tau++) {
    const prev = n[tau - 1]!;
    const cur = n[tau]!;
    if (prev <= 0 && cur > 0) {
      inPositiveLobe = true;
      bestTau = -1;
      bestValue = -Infinity;
    }
    if (inPositiveLobe) {
      if (cur > bestValue) {
        bestValue = cur;
        bestTau = tau;
      }
      if (prev > 0 && cur <= 0) {
        if (bestTau > 0) maxima.push({ tau: bestTau, value: bestValue });
        inPositiveLobe = false;
      }
    }
  }
  if (inPositiveLobe && bestTau > 0) maxima.push({ tau: bestTau, value: bestValue });
  return maxima;
}

function parabolicPeak(n: Float64Array, tau: number): { tau: number; value: number } {
  if (tau <= 0 || tau >= n.length - 1) return { tau, value: n[tau]! };
  const s0 = n[tau - 1]!;
  const s1 = n[tau]!;
  const s2 = n[tau + 1]!;
  const denom = 2 * (2 * s1 - s2 - s0);
  if (Math.abs(denom) < 1e-12) return { tau, value: s1 };
  const shift = (s2 - s0) / denom;
  if (shift <= -1 || shift >= 1) return { tau, value: s1 };
  const interpolatedValue = s1 - 0.25 * (s0 - s2) * shift;
  return { tau: tau + shift, value: interpolatedValue };
}

export function mpmDetect(frame: Float64Array, config: MpmConfig): MpmResult {
  const { sampleRate, minFrequency, maxFrequency, clarityThreshold } = config;
  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / minFrequency));
  if (maxLag <= minLag) return { f0: null, confidence: 0 };

  const n = nsdf(frame, maxLag);
  const maxima = findKeyMaxima(n).filter((m) => m.tau >= minLag);
  if (maxima.length === 0) return { f0: null, confidence: 0 };

  const globalMax = Math.max(...maxima.map((m) => m.value));
  if (globalMax <= 0) return { f0: null, confidence: 0 };

  const threshold = clarityThreshold * globalMax;
  const chosen = maxima.find((m) => m.value >= threshold) ?? maxima[0]!;

  const { tau: refinedTau, value } = parabolicPeak(n, chosen.tau);
  if (refinedTau <= 0) return { f0: null, confidence: 0 };

  return {
    f0: sampleRate / refinedTau,
    confidence: Math.max(0, Math.min(1, value)),
  };
}
