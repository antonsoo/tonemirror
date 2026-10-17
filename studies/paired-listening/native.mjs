// Native digital rendering of the production scheduler; no audio-device or hearing claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
const [rootArg, output] = process.argv.slice(2);
assert.ok(rootArg && output, 'SOURCE_ROOT OUTPUT.json');
const root = resolve(rootArg), require = createRequire(join(root, 'package.json'));
const { buildSync } = require('esbuild');
const { chromium, firefox } = require('@playwright/test');
const bundle = buildSync({ entryPoints: [join(root, 'src/audio/pairedPlayback.ts')], bundle: true,
  format: 'iife', globalName: 'PairedStudy', platform: 'browser', target: 'es2022', write: false }).outputFiles[0].text;
const results = [];
for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
  const browser = await launcher.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Native paired listening render</title>');
    await page.addScriptTag({ content: bundle });
    const rows = await page.evaluate(async () => {
      const rows = [], unsupported = [];
      for (const sampleRate of [8000, 44100, 48000, 96000]) for (const cropped of [false, true]) {
        const reference = Float32Array.from({ length: Math.floor(sampleRate * .24) }, (_, i) => .1 + .02 * (i % 97) / 97);
        const attempt = Float32Array.from({ length: Math.floor(sampleRate * .18) }, (_, i) => -.1 - .02 * (i % 89) / 89);
        const first = cropped ? { start: Math.floor(sampleRate * .05), end: Math.floor(sampleRate * .17) } : { start: 0, end: reference.length };
        const second = cropped ? { start: Math.floor(sampleRate * .04), end: Math.floor(sampleRate * .13) } : { start: 0, end: attempt.length };
        const firstAt = .03, firstDuration = (first.end - first.start) / sampleRate;
        const secondAt = firstAt + firstDuration + .35, secondDuration = (second.end - second.start) / sampleRate;
        for (const stopDuring of ['none', 'before-start', 'reference', 'gap', 'attempt']) {
          const length = sampleRate, context = new OfflineAudioContext(1, length, sampleRate);
          if (!context.suspend && !['none', 'before-start'].includes(stopDuring)) { unsupported.push({ sampleRate, cropped, stopDuring, reason: 'OfflineAudioContext.suspend unavailable; live cancellation checked separately' }); continue; }
          const player = new PairedStudy.PairedPlayer(context);
          let completions = 0;
          player.play({ pcm: reference, sampleRate, region: first }, { pcm: attempt, sampleRate, region: second }, () => completions++);
          const initialState = player.state;
          let stoppedAt = null, stateBeforeStop = null;
          let rendering;
          if (stopDuring === 'before-start') { stoppedAt = 0; stateBeforeStop = player.state; player.stop(); rendering = context.startRendering(); }
          else if (stopDuring === 'none') rendering = context.startRendering();
          else {
            const when = stopDuring === 'reference' ? firstAt + firstDuration / 2 : stopDuring === 'gap' ? firstAt + firstDuration + .175 : secondAt + secondDuration / 2;
            const suspended = context.suspend(when); rendering = context.startRendering(); await suspended;
            stoppedAt = context.currentTime; stateBeforeStop = player.state; player.stop(); await context.resume();
          }
          const actual = (await rendering).getChannelData(0);
          await new Promise(done => setTimeout(done, 0));
          const expected = new Float32Array(length), stopFrame = stoppedAt === null ? length : Math.round(stoppedAt * sampleRate);
          for (const [pcm, region, when] of [[reference, first, firstAt], [attempt, second, secondAt]]) {
            const at = Math.round(when * sampleRate);
            for (let i = region.start; i < region.end && at + i - region.start < stopFrame; i++) expected[at + i - region.start] = pcm[i];
          }
          let mismatches = 0, maxDifference = 0;
          for (let i = 0; i < length; i++) { const d = Math.abs(actual[i] - expected[i]); maxDifference = Math.max(maxDifference, d); mismatches += Number(d > 1e-7); }
          rows.push({ sampleRate, cropped, stopDuring, first, second, firstAt, secondAt, gapSeconds: .35,
            frames: length, stoppedAt, initialState, stateBeforeStop, finalState: player.state, completions,
            expectedCompletions: stopDuring === 'none' ? 1 : 0, sampleMismatches: mismatches, maxDifference,
            referenceUnchanged: reference.every((value, i) => value === Math.fround(.1 + .02 * (i % 97) / 97)),
            attemptUnchanged: attempt.every((value, i) => value === Math.fround(-.1 - .02 * (i % 89) / 89)) });
        }
      }
      return { rows, unsupported };
    });
    for (const row of rows.rows) {
      assert.equal(row.sampleMismatches, 0, JSON.stringify(row));
      assert.equal(row.completions, row.expectedCompletions, JSON.stringify(row));
      assert.equal(row.finalState.phase, 'idle');
      assert.ok(row.referenceUnchanged && row.attemptUnchanged);
      if (['reference', 'gap', 'attempt'].includes(row.stopDuring)) assert.equal(row.stateBeforeStop.phase, row.stopDuring);
    }
    const live = await page.evaluate(async () => {
      const rows = [];
      for (const stopDuring of ['before-start', 'reference', 'gap', 'attempt']) {
        const sampleRate = 48000, context = new AudioContext({ sampleRate }); await context.resume();
        const analyser = context.createAnalyser(); analyser.fftSize = 128; analyser.connect(context.destination);
        const starts = [], stops = [], nativeCreate = context.createBufferSource.bind(context);
        context.createBufferSource = () => {
          const node = nativeCreate(), start = node.start.bind(node), stop = node.stop.bind(node), connect = node.connect.bind(node);
          node.start = when => { starts.push(when); start(when); };
          node.stop = () => { stops.push(context.currentTime); stop(); };
          node.connect = () => connect(analyser);
          return node;
        };
        const player = new PairedStudy.PairedPlayer(context); let completions = 0;
        const wait = async target => {
          const deadline = performance.now() + 5000;
          while (context.currentTime < target) {
            if (performance.now() > deadline) throw new Error('Native audio clock did not advance');
            await new Promise(done => setTimeout(done, 5));
          }
        };
        try {
          player.play({ pcm: new Float32Array(Math.round(sampleRate * .24)).fill(.1), sampleRate },
            { pcm: new Float32Array(Math.round(sampleRate * .18)).fill(-.1), sampleRate }, () => completions++);
          const target = stopDuring === 'reference' ? starts[0] + .12 : stopDuring === 'gap' ? starts[0] + .24 + .175 : starts[1] + .09;
          if (stopDuring !== 'before-start') await wait(target);
          const stateBeforeStop = player.state; player.stop();
          const stoppedAt = context.currentTime;
          await wait(stoppedAt + .064);
          let peakAfterStop = 0, observations = 0;
          do {
            const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
            peakAfterStop = Math.max(peakAfterStop, ...samples.map(Math.abs)); observations++;
            await wait(context.currentTime + .016);
          } while (context.currentTime < starts[1] + .18 + .08);
          rows.push({ stopDuring, stateBeforeStop, stoppedAt, starts, stops, peakAfterStop, observations,
            finalState: player.state, completions, attemptStoppedBeforeStart: stops[1] < starts[1] });
        } finally { player.stop(); await context.close(); }
      }
      return rows;
    });
    for (const row of live) {
      assert.equal(row.peakAfterStop, 0, JSON.stringify(row));
      assert.equal(row.completions, 0);
      assert.equal(row.stops.length, 2);
      assert.equal(row.finalState.phase, 'idle');
      if (row.stopDuring !== 'before-start') assert.equal(row.stateBeforeStop.phase, row.stopDuring);
      if (row.stopDuring !== 'attempt') assert.equal(row.attemptStoppedBeforeStart, true);
    }
    results.push({ engine, version: browser.version(), offline: rows.rows, unavailableOfflineControls: rows.unsupported, live });
    console.log(engine, rows.rows.length, 'native renders match independent sample arrays;', live.length, 'live cancellation cases');
  } finally { await browser.close(); }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await writeFile(output, JSON.stringify({ scope: 'Synthetic positive/negative ramps, rendered by real OfflineAudioContext. Independent sample arrays specify passage order, the 350 ms silence and cancellation boundaries. No acoustic device or human listening assessment.',
  sourceSha256: hash(await readFile(join(root, 'src/audio/pairedPlayback.ts'))), bundleSha256: hash(bundle),
  driverSha256: hash(await readFile(new URL(import.meta.url))), offlineCases: results.reduce((n, row) => n + row.offline.length, 0), liveCases: results.reduce((n, row) => n + row.live.length, 0), unavailableOfflineControls: results.reduce((n, row) => n + row.unavailableOfflineControls.length, 0), results }, null, 2) + '\n');
