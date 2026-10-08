/**
 * [exploration] YIN's cumulative mean normalised difference minima per frame (the same d' as src/core/yin.ts),
 * so alternative period-selection rules can be tried offline.
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


function dprime(frame: Float64Array, maxLag: number): Float64Array {
  const w = frame.length - maxLag;
  const dp = new Float64Array(maxLag + 1);
  let run = 0;
  dp[0] = 1;
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) { const d = frame[j]! - frame[j + tau]!; sum += d * d; }
    run += sum;
    dp[tau] = run === 0 ? 1 : (sum * tau) / run;
  }
  return dp;
}

mkdirSync(outDir, { recursive: true });
for (let k = 0; k < items.length; k++) {
  if (k % nShards !== shard) continue;
  const it = items[k]!;
  if (!(it.corpus === "ptdb" && /^[FM]0[13579]$/.test(it.speaker))) continue;
  const { pcm, sampleRate } = readWav16(it.path);
  const maxLag = Math.floor(sampleRate / 60);
  const frameSize = maxLag * 2;
  const minLag = Math.max(2, Math.floor(sampleRate / 1000));
  const hop = Math.round(0.01 * sampleRate);
  const n = Math.floor((pcm.length - frameSize) / hop) + 1;
  const t: number[] = [], rms: number[] = [], minima: number[][][] = [];
  for (let i = 0; i < n; i++) {
    const slice = new Float64Array(frameSize);
    let e = 0;
    for (let q = 0; q < frameSize; q++) { slice[q] = pcm[i * hop + q]!; e += slice[q]! * slice[q]!; }
    const dp = dprime(slice, maxLag);
    const m: number[][] = [];
    for (let tau = minLag + 1; tau < maxLag; tau++) {
      if (dp[tau]! < dp[tau - 1]! && dp[tau]! <= dp[tau + 1]! && dp[tau]! < 0.5) {
        const s0 = dp[tau - 1]!, s1 = dp[tau]!, s2 = dp[tau + 1]!;
        const den = 2 * (2 * s1 - s2 - s0);
        const sh = Math.abs(den) < 1e-12 ? 0 : (s2 - s0) / den;
        m.push([+(sampleRate / (tau + (Math.abs(sh) < 1 ? sh : 0))).toFixed(3), +s1.toFixed(4)]);
      }
    }
    t.push((i * hop + frameSize / 2) / sampleRate);
    rms.push(+Math.sqrt(e / frameSize).toFixed(5));
    minima.push(m);
  }
  writeFileSync(join(outDir, `${it.corpus}_${it.speaker}_${it.id}.json`), JSON.stringify({ corpus: it.corpus, speaker: it.speaker, id: it.id, sampleRate, t, rms, minima }));
}
