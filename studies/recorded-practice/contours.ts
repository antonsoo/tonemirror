// npx tsx studies/recorded-practice/contours.ts OUTPUT.json
// Descriptive replay, not independent F0 or tone-classification ground truth.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { trackPitch } from "../../src/core/pitchTrack.js";
import { classifyMandarinTone } from "../../src/core/toneClassifier.js";

const manifest = JSON.parse(readFileSync(new URL("./source.json", import.meta.url), "utf8")) as {
  recording: { sha256: string };
  selections: { tone: number; syllable: string; start: number; end: number }[];
};
const original = new URL("../../src/references/FourMandarinTones.ogg", import.meta.url);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(readFileSync(original)), manifest.recording.sha256);
const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", original.pathname, "-f", "f32le", "-ac", "1", "-"], { maxBuffer: 4 * 1024 * 1024 });
assert.equal(decoded.status, 0, decoded.stderr.toString());
const view = new DataView(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength);
const pcm = new Float32Array(decoded.stdout.length / 4);
for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(i * 4, true);
const sampleRate = 44100;
const results = manifest.selections.flatMap(selection => (["yin", "mpm"] as const).map(algorithm => {
  const excerpt = pcm.slice(Math.floor(selection.start * sampleRate), Math.ceil(selection.end * sampleRate));
  const contour = trackPitch(excerpt, { sampleRate, algorithm });
  const samples = contour.points.filter(p => p.voiced && p.semitone !== null).map(p => ({ time: p.time, semitone: p.semitone! }));
  const frequencies = contour.points.filter(p => p.f0 !== null).map(p => p.f0!);
  return { ...selection, algorithm, samples: excerpt.length, frames: contour.points.length, voiced: frequencies.length,
    medianF0: contour.medianF0, frequencyRange: [Math.min(...frequencies), Math.max(...frequencies)], helper: classifyMandarinTone(samples) };
}));
const output = process.argv[2];
assert.ok(output, "Pass an output JSON path.");
writeFileSync(output, JSON.stringify({ sourceSha256: manifest.recording.sha256, node: process.version,
  ffmpeg: spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0],
  scope: "Original recording decoded by FFmpeg at its native 44100 Hz, channel average to mono. App pitch algorithms unchanged. Source tone labels are not independent F0 ground truth; helper strengths are not probabilities.",
  decoded: { sampleRate, samples: pcm.length, sha256: sha256(decoded.stdout) }, results }, null, 2) + "\n");
