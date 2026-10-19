import { describe, expect, it } from "vitest";
import { compareContours, MAX_ALIGNED_SAMPLES, toDtwSamples, warpedOverlay } from "../src/core/dtw.js";
import type { PitchContour } from "../src/core/types.js";

function contour(points: [number, number | null][]): PitchContour {
  return {
    sampleRate: 1000, hopSeconds: 0.01, frameSeconds: 0.03, medianF0: 100,
    points: points.map(([time, semitone]) => ({
      time, semitone, voiced: semitone !== null,
      f0: semitone === null ? null : 100 * 2 ** (semitone / 12), confidence: 1,
    })),
  };
}

describe("voiced continuity in aligned drawings", () => {
  it("retains an explicit unvoiced frame even when it is shorter than the former display threshold", () => {
    const voice = contour([[0, 0], [0.01, 1], [0.02, null], [0.03, 2], [0.04, 3]]);
    const result = compareContours(voice, voice);
    expect(result.score).toBe(100);
    expect(result.totalCost).toBe(0);
    expect(warpedOverlay(result)).toEqual([
      { t: 0, referenceSemitone: 0, attemptSemitone: 0 },
      { t: 0.25, referenceSemitone: 1, attemptSemitone: 1 },
      { t: 0.75, referenceSemitone: 2, attemptSemitone: 2, breakBefore: true },
      { t: 1, referenceSemitone: 3, attemptSemitone: 3 },
    ]);
  });

  it("breaks on a reference gap even when the attempt is continuously voiced", () => {
    const reference = contour([[0, 0], [0.01, 1], [0.5, 2], [0.51, 3]]);
    const attempt = contour([[0, 0], [0.01, 1], [0.02, 2], [0.03, 3]]);
    const result = compareContours(reference, attempt);
    expect(result.score).toBe(100);
    expect(warpedOverlay(result).map(p => p.breakBefore ?? false)).toEqual([false, false, true, false]);
  });

  it("does not average distinct attempt runs together when DTW maps them to the same reference instant", () => {
    const reference = contour([[0, 0], [0.01, 10]]);
    const attempt = contour([[0, -0.1], [0.01, 0.1], [0.8, 0.2], [0.81, 10]]);
    const result = compareContours(reference, attempt);
    expect(result.path).toEqual([
      { refIndex: 0, attemptIndex: 0 }, { refIndex: 0, attemptIndex: 1 },
      { refIndex: 0, attemptIndex: 2 }, { refIndex: 1, attemptIndex: 3 },
    ]);
    expect(warpedOverlay(result)).toEqual([
      { t: 0, referenceSemitone: 0, attemptSemitone: 0 },
      { t: 0, referenceSemitone: 0, attemptSemitone: 0.2, breakBefore: true },
      { t: 1, referenceSemitone: 10, attemptSemitone: 10 },
    ]);
    expect(result.totalCost).toBe(0.4);
  });

  it("preserves gaps skipped by the core API's bounded sampling", () => {
    const points: [number, number | null][] = Array.from({ length: 20_000 }, (_, i) => [i * 0.01, i === 2 ? null : 0]);
    const result = compareContours(contour(points), contour([[0, 0], [0.01, 0]]));
    expect(result.reference).toHaveLength(MAX_ALIGNED_SAMPLES);
    expect(result.reference[1]?.breakBefore).toBe(true);
    expect(warpedOverlay(result).filter(p => p.breakBefore)).toHaveLength(1);
    expect(result.score).toBe(100);
  });

  it("treats a skipped nonfinite observation as a gap and respects sample-quantized hops", () => {
    expect(toDtwSamples(contour([[0, 0], [0.01, NaN], [0.02, 1]]))[1]?.breakBefore).toBe(true);
    const dense = contour([[0, 0], [1 / 8000, 1], [2 / 8000, 2]]);
    dense.sampleRate = 8000;
    dense.hopSeconds = 0.000001;
    expect(toDtwSamples(dense).some(p => p.breakBefore)).toBe(false);
  });
});
