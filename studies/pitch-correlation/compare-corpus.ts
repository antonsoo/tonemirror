/** Paired unrounded replay; run fetch.py --offline first to verify source bytes.
 * tsx compare-corpus.ts BASELINE CHECKOUT OUTPUT [SHARD=0] [SHARDS=1]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [beforeRoot, afterRoot, output, shardArg = '0', shardsArg = '1'] = process.argv.slice(2);
const before = await import(pathToFileURL(resolve(beforeRoot!, 'src/core/pitchTrack.ts')).href);
const after = await import(pathToFileURL(resolve(afterRoot!, 'src/core/pitchTrack.ts')).href);
const cache = resolve(afterRoot!, 'studies/real-voice/cache');
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const paths: string[] = [];
for (const speaker of readdirSync(join(cache, 'ptdb')).filter(s => /^[FM]\d\d$/.test(s)).sort()) {
  for (const name of readdirSync(join(cache, 'ptdb', speaker)).filter(s => s.endsWith('.wav')).sort()) paths.push(`ptdb/${speaker}/${name}`);
}
for (const speaker of ['rl', 'sb']) {
  for (const name of readdirSync(join(cache, 'fda-extracted', speaker)).filter(s => s.endsWith('.sig')).sort()) paths.push(`fda-extracted/${speaker}/${name}`);
}
assert.equal(paths.length, 580);
function audio(bytes: Buffer, raw: boolean) {
  if (raw) return { sampleRate: 20000, pcm: Float32Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16BE(2 * i) / 32768) };
  let sampleRate = 0;
  for (let p = 12; p + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4);
    if (name === 'fmt ') {
      assert.equal(bytes.readUInt16LE(p + 8), 1); assert.equal(bytes.readUInt16LE(p + 10), 1); assert.equal(bytes.readUInt16LE(p + 22), 16);
      sampleRate = bytes.readUInt32LE(p + 12);
    }
    if (name === 'data') return { sampleRate, pcm: Float32Array.from({ length: size / 2 }, (_, i) => bytes.readInt16LE(p + 8 + 2 * i) / 32768) };
    p += 8 + size + (size & 1);
  }
  throw Error('No PCM');
}
const results = [];
for (let index = Number(shardArg); index < paths.length; index += Number(shardsArg)) {
  const path = paths[index]!, bytes = readFileSync(join(cache, path));
  const { pcm, sampleRate } = audio(bytes, path.endsWith('.sig'));
  for (const algorithm of ['yin', 'mpm']) {
    const options = { sampleRate, algorithm };
    const oldRaw = before.trackPitchRaw(pcm, options), newRaw = after.trackPitchRaw(pcm, options);
    const oldContour = before.trackPitch(pcm, options), newContour = after.trackPitch(pcm, options);
    assert.equal(oldRaw.length, newRaw.length); assert.equal(oldContour.points.length, newContour.points.length);
    let maxHz = 0, maxConfidence = 0, maxSemitones = 0, voicingChanges = 0, roundedHzChanges = 0;
    const delta = (a: number | null, b: number | null) => {
      if (a === null || b === null) { if (a !== b) voicingChanges++; return 0; }
      assert.ok(Number.isFinite(a) && Number.isFinite(b));
      if (a.toFixed(3) !== b.toFixed(3)) roundedHzChanges++;
      return Math.abs(a - b);
    };
    for (let i = 0; i < oldRaw.length; i++) {
      const a = oldRaw[i], b = newRaw[i];
      assert.equal(a.time, b.time); assert.equal(a.rms, b.rms); assert.equal(a.voiced, b.voiced);
      maxHz = Math.max(maxHz, delta(a.f0, b.f0)); maxConfidence = Math.max(maxConfidence, Math.abs(a.confidence - b.confidence));
      const c = oldContour.points[i], d = newContour.points[i];
      assert.equal(c.time, d.time); maxHz = Math.max(maxHz, delta(c.f0, d.f0));
      assert.equal(c.semitone === null, d.semitone === null);
      if (c.semitone !== null) maxSemitones = Math.max(maxSemitones, Math.abs(c.semitone - d.semitone));
    }
    assert.equal(voicingChanges, 0, path); assert.ok(maxHz < 1e-7, `${path}: ${maxHz}`); assert.ok(maxConfidence < 1e-10); assert.ok(maxSemitones < 1e-8);
    results.push({ path, sha256: hash(bytes), sampleRate, samples: pcm.length, algorithm, frames: oldRaw.length, voiced: oldRaw.filter((f: { voiced: boolean }) => f.voiced).length, maxHz, maxConfidence, maxSemitones, voicingChanges, roundedHzChanges,
      beforeSha256: hash(JSON.stringify([oldRaw, oldContour])), afterSha256: hash(JSON.stringify([newRaw, newContour])) });
  }
  if (index % 20 < Number(shardsArg)) console.error(`${index + 1}/${paths.length}: ${path}`);
}
writeFileSync(output!, JSON.stringify({ node: process.version, shard: +shardArg, shards: +shardsArg, manifestSha256: hash(readFileSync(resolve(afterRoot!, 'studies/real-voice/manifest.json'))), results }, null, 2) + '\n');
console.error(`Completed ${results.length} paired algorithm runs`);
