// node --import tsx studies/wav-export/format-check.mjs OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeWav, WAV_SYNTHETIC_COMMENT } from '../../src/audio/wav.ts';
const output = resolve(process.argv[2]); await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const rate of [8000, 11025, 16000, 22050, 44100, 48000, 96000]) {
  // Subarray boundaries, signed zero, subnormal floats and unclipped headroom.
  const source = new Float32Array([99, -1.25, -1, -0, 0, 2 ** -149, 0.125, 1, 1.25, 99]);
  const pcm = source.subarray(1, source.length - 1);
  const encoded = Buffer.from(encodeWav(pcm, rate, true));
  const file = resolve(output, `${rate}.wav`); await writeFile(file, encoded);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr); const metadata = JSON.parse(probe.stdout);
  assert.equal(metadata.streams[0].codec_name, 'pcm_f32le'); assert.equal(metadata.streams[0].channels, 1);
  assert.equal(Number(metadata.streams[0].sample_rate), rate); assert.equal(metadata.format.tags.comment, WAV_SYNTHETIC_COMMENT);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-']);
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const expected = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength); assert.deepEqual(decoded.stdout, expected);
  results.push({ rate, samples: pcm.length, bytes: encoded.length, sha256: hash(encoded), pcmSha256: hash(expected), ffmpegSamplesMatch: true });
}
const pcm = new Float32Array(60 * 96000);
for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 97) / 2;
const started = performance.now(), largest = Buffer.from(encodeWav(pcm, 96000));
const milliseconds = performance.now() - started;
assert.ok(largest.length <= 25 * 1024 * 1024);
const file = resolve(output, 'maximum.wav'); await writeFile(file, largest);
const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 30 * 1024 * 1024 });
assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.deepEqual(decoded.stdout, Buffer.from(pcm.buffer));
await writeFile(resolve(output, 'format.json'), JSON.stringify({ node: process.version, ffmpeg: spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0], cases: results,
  maximum: { samples: pcm.length, sampleRate: 96000, seconds: 60, bytes: largest.length, sha256: hash(largest), pcmSha256: hash(decoded.stdout), encodeMilliseconds: milliseconds, ffmpegSamplesMatch: true },
  timingScope: 'One local Node encoding run on 14-vCPU WSL2 Linux with 48 GiB RAM; not a browser or cross-device latency guarantee.' }, null, 2) + '\n');
console.log(JSON.stringify({ rates: results.length, maximumBytes: largest.length, encodeMilliseconds: milliseconds }));
