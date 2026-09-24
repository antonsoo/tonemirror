import { describe, expect, it } from "vitest";
import { classifyMandarinTone } from "../src/core/toneClassifier.js";
import { mandarinToneContour, ALL_MANDARIN_TONES } from "../src/core/mandarinTones.js";
import { sampleControlPoints } from "../src/core/accentTemplates.js";

/** Build a syllable-shaped sample sequence from a tone's control-point
 * contour, optionally with small additive noise to check robustness. */
function syllableSamples(tone: (typeof ALL_MANDARIN_TONES)[number], duration: number, noise = 0, n = 24) {
  const shape = sampleControlPoints(mandarinToneContour(tone), n);
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  return shape.map((semitone, i) => ({ time: (i / (n - 1)) * duration, semitone: semitone + rand() * noise }));
}

describe("classifyMandarinTone", () => {
  it("labels tone 1 (high level) correctly", () => {
    const result = classifyMandarinTone(syllableSamples(1, 0.35));
    expect(result.tone).toBe(1);
  });

  it("labels tone 2 (rising) correctly", () => {
    const result = classifyMandarinTone(syllableSamples(2, 0.35));
    expect(result.tone).toBe(2);
  });

  it("labels tone 3 (dipping) correctly", () => {
    const result = classifyMandarinTone(syllableSamples(3, 0.35));
    expect(result.tone).toBe(3);
  });

  it("labels tone 4 (falling) correctly", () => {
    const result = classifyMandarinTone(syllableSamples(4, 0.35));
    expect(result.tone).toBe(4);
  });

  it("labels a short, flat syllable as neutral", () => {
    const result = classifyMandarinTone(syllableSamples("neutral", 0.1));
    expect(result.tone).toBe("neutral");
  });

  it("stays correct on the four full tones under mild noise", () => {
    for (const tone of [1, 2, 3, 4] as const) {
      const result = classifyMandarinTone(syllableSamples(tone, 0.35, 0.4));
      expect(result.tone).toBe(tone);
    }
  });

  it("returns confidence in [0, 1] for every tone", () => {
    for (const tone of ALL_MANDARIN_TONES) {
      const duration = tone === "neutral" ? 0.1 : 0.35;
      const result = classifyMandarinTone(syllableSamples(tone, duration));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("reports insufficient data for very short input", () => {
    const result = classifyMandarinTone([{ time: 0, semitone: 0 }]);
    expect(result.tone).toBeNull();
  });
});
