import { describe, expect, it } from "vitest";
import { compareContours, dtwAlign, warpedOverlay } from "../src/core/dtw.js";
import type { PitchContour } from "../src/core/types.js";

describe("dtwAlign", () => {
  it("costs zero for identical sequences (diagonal path only)", () => {
    const { path, totalCost } = dtwAlign([1, 2, 3, 4], [1, 2, 3, 4]);
    expect(totalCost).toBe(0);
    expect(path).toEqual([
      { refIndex: 0, attemptIndex: 0 },
      { refIndex: 1, attemptIndex: 1 },
      { refIndex: 2, attemptIndex: 2 },
      { refIndex: 3, attemptIndex: 3 },
    ]);
  });

  it("warps a stretched-in-time copy to zero cost", () => {
    // b is a time-stretched version of a (each value repeated); DTW should
    // absorb the stretch with zero cost since the *values* still match.
    const { totalCost } = dtwAlign([0, 10], [0, 0, 10, 10]);
    expect(totalCost).toBe(0);
  });

  it("computes the exact cost for a simple two-point case by hand", () => {
    // Only one possible path (diagonal) for two equal-length sequences of
    // length 2: cost = |0-0| + |5-10| = 5.
    const { totalCost, path } = dtwAlign([0, 5], [0, 10]);
    expect(totalCost).toBe(5);
    expect(path).toHaveLength(2);
  });

  it("produces a monotonic path from (0,0) to (n-1,m-1)", () => {
    const { path } = dtwAlign([3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8]);
    expect(path[0]).toEqual({ refIndex: 0, attemptIndex: 0 });
    expect(path[path.length - 1]).toEqual({ refIndex: 7, attemptIndex: 5 });
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.refIndex).toBeGreaterThanOrEqual(path[i - 1]!.refIndex);
      expect(path[i]!.attemptIndex).toBeGreaterThanOrEqual(path[i - 1]!.attemptIndex);
    }
  });

  it("handles empty input without throwing", () => {
    expect(dtwAlign([], [1, 2])).toEqual({ path: [], totalCost: 0 });
  });
});

function contourFromSemitones(semitones: number[], hop = 0.01): PitchContour {
  return {
    points: semitones.map((s, i) => ({ time: i * hop, f0: 150, semitone: s, voiced: true, confidence: 1 })),
    medianF0: 150,
    hopSeconds: hop,
    frameSeconds: 0.02,
    sampleRate: 22050,
  };
}

describe("compareContours", () => {
  it("scores an identical contour as a near-perfect match", () => {
    const contour = contourFromSemitones([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]);
    const result = compareContours(contour, contour);
    expect(result.score).toBeGreaterThanOrEqual(99);
  });

  it("scores a strongly divergent contour much lower than a close one", () => {
    const rising = contourFromSemitones([0, 1, 2, 3, 4, 5, 6]);
    const closeMatch = contourFromSemitones([0.2, 1.1, 2.3, 2.9, 4.1, 4.8, 6.1]);
    const falling = contourFromSemitones([6, 5, 4, 3, 2, 1, 0]);
    const closeScore = compareContours(rising, closeMatch).score;
    const farScore = compareContours(rising, falling).score;
    expect(closeScore).toBeGreaterThan(farScore);
    expect(farScore).toBeLessThan(closeScore - 20);
  });

  it("flags a reversed direction in feedback", () => {
    const rising = contourFromSemitones(Array.from({ length: 30 }, (_, i) => (i / 29) * 8));
    const falling = contourFromSemitones(Array.from({ length: 30 }, (_, i) => 8 - (i / 29) * 8));
    const result = compareContours(rising, falling);
    expect(result.feedback.some((f) => f.toLowerCase().includes("opposite"))).toBe(true);
  });

  it("warpedOverlay maps the attempt onto the reference's timeline with matching values for identical contours", () => {
    const contour = contourFromSemitones([0, 2, 4, 6, 4, 2, 0]);
    const result = compareContours(contour, contour);
    const overlay = warpedOverlay(result);
    expect(overlay.length).toBeGreaterThan(0);
    for (const point of overlay) {
      expect(point.attemptSemitone).toBeCloseTo(point.referenceSemitone, 6);
      expect(point.t).toBeGreaterThanOrEqual(0);
      expect(point.t).toBeLessThanOrEqual(1);
    }
  });

  it("reports insufficient signal when a contour has no voiced frames", () => {
    const empty: PitchContour = {
      points: [{ time: 0, f0: null, semitone: null, voiced: false, confidence: 0 }],
      medianF0: null,
      hopSeconds: 0.01,
      frameSeconds: 0.02,
      sampleRate: 22050,
    };
    const result = compareContours(contourFromSemitones([0, 1, 2]), empty);
    expect(result.score).toBe(0);
    expect(result.feedback[0]).toMatch(/not enough voiced signal/i);
  });
});
