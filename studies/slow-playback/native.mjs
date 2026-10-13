// Render through the actual ClipPlayer and each browser's native audio graph.
// node studies/slow-playback/native.mjs CHECKOUT OUTPUT_JSON before|after
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, firefox } from '@playwright/test';
const [rootArg, output, mode] = process.argv.slice(2), root = resolve(rootArg);
assert.ok(['before', 'after'].includes(mode));
const bundled = await build({ stdin: { contents: `export { ClipPlayer } from './src/audio/playback.ts'; ${mode === 'after' ? "export { prepareHalfSpeed } from './src/audio/slowPlayback.ts';" : ''}`, resolveDir: root }, bundle: true, format: 'iife', globalName: 'Playback', write: false });
const results = [];
for (const [engine, driver] of Object.entries({ chromium, firefox })) {
  const browser = await driver.launch();
  try {
    const page = await browser.newPage(); await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const rendered = await page.evaluate(async mode => {
      const rate = 48000, cases = [];
      for (const kind of ['tone', 'chirp', 'bursts']) {
        const seconds = kind === 'tone' ? 1 : 2;
        const pcm = Float32Array.from({ length: rate * seconds }, (_, i) => {
          const t = i / rate;
          if (kind === 'tone') return .3 * Math.sin(2 * Math.PI * 440 * t);
          if (kind === 'chirp') return .3 * Math.sin(2 * Math.PI * (220 * t + 55 * t * t));
          const envelope = [.25, 1, 1.75].reduce((s, center) => s + Math.exp(-(((t - center) / .02) ** 2)), 0);
          return .3 * envelope * Math.sin(2 * Math.PI * 440 * t);
        });
        const context = new OfflineAudioContext(1, rate * (seconds * 2 + .25), rate);
        const player = new Playback.ClipPlayer(context); player.load(pcm, rate);
        const start = performance.now();
        if (mode === 'after') player.loadHalfSpeed(await Playback.prepareHalfSpeed(pcm, rate));
        const preparationMs = performance.now() - start;
        player.setHalfSpeed(true); player.play();
        const out = (await context.startRendering()).getChannelData(0);
        function frequency(center, window) {
          const points = [];
          for (let i = Math.ceil((center - window / 2) * rate); i < (center + window / 2) * rate; i++) {
            if (out[i - 1] < 0 && out[i] >= 0) points.push(i - 1 - out[i - 1] / (out[i] - out[i - 1]));
          }
          return (points.length - 1) * rate / (points.at(-1) - points[0]);
        }
        let last = out.length - 1; while (last >= 0 && Math.abs(out[last]) < 1e-5) last--;
        const probes = kind === 'bursts' ? [.5, 2, 3.5].map(expected => {
          let energy = 0, moment = 0;
          for (let i = Math.ceil((expected - .2) * rate); i < (expected + .2) * rate; i++) {
            energy += out[i] ** 2; moment += i / rate * out[i] ** 2;
          }
          return { expectedSecond: expected, energyCentroidSecond: moment / energy, errorMs: 1000 * (moment / energy - expected) };
        }) : (kind === 'tone' ? [1] : [.5, 1, 2, 3, 3.5]).map(t => {
          const expectedHz = kind === 'tone' ? 440 : 220 + 110 * t / 2, measuredHz = frequency(t, kind === 'tone' ? 1.5 : .1);
          return { outputSecond: t, expectedHz, measuredHz, cents: 1200 * Math.log2(measuredHz / expectedHz) };
        });
        cases.push({ kind, inputSamples: pcm.length, inputSeconds: seconds, lastAudibleSecond: (last + 1) / rate,
          preparationMs, finite: out.every(Number.isFinite), probes });
      }
      return cases;
    }, mode);
    for (const c of rendered) {
      assert.ok(c.finite);
      if (mode === 'after' && c.kind !== 'bursts') for (const p of c.probes) assert.ok(Math.abs(p.cents) < 20, JSON.stringify(p));
      if (mode === 'before' && c.kind === 'tone') assert.ok(Math.abs(c.probes[0].cents + 1200) < 1);
    }
    results.push({ engine, browser: browser.version(), cases: rendered });
  } finally { await browser.close(); }
}
await writeFile(output, JSON.stringify({ mode, results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(r => ({ engine: r.engine, cases: r.cases.map(c => ({ kind: c.kind, probes: c.probes })) })), null, 2));
