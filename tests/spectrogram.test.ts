import { describe, expect, it } from "vitest";
import { computeSpectrogram } from "../src/core/spectrogram.js";
import { synthesizePureTone } from "../src/core/synth.js";

describe("computeSpectrogram", () => {
  it("shows an energy ridge at the tone's frequency across all frames", () => {
    const sampleRate = 22050;
    const freq = 660;
    const signal = synthesizePureTone(freq, { sampleRate, duration: 0.5 });
    const spec = computeSpectrogram(signal, sampleRate, { fftSize: 1024, hopSize: 256 });
    expect(spec.frames.length).toBeGreaterThan(5);
    for (const frame of spec.frames) {
      const peakBin = frame.indexOf(Math.max(...frame));
      const peakFreq = peakBin * spec.freqStep;
      expect(Math.abs(peakFreq - freq)).toBeLessThan(spec.freqStep * 2 + 20);
    }
  });

  it("returns no frames for signals shorter than one FFT window", () => {
    const spec = computeSpectrogram(new Float32Array(100), 22050, { fftSize: 1024 });
    expect(spec.frames).toHaveLength(0);
  });
});
