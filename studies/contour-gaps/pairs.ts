/** Differently timed real voices: numeric compatibility and an independent run/group oracle.
 * tsx pairs.ts BASELINE CHECKOUT OUTPUT
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PitchContour } from '../../src/core/types.js';
import type { AlignmentResult } from '../../src/core/dtw.js';

const [oldRoot, root, output] = process.argv.slice(2);
assert.ok(oldRoot && root && output, 'pairs.ts BASELINE CHECKOUT OUTPUT');
const before = await import(pathToFileURL(resolve(oldRoot, 'src/core/dtw.ts')).href) as typeof import('../../src/core/dtw.js');
const after = await import(pathToFileURL(resolve(root, 'src/core/dtw.ts')).href) as typeof import('../../src/core/dtw.js');
const { trackPitch } = await import(pathToFileURL(resolve(root, 'src/core/pitchTrack.ts')).href) as typeof import('../../src/core/pitchTrack.js');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const manifestBytes = readFileSync(resolve(root, 'studies/real-voice/manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as { files: { path: string; sha256: string }[] };
const cache = new Map<string, PitchContour>();
const recordings = new Map<string, { path: string; sha256: string }>();
function load(speaker: string, sentence: string, algorithm: 'yin' | 'mpm') {
  const path = `ptdb/${speaker}/mic_${speaker}_${sentence}.wav`, key = path + algorithm;
  const stored = cache.get(key);
  if (stored) return stored;
  const bytes = readFileSync(resolve(root, 'studies/real-voice/cache', path));
  assert.equal(hash(bytes), manifest.files.find(file => file.path === path)!.sha256);
  let sampleRate = 0, voice: PitchContour | undefined;
  for (let p = 12; p + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', p, p + 4), size = bytes.readUInt32LE(p + 4);
    if (kind === 'fmt ') {
      assert.equal(bytes.readUInt16LE(p + 8), 1); assert.equal(bytes.readUInt16LE(p + 10), 1); assert.equal(bytes.readUInt16LE(p + 22), 16);
      sampleRate = bytes.readUInt32LE(p + 12);
    }
    if (kind === 'data') {
      assert.ok(sampleRate && p + 8 + size <= bytes.length);
      voice = trackPitch(Float32Array.from({ length: size / 2 }, (_, i) => bytes.readInt16LE(p + 8 + i * 2) / 32768), { sampleRate, algorithm });
      break;
    }
    p += 8 + size + (size & 1);
  }
  assert.ok(voice);
  recordings.set(path, { path, sha256: hash(bytes) });
  cache.set(key, voice);
  return voice;
}
function signature(result: AlignmentResult) {
  const { reference, attempt, ...rest } = result;
  return { ...rest, reference: reference.map(s => [s.time, s.semitone]), attempt: attempt.map(s => [s.time, s.semitone]) };
}
function oracle(result: AlignmentResult, reference: PitchContour, attempt: PitchContour) {
  const nativeRef = new Map(reference.points.map((p, i) => [p.time, i]));
  const nativeAtt = new Map(attempt.points.map((p, i) => [p.time, i]));
  const runs: Map<number, number[]>[] = [];
  let previousRef = -1, previousAtt = -1;
  for (const { refIndex, attemptIndex } of result.path) {
    const refFrame = nativeRef.get(result.reference[refIndex]!.time)!;
    const attFrame = nativeAtt.get(result.attempt[attemptIndex]!.time)!;
    const disconnected = (previousRef >= 0 && refFrame > previousRef + 1) || (previousAtt >= 0 && attFrame > previousAtt + 1);
    if (!runs.length || disconnected) runs.push(new Map());
    const run = runs.at(-1)!;
    const values = run.get(refIndex) ?? [];
    values.push(result.attempt[attemptIndex]!.semitone);
    run.set(refIndex, values);
    previousRef = refFrame; previousAtt = attFrame;
  }
  const t0 = result.reference[0]!.time, span = result.reference.at(-1)!.time - t0 || 1;
  // Each native contiguous path run defines separate reference-time groups.
  // Arithmetic means are taken within a run; no implementation gap flag is read.
  return runs.flatMap((run, i) => [...run].map(([refIndex, values], j) => ({
    t: (result.reference[refIndex]!.time - t0) / span,
    referenceSemitone: result.reference[refIndex]!.semitone,
    attemptSemitone: values.reduce((sum, value) => sum + value, 0) / values.length,
    ...(i && j === 0 ? { breakBefore: true as const } : {}),
  })));
}
const speakers = ['F', 'M'].flatMap(prefix => Array.from({ length: 10 }, (_, i) => prefix + String(i + 1).padStart(2, '0')));
const cases = [
  ...speakers.filter(s => s !== 'F01').map(s => ({ reference: ['F01', 'sa1'], attempt: [s, 'sa1'] })),
  ...speakers.map(s => ({ reference: [s, 'sa1'], attempt: [s, 'sa2'] })),
];
const results = [];
for (const [index, pair] of cases.entries()) for (const algorithm of ['yin', 'mpm'] as const) {
  const reference = load(pair.reference[0]!, pair.reference[1]!, algorithm), attempt = load(pair.attempt[0]!, pair.attempt[1]!, algorithm);
  const a = before.compareContours(reference, attempt), b = after.compareContours(reference, attempt);
  assert.deepEqual(signature(b), signature(a));
  const drawn = after.warpedOverlay(b), expected = oracle(b, reference, attempt);
  assert.deepEqual(drawn, expected);
  const repeatedTimes = drawn.filter((p, i) => i > 0 && p.t === drawn[i - 1]!.t).length;
  results.push({ reference: pair.reference.join('/'), attempt: pair.attempt.join('/'), algorithm, score: b.score, pathSteps: b.path.length, oldOverlayPoints: before.warpedOverlay(a).length, correctedOverlayPoints: drawn.length, breaks: drawn.filter(p => p.breakBefore).length, distinctRunsAtOneReferenceTime: repeatedTimes, unchangedAlignmentSha256: hash(JSON.stringify(signature(a))), independentlyVerifiedOverlaySha256: hash(JSON.stringify(drawn)) });
  if (algorithm === 'mpm' && index % 5 === 0) console.log(`${index + 1}/${cases.length} real-voice pairs`);
}
writeFileSync(output, JSON.stringify({ node: process.version, manifestSha256: hash(manifestBytes), recordings: [...recordings.values()], comparisons: results.length, allAlignmentsUnchanged: true, allOverlaysMatchIndependentRunOracle: true, results }, null, 2) + '\n');
console.log(`${results.length} differently timed speech comparisons keep every alignment and match the independent native-run oracle.`);
