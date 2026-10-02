import { describe, expect, it } from "vitest";
import { MAX_ALIGNED_SAMPLES, compareContours, dtwAlign, warpedOverlay, type DtwStep } from "../src/core/dtw.js";
import { trackPitch, trackPitchRaw } from "../src/core/pitchTrack.js";
import { computeSpectrogram } from "../src/core/spectrogram.js";
import { synthesizeVoice } from "../src/core/synth.js";
import type { PitchAlgorithm, PitchContour } from "../src/core/types.js";
import { waveformColumns } from "../src/ui/analysisView.js";

/** Small deterministic generator, so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The textbook formulation dtwAlign replaced: the whole cumulative-cost table, read back from the far corner. */
function dtwFullTable(a: number[], b: number[]): { path: DtwStep[]; totalCost: number } {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return { path: [], totalCost: 0 };
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  cost[0]![0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i]![j] = Math.abs(a[i - 1]! - b[j - 1]!) + Math.min(cost[i - 1]![j]!, cost[i]![j - 1]!, cost[i - 1]![j - 1]!);
    }
  }
  const path: DtwStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    path.push({ refIndex: i - 1, attemptIndex: j - 1 });
    const diag = cost[i - 1]![j - 1]!;
    const up = cost[i - 1]![j]!;
    const left = cost[i]![j - 1]!;
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up <= left) {
      i--;
    } else {
      j--;
    }
  }
  return { path: path.reverse(), totalCost: cost[n]![m]! };
}

function contourFromSemitones(semitones: number[], hop = 0.01): PitchContour {
  return {
    points: semitones.map((s, i) => ({ time: i * hop, f0: 150, semitone: s, voiced: true, confidence: 1 })),
    medianF0: 150,
    hopSeconds: hop,
    frameSeconds: 0.02,
    sampleRate: 22050,
  };
}

/** Phrases that rise, fall and bend around a drifting baseline, with a little jitter. */
function speechLikeSemitones(length: number, seed: number): number[] {
  const random = rng(seed);
  const out: number[] = [];
  let base = 0;
  while (out.length < length) {
    const phrase = 30 + Math.floor(random() * 170);
    const from = base + (random() - 0.5) * 6;
    const to = base + (random() - 0.5) * 6;
    const bend = (random() - 0.5) * 4;
    for (let i = 0; i < phrase && out.length < length; i++) {
      const t = i / phrase;
      out.push(from + (to - from) * t + bend * Math.sin(Math.PI * t) + (random() - 0.5) * 0.4);
    }
    base = (base + (random() - 0.5) * 1.5) * 0.9;
  }
  return out;
}

/** The same contour spoken at a wandering pace, each stretch off by up to `error` semitones. */
function imitation(reference: number[], seed: number, error: number): number[] {
  const random = rng(seed);
  const out: number[] = [];
  let position = 0;
  let speed = 1;
  let offset = 0;
  for (let k = 0; position < reference.length - 1; k++) {
    if (k % 80 === 0) {
      speed = 0.7 + random() * 0.7;
      offset = (random() - 0.5) * 2 * error;
    }
    const i = Math.floor(position);
    const f = position - i;
    out.push(reference[i]! * (1 - f) + reference[i + 1]! * f + offset + (random() - 0.5) * 0.4);
    position += speed;
  }
  return out;
}

describe("dtwAlign against the full cost table", () => {
  it("finds the same path and cost on random sequences, ties included", () => {
    const random = rng(20261001);
    for (let round = 0; round < 400; round++) {
      const n = 1 + Math.floor(random() * 40);
      const m = 1 + Math.floor(random() * 40);
      // Whole numbers from a small range half the time: many cells tie, which is where the two
      // could part ways if the recorded direction and the backtrack disagreed.
      const whole = round % 2 === 0;
      const value = (): number => (whole ? Math.floor(random() * 4) : (random() - 0.5) * 12);
      const a = Array.from({ length: n }, value);
      const b = Array.from({ length: m }, value);
      expect(dtwAlign(a, b), `round ${round}`).toEqual(dtwFullTable(a, b));
    }
  });

  it("finds the same path and cost on speech-like contours", () => {
    for (const seed of [1, 2, 3]) {
      const a = speechLikeSemitones(700, seed);
      const b = imitation(a, seed + 10, 3);
      expect(dtwAlign(a, b)).toEqual(dtwFullTable(a, b));
    }
  });
});

describe("compareContours on long recordings", () => {
  it("aligns every voiced sample of a contour at the limit", () => {
    const semitones = speechLikeSemitones(MAX_ALIGNED_SAMPLES, 5);
    const short = contourFromSemitones(semitones.slice(0, 400));
    const result = compareContours(contourFromSemitones(semitones), short);
    expect(result.reference).toHaveLength(MAX_ALIGNED_SAMPLES);
    expect(result.attempt).toHaveLength(400);
  });

  it("thins a longer contour, and still scores it close to the exact alignment", () => {
    // Three minutes of voiced speech each: the full table for these two is 2.4 GB of doubles.
    const reference = speechLikeSemitones(18_000, 11);
    const attempt = imitation(reference, 12, 3);
    const started = performance.now();
    const result = compareContours(contourFromSemitones(reference), contourFromSemitones(attempt));
    const elapsed = performance.now() - started;

    expect(result.reference).toHaveLength(MAX_ALIGNED_SAMPLES);
    expect(result.attempt.length).toBeLessThanOrEqual(MAX_ALIGNED_SAMPLES);
    expect(result.attempt.length).toBeGreaterThan(MAX_ALIGNED_SAMPLES / 2);
    // Every third sample, in order, keeping its own time.
    expect(result.reference[1]).toEqual({ time: 0.03, semitone: reference[3] });
    expect(elapsed).toBeLessThan(5_000);

    expect(result.path[0]).toEqual({ refIndex: 0, attemptIndex: 0 });
    expect(result.path[result.path.length - 1]).toEqual({ refIndex: result.reference.length - 1, attemptIndex: result.attempt.length - 1 });
    expect(warpedOverlay(result)).toHaveLength(result.reference.length);

    const exact = dtwAlign(reference, attempt);
    const exactScore = Math.round(100 * Math.exp(-exact.totalCost / exact.path.length / 2.8));
    expect(exactScore).toBeGreaterThan(60);
    expect(Math.abs(result.score - exactScore)).toBeLessThanOrEqual(4);
  });

  it("scores a long recording against itself as a match", () => {
    const contour = contourFromSemitones(speechLikeSemitones(20_000, 21));
    const result = compareContours(contour, contour);
    expect(result.score).toBe(100);
    expect(result.feedback).toEqual(["Shape and timing closely track the reference - nice work."]);
  });
});

describe("samples that are not numbers", () => {
  const sampleRate = 22050;
  // As doubles, so that one of the cases can hold a value whose square overflows.
  const clean = (): Float64Array => Float64Array.from(synthesizeVoice({ sampleRate, duration: 1.0, f0AtFraction: (frac) => 160 + 80 * frac, seed: 4 }));

  const damage: Array<[string, (signal: Float64Array) => void]> = [
    ["one NaN", (s) => void (s[9000] = NaN)],
    ["a run of NaN", (s) => s.fill(NaN, 8000, 8400)],
    ["+Infinity and -Infinity", (s) => void ((s[5000] = Infinity), (s[15000] = -Infinity))],
    // With YIN this one used to give a NaN pitch in a voiced frame, and so a NaN score.
    [
      "an infinite sample every 700, alternating in sign",
      (s) => {
        for (let i = 0; i < s.length; i += 700) s[i] = i % 1400 ? Infinity : -Infinity;
      },
    ],
    [
      "an infinite sample every 2000",
      (s) => {
        for (let i = 0; i < s.length; i += 2000) s[i] = Infinity;
      },
    ],
    ["all NaN", (s) => s.fill(NaN)],
    ["all Infinity", (s) => s.fill(Infinity)],
    ["a sample too large to square", (s) => void (s[9000] = 1e200)],
  ];

  for (const algorithm of ["yin", "mpm"] as PitchAlgorithm[]) {
    for (const [name, apply] of damage) {
      it(`${algorithm}: ${name} leaves a contour of numbers and nulls`, () => {
        const signal = clean();
        apply(signal);
        for (const frame of trackPitchRaw(signal, { sampleRate, algorithm })) {
          expect(Number.isFinite(frame.rms)).toBe(true);
          expect(Number.isFinite(frame.confidence)).toBe(true);
          expect(frame.f0 === null || Number.isFinite(frame.f0)).toBe(true);
        }
        const contour = trackPitch(signal, { sampleRate, algorithm });
        expect(contour.medianF0 === null || Number.isFinite(contour.medianF0)).toBe(true);
        for (const point of contour.points) {
          expect(Number.isFinite(point.confidence)).toBe(true);
          expect(point.f0 === null || Number.isFinite(point.f0)).toBe(true);
          expect(point.semitone === null || Number.isFinite(point.semitone)).toBe(true);
          expect(point.voiced).toBe(point.f0 !== null);
        }
        const result = compareContours(trackPitch(clean(), { sampleRate, algorithm }), contour);
        expect(Number.isFinite(result.score)).toBe(true);
        expect(Number.isFinite(result.totalCost)).toBe(true);
      });
    }

    it(`${algorithm}: frames clear of the damage are tracked as before`, () => {
      const signal = clean();
      const before = trackPitchRaw(signal, { sampleRate, algorithm });
      signal.fill(NaN, 8000, 8400);
      const after = trackPitchRaw(signal, { sampleRate, algorithm });
      expect(after).toHaveLength(before.length);
      const frameSize = Math.floor(sampleRate / 60) * 2;
      let untouched = 0;
      let silenced = 0;
      after.forEach((frame, i) => {
        const start = Math.round(frame.time * sampleRate - frameSize / 2);
        if (start + frameSize <= 8000 || start >= 8400) {
          expect(frame).toEqual(before[i]);
          untouched++;
        } else {
          expect(frame).toEqual({ time: frame.time, f0: null, confidence: 0, voiced: false, rms: 0 });
          silenced++;
        }
      });
      expect(untouched).toBeGreaterThan(50);
      expect(silenced).toBeGreaterThan(3);
    });
  }

  it("a contour carrying a NaN semitone is compared on its other samples", () => {
    const reference = contourFromSemitones([0, 1, 2, 3, 4, 5, 6]);
    const attempt = contourFromSemitones([0, 1, NaN, 3, Infinity, 5, 6]);
    const result = compareContours(reference, attempt);
    expect(result.attempt.map((s) => s.semitone)).toEqual([0, 1, 3, 5, 6]);
    expect(result.score).toBeGreaterThan(80);
  });

  it("the spectrogram draws such a frame as empty", () => {
    const signal = clean();
    signal.fill(NaN, 8000, 8400);
    signal[15000] = Infinity;
    signal[19000] = 1e200;
    const spec = computeSpectrogram(signal, sampleRate, { fftSize: 1024, hopSize: 256 });
    let atFloor = 0;
    for (const frame of spec.frames) {
      for (const value of frame) expect(Number.isFinite(value)).toBe(true);
      if (frame.every((value) => value === spec.floorDb)) atFloor++;
    }
    expect(atFloor).toBeGreaterThan(4);
    expect(atFloor).toBeLessThan(spec.frames.length / 2);
  });
});

describe("waveformColumns", () => {
  it("covers the clip to its last sample, whatever the width", () => {
    const pcm = new Float32Array(1000);
    pcm[0] = -0.5;
    pcm[999] = 0.75;
    for (const width of [1, 7, 300, 999, 1000]) {
      const columns = waveformColumns(pcm, width);
      expect(columns).toHaveLength(width * 2);
      expect(columns[0]).toBe(-0.5);
      expect(columns[width * 2 - 1]).toBe(0.75);
    }
  });

  it("spreads a clip shorter than the view across all of it", () => {
    const pcm = Float32Array.from([0.5, -0.5, 0.25]);
    const columns = waveformColumns(pcm, 9);
    // Sample k lands in the column where its share of the width ends: columns 2, 5 and 8.
    expect(Array.from(columns)).toEqual([0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, -0.5, -0.5, 0, 0, 0, 0, 0.25, 0.25]);
  });
});
