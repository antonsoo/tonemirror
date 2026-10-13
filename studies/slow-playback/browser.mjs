// node studies/slow-playback/browser.mjs DIST SPEECH_CACHE OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const [distArg, cacheArg, outputArg] = process.argv.slice(2);
const dist = resolve(distArg), cache = resolve(cacheArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../real-voice/manifest.json', import.meta.url)));
const fixture = manifest.files.find(f => f.path === 'ptdb/F01/mic_F01_sa1.wav');
assert.equal(hash(await readFile(resolve(cache, fixture.path))), fixture.sha256);
const results = [];
for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const served = {}, pending = [], errors = [], external = [], late = [];
      const server = createServer(async (request, response) => {
        const file = new URL(request.url, 'http://localhost').pathname.replace(/^\/tonemirror\//, '') || 'index.html';
        const path = resolve(dist, file);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream' });
          response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme: width === 375 ? 'light' : 'dark' });
      try {
        const page = await context.newPage(); let offline = false;
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (/^https?:/.test(r.url())) { if (offline) late.push(r.url()); if (new URL(r.url()).origin !== origin) external.push(r.url()); } });
        page.on('response', response => {
          if (!/^https?:/.test(response.url())) return;
          pending.push((async () => {
            const file = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await response.body(); assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))));
            served[file] = { bytes: bytes.length, sha256: hash(bytes) };
          })());
        });
        await page.addInitScript(() => {
          window.slowStudy = { violations: [], jobs: 0, terminated: 0, starts: [], elapsed: [] };
          document.addEventListener('securitypolicyviolation', e => window.slowStudy.violations.push(e.violatedDirective));
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            postMessage(message, ...rest) {
              if (message.type === 'analyze') window.slowStudy.decoded = { samples: message.pcm.length, rate: message.sampleRate };
              if (message.type === 'prepare-half-speed') {
                this.slow = true; window.slowStudy.jobs++; const start = performance.now();
                this.addEventListener('message', () => window.slowStudy.elapsed.push(performance.now() - start), { once: true });
              }
              return super.postMessage(message, ...rest);
            }
            terminate() { if (this.slow) window.slowStudy.terminated++; super.terminate(); }
          };
          const start = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function (...args) {
            window.slowStudy.starts.push({ samples: this.buffer.length, rate: this.buffer.sampleRate,
              nativeRate: this.playbackRate.value, offset: args[1] ?? 0, loopStart: this.loopStart, loopEnd: this.loopEnd });
            return start.apply(this, args);
          };
        });
        await page.goto(`${origin}/tonemirror/`);
        await page.evaluate(async () => {
          await Promise.all(['400 24px Fraunces', '500 24px Fraunces', '600 24px Fraunces', 'italic 500 24px Fraunces'].map(font => document.fonts.load(font)));
          await document.fonts.ready;
        });
        await Promise.all(pending);
        await context.setOffline(true); await new Promise(done => server.close(done)); offline = true;
        const button = name => page.getByRole('button', { name, exact: true });
        await page.getByLabel('Choose an audio file to load').setInputFiles(resolve(cache, fixture.path));
        await expect(page.locator('.tm-clip-label')).toContainText('F01_sa1.wav ·');
        await page.getByLabel('Region start (s)').fill('3'); await page.getByLabel('Region end (s)').fill('4');
        await button('Loop region').click();
        await page.getByRole('checkbox', { name: 'half-speed, same pitch', exact: true }).focus(); await page.keyboard.press('Space');
        await button('▶ Play').focus(); await page.keyboard.press('Enter');
        await expect(page.locator('#playback-note')).toContainText('pitch preserved');
        await expect(button('⏸ Pause')).toBeVisible();
        const first = await page.evaluate(() => window.slowStudy.starts.at(-1));
        assert.equal(first.nativeRate, 1); assert.equal(first.loopStart, 6); assert.equal(first.loopEnd, 8);
        await button('⏸ Pause').focus(); await page.keyboard.press('Enter');
        await button('▶ Play').click(); await expect(button('⏸ Pause')).toBeVisible();
        await page.locator('#audio-analysis').screenshot({ path: resolve(output, `${engineName}-${width}.png`) });
        await button('⏸ Pause').click();
        const axe = (await new AxeBuilder({ page }).analyze()).violations;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        const probe = await page.evaluate(() => window.slowStudy);
        assert.equal(probe.jobs, 1); assert.equal(probe.terminated, 1); assert.equal(probe.starts.length, 2);
        assert.equal(axe.length, 0); assert.equal(overflow, false); assert.deepEqual(probe.violations, []);
        assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(late, []);
        let longClip = null;
        if (width === 1440) {
          const rate = 48000, samples = rate * 60, wav = Buffer.alloc(44 + samples * 4);
          wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
          wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
          wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34);
          wav.write('data', 36); wav.writeUInt32LE(samples * 4, 40);
          for (let i = 0; i < samples; i++) wav.writeFloatLE(.3 * Math.sin(2 * Math.PI * 220 * i / rate), 44 + i * 4);
          await page.getByLabel('Choose an audio file to load').setInputFiles({ name: 'synthetic-60-seconds.wav', mimeType: 'audio/wav', buffer: wav });
          await expect(page.locator('.tm-clip-label')).toContainText('60.00s');
          await button('▶ Play').click();
          await expect.poll(() => page.evaluate(() => window.slowStudy.jobs)).toBe(2);
          const start = performance.now(); await button('Cancel playback').click();
          await expect(button('▶ Play')).toBeVisible();
          const cancelMs = performance.now() - start;
          assert.equal(await page.evaluate(() => window.slowStudy.terminated), 2);
          assert.equal(await page.evaluate(() => window.slowStudy.starts.length), 2);
          await button('▶ Play').click(); await expect(button('⏸ Pause')).toBeVisible();
          await button('⏸ Pause').click();
          longClip = { cancellationRoundTripMs: cancelMs, ...await page.evaluate(() => window.slowStudy) };
          assert.equal(longClip.jobs, 3); assert.equal(longClip.terminated, 3);
          // decodeAudioData may resample to the context's 44.1 kHz rate.
          assert.equal(longClip.starts.at(-1).samples, longClip.decoded.samples * 2);
          assert.ok(Math.abs(longClip.decoded.samples / longClip.decoded.rate - 60) < .001);
          assert.equal(longClip.starts.at(-1).nativeRate, 1);
          assert.deepEqual(longClip.violations, []);
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(late, []);
        }
        results.push({ engine: engineName, browser: browser.version(), width, fixture, axeViolations: axe.length, overflow,
          pageErrors: errors, externalRequests: external, requestsAfterDisconnect: late, ...probe, longClip, served });
        console.log(`${engineName} ${width}: offline speech playback, keyboard controls, cached resume, native loop mapping, screenshot and axe passed`);
      } finally { await context.close(); if (server.listening) await new Promise(done => server.close(done)); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ results }, null, 2) + '\n');
