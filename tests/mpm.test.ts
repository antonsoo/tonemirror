import { describe, expect, it } from "vitest";
import { mpmDetect } from "../src/core/mpm.js";

function pureToneFrame(freq: number, sampleRate: number, length: number): Float64Array {
  const frame = new Float64Array(length);
  for (let i = 0; i < length; i++) frame[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return frame;
}

describe("mpmDetect", () => {
  const sampleRate = 44100;
  const config = { sampleRate, minFrequency: 60, maxFrequency: 1000, clarityThreshold: 0.93 };

  it("recovers the frequency of a pure sine tone within a few cents", () => {
    const freq = 220;
    const maxLag = Math.floor(sampleRate / config.minFrequency);
    const frame = pureToneFrame(freq, sampleRate, maxLag * 2);
    const result = mpmDetect(frame, config);
    expect(result.f0).not.toBeNull();
    const cents = Math.abs(1200 * Math.log2(result.f0! / freq));
    expect(cents).toBeLessThan(3);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("recovers frequency across a range of voice-like pitches", () => {
    const maxLag = Math.floor(sampleRate / config.minFrequency);
    for (const freq of [80, 110, 165, 220, 330, 440]) {
      const frame = pureToneFrame(freq, sampleRate, maxLag * 2);
      const result = mpmDetect(frame, config);
      expect(result.f0).not.toBeNull();
      const cents = Math.abs(1200 * Math.log2(result.f0! / freq));
      expect(cents).toBeLessThan(5);
    }
  });

  it("prefers the fundamental over an octave via the key-maximum rule", () => {
    // Two harmonics with the 2nd stronger than the 1st: naive ACF peak
    // picking could lock onto the octave; MPM's key-maximum threshold
    // should still choose the lag corresponding to f0.
    const f0 = 200;
    const sr = sampleRate;
    const maxLag = Math.floor(sr / config.minFrequency);
    const frame = new Float64Array(maxLag * 2);
    for (let i = 0; i < frame.length; i++) {
      frame[i] = 0.6 * Math.sin((2 * Math.PI * f0 * i) / sr) + Math.sin((2 * Math.PI * 2 * f0 * i) / sr);
    }
    const result = mpmDetect(frame, config);
    expect(result.f0).not.toBeNull();
    const cents = Math.abs(1200 * Math.log2(result.f0! / f0));
    expect(cents).toBeLessThan(20);
  });
});
