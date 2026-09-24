/**
 * Generates the accuracy table pasted into README.md. Run with `npm run bench`.
 * Every number here comes from an actual run against synthetic signals with
 * known ground-truth F0 - see src/core/synth.ts and src/core/metrics.ts.
 */
import { trackPitchRaw } from "../src/core/pitchTrack.js";
import { evaluateAccuracy } from "../src/core/metrics.js";
import { synthesizeVoice } from "../src/core/synth.js";
import type { PitchAlgorithm } from "../src/core/types.js";

const sampleRate = 44100;

interface Condition {
  name: string;
  signal: Float32Array;
  trueF0AtTime: (t: number) => number | null;
}

function harmonicComplex(f0: number, seed: number, extra: Partial<Parameters<typeof synthesizeVoice>[0]> = {}) {
  return synthesizeVoice({ sampleRate, duration: 1.0, f0AtFraction: () => f0, seed, ...extra });
}

const conditions: Condition[] = [
  {
    name: "Pure tone, 220 Hz",
    signal: synthesizeVoice({ sampleRate, duration: 1.0, f0AtFraction: () => 220, numHarmonics: 1, formants: [], seed: 100 }),
    trueF0AtTime: () => 220,
  },
  {
    name: "Harmonic complex, 150 Hz, missing fundamental",
    signal: harmonicComplex(150, 101, { missingFundamental: true }),
    trueF0AtTime: () => 150,
  },
  {
    name: "Harmonic complex, 180 Hz + vibrato (5 Hz, +-50 cents)",
    signal: harmonicComplex(180, 102, { vibratoRateHz: 5, vibratoDepthCents: 50 }),
    trueF0AtTime: (t) => 180 * 2 ** ((50 * Math.sin(2 * Math.PI * 5 * t)) / 1200),
  },
  {
    name: "Linear glide, 150 -> 300 Hz over 1s",
    signal: synthesizeVoice({ sampleRate, duration: 1.0, f0AtFraction: (f) => 150 + 150 * f, seed: 103 }),
    trueF0AtTime: (t) => 150 + 150 * t,
  },
  {
    name: "Harmonic complex, 180 Hz, white noise SNR 20dB",
    signal: harmonicComplex(180, 104, { noiseSnrDb: 20 }),
    trueF0AtTime: () => 180,
  },
  {
    name: "Harmonic complex, 180 Hz, white noise SNR 10dB",
    signal: harmonicComplex(180, 105, { noiseSnrDb: 10 }),
    trueF0AtTime: () => 180,
  },
  {
    name: "Harmonic complex, 180 Hz, white noise SNR 0dB",
    signal: harmonicComplex(180, 106, { noiseSnrDb: 0 }),
    trueF0AtTime: () => 180,
  },
];

const algorithms: PitchAlgorithm[] = ["yin", "mpm"];

console.log(`Machine: ${process.platform} ${process.arch}, Node ${process.version}`);
console.log(`Sample rate: ${sampleRate} Hz, hop: 10ms, min/max F0 search: 60-1000 Hz\n`);
console.log("| Condition | Algorithm | Voicing recall | Gross error rate | Fine pitch MAE (cents) |");
console.log("|---|---|---:|---:|---:|");

for (const condition of conditions) {
  for (const algorithm of algorithms) {
    const frames = trackPitchRaw(condition.signal, { sampleRate, algorithm });
    const acc = evaluateAccuracy(frames, condition.trueF0AtTime);
    const fmt = (x: number): string => (Number.isNaN(x) ? "n/a" : x.toFixed(x < 1 ? 3 : 1));
    console.log(
      `| ${condition.name} | ${algorithm.toUpperCase()} | ${(acc.voicingRecall * 100).toFixed(1)}% | ${(acc.grossErrorRate * 100).toFixed(1)}% | ${fmt(acc.finePitchMaeCents)} |`,
    );
  }
}
