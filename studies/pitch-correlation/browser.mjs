/** Actual production file intake, offline after initial page/font load.
 * node browser.mjs DIST PHRASE_WAV REPEATED_WAV OUTPUT_DIR [desktop|all]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, firefox } from '@playwright/test';
const [distArg, phrase, repeated, outputArg, mode = 'all'] = process.argv.slice(2);
const dist = resolve(distArg), output = resolve(outputArg);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const rows = [], captures = [];
for (const [engine, type] of Object.entries({ chromium, firefox })) {
  const browser = await type.launch();
  try {
    for (const width of mode === 'desktop' ? [1440] : [1440, 375]) {
      const assets = {}, pendingAssets = [], errors = [], requests = [];
      let offline = false, closed = false;
      const server = createServer(async (request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tonemirror\//, '') || 'index.html';
        const path = resolve(dist, name);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const close = async () => { if (!closed) { closed = true; server.closeAllConnections(); await new Promise(done => server.close(done)); } };
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', r => { if (offline && /^https?:/.test(r.url())) requests.push(r.url()); });
        page.on('response', r => { if (/^https?:/.test(r.url())) pendingAssets.push((async () => {
          const name = new URL(r.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
          const bytes = await r.body(); assert.equal(sha(bytes), sha(await readFile(resolve(dist, name)))); assets[name] = { bytes: bytes.length, sha256: sha(bytes) };
        })()); });
        await page.addInitScript(() => {
          window.measurements = []; window.policyViolations = [];
          document.addEventListener('securitypolicyviolation', e => window.policyViolations.push(e.violatedDirective));
          const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args); this.pending = new Map();
              this.addEventListener('message', e => {
                const record = this.pending.get(e.data.requestId);
                if (!record || e.data.type !== 'analyzed') return;
                record.workerMs = performance.now() - record.start;
                const { contour, spectrogram } = e.data;
                record.frames = contour.points.length;
                record.voiced = contour.points.filter(p => p.voiced).length;
                // Quantization is explicit; the native corpus replay checks unrounded deltas.
                const rounded = contour.points.map(p => [p.time, p.voiced, p.f0 === null ? null : +p.f0.toFixed(3), p.semitone === null ? null : +p.semitone.toFixed(6), +p.confidence.toFixed(6)]);
                const flat = new Float32Array(spectrogram.frames.reduce((n, f) => n + f.length, 0));
                let offset = 0; for (const f of spectrogram.frames) { flat.set(f, offset); offset += f.length; }
                Promise.all([record.pcmHash, digest(new TextEncoder().encode(JSON.stringify(rounded))), digest(flat.buffer)]).then(([pcmSha256, contourRoundedSha256, spectrumSha256]) => {
                  delete record.pcmHash; delete record.start;
                  window.measurements.push({ ...record, pcmSha256, contourRoundedSha256, spectrumSha256 });
                });
              });
            }
            postMessage(message, ...args) {
              if (message.type === 'analyze') {
                const copy = message.pcm.slice();
                const record = { algorithm: message.algorithm, sampleRate: message.sampleRate, samples: copy.length, start: performance.now() };
                this.pending.set(message.requestId, record);
                super.postMessage(message, ...args);
                record.pcmHash = digest(copy.buffer);
              } else super.postMessage(message, ...args);
            }
          };
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/tonemirror/`);
        await page.getByLabel('Choose an audio file to load').waitFor({ state: 'attached' });
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(f => f.load())); });
        await Promise.all(pendingAssets); await close(); offline = true;
        const input = page.getByLabel('Choose an audio file to load');
        let algorithm = 'yin';
        const waitAnalysis = async count => {
          await page.waitForFunction(n => window.measurements.length > n, count, { timeout: 60_000 });
          await page.waitForFunction(() => !/Analy[sz]|Loading/.test(document.querySelector('.tm-status')?.textContent ?? ''), null, { timeout: 60_000 });
        };
        for (const desired of ['yin', 'mpm']) {
          if (desired !== algorithm) {
            const count = await page.evaluate(() => window.measurements.length);
            await page.getByLabel('Pitch detection algorithm').selectOption(desired);
            await waitAnalysis(count); algorithm = desired;
          }
          // Warm each algorithm with the real phrase before measured uploads.
          let count = await page.evaluate(() => window.measurements.length);
          await input.setInputFiles(phrase); await waitAnalysis(count);
          for (const [fixture, file] of [['phrase', phrase], ['repeated60', repeated]]) {
            for (let iteration = 0; iteration < (width === 1440 ? 3 : 1); iteration++) {
              count = await page.evaluate(() => window.measurements.length);
              const start = performance.now(); await input.setInputFiles(file); await waitAnalysis(count);
              const uploadToReadyMs = performance.now() - start;
              const measurements = await page.evaluate(n => window.measurements.slice(n), count);
              assert.equal(measurements.length, 1);
              rows.push({ engine, browser: browser.version(), width, fixture, algorithm, iteration, uploadToReadyMs, ...measurements[0] });
            }
          }
        }
        // Finish with a real-voice reference/attempt overlay and the visible score.
        let count = await page.evaluate(() => window.measurements.length);
        await input.setInputFiles(phrase); await waitAnalysis(count);
        await page.getByRole('tab', { name: 'Reference', exact: true }).click();
        count = await page.evaluate(() => window.measurements.length);
        await input.setInputFiles(phrase); await waitAnalysis(count);
        await page.waitForFunction(() => document.querySelector('.tm-score')?.textContent === '100');
        const scores = { mpm: await page.locator('.tm-score').innerText() };
        await page.getByLabel('Pitch detection algorithm').selectOption('yin');
        await page.waitForFunction(() => document.querySelector('.tm-status')?.textContent === 'Pitch analysis updated (YIN).' && document.querySelector('.tm-score')?.textContent === '100');
        scores.yin = await page.locator('.tm-score').innerText();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        const policyViolations = await page.evaluate(() => window.policyViolations);
        assert.equal(overflow, 0); assert.deepEqual(errors, []); assert.deepEqual(requests, []); assert.deepEqual(policyViolations, []);
        const screenshot = `${engine}-${width}.png`;
        await page.screenshot({ path: resolve(output, screenshot), fullPage: true });
        captures.push({ engine, width, scores, overflow, errors, requestsAfterServerStopped: requests, policyViolations, assets, screenshot });
      } finally { await context.close(); await close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ node: process.version, rows, captures }, null, 2) + '\n');
console.log(`Completed ${rows.length} timed uploads and ${captures.length} offline comparison captures`);
