/**
 * YIN fundamental frequency estimator.
 *
 * Implements the algorithm of:
 *   A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator
 *   for speech and music," Journal of the Acoustical Society of America,
 *   vol. 111, no. 4, pp. 1917-1930, 2002. https://doi.org/10.1121/1.1458024
 *
 * Steps 1-5 of the paper:
 *   1. Difference function d(tau).
 *   2. Cumulative mean normalized difference function d'(tau).
 *   3. Absolute threshold: smallest tau with d'(tau) below a threshold,
 *      refined to the local minimum.
 *   4. (Best local estimate over neighboring windows is not implemented;
 *      we rely on frame-to-frame median smoothing and octave correction
 *      in pitchTrack.ts instead, which is simpler and works well for the
 *      ~10ms hops used here.)
 *   5. Parabolic interpolation for sub-sample lag precision.
 *
 * The implementation favors clarity over raw speed: the difference function
 * is computed directly (O(W^2) per frame). For the frame sizes used in this
 * app (a few hundred samples of lag search) this comfortably keeps up with
 * real-time analysis in a Worker.
 */

export interface YinResult {
  /** Estimated F0 in Hz, or null if no candidate lag was found at all. */
  f0: number | null;
  /** 1 - d'(tau) at the chosen lag; higher means more periodic. */
  confidence: number;
}

export interface YinConfig {
  sampleRate: number;
  minFrequency: number;
  maxFrequency: number;
  /** Absolute threshold for step 3, typically 0.10-0.20. */
  threshold: number;
}

/** Step 1: difference function, d(tau) for tau in [0, maxLag]. */
function differenceFunction(frame: Float64Array, maxLag: number): Float64Array {
  const w = frame.length - maxLag;
  const d = new Float64Array(maxLag + 1);
  for (let tau = 0; tau <= maxLag; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const delta = frame[j]! - frame[j + tau]!;
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  return d;
}

/** Step 2: cumulative mean normalized difference function, d'(tau). */
function cumulativeMeanNormalizedDifference(d: Float64Array): Float64Array {
  const n = d.length;
  const dp = new Float64Array(n);
  dp[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < n; tau++) {
    runningSum += d[tau]!;
    dp[tau] = runningSum === 0 ? 1 : (d[tau]! * tau) / runningSum;
  }
  return dp;
}

/** Step 5: parabolic interpolation around a candidate lag using its neighbors. */
function parabolicInterpolate(dp: Float64Array, tau: number): number {
  const n = dp.length;
  if (tau <= 0 || tau >= n - 1) return tau;
  const s0 = dp[tau - 1]!;
  const s1 = dp[tau]!;
  const s2 = dp[tau + 1]!;
  const denom = 2 * (2 * s1 - s2 - s0);
  if (Math.abs(denom) < 1e-12) return tau;
  const shift = (s2 - s0) / denom;
  // Guard against pathological interpolation escaping the neighbor bracket.
  if (shift <= -1 || shift >= 1) return tau;
  return tau + shift;
}

/**
 * Run YIN on a single frame (already extracted from the signal, no windowing
 * needed). `frame.length` must exceed the lag corresponding to `minFrequency`
 * by a comfortable margin (pitchTrack.ts sizes frames as ~2x the max lag).
 */
export function yinDetect(frame: Float64Array, config: YinConfig): YinResult {
  const { sampleRate, minFrequency, maxFrequency, threshold } = config;
  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / minFrequency));
  if (maxLag <= minLag) return { f0: null, confidence: 0 };

  const d = differenceFunction(frame, maxLag);
  const dp = cumulativeMeanNormalizedDifference(d);

  // Step 3: smallest tau >= minLag with dp(tau) < threshold, walked forward
  // to the local minimum. Falls back to the global minimum in [minLag, maxLag]
  // if nothing crosses the threshold (very inharmonic / noisy frame).
  let chosenTau = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (dp[tau]! < threshold) {
      let t = tau;
      while (t + 1 <= maxLag && dp[t + 1]! < dp[t]!) t++;
      chosenTau = t;
      break;
    }
  }

  if (chosenTau === -1) {
    let bestTau = minLag;
    let bestVal = dp[minLag]!;
    for (let tau = minLag + 1; tau <= maxLag; tau++) {
      if (dp[tau]! < bestVal) {
        bestVal = dp[tau]!;
        bestTau = tau;
      }
    }
    chosenTau = bestTau;
  }

  const interpolatedTau = parabolicInterpolate(dp, chosenTau);
  if (interpolatedTau <= 0) return { f0: null, confidence: 0 };

  const f0 = sampleRate / interpolatedTau;
  const confidence = Math.max(0, Math.min(1, 1 - dp[chosenTau]!));
  return { f0, confidence };
}
