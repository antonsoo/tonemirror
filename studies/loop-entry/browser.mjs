// Actual first playback and region edits in the production build, offline before import.
// node browser.mjs DIST OUTPUT_DIR [--baseline]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium, firefox } from '@playwright/test';

const [distArg, outputArg, mode] = process.argv.slice(2);
const dist = resolve(distArg), output = resolve(outputArg), baseline = mode === '--baseline';
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sampleRate = 48000, samples = sampleRate * 4;
const wav = Buffer.alloc(44 + samples * 4);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36);
wav.writeUInt32LE(samples * 4, 40);
for (let i = 0; i < samples; i++) wav.writeFloatLE(0.05 + i / (sampleRate * 8), 44 + i * 4);
const captures = [];

for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
  const browser = await launcher.launch();
  try {
    for (const width of [1440, 375]) {
      let stopped = false;
      const errors = [], offlineRequests = [], assets = {}, pending = [];
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
      const close = async () => {
        if (stopped) return;
        stopped = true; server.closeAllConnections();
        await new Promise(done => server.close(done));
      };
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      try {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (stopped && /^https?:/.test(r.url())) offlineRequests.push(r.url()); });
        page.on('response', r => {
          if (!/^https?:/.test(r.url())) return;
          pending.push((async () => {
            const name = new URL(r.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await r.body();
            assert.equal(hash(bytes), hash(await readFile(resolve(dist, name))));
            assets[name] = { bytes: bytes.length, sha256: hash(bytes) };
          })());
        });
        await page.addInitScript(() => {
          window.probe = { starts: [], observations: [], capture: false, active: null, policyViolations: [], original: null };
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker { postMessage(message, ...args) {
            if (message.type === 'analyze') window.probe.original = message.pcm.slice();
            return super.postMessage(message, ...args);
          } };
          document.addEventListener('securitypolicyviolation', e => window.probe.policyViolations.push(e.violatedDirective));
          // Keep real nodes, real audio clocks and the original destination.
          const create = AudioContext.prototype.createBufferSource;
          AudioContext.prototype.createBufferSource = function (...args) {
            const source = create.apply(this, args), ctx = this;
            const analyser = ctx.createAnalyser(); analyser.fftSize = 32;
            const connect = source.connect.bind(source), start = source.start.bind(source), stop = source.stop.bind(source);
            source.connect = destination => { connect(analyser); return analyser.connect(destination); };
            source.start = (...startArgs) => {
              start(...startArgs);
              const record = { source, analyser, context: ctx, startedAt: ctx.currentTime };
              window.probe.active = record;
              window.probe.starts.push({ offset: startArgs[1], loop: source.loop, loopStart: source.loopStart, loopEnd: source.loopEnd, nativeRate: source.playbackRate.value });
            };
            source.stop = (...stopArgs) => {
              if (window.probe.active?.source === source) window.probe.active = null;
              return stop(...stopArgs);
            };
            return source;
          };
          const paths = new WeakMap(), proto = CanvasRenderingContext2D.prototype;
          for (const method of ['beginPath', 'moveTo', 'lineTo', 'stroke']) {
            const native = proto[method];
            proto[method] = function (...args) {
              if (method === 'beginPath') paths.set(this, []);
              else if (method === 'moveTo' || method === 'lineTo') paths.get(this)?.push(args);
              else {
                const points = paths.get(this), active = window.probe.active;
                if (window.probe.capture && active && this.canvas.closest('#audio-analysis') && this.lineWidth === 2 &&
                    points?.length === 2 && points[0][0] === points[1][0] && points[0][1] === 0 && points[1][1] > 0) {
                  const data = new Float32Array(32);
                  active.analyser.getFloatTimeDomainData(data);
                  const cursor = points[0][0] / this.canvas.clientWidth * active.source.buffer.duration;
                  const audio = (data.at(-1) - 0.05) * 8;
                  window.probe.observations.push({ cursor, audio, errorSeconds: Math.abs(cursor - audio),
                    rate: active.source.playbackRate.value, contextTime: active.context.currentTime });
                }
              }
              return native.apply(this, args);
            };
          }
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/tonemirror/`);
        const input = page.getByLabel('Choose an audio file to load');
        await input.waitFor({ state: 'attached' });
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(f => f.load())); });
        await Promise.all(pending); await close(); await context.setOffline(true);
        await input.setInputFiles({ name: 'synthetic-time-ramp.wav', mimeType: 'audio/wav', buffer: wav });
        await page.waitForFunction(() => document.querySelector('.tm-status')?.textContent.includes('synthetic-time-ramp.wav —'), null, { timeout: 60_000 });
        const play = page.locator('#audio-analysis').getByRole('button', { name: /Play|Pause/ });
        const button = name => page.getByRole('button', { name, exact: true });
        const region = async (start, end) => {
          await page.getByLabel('Region start (s)').fill(String(start));
          await page.getByLabel('Region end (s)').fill(String(end));
          await button('Loop region').focus(); await page.keyboard.press('Enter');
        };
        const capture = async (start, end) => {
          await page.evaluate(() => { window.probe.observations = []; window.probe.capture = true; });
          await page.waitForFunction(() => window.probe.observations.length >= 12);
          await page.evaluate(() => { window.probe.capture = false; });
          const observations = await page.evaluate(() => window.probe.observations);
          return { observations, inside: observations.every(o => o.audio >= start - .001 && o.audio < end + .001),
            maxErrorSeconds: Math.max(...observations.map(o => o.errorSeconds)) };
        };
        await region(1, 2); await play.focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.probe.active && window.probe.active.context.currentTime - window.probe.active.startedAt >= .1);
        const first = await capture(1, 2);
        await play.click();
        const screenshot = `${engine}-${width}.png`;
        await page.locator('#audio-analysis').screenshot({ path: resolve(output, screenshot) });
        await play.click(); await region(2, 3);
        const moved = await capture(2, 3);
        const beforeClear = await page.evaluate(() => window.probe.starts.length);
        await button('Clear loop').click();
        const cleared = await capture(0, 4);
        const clearRetainsNode = await page.evaluate(n => window.probe.starts.length === n && window.probe.active.source.loop === false, beforeClear);
        await play.click();
        // A fresh decode resets the paused cursor to zero before preparing real slow audio.
        await input.setInputFiles({ name: 'synthetic-time-ramp.wav', mimeType: 'audio/wav', buffer: wav });
        await page.waitForFunction(() => document.querySelector('.tm-status')?.textContent.includes('synthetic-time-ramp.wav —'));
        await region(1, 2);
        await page.getByLabel('half-speed, same pitch', { exact: true }).check();
        await play.click();
        await page.waitForFunction(() => document.querySelector('#playback-note')?.textContent.includes('pitch preserved'));
        const half = await page.evaluate(() => {
          const start = window.probe.starts.at(-1);
          return { ...start, matches: start.offset === 2 && start.loopStart === 2 && start.loopEnd === 4 && start.nativeRate === 1 };
        });
        await play.click();
        const pendingDownload = page.waitForEvent('download'); await button('Download WAV').click();
        const downloaded = await readFile(await (await pendingDownload).path());
        let data;
        for (let at = 12; at + 8 <= downloaded.length;) {
          const size = downloaded.readUInt32LE(at + 4);
          if (downloaded.toString('ascii', at, at + 4) === 'data') data = downloaded.subarray(at + 8, at + 8 + size);
          at += 8 + size + size % 2;
        }
        assert.ok(data);
        const original = await page.evaluate(async () => {
          const pcm = window.probe.original;
          const bytes = await crypto.subtle.digest('SHA-256', pcm);
          return { samples: pcm.length, sha256: [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('') };
        });
        const exportMatches = data.length === original.samples * 4 && hash(data) === original.sha256;
        const measured = await page.evaluate(() => ({ starts: window.probe.starts,
          policyViolations: window.probe.policyViolations,
          overflow: document.documentElement.scrollWidth - innerWidth }));
        const maxErrorSeconds = Math.max(first.maxErrorSeconds, moved.maxErrorSeconds, cleared.maxErrorSeconds);
        assert.deepEqual(errors, []); assert.deepEqual(offlineRequests, []);
        assert.deepEqual(measured.policyViolations, []); assert.equal(measured.overflow, 0);
        captures.push({ engine, browser: browser.version(), width, ...measured, first, moved, cleared, clearRetainsNode, half, original, exportMatches, maxErrorSeconds,
          toleranceSeconds: 0.064, matches: first.inside && moved.inside && half.matches && clearRetainsNode && exportMatches && maxErrorSeconds <= 0.064, errors, offlineRequests, assets, screenshot });
        console.log(`${engine} ${width}: largest cursor/audio difference ${maxErrorSeconds.toFixed(6)} seconds`);
      } finally { await context.close(); await close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({
  synthetic: true, fixture: { bytes: wav.length, sha256: hash(wav), sampleRate, durationSeconds: 4 },
  baseline, scope: 'Normal-speed native audio and painted cursor; actual prepared half-speed node offsets; exact original PCM export. No microphone or acoustic validation.', captures,
}, null, 2) + '\n');
if (!baseline) assert.ok(captures.every(row => row.matches));
