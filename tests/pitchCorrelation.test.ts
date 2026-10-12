import { describe, expect, it } from "vitest";
import { differenceFunction, normalizedSquareDifference } from "../src/core/pitchCorrelation.js";

// The defining time-domain sums are independent of FFT packing, padding,
// normalization tables and cancellation guards in the production path.
function direct(frame: Float64Array, lag: number, maxLag: number): [number, number] {
  let difference = 0;
  let correlation = 0;
  let energy = 0;
  for (let j = 0; j < frame.length - lag; j++) {
    const a = frame[j]!;
    const b = frame[j + lag]!;
    correlation += a * b;
    energy += a * a + b * b;
    if (j < frame.length - maxLag) difference += (a - b) ** 2;
  }
  return [difference, energy === 0 ? 0 : 2 * correlation / energy];
}

describe("pitch correlations against the defining sums at every lag", () => {
  for (const [length, maxLag] of [[266, 133], [1024, 511], [1024, 512], [1600, 800], [3200, 1600], [1901, 711], [1200, 900]]) {
    for (const kind of ["noise", "harmonics", "flat", "offset", "impulses", "ramp"] as const) {
      it(`${kind}, length ${length}, max lag ${maxLag}`, () => {
        let seed = 42;
        const frame = Float64Array.from({ length: length! }, (_, j) => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          switch (kind) {
            case "noise": return seed / 2 ** 32 - 0.5;
            case "harmonics": return Math.sin(2 * Math.PI * j / 64) + 0.2 * Math.cos(2 * Math.PI * j / 32);
            case "flat": return 0.37;
            case "offset": return 1 + 1e-9 * Math.sin(j / 23);
            case "impulses": return j === 0 ? 0.3 : j === length! - 1 ? 0.7 : 0;
            case "ramp": return j / length!;
          }
        });
        const before = frame.slice();
        const d = differenceFunction(frame, maxLag!);
        const n = normalizedSquareDifference(frame, maxLag!);
        const scale = frame.reduce((sum, v) => sum + (v - frame[0]!) ** 2, 0);
        for (let lag = 0; lag <= maxLag!; lag++) {
          const [expectedD, expectedN] = direct(frame, lag, maxLag!);
          expect(Math.abs(d[lag]! - expectedD)).toBeLessThanOrEqual(2e-12 * scale);
          expect(Math.abs(n[lag]! - expectedN)).toBeLessThanOrEqual(2e-12);
        }
        expect(frame).toEqual(before);
      });
    }
  }

  it("preserves exact silence, repetition, and isolated impulse zero crossings", () => {
    const silence = new Float64Array(1600);
    expect(differenceFunction(silence, 800).every(v => v === 0)).toBe(true);
    expect(normalizedSquareDifference(silence, 800).every(v => v === 0)).toBe(true);
    const periodic = Float64Array.from({ length: 1600 }, (_, j) => j % 16 / 16);
    const differences = differenceFunction(periodic, 800);
    for (let lag = 16; lag <= 800; lag += 16) expect(differences[lag]).toBe(0);
    const impulse = silence.slice();
    impulse[799] = 1;
    expect(normalizedSquareDifference(impulse, 800).slice(1).every(v => v === 0)).toBe(true);
  });

  it("keeps a large excluded middle sample from swamping short tail windows", () => {
    const frame = Float64Array.from({ length: 1200 }, (_, j) => 1e-12 * Math.sin(j));
    frame[600] = 1;
    const nsdf = normalizedSquareDifference(frame, 900);
    for (let lag = 601; lag <= 900; lag++) expect(nsdf[lag]).toBe(direct(frame, lag, 900)[1]);
  });
});
