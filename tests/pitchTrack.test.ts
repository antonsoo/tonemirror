import { describe, expect, it } from "vitest";
import { trackPitch, trackPitchRaw } from "../src/core/pitchTrack.js";
import { evaluateAccuracy } from "../src/core/metrics.js";
import { synthesizeVoice } from "../src/core/synth.js";

const sampleRate = 22050;

describe("trackPitch / trackPitchRaw", () => {
  it("tracks a steady harmonic complex accurately", () => {
    const f0 = 180;
    const signal = synthesizeVoice({ sampleRate, duration: 1.0, f0AtFraction: () => f0, seed: 1 });
    const frames = trackPitchRaw(signal, { sampleRate, algorithm: "yin" });
    const acc = evaluateAccuracy(frames, () => f0);
    expect(acc.voicingRecall).toBeGreaterThan(0.9);
    expect(acc.grossErrorRate).toBeLessThan(0.05);
    expect(acc.finePitchMaeCents).toBeLessThan(10);
  });

  it("tracks a linear glide (150Hz -> 300Hz)", () => {
    const start = 150;
    const end = 300;
    const signal = synthesizeVoice({
      sampleRate,
      duration: 1.0,
      f0AtFraction: (frac) => start + (end - start) * frac,
      seed: 2,
    });
    const frames = trackPitchRaw(signal, { sampleRate, algorithm: "yin", hopSeconds: 0.01 });
    const trueF0AtTime = (t: number): number => start + (end - start) * t; // duration = 1s
    const acc = evaluateAccuracy(frames, trueF0AtTime);
    expect(acc.grossErrorRate).toBeLessThan(0.1);
    expect(acc.finePitchMaeCents).toBeLessThan(40); // glides intrinsically blur YIN's window estimate
  });

  it("tracks a signal with vibrato", () => {
    const f0 = 200;
    const signal = synthesizeVoice({
      sampleRate,
      duration: 1.0,
      f0AtFraction: () => f0,
      vibratoRateHz: 5,
      vibratoDepthCents: 50,
      seed: 3,
    });
    const trueF0AtTime = (t: number): number => f0 * 2 ** ((50 * Math.sin(2 * Math.PI * 5 * t)) / 1200);
    const frames = trackPitchRaw(signal, { sampleRate, algorithm: "yin" });
    const acc = evaluateAccuracy(frames, trueF0AtTime);
    expect(acc.grossErrorRate).toBeLessThan(0.05);
    expect(acc.finePitchMaeCents).toBeLessThan(20);
  });

  it("degrades gracefully but stays usable under moderate noise (10dB SNR)", () => {
    const f0 = 180;
    const signal = synthesizeVoice({ sampleRate, duration: 1.0, f0AtFraction: () => f0, noiseSnrDb: 10, seed: 4 });
    const frames = trackPitchRaw(signal, { sampleRate, algorithm: "yin" });
    const acc = evaluateAccuracy(frames, () => f0);
    expect(acc.grossErrorRate).toBeLessThan(0.2);
  });

  it("full trackPitch pipeline produces a voiced-median-relative semitone contour that centers near zero", () => {
    const f0 = 220;
    const signal = synthesizeVoice({ sampleRate, duration: 0.5, f0AtFraction: () => f0, seed: 5 });
    const contour = trackPitch(signal, { sampleRate });
    expect(contour.medianF0).not.toBeNull();
    expect(Math.abs(contour.medianF0! - f0)).toBeLessThan(3);
    const voicedSemitones = contour.points.filter((p) => p.voiced).map((p) => p.semitone!);
    expect(voicedSemitones.length).toBeGreaterThan(0);
    const meanAbs = voicedSemitones.reduce((a, b) => a + Math.abs(b), 0) / voicedSemitones.length;
    expect(meanAbs).toBeLessThan(0.5); // steady tone -> contour should hug 0 semitones
  });

  it("returns an empty contour for a signal shorter than one analysis frame", () => {
    const frames = trackPitchRaw(new Float32Array(10), { sampleRate });
    expect(frames).toHaveLength(0);
  });

  it("marks silence as unvoiced", () => {
    const silence = new Float32Array(Math.round(sampleRate * 0.5));
    const frames = trackPitchRaw(silence, { sampleRate });
    expect(frames.every((f) => !f.voiced)).toBe(true);
  });
});
