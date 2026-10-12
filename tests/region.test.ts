import { describe, expect, it } from "vitest";
import { regionSamples } from "../src/audio/region.js";

describe("practice region sample boundaries", () => {
  it("covers fractional samples, retains the last sample and never extends the source", () => {
    expect(regionSamples(48000, 48000, 0.10001, 0.20001)).toEqual({ start: 4800, end: 9601 });
    expect(regionSamples(48001, 48000, 1, 48001 / 48000)).toEqual({ start: 48000, end: 48001 });
  });

  it.each([[NaN, 1], [0, Infinity], [-1, 1], [1, 1], [1, 0], [0, 2.01]])("rejects invalid region %s to %s", (start, end) => {
    expect(() => regionSamples(96000, 48000, start, end)).toThrow("within the clip");
  });
});
