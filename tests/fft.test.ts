import { describe, expect, it } from "vitest";
import { fft, isPowerOfTwo, magnitudeSpectrum, nextPowerOfTwo } from "../src/core/fft.js";

describe("nextPowerOfTwo / isPowerOfTwo", () => {
  it("rounds up to the next power of two", () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(1000)).toBe(1024);
    expect(nextPowerOfTwo(1024)).toBe(1024);
  });

  it("identifies powers of two", () => {
    expect(isPowerOfTwo(1024)).toBe(true);
    expect(isPowerOfTwo(1023)).toBe(false);
    expect(isPowerOfTwo(0)).toBe(false);
  });
});

describe("fft", () => {
  it("transforms a DC signal to energy only in bin 0", () => {
    const n = 16;
    const re = new Float64Array(n).fill(1);
    const im = new Float64Array(n);
    fft(re, im);
    expect(re[0]).toBeCloseTo(n, 6);
    for (let i = 1; i < n; i++) {
      expect(Math.hypot(re[i]!, im[i]!)).toBeCloseTo(0, 6);
    }
  });

  it("places a pure sine's energy in the expected bin", () => {
    const n = 64;
    const k = 5; // target bin
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
    fft(re, im);
    const magnitudes = Array.from({ length: n / 2 }, (_, i) => Math.hypot(re[i]!, im[i]!));
    const peakBin = magnitudes.indexOf(Math.max(...magnitudes));
    expect(peakBin).toBe(k);
  });

  it("round-trips signal -> fft -> inverse fft", () => {
    const n = 32;
    const original = new Float64Array(n);
    for (let i = 0; i < n; i++) original[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1);
    const re = Float64Array.from(original);
    const im = new Float64Array(n);
    fft(re, im, false);
    fft(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(original[i]!, 6);
      expect(im[i]).toBeCloseTo(0, 6);
    }
  });

  it("throws on non-power-of-two length", () => {
    expect(() => fft(new Float64Array(10), new Float64Array(10))).toThrow();
  });

  it("magnitudeSpectrum peaks near a sine's true frequency after zero-padding", () => {
    const sampleRate = 8000;
    const freq = 1000;
    const n = 100; // not a power of two, forces zero-padding
    const frame = new Float64Array(n);
    for (let i = 0; i < n; i++) frame[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    const mag = magnitudeSpectrum(frame);
    const paddedN = (mag.length - 1) * 2;
    const peakBin = mag.indexOf(Math.max(...mag));
    const peakFreq = (peakBin * sampleRate) / paddedN;
    expect(Math.abs(peakFreq - freq)).toBeLessThan(sampleRate / paddedN + 1);
  });
});
