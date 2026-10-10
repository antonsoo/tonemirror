/**
 * Pitch-tracking accuracy metrics, following the conventions used in F0
 * estimation research (e.g. de Cheveigné & Kawahara 2002; the mir_eval
 * melody-extraction metrics): gross pitch error (GPE) rate - the fraction of
 * voiced frames whose estimate is off by more than a set tolerance (we use
 * 20% of the reference frequency by default) - and fine pitch mean
 * absolute error (MAE) in cents, measured only over the frames that are
 * *not* gross errors, so a handful of octave slips don't dominate the
 * headline error metric the way a plain average would.
 */

import type { PitchFrame } from "./types.js";

export interface AccuracyResult {
  /** Frames where the ground truth says voiced. */
  totalVoicedFrames: number;
  /** Of the voiced ground-truth frames, how many the tracker also called voiced. */
  voicingRecall: number;
  /** Of the frames the tracker called voiced, how many the ground truth says are actually voiced. */
  voicingPrecision: number;
  /** Fraction of jointly voiced frames beyond the configured error tolerance. */
  grossErrorRate: number;
  /** Mean absolute cents error over tracker-voiced, ground-truth-voiced frames that are NOT gross errors. */
  finePitchMaeCents: number;
}

export interface AccuracyOptions {
  /** Relative frequency error above which an error is gross. Default 0.2 (20%). */
  grossErrorFraction?: number;
  /** Explicit symmetric cents tolerance, instead of a relative frequency tolerance. */
  grossErrorCents?: number;
}

export function evaluateAccuracy(
  frames: PitchFrame[],
  trueF0AtTime: (t: number) => number | null,
  options: AccuracyOptions = {},
): AccuracyResult {
  const { grossErrorCents } = options;
  const grossErrorFraction = options.grossErrorFraction ?? 0.2;
  if (grossErrorCents !== undefined && options.grossErrorFraction !== undefined) {
    throw new RangeError("Choose a relative-frequency or a cents tolerance, not both.");
  }
  const tolerance = grossErrorCents ?? grossErrorFraction;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError("Pitch error tolerance must be finite and nonnegative.");

  let totalVoicedFrames = 0;
  let trackerVoicedFrames = 0;
  let bothVoiced = 0;
  let grossErrors = 0;
  let fineCentsSum = 0;
  let fineCount = 0;

  for (const frame of frames) {
    const trueF0 = trueF0AtTime(frame.time);
    const groundTruthVoiced = trueF0 !== null && trueF0 > 0;
    if (groundTruthVoiced) totalVoicedFrames++;
    if (frame.voiced && frame.f0 !== null) trackerVoicedFrames++;

    if (groundTruthVoiced && frame.voiced && frame.f0 !== null) {
      bothVoiced++;
      const cents = Math.abs(1200 * Math.log2(frame.f0 / trueF0));
      const gross = grossErrorCents === undefined
        ? Math.abs(frame.f0 - trueF0) > grossErrorFraction * trueF0
        : cents > grossErrorCents;
      if (gross) {
        grossErrors++;
      } else {
        fineCentsSum += cents;
        fineCount++;
      }
    }
  }

  return {
    totalVoicedFrames,
    voicingRecall: totalVoicedFrames > 0 ? bothVoiced / totalVoicedFrames : NaN,
    voicingPrecision: trackerVoicedFrames > 0 ? bothVoiced / trackerVoicedFrames : NaN,
    grossErrorRate: bothVoiced > 0 ? grossErrors / bothVoiced : NaN,
    finePitchMaeCents: fineCount > 0 ? fineCentsSum / fineCount : NaN,
  };
}
