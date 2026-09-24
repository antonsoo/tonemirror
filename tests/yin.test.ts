import { describe, expect, it } from "vitest";
import { yinDetect } from "../src/core/yin.js";

function pureToneFrame(freq: number, sampleRate: number, length: number, phase = 0): Float64Array {
  const frame = new Float64Array(length);
  for (let i = 0; i < length; i++) frame[i] = Math.sin(2 * Math.PI * freq * (i / sampleRate) + phase);
  return frame;
}

describe("yinDetect", () => {
  const sampleRate = 44100;
  const config = { sampleRate, minFrequency: 60, maxFrequency: 1000, threshold: 0.15 };

  it("recovers the frequency of a pure sine tone within 1 cent", () => {
    const freq = 220;
    const maxLag = Math.floor(sampleRate / config.minFrequency);
    const frame = pureToneFrame(freq, sampleRate, maxLag * 2);
    const result = yinDetect(frame, config);
    expect(result.f0).not.toBeNull();
    const cents = 1200 * Math.log2(result.f0! / freq);
    expect(Math.abs(cents)).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("recovers frequency across a range of voice-like pitches", () => {
    const maxLag = Math.floor(sampleRate / config.minFrequency);
    for (const freq of [80, 110, 165, 220, 330, 440]) {
      const frame = pureToneFrame(freq, sampleRate, maxLag * 2);
      const result = yinDetect(frame, config);
      expect(result.f0).not.toBeNull();
      const cents = Math.abs(1200 * Math.log2(result.f0! / freq));
      expect(cents).toBeLessThan(5);
    }
  });

  it("returns low confidence on white noise", () => {
    const maxLag = Math.floor(sampleRate / config.minFrequency);
    const frame = new Float64Array(maxLag * 2);
    let seed = 42;
    for (let i = 0; i < frame.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      frame[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const result = yinDetect(frame, config);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it("handles a harmonic complex missing its fundamental", () => {
    const f0 = 150;
    const maxLag = Math.floor(sampleRate / config.minFrequency);
    const frame = new Float64Array(maxLag * 2);
    for (let i = 0; i < frame.length; i++) {
      let sample = 0;
      for (let k = 2; k <= 6; k++) sample += (1 / k) * Math.sin((2 * Math.PI * k * f0 * i) / sampleRate);
      frame[i] = sample;
    }
    const result = yinDetect(frame, config);
    expect(result.f0).not.toBeNull();
    const cents = Math.abs(1200 * Math.log2(result.f0! / f0));
    expect(cents).toBeLessThan(15);
  });
});
