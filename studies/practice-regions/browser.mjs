/* global window, document, innerWidth, indexedDB */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox } from '@playwright/test';

const [distArg, cacheArg, outputArg, mode] = process.argv.slice(2);
assert.ok(distArg && cacheArg && outputArg && ['before', 'after'].includes(mode), 'DIST CACHE OUTPUT before|after');
const dist = resolve(distArg), cache = resolve(cacheArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../real-voice/manifest.json', import.meta.url)));
const fixtures = ['ptdb/F01/mic_F01_sa1.wav', 'ptdb/M01/mic_M01_sa1.wav'].map(path => manifest.files.find(file => file.path === path));
for (const fixture of fixtures) {
  const bytes = await readFile(resolve(cache, fixture.path));
  assert.equal(bytes.length, fixture.bytes); assert.equal(hash(bytes), fixture.sha256);
}
const results = [];
for (const [name, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) for (const fixture of fixtures) {
      const served = {}, pending = [], errors = [], offlineRequests = [], external = [];
      const server = createServer(async (request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tonemirror\//, '') || 'index.html';
        const path = resolve(dist, name);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
          response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: width === 375 ? 'light' : 'dark' });
      try {
        const page = await context.newPage();
        let offline = false;
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (!/^https?:/.test(request.url())) return;
          if (offline) offlineRequests.push(request.url());
          if (new URL(request.url()).origin !== origin) external.push(request.url());
        });
        page.on('response', response => {
          if (!/^https?:/.test(response.url())) return;
          pending.push((async () => {
            const file = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await response.body();
            assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))));
            served[file] = { bytes: bytes.length, sha256: hash(bytes) };
          })());
        });
        await page.addInitScript(() => {
          window.probe = { inputs: [], playback: null, violations: [], voicedFrames: 0 };
          document.addEventListener('securitypolicyviolation', event => window.probe.violations.push(event.violatedDirective));
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args);
              this.addEventListener('message', event => {
                if (event.data.contour) window.probe.voicedFrames = event.data.contour.points.filter(point => point.voiced).length;
              });
            }
            postMessage(message, ...rest) {
              if (message.type === 'analyze') window.probe.inputs.push({ pcm: message.pcm.slice(), sampleRate: message.sampleRate });
              return super.postMessage(message, ...rest);
            }
          };
          const start = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function (...args) {
            window.probe.playback = this.buffer.getChannelData(0).slice();
            return start.apply(this, args);
          };
        });
        await page.goto(`${origin}/tonemirror/`);
        await page.getByLabel('Choose an audio file to load').waitFor();
        await Promise.all(pending);
        offline = true;
        await context.setOffline(true);
        const button = name => page.getByRole('button', { name, exact: true });
        await page.getByLabel('Choose an audio file to load').setInputFiles(resolve(cache, fixture.path));
        await page.waitForFunction(() => document.querySelector('.tm-clip-label')?.textContent.includes('.wav ·'));
        const duration = await page.evaluate(() => window.probe.inputs[0].pcm.length / window.probe.inputs[0].sampleRate);
        if (mode === 'before') {
          const box = await page.locator('#audio-analysis canvas').boundingBox();
          await page.mouse.move(box.x + box.width * 3 / duration, box.y + 20); await page.mouse.down();
          await page.mouse.move(box.x + box.width * 4 / duration, box.y + 20); await page.mouse.up();
          assert.equal(await button('Keep region').count(), 0);
        } else {
          await page.getByLabel('Region start (s)').fill('3');
          await page.getByLabel('Region end (s)').fill('4');
          await button('Keep region').focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('.tm-clip-label')?.textContent.includes('· 1.00s'));
          await button('▶ Play').click(); await button('⏸ Pause').click();
        }
        page.once('dialog', dialog => dialog.accept('Speech region'));
        await button('Save current attempt').click();
        await page.getByText('Saved Speech region on this device.', { exact: true }).waitFor();
        const evidence = await page.evaluate(async mode => {
          const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('tonemirror'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
          });
          const stored = await new Promise((resolve, reject) => {
            const get = db.transaction('references').objectStore('references').getAll();
            get.onsuccess = () => resolve(new Float32Array(get.result[0].pcmBuffer)); get.onerror = () => reject(get.error);
          });
          db.close();
          const original = window.probe.inputs[0], expected = mode === 'before' ? original.pcm : original.pcm.slice(3 * original.sampleRate, 4 * original.sampleRate);
          const differences = pcm => pcm.length === expected.length ? pcm.reduce((n, value, i) => n + Number(value !== expected[i]), 0) : -1;
          return { requestedSeconds: [3, 4], voicedFrames: window.probe.voicedFrames, sourceSamples: original.pcm.length, sampleRate: original.sampleRate, storedSamples: stored.length,
            storedMismatches: differences(stored), analyzedMismatches: differences(window.probe.inputs.at(-1).pcm),
            playbackMismatches: mode === 'after' ? differences(window.probe.playback) : null };
        }, mode);
        assert.equal(evidence.storedMismatches, 0); assert.equal(evidence.analyzedMismatches, 0);
        if (mode === 'after') {
          assert.equal(evidence.playbackMismatches, 0); assert.ok(evidence.voicedFrames > 0);
          assert.equal(evidence.storedSamples, evidence.sampleRate);
          if (fixture.path.includes('F01')) await page.locator('#audio-analysis').screenshot({ path: resolve(output, `${name}-${width}.png`) });
          await button('Restore full clip').click();
          await page.waitForFunction(() => !document.querySelector('.tm-clip-label')?.textContent.includes('[3.000'));
          assert.ok(await page.evaluate(() => window.probe.inputs.at(-1).pcm.length === window.probe.inputs[0].pcm.length && window.probe.inputs.at(-1).pcm.every((value, i) => value === window.probe.inputs[0].pcm[i])));
        } else assert.equal(evidence.storedSamples, evidence.sourceSamples);
        assert.deepEqual(errors, []); assert.deepEqual(offlineRequests, []); assert.deepEqual(external, []);
        assert.deepEqual(await page.evaluate(() => window.probe.violations), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        results.push({ browser: name, version: browser.version(), width, fixture, ...evidence,
          restoredExactly: mode === 'after' ? true : null, offlineRequests, external, errors, served });
      } finally {
        await context.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
      }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify({ mode, results }, null, 2) + '\n');
console.log(`${mode}: ${results.length} recorded-speech workflows checked`);
