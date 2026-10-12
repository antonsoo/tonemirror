// Compare the real ClipPlayer clock with actual browser-rendered PCM.
// node native.mjs SOURCE_ROOT RECEIPT.json [--baseline]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [sourceArg, output, mode] = process.argv.slice(2);
assert.ok(sourceArg && output);
const root = resolve(sourceArg), baseline = mode === '--baseline';
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const { chromium, firefox } = require('@playwright/test');
const source = await readFile(join(root, 'src/audio/playback.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('export class ClipPlayer', 'class ClipPlayer') + '\nglobalThis.ClipPlayer = ClipPlayer;';
const results = [];

for (const [engine, launcher] of [['chromium', chromium], ['firefox', firefox]]) {
  const browser = await launcher.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<button>Start native playback checks</button>');
    await page.addScriptTag({ content: code });
    const offline = await page.evaluate(async () => {
      const rows = [];
      for (const sampleRate of [8000, 44100, 48000]) {
        for (const half of [false, true]) {
          for (const offset of [0, 1, 2, 3, 4, 5, 7, 10]) {
            const duration = 10, outputFrames = 4096;
            const context = new OfflineAudioContext(1, outputFrames, sampleRate);
            const player = new ClipPlayer(context);
            // Every input sample encodes its source time: amplitude * 10.
            // No microphone, speech labels or simulated AudioNodes are used.
            const pcm = Float32Array.from({ length: sampleRate * duration }, (_, i) => i / (sampleRate * duration));
            player.load(pcm, sampleRate);
            player.setLoopRegion({ start: 0.2, end: 0.4 });
            player.setHalfSpeed(half);
            player.play(offset);
            const cursorStart = player.currentPositionSeconds();
            const output = (await context.startRendering()).getChannelData(0);
            const nativeStart = output[0] * duration;
            // Independently render from the reported cursor with a bare native
            // node. Comparing all samples handles Firefox's half-speed filter
            // transient without treating its amplitude change as clock drift.
            const reference = new OfflineAudioContext(1, outputFrames, sampleRate);
            const node = reference.createBufferSource();
            const referenceBuffer = reference.createBuffer(1, pcm.length, sampleRate);
            referenceBuffer.copyToChannel(pcm, 0);
            node.buffer = referenceBuffer;
            node.loop = true; node.loopStart = 2; node.loopEnd = 4;
            node.playbackRate.value = half ? 0.5 : 1;
            node.connect(reference.destination);
            node.start(0, cursorStart);
            const expected = (await reference.startRendering()).getChannelData(0);
            let maxSampleDifference = 0;
            for (let i = 0; i < output.length; i++) {
              maxSampleDifference = Math.max(maxSampleDifference, Math.abs(output[i] - expected[i]));
            }
            node.disconnect();
            let nativeEnd = output.at(-1) * duration + (half ? 0.5 : 1) / sampleRate;
            if (nativeEnd >= 4) nativeEnd = 2 + (nativeEnd - 4);
            const cursorEnd = player.currentPositionSeconds();
            const endErrorSeconds = Math.abs(cursorEnd - nativeEnd);
            rows.push({ sampleRate, half, offset, cursorStart, nativeStart, cursorEnd, nativeEnd, maxSampleDifference,
              renderedFrames: output.length, contextTime: context.currentTime,
              endErrorSeconds, endToleranceSeconds: 0.001, sampleTolerance: 0.000001,
              matches: maxSampleDifference < 0.000001 && endErrorSeconds < 0.001 });
            player.stop();
          }
        }
      }
      return rows;
    });

    // Firefox has no OfflineAudioContext.suspend. Exercise live loop edits
    // in both engines instead, reading their real output through an AnalyserNode.
    await page.evaluate(() => {
      document.querySelector('button').onclick = async () => {
        try {
          const rows = [];
          for (const scenario of [
            { name: 'enable-after-end', offset: 5, loop: null, next: { start: 0.2, end: 0.4 } },
            { name: 'shorten-loop', offset: 5, loop: { start: 0.2, end: 0.8 }, next: { start: 0.2, end: 0.4 } },
            { name: 'enable-inside', offset: 2, loop: null, next: { start: 0.2, end: 0.4 } },
            { name: 'clear-loop', offset: 3.9, loop: { start: 0.2, end: 0.4 }, next: null },
          ]) {
            for (const half of [false, true]) {
              const context = new AudioContext({ sampleRate: 8000 });
              await context.resume();
              let analyser;
              const createSource = context.createBufferSource.bind(context);
              context.createBufferSource = () => {
                const node = createSource();
                const connect = node.connect.bind(node);
                node.connect = destination => {
                  analyser = context.createAnalyser();
                  analyser.fftSize = 32;
                  connect(analyser);
                  return analyser.connect(destination);
                };
                return node;
              };
              const player = new ClipPlayer(context);
              player.load(Float32Array.from({ length: 80000 }, (_, i) => i / 80000), 8000);
              player.setLoopRegion(scenario.loop);
              player.setHalfSpeed(half);
              player.play(scenario.offset);
              const waitClock = async seconds => {
                const until = context.currentTime + seconds;
                const deadline = performance.now() + 5000;
                while (context.currentTime < until) {
                  if (performance.now() > deadline) throw new Error('Native audio clock did not advance');
                  await new Promise(done => setTimeout(done, 10));
                }
              };
              try {
                await waitClock(0.16);
                const before = player.currentPositionSeconds();
                player.setLoopRegion(scenario.next);
                const immediatelyAfter = player.currentPositionSeconds();
                const observations = [];
                await waitClock(0.08);
                for (let i = 0; i < 6; i++) {
                  await waitClock(0.032);
                  const samples = new Float32Array(32);
                  analyser.getFloatTimeDomainData(samples);
                  const native = samples.at(-1) * 10;
                  const cursor = player.currentPositionSeconds();
                  observations.push({ contextTime: context.currentTime, native, cursor, errorSeconds: Math.abs(native - cursor) });
                }
                // The main-thread clock and AnalyserNode can differ by a
                // render quantum. A 64 ms budget is four 128-frame quanta
                // at 8 kHz; it is far below the reproduced >1 second error.
                const maximum = Math.max(...observations.map(row => row.errorSeconds));
                rows.push({ scenario: scenario.name, half, before, immediatelyAfter, observations,
                  maxErrorSeconds: maximum, toleranceSeconds: 0.064, matches: maximum <= 0.064 });
              } finally {
                player.stop();
                await context.close();
              }
            }
          }
          globalThis.liveResult = { rows };
        } catch (error) {
          globalThis.liveResult = { error: String(error) };
        }
      };
    });
    await page.click('button');
    await page.waitForFunction(() => globalThis.liveResult, null, { timeout: 60_000 });
    const live = await page.evaluate(() => globalThis.liveResult);
    assert.equal(live.error, undefined);
    assert.deepEqual(errors, []);
    results.push({ engine, version: browser.version(), offline, live: live.rows, errors });
    console.log(`${engine}: ${offline.filter(row => row.matches).length}/${offline.length} offline positions; ${live.rows.filter(row => row.matches).length}/${live.rows.length} live loop edits`);
  } finally { await browser.close(); }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await writeFile(output, JSON.stringify({
  synthetic: true, baseline, sourceSha256: hash(source),
  driverSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  offlineCases: results.reduce((n, row) => n + row.offline.length, 0),
  offlineMatches: results.reduce((n, row) => n + row.offline.filter(test => test.matches).length, 0),
  liveCases: results.reduce((n, row) => n + row.live.length, 0),
  liveMatches: results.reduce((n, row) => n + row.live.filter(test => test.matches).length, 0),
  scope: 'Digital native browser rendering and clock agreement; no microphone, acoustic or device-latency validation',
  results,
}, null, 2) + '\n');
if (!baseline) {
  for (const result of results) {
    assert.ok(result.offline.every(row => row.matches), JSON.stringify(result.offline.filter(row => !row.matches)));
    assert.ok(result.live.every(row => row.matches), JSON.stringify(result.live.filter(row => !row.matches)));
  }
}
