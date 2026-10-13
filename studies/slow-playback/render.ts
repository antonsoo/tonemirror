/** Render fixtures without distributing corpus audio. Run from the repo root:
 * npx tsx studies/slow-playback/render.ts OUTPUT_DIRECTORY
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, totalmem, release } from 'node:os';
import { prepareHalfSpeed } from '../../src/audio/slowPlayback.js';

const output = resolve(process.argv[2]!);
mkdirSync(output, { recursive: true });
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (pcm: Float32Array) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
const rms = (pcm: Float32Array) => Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / pcm.length);
const peak = (pcm: Float32Array) => pcm.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
function wav16(b: Buffer) {
  let rate = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const name = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4);
    if (name === 'fmt ') {
      assert.equal(b.readUInt16LE(at + 8), 1); assert.equal(b.readUInt16LE(at + 10), 1); assert.equal(b.readUInt16LE(at + 22), 16);
      rate = b.readUInt32LE(at + 12);
    }
    if (name === 'data') return { rate, pcm: Float32Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(at + 8 + 2 * i) / 32768) };
    at += 8 + size + size % 2;
  }
  throw Error('Missing PCM');
}
const manifest = JSON.parse(readFileSync('studies/real-voice/manifest.json', 'utf8'));
const selected = manifest.files.filter((f: { path: string }) => /^ptdb\/[FM]\d\d\/mic_.*\.wav$/.test(f.path));
assert.equal(selected.length, 480);
const speech = [];
for (const f of selected) {
  const b = readFileSync(join('studies/real-voice/cache', f.path));
  assert.equal(hash(b), f.sha256); assert.equal(b.length, f.bytes);
  const { rate, pcm } = wav16(b), originalHash = hash(bytes(pcm));
  const start = performance.now(), stretched = await prepareHalfSpeed(pcm, rate), ms = performance.now() - start;
  assert.equal(stretched.length, pcm.length * 2); assert.equal(hash(bytes(pcm)), originalHash);
  assert.ok(stretched.every(Number.isFinite));
  const id = f.path.split('/').at(-1)!.replace('.wav', '');
  writeFileSync(join(output, `${id}.f32`), bytes(stretched));
  speech.push({ path: f.path, sourceSha256: f.sha256, sampleRate: rate, inputSamples: pcm.length,
    outputSamples: stretched.length, outputSha256: hash(bytes(stretched)), preparationMs: ms,
    inputPeak: peak(pcm), outputPeak: peak(stretched), rmsRatio: rms(stretched) / rms(pcm) });
  if (speech.length % 80 === 0) console.log(`Rendered ${speech.length}/480 speech clips`);
}
const tones = [];
for (const rate of [8000, 16000, 22050, 44100, 48000, 96000]) {
  for (const hz of [80, 220, 440, 880]) {
    const pcm = Float32Array.from({ length: rate }, (_, i) => .3 * Math.sin(2 * Math.PI * hz * i / rate));
    const out = await prepareHalfSpeed(pcm, rate);
    const crossings = [];
    for (let i = Math.floor(rate * .25); i < out.length - rate * .25; i++) {
      if (out[i - 1]! < 0 && out[i]! >= 0) crossings.push(i - 1 - out[i - 1]! / (out[i]! - out[i - 1]!));
    }
    const measured = (crossings.length - 1) * rate / (crossings.at(-1)! - crossings[0]!);
    tones.push({ rate, inputHz: hz, outputHz: measured, cents: 1200 * Math.log2(measured / hz), outputSamples: out.length });
    assert.ok(Math.abs(1200 * Math.log2(measured / hz)) < 5);
  }
}
const short = [];
for (const rate of [8000, 48000, 96000]) {
  for (const seconds of [.001, .005, .01, .02, .05, .1, .2]) {
    const pcm = Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => .3 * Math.sin(2 * Math.PI * 220 * i / rate));
    const out = await prepareHalfSpeed(pcm, rate);
    short.push({ rate, seconds, inputSamples: pcm.length, outputSamples: out.length, rmsRatio: rms(out) / rms(pcm), peak: peak(out) });
    assert.equal(out.length, pcm.length * 2); assert.ok(rms(out) > 0);
  }
}
const longest = [];
for (const rate of [8000, 48000, 96000]) {
  const pcm = Float32Array.from({ length: rate * 60 }, (_, i) => .3 * Math.sin(2 * Math.PI * 220 * i / rate));
  const start = performance.now(), out = await prepareHalfSpeed(pcm, rate), ms = performance.now() - start;
  longest.push({ rate, inputSeconds: 60, outputSamples: out.length, preparationMs: ms, finite: out.every(Number.isFinite) });
  assert.equal(out.length, pcm.length * 2);
}
writeFileSync(join(output, 'render.json'), JSON.stringify({ node: process.version, platform: `${process.platform} ${release()}`,
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 2 ** 30, speech, tones, short, longest }, null, 2) + '\n');
console.log(`Wrote ${output}/render.json`);
