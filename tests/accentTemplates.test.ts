import { describe, expect, it } from "vitest";
import {
  greekAccentContour,
  japaneseAccentContour,
  sampleControlPoints,
} from "../src/core/accentTemplates.js";

describe("greekAccentContour", () => {
  it("acute rises monotonically", () => {
    const shape = sampleControlPoints(greekAccentContour("acute"), 10);
    for (let i = 1; i < shape.length; i++) expect(shape[i]!).toBeGreaterThanOrEqual(shape[i - 1]!);
    expect(shape[shape.length - 1]!).toBeGreaterThan(shape[0]!);
  });

  it("circumflex rises then falls, peaking near the middle", () => {
    const shape = sampleControlPoints(greekAccentContour("circumflex"), 11);
    const peakIdx = shape.indexOf(Math.max(...shape));
    expect(peakIdx).toBeGreaterThan(2);
    expect(peakIdx).toBeLessThan(8);
    expect(shape[0]!).toBeLessThan(shape[peakIdx]!);
    expect(shape[shape.length - 1]!).toBeLessThan(shape[peakIdx]!);
  });
});

describe("japaneseAccentContour", () => {
  it("heiban never drops after its rise (word + particle both stay high)", () => {
    const shape = japaneseAccentContour("heiban", 4);
    const min = Math.min(...shape.slice(1).map((p) => p.semitone));
    const max = Math.max(...shape.map((p) => p.semitone));
    expect(min).toBe(max); // flat-high after the first mora
  });

  it("atamadaka drops immediately after the first mora", () => {
    const shape = japaneseAccentContour("atamadaka", 4);
    expect(shape[0]!.semitone).toBeGreaterThan(shape[1]!.semitone);
    for (let i = 2; i < shape.length; i++) expect(shape[i]!.semitone).toBe(shape[1]!.semitone);
  });

  it("odaka only drops on the trailing particle, not within the word", () => {
    const moraCount = 3;
    const shape = japaneseAccentContour("odaka", moraCount);
    // shape[0..moraCount-1] is the word (moraCount entries); shape[moraCount] is the particle.
    for (let i = 1; i < moraCount; i++) expect(shape[i]!.semitone).toBe(shape[1]!.semitone);
    expect(shape[moraCount]!.semitone).toBeLessThan(shape[1]!.semitone);
  });

  it("nakadaka drops inside the word, distinct from atamadaka and odaka", () => {
    const shape = japaneseAccentContour("nakadaka", 4);
    const dropIndex = shape.findIndex((p, i) => i > 0 && p.semitone < shape[i - 1]!.semitone);
    expect(dropIndex).toBeGreaterThan(1); // later than atamadaka's drop-after-mora-1
    expect(dropIndex).toBeLessThan(shape.length - 1); // earlier than odaka's drop-on-particle
  });
});
