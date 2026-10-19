/** Fresh detector output from pinned recordings, paired alignment/overlay cores.
 * tsx corpus.ts BASELINE CHECKOUT OUTPUT
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PitchContour } from '../../src/core/types.js';
import type { AlignmentResult, WarpedPoint } from '../../src/core/dtw.js';

const [beforeRoot, afterRoot, output] = process.argv.slice(2);
assert.ok(beforeRoot && afterRoot && output, 'corpus.ts BASELINE CHECKOUT OUTPUT');
const before = await import(pathToFileURL(resolve(beforeRoot, 'src/core/dtw.ts')).href) as typeof import('../../src/core/dtw.js');
const after = await import(pathToFileURL(resolve(afterRoot, 'src/core/dtw.ts')).href) as typeof import('../../src/core/dtw.js');
const tracking = await import(pathToFileURL(resolve(afterRoot, 'src/core/pitchTrack.ts')).href) as typeof import('../../src/core/pitchTrack.js');
const cache = resolve(afterRoot, 'studies/real-voice/cache');
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const detectorFiles = ['pitchTrack.ts', 'yin.ts', 'mpm.ts', 'pitchCorrelation.ts', 'fft.ts'];
for (const name of detectorFiles) assert.equal(hash(readFileSync(resolve(beforeRoot, 'src/core', name))), hash(readFileSync(resolve(afterRoot, 'src/core', name))), name);
const manifestBytes = readFileSync(resolve(afterRoot, 'studies/real-voice/manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as { files: { path: string; sha256: string; bytes: number }[] };
const pinned = new Map(manifest.files.map(file => [file.path, file]));
const paths: string[] = [];
for (const speaker of readdirSync(join(cache, 'ptdb')).filter(s => /^[FM]\d\d$/.test(s)).sort()) {
  for (const name of readdirSync(join(cache, 'ptdb', speaker)).filter(s => s.endsWith('.wav')).sort()) paths.push(`ptdb/${speaker}/${name}`);
}
for (const speaker of ['rl', 'sb']) for (const name of readdirSync(join(cache, 'fda-extracted', speaker)).filter(s => s.endsWith('.sig')).sort()) paths.push(`fda-extracted/${speaker}/${name}`);
assert.equal(paths.length, 580);
function audio(bytes: Buffer, raw: boolean) {
  if (raw) return { sampleRate: 20000, pcm: Float32Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16BE(2 * i) / 32768) };
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  let sampleRate = 0;
  for (let p = 12; p + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4);
    assert.ok(p + 8 + size <= bytes.length);
    if (name === 'fmt ') {
      assert.equal(bytes.readUInt16LE(p + 8), 1); assert.equal(bytes.readUInt16LE(p + 10), 1); assert.equal(bytes.readUInt16LE(p + 22), 16);
      sampleRate = bytes.readUInt32LE(p + 12);
    }
    if (name === 'data') { assert.ok(sampleRate > 0); return { sampleRate, pcm: Float32Array.from({ length: size / 2 }, (_, i) => bytes.readInt16LE(p + 8 + 2 * i) / 32768) }; }
    p += 8 + size + (size & 1);
  }
  throw Error('No PCM');
}
function signature(result: AlignmentResult) {
  const { reference, attempt, ...rest } = result;
  const values = (samples: AlignmentResult['reference']) => samples.map(s => ({ time: s.time, semitone: s.semitone }));
  return { ...rest, reference: values(reference), attempt: values(attempt) };
}
function omissions(voice: PitchContour): { start: number; end: number }[] {
  const gaps = [];
  let previous = -1;
  for (let i = 0; i < voice.points.length; i++) {
    const point = voice.points[i]!;
    if (!point.voiced || point.semitone === null) continue;
    if (previous >= 0 && i !== previous + 1) gaps.push({ start: voice.points[previous]!.time, end: point.time });
    previous = i;
  }
  return gaps;
}
function connections(overlay: WarpedPoint[], gaps: { start: number; end: number }[], contour: PitchContour): number {
  const voice = contour.points.filter(p => p.voiced && p.semitone !== null);
  if (!voice.length) return 0;
  const t0 = voice[0]!.time, span = voice.at(-1)!.time - t0 || 1;
  return gaps.filter(gap => {
    const start = (gap.start - t0) / span, end = (gap.end - t0) / span;
    for (let i = 1; i < overlay.length; i++) if (!overlay[i]!.breakBefore && overlay[i - 1]!.t <= start + 1e-12 && overlay[i]!.t >= end - 1e-12) return true;
    return false;
  }).length;
}
const results = [];
let frames = 0, missingIntervals = 0, oldConnections = 0, newConnections = 0;
for (const [index, path] of paths.entries()) {
  const bytes = readFileSync(join(cache, path)), source = pinned.get(path);
  if (source) { assert.equal(bytes.length, source.bytes); assert.equal(hash(bytes), source.sha256); }
  const { pcm, sampleRate } = audio(bytes, path.endsWith('.sig'));
  for (const algorithm of ['yin', 'mpm'] as const) {
    const contour = tracking.trackPitch(pcm, { sampleRate, algorithm });
    const original = before.compareContours(contour, contour), corrected = after.compareContours(contour, contour);
    const originalSignature = signature(original), correctedSignature = signature(corrected);
    assert.deepEqual(correctedSignature, originalSignature, `${path}: ${algorithm}`);
    const gaps = omissions(contour), a = before.warpedOverlay(original), b = after.warpedOverlay(corrected);
    const beforeConnections = connections(a, gaps, contour), afterConnections = connections(b, gaps, contour);
    assert.equal(afterConnections, 0, `${path}: ${algorithm}`);
    frames += contour.points.length; missingIntervals += gaps.length; oldConnections += beforeConnections; newConnections += afterConnections;
    results.push({ path, sha256: hash(bytes), sampleRate, samples: pcm.length, algorithm, frames: contour.points.length, voiced: original.reference.length, omittedIntervals: gaps.length, beforeConnections, afterConnections, unchangedAlignmentSha256: hash(JSON.stringify(originalSignature)), contourSha256: hash(JSON.stringify(contour)) });
  }
  if (index % 20 === 0) console.log(`${index + 1}/${paths.length}: ${path}`);
}
writeFileSync(output, JSON.stringify({ node: process.version, manifestSha256: hash(manifestBytes), detectorFilesUnchanged: detectorFiles, recordings: paths.length, pairedAlgorithmRuns: results.length, frames, missingIntervals, beforeConnections: oldConnections, afterConnections: newConnections, results }, null, 2) + '\n');
console.log(`${results.length} paired alignments; ${oldConnections} unsupported connections become ${newConnections}.`);
