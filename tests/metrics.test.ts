import { describe, expect, it } from "vitest";
import { evaluateAccuracy } from "../src/core/metrics.js";
import type { PitchFrame } from "../src/core/types.js";

const frame = (f0: number): PitchFrame => ({ time: 0, f0, voiced: true, confidence: 1, rms: 0.5 });

describe("relative-frequency accuracy", () => {
  it.each([
    [79, 1], [80, 0], [82, 0], [100, 0], [118, 0], [120, 0], [121, 1],
  ])("compares %s Hz with the stated 20 percent interval [80, 120] Hz", (estimate, expected) => {
    const result = evaluateAccuracy([frame(estimate)], () => 100);
    expect(result.grossErrorRate).toBe(expected);
    if (expected === 0) expect(result.finePitchMaeCents).toBeCloseTo(Math.abs(1200 * Math.log2(estimate / 100)), 10);
  });

  it("keeps an explicitly requested symmetric cents measure", () => {
    expect(evaluateAccuracy([frame(82)], () => 100, { grossErrorCents: 1200 * Math.log2(1.2) }).grossErrorRate).toBe(1);
    expect(evaluateAccuracy([frame(82)], () => 100, { grossErrorFraction: 0.25 }).grossErrorRate).toBe(0);
  });

  it("rejects contradictory or invalid threshold options", () => {
    expect(() => evaluateAccuracy([], () => 100, { grossErrorCents: 100, grossErrorFraction: 0.2 })).toThrow(RangeError);
    for (const value of [-1, Infinity, NaN]) {
      expect(() => evaluateAccuracy([], () => 100, { grossErrorFraction: value })).toThrow(RangeError);
      expect(() => evaluateAccuracy([], () => 100, { grossErrorCents: value })).toThrow(RangeError);
    }
  });
});
