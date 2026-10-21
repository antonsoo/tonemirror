/** Native-rate replay of existing pitch methods at three explicit search floors.
 * Audio/reference bytes must first pass the existing offline source verifier.
 * Usage: tsx capture.ts SOURCE_ROOT OUTPUT_DIRECTORY [SHARD SHARDS]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PitchContour } from "../../src/core/types.js";

const [source, destination, shardText = "0", shardsText = "1"] = process.argv.slice(2);
if (!source || !destination) throw new Error("SOURCE_ROOT OUTPUT_DIRECTORY [SHARD SHARDS]");
const shard = Number(shardText), shards = Number(shardsText);
if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(shard) || shard < 0 || shard >= shards) throw new Error("Invalid shard selection.");
const root = resolve(source), out = resolve(destination);
const cache = resolve(import.meta.dirname, "../real-voice/cache");
const { trackPitch } = await import(pathToFileURL(join(root, "src/core/pitchTrack.ts")).href) as {
  trackPitch: (pcm: Float32Array, opts: { sampleRate: number; algorithm: "yin" | "mpm"; minFrequency?: number }) => PitchContour;
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function readPcm(file: string, raw: boolean) {
  const b = readFileSync(file);
  if (raw) return { sampleRate: 20000, pcm: Float32Array.from({ length: b.length / 2 }, (_, i) => b.readInt16BE(i * 2) / 32768), sha256: hash(b) };
  let sampleRate = 0;
  for (let p = 12; p + 8 <= b.length;) {
    const name = b.toString("ascii", p, p + 4), n = b.readUInt32LE(p + 4);
    if (name === "fmt ") {
      if (b.readUInt16LE(p + 8) !== 1 || b.readUInt16LE(p + 10) !== 1 || b.readUInt16LE(p + 22) !== 16) throw new Error("Expected native mono PCM16 WAV.");
      sampleRate = b.readUInt32LE(p + 12);
    }
    if (name === "data" && sampleRate) return { sampleRate,
      pcm: Float32Array.from({ length: n / 2 }, (_, i) => b.readInt16LE(p + 8 + 2 * i) / 32768), sha256: hash(b) };
    p += 8 + n + (n & 1);
  }
  throw new Error("Missing PCM data.");
}

const items: { corpus: "ptdb" | "fda"; speaker: string; id: string; file: string }[] = [];
for (const speaker of readdirSync(join(cache, "ptdb")).filter(s => /^[FM]\d\d$/.test(s)).sort()) {
  for (const file of readdirSync(join(cache, "ptdb", speaker)).filter(f => f.endsWith(".wav")).sort()) {
    items.push({ corpus: "ptdb", speaker, id: file.replace(/^mic_[FM]\d\d_|\.wav$/g, ""), file: join(cache, "ptdb", speaker, file) });
  }
}
for (const speaker of ["rl", "sb"]) for (const file of readdirSync(join(cache, "fda-extracted", speaker)).filter(f => f.endsWith(".sig")).sort()) {
  items.push({ corpus: "fda", speaker, id: file.replace(/\.sig$/, ""), file: join(cache, "fda-extracted", speaker, file) });
}
if (items.length !== 580) throw new Error(`Expected 580 pinned recordings; found ${items.length}.`);
mkdirSync(out, { recursive: true });
let done = 0;
const receipt = [];
for (const [index, item] of items.entries()) {
  if (index % shards !== shard) continue;
  const { pcm, sampleRate, sha256 } = readPcm(item.file, item.corpus === "fda");
  const settings = [];
  for (const algorithm of ["yin", "mpm"] as const) {
    for (const minFrequency of [40, 60, 90]) {
      const start = performance.now();
      const contour = trackPitch(pcm, { sampleRate, algorithm, minFrequency });
      const milliseconds = performance.now() - start;
      if (minFrequency === 60) {
        const unchangedDefault = trackPitch(pcm, { sampleRate, algorithm });
        if (JSON.stringify(contour) !== JSON.stringify(unchangedDefault)) throw new Error("The explicit 60 Hz preset changed the existing default.");
      }
      settings.push({ algorithm, minFrequency, milliseconds, frameSeconds: contour.frameSeconds,
        points: contour.points.map(p => [p.time, p.f0 ?? 0, p.confidence]) });
    }
  }
  const file = `${item.corpus}_${item.speaker}_${item.id}.json`;
  const data = JSON.stringify({ corpus: item.corpus, speaker: item.speaker, id: item.id, sampleRate, samples: pcm.length, audioSha256: sha256, settings });
  writeFileSync(join(out, file), data);
  receipt.push({ file, sha256: hash(data), audioSha256: sha256 });
  done++;
  if (done % 40 === 0) console.error(`shard ${shard}: ${done} recordings`);
}
const sourceFiles = ["src/core/pitchTrack.ts", "src/core/yin.ts", "src/core/mpm.ts", "src/core/pitchCorrelation.ts", "src/core/fft.ts", "src/core/types.ts"];
writeFileSync(join(out, `shard-${shard}.json`), JSON.stringify({ shard, shards, node: process.version,
  sourceManifestSha256: hash(readFileSync(resolve(import.meta.dirname, "../real-voice/manifest.json"))),
  sourceFiles: sourceFiles.map(file => ({ file, sha256: hash(readFileSync(join(root, file))) })),
  captureSha256: hash(readFileSync(import.meta.filename)), recordings: receipt }, null, 2) + "\n");
console.error(`shard ${shard}: completed ${done} recordings`);
