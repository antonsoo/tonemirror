/**
 * [exploration] Per-frame detector candidates with no voicing gate, so thresholds can be studied offline.
 * Original header follows.
 *
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
const yinMod = (await import(pathToFileURL(join(repoRoot, "src/core/yin.ts")).href)) as { yinDetect: (f: Float64Array, c: { sampleRate: number; minFrequency: number; maxFrequency: number; threshold: number }) => { f0: number | null; confidence: number } };
const mpmMod = (await import(pathToFileURL(join(repoRoot, "src/core/mpm.ts")).href)) as { mpmDetect: (f: Float64Array, c: { sampleRate: number; minFrequency: number; maxFrequency: number; clarityThreshold: number }) => { f0: number | null; confidence: number } };

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
for (let k = 0; k < items.length; k++) {
  if (k % nShards !== shard) continue;
  if (process.env.ONLY_DEV && !(items[k]!.corpus === "ptdb" && /^[FM]0[13579]$/.test(items[k]!.speaker))) continue;
  const it = items[k]!;
  const { pcm, sampleRate } = it.corpus === "fda" ? readRawBE(it.path) : readWav16(it.path);
  const maxLag = Math.floor(sampleRate / 60);
  const frameSize = Math.round(maxLag * Number(process.env.FRAME_MULT ?? 2));
  const hop = Math.max(1, Math.round(0.01 * sampleRate));
  const n = pcm.length < frameSize ? 0 : Math.floor((pcm.length - frameSize) / hop) + 1;
  const o: Record<string, number[]> = { t: [], rms: [], yinF0: [], yinConf: [], mpmF0: [], mpmConf: [] };
  for (let i = 0; i < n; i++) {
    const slice = new Float64Array(frameSize);
    let e = 0;
    for (let q = 0; q < frameSize; q++) { slice[q] = pcm[i * hop + q]!; e += slice[q]! * slice[q]!; }
    const rmsv = Math.sqrt(e / frameSize);
    const y = yinMod.yinDetect(slice, { sampleRate, minFrequency: 60, maxFrequency: 1000, threshold: 0.15 });
    const m = mpmMod.mpmDetect(slice, { sampleRate, minFrequency: 60, maxFrequency: 1000, clarityThreshold: 0.93 });
    o.t!.push((i * hop + frameSize / 2) / sampleRate);
    o.rms!.push(+rmsv.toFixed(5));
    o.yinF0!.push(y.f0 === null ? 0 : +y.f0.toFixed(3)); o.yinConf!.push(+y.confidence.toFixed(4));
    o.mpmF0!.push(m.f0 === null ? 0 : +m.f0.toFixed(3)); o.mpmConf!.push(+m.confidence.toFixed(4));
  }
  writeFileSync(join(outDir, `${it.corpus}_${it.speaker}_${it.id}.json`), JSON.stringify({ corpus: it.corpus, speaker: it.speaker, id: it.id, sampleRate, ...o }));
}
