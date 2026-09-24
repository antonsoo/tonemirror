import { describe, expect, it } from "vitest";
import { synthesizeVoice, synthesizePureTone } from "../src/core/synth.js";
import { magnitudeSpectrum } from "../src/core/fft.js";

describe("synthesizeVoice", () => {
  const sampleRate = 22050;

  it("produces a signal whose spectral peak matches the requested pure-tone frequency", () => {
    const freq = 440;
    const signal = synthesizePureTone(freq, { sampleRate, duration: 0.5 });
    const mid = signal.subarray(Math.floor(signal.length / 4), Math.floor(signal.length / 4) + 2048);
    const mag = magnitudeSpectrum(mid);
    const n = (mag.length - 1) * 2;
    const peakBin = mag.indexOf(Math.max(...mag));
    const peakFreq = (peakBin * sampleRate) / n;
    expect(Math.abs(peakFreq - freq)).toBeLessThan(sampleRate / n + 5);
  });

  it("keeps peak amplitude at the requested level", () => {
    const signal = synthesizeVoice({ sampleRate, duration: 0.3, f0AtFraction: () => 150, amplitude: 0.5, seed: 9 });
    let peak = 0;
    for (const s of signal) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeCloseTo(0.5, 1);
  });

  it("fades in/out so the edges are near zero (no clicks)", () => {
    const signal = synthesizeVoice({ sampleRate, duration: 0.3, f0AtFraction: () => 150, seed: 10 });
    expect(Math.abs(signal[0]!)).toBeLessThan(0.01);
    expect(Math.abs(signal[signal.length - 1]!)).toBeLessThan(0.01);
  });

  it("adds noise close to the requested SNR", () => {
    const clean = synthesizeVoice({ sampleRate, duration: 0.5, f0AtFraction: () => 180, seed: 11 });
    const noisy = synthesizeVoice({ sampleRate, duration: 0.5, f0AtFraction: () => 180, noiseSnrDb: 6, seed: 11 });
    let signalPower = 0;
    let noisePower = 0;
    for (let i = 0; i < clean.length; i++) {
      signalPower += clean[i]! * clean[i]!;
      const noiseSample = noisy[i]! - clean[i]!;
      noisePower += noiseSample * noiseSample;
    }
    const measuredSnrDb = 10 * Math.log10(signalPower / noisePower);
    expect(measuredSnrDb).toBeGreaterThan(2);
    expect(measuredSnrDb).toBeLessThan(10);
  });
});
