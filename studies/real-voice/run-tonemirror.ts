/**
 * Run tonemirror's own trackers, configured as the app configures them, over the cached
 * recordings and write per-utterance frame tables for score.py.
 *
 *   tsx run-tonemirror.ts <repo-root> <out-dir> <shard> <n-shards>
 *
 * The app calls trackPitch(pcm, { sampleRate, algorithm }) and nothing else (src/worker/pitchWorker.ts),
 * so every option is the default in src/core/pitchTrack.ts. Output per utterance and algorithm:
 *   raw     the per-frame detector output (trackPitchRaw): time, f0 (null if unvoiced), confidence, rms
 *   contour the plotted contour (trackPitch): time, f0 (null if unvoiced) after octave correction + median smoothing
 * Audio goes in at the corpus's native rate, as it would from a decoded file.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, outDir, shardArg, nShardsArg] = process.argv.slice(2) as [string, string, string, string];
const shard = Number(shardArg);
const nShards = Number(nShardsArg);
const cache = resolve(import.meta.dirname, "cache");

const mod = (await import(pathToFileURL(join(repoRoot, "src/core/pitchTrack.ts")).href)) as {
  trackPitch: (s: Float32Array, o: { sampleRate: number; algorithm: "yin" | "mpm" }) => {
    points: { time: number; f0: number | null }[];
  };
  trackPitchRaw: (s: Float32Array, o: { sampleRate: number; algorithm: "yin" | "mpm" }) => {
    time: number; f0: number | null; confidence: number; rms: number;
  }[];
};

function readWav16(path: string): { pcm: Float32Array; sampleRate: number } {
  const b = readFileSync(path);
  let pos = 12;
  let sampleRate = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      if (b.readUInt16LE(pos + 10) !== 1 || b.readUInt16LE(pos + 22) !== 16) throw new Error("not 16-bit mono PCM: " + path);
      sampleRate = b.readUInt32LE(pos + 12);
    } else if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - pos - 8) / 2);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(pos + 8 + 2 * i) / 32768;
      return { pcm, sampleRate };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error("no data chunk: " + path);
}

/** FDA .sig: headerless 16-bit big-endian, 20 kHz. */
function readRawBE(path: string): { pcm: Float32Array; sampleRate: number } {
  const b = readFileSync(path);
  const n = b.length >> 1;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = b.readInt16BE(2 * i) / 32768;
  return { pcm, sampleRate: 20000 };
}

interface Item { corpus: string; speaker: string; id: string; path: string }
const items: Item[] = [];
for (const spk of readdirSync(join(cache, "ptdb")).filter((d) => /^[FM]\d\d$/.test(d)).sort()) {
  for (const f of readdirSync(join(cache, "ptdb", spk)).filter((x) => x.endsWith(".wav")).sort()) {
    items.push({ corpus: "ptdb", speaker: spk, id: f.replace(/^mic_[FM]\d\d_|\.wav$/g, ""), path: join(cache, "ptdb", spk, f) });
  }
}
for (const spk of ["rl", "sb"]) {
  const dir = join(cache, "fda-extracted", spk);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sig")).sort()) {
    items.push({ corpus: "fda", speaker: spk, id: f.replace(".sig", ""), path: join(dir, f) });
  }
}

mkdirSync(outDir, { recursive: true });
let done = 0;
for (let k = 0; k < items.length; k++) {
  if (k % nShards !== shard) continue;
  const it = items[k]!;
  const { pcm, sampleRate } = it.corpus === "fda" ? readRawBE(it.path) : readWav16(it.path);
  const out: Record<string, unknown> = { corpus: it.corpus, speaker: it.speaker, id: it.id, sampleRate, samples: pcm.length };
  for (const algorithm of ["yin", "mpm"] as const) {
    const raw = mod.trackPitchRaw(pcm, { sampleRate, algorithm });
    const contour = mod.trackPitch(pcm, { sampleRate, algorithm });
    out[algorithm] = {
      t: raw.map((f) => f.time),
      rawF0: raw.map((f) => (f.f0 === null ? 0 : +f.f0.toFixed(3))),
      conf: raw.map((f) => +f.confidence.toFixed(4)),
      rms: raw.map((f) => +f.rms.toFixed(5)),
      contourF0: contour.points.map((p) => (p.f0 === null ? 0 : +p.f0.toFixed(3))),
    };
  }
  writeFileSync(join(outDir, `${it.corpus}_${it.speaker}_${it.id}.json`), JSON.stringify(out));
  done++;
}
console.error(`shard ${shard}: ${done} utterances`);
