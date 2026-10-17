// Production listening workflow using two excerpts from the attributed Mandarin recording.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const [distArg, outputArg] = process.argv.slice(2);
assert.ok(distArg && outputArg, 'DIST OUTPUT');
const dist = resolve(distArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const errors = [], external = [], offlineRequests = [], pending = [], assets = {}, assetErrors = [];
      let offline = false, captureAssets = true;
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
      const origin = process.env.TONEMIRROR_BROWSER_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme: width === 375 ? 'light' : 'dark' });
      const prefix = `${engineName}-${width}`;
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (!/^https?:/.test(request.url())) return;
          if (offline) offlineRequests.push(request.url());
          if (new URL(request.url()).origin !== origin) external.push(request.url());
        });
        page.on('response', response => {
          if (!captureAssets || response.status() !== 200 || !response.url().startsWith(origin)) return;
          pending.push((async () => {
            const file = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await response.body(); assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))));
            assets[file] = { bytes: bytes.length, sha256: hash(bytes) };
          })().catch(error => assetErrors.push(error.message)));
        });
        await page.addInitScript(() => {
          window.pairEvidence = { inputs: [], starts: [], nodes: [], stops: [], csp: [], slowJobs: 0 };
          document.addEventListener('securitypolicyviolation', event => window.pairEvidence.csp.push(event.violatedDirective));
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            postMessage(message, ...rest) {
              if (message.type === 'analyze') window.pairEvidence.inputs.push({ pcm: message.pcm.slice(), rate: message.sampleRate });
              if (message.type === 'prepare-half-speed') window.pairEvidence.slowJobs++;
              return super.postMessage(message, ...rest);
            }
          };
          const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
          AudioBufferSourceNode.prototype.start = function (...args) {
            const index = window.pairEvidence.nodes.push(this) - 1;
            window.pairEvidence.starts.push({ index, when: args[0] ?? 0, now: this.context.currentTime, pcm: this.buffer.getChannelData(0).slice(), rate: this.buffer.sampleRate,
              playbackRate: this.playbackRate.value, loop: this.loop, offset: args[1] ?? 0 });
            return start.apply(this, args);
          };
          AudioBufferSourceNode.prototype.stop = function (...args) {
            window.pairEvidence.stops.push({ index: window.pairEvidence.nodes.indexOf(this), at: this.context.currentTime });
            return stop.apply(this, args);
          };
        });
        await page.goto(`${origin}/tonemirror/`);
        await page.getByRole('group', { name: 'Recorded Mandarin references' }).waitFor();
        await page.evaluate(async () => { await Promise.allSettled(Array.from(document.fonts, face => face.load())); await document.fonts.ready; });
        for (let settled = 0; settled < pending.length;) { const batch = pending.slice(settled); settled = pending.length; await Promise.all(batch); }
        captureAssets = false; assert.deepEqual(assetErrors, []);
        await context.setOffline(true); offline = true;
        const button = name => page.getByRole('button', { name, exact: true });
        const note = page.locator('#paired-listening-status');
        const downloads = [];
        async function download(stage) {
          const event = page.waitForEvent('download'); await button('Download WAV').click();
          const item = await event; assert.equal(await item.failure(), null);
          const path = resolve(output, `${prefix}-${stage}.wav`); await item.saveAs(path);
          const bytes = await readFile(path);
          downloads.push({ file: `${prefix}-${stage}.wav`, bytes: bytes.length, sha256: hash(bytes), filename: item.suggestedFilename() });
          return path;
        }
        async function startPair() {
          await button('Play reference then attempt').click(); await expect(note).toHaveText('Listening to the reference.');
        }
        async function finishPair() {
          await expect(note).toHaveText('Brief pause before your attempt.');
          await expect(note).toHaveText('Listening to your attempt.');
          await expect(note).toHaveText('Finished listening to the reference and your attempt.');
        }
        async function region(start, end) {
          await page.getByLabel('Region start (s)').fill(String(start)); await page.getByLabel('Region end (s)').fill(String(end));
          await button('Loop region').click();
        }
        await expect(button('Play reference then attempt')).toBeDisabled();
        await button('Load recorded mà, tone 4').click();
        await expect(page.locator('.tm-clip-label')).toContainText('Recorded Mandarin mà');
        const falling = await download('falling-original');
        await button('Load recorded má, tone 2').click();
        await expect(page.locator('.tm-clip-label')).toContainText('Recorded Mandarin má');
        await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
        await page.getByLabel('Choose an audio file to load').setInputFiles(falling);
        await expect(page.locator('.tm-audio-credit')).toContainText('Wolfdog');
        await expect(button('Play reference then attempt')).toBeEnabled();
        await download('attempt-before');
        await page.getByRole('checkbox', { name: 'half-speed, same pitch', exact: true }).check();
        await startPair(); await finishPair();
        assert.equal((await page.getByRole('tab', { name: 'Your attempt', exact: true }).getAttribute('aria-selected')), 'true');
        const expectedFull = await page.evaluate(() => {
          const p = window.pairEvidence, expected = [p.inputs[1], p.inputs[2]];
          return p.starts.map((row, i) => ({ samples: row.pcm.length, rate: row.rate, when: row.when, playbackRate: row.playbackRate, loop: row.loop,
            matches: row.pcm.length === expected[i].pcm.length && row.pcm.every((v, at) => v === expected[i].pcm[at]) }));
        });
        assert.equal(expectedFull.length, 2); assert.ok(expectedFull.every(row => row.matches && row.playbackRate === 1 && !row.loop));
        assert.ok(Math.abs(expectedFull[1].when - expectedFull[0].when - expectedFull[0].samples / expectedFull[0].rate - .35) < 1e-10);
        const violations = (await new AxeBuilder({ page }).analyze()).violations; assert.deepEqual(violations, []);
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: resolve(output, `${prefix}.png`), fullPage: true });
        if (engineName === 'chromium' && width === 1440) await page.locator('.tm-panel').filter({ has: page.getByRole('heading', { name: '2. Compare contours' }) }).screenshot({ path: resolve(output, 'paired-listening.png') });
        await region(.1, .45);
        await page.getByRole('tab', { name: 'Reference', exact: true }).click(); await region(.1, .55);
        await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
        await startPair(); await button('Stop listening').click();
        await expect(note).toHaveText('Listening stopped.');
        const cancellation = await page.evaluate(() => ({ starts: window.pairEvidence.starts.slice(-2).map(row => ({ index: row.index, when: row.when })), stops: window.pairEvidence.stops.slice(-2) }));
        assert.equal(cancellation.stops.length, 2); assert.ok(cancellation.stops[1].at < cancellation.starts[1].when, JSON.stringify(cancellation));
        await startPair(); await finishPair();
        await download('attempt-after');
        assert.equal(downloads[1].sha256, downloads[2].sha256);
        const selected = await page.evaluate(async () => {
          const p = window.pairEvidence;
          const sha = async pcm => [...new Uint8Array(await crypto.subtle.digest('SHA-256', pcm))].map(b => b.toString(16).padStart(2, '0')).join('');
          const expected = [p.inputs[1].pcm.slice(Math.floor(.1 * p.inputs[1].rate), Math.ceil(.55 * p.inputs[1].rate)),
            p.inputs[2].pcm.slice(Math.floor(.1 * p.inputs[2].rate), Math.ceil(.45 * p.inputs[2].rate))];
          const starts = [];
          for (const [i, row] of p.starts.slice(-2).entries()) starts.push({ index: row.index, when: row.when, samples: row.pcm.length, rate: row.rate,
            sha256: await sha(row.pcm), expectedSha256: await sha(expected[i]), playbackRate: row.playbackRate, loop: row.loop });
          return { starts, analysisJobs: p.inputs.length, slowJobs: p.slowJobs, csp: p.csp };
        });
        assert.ok(selected.starts.every(row => row.sha256 === row.expectedSha256 && row.playbackRate === 1 && !row.loop));
        assert.equal(selected.analysisJobs, 3); assert.equal(selected.slowJobs, 0);
        assert.deepEqual(selected.csp, []); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(offlineRequests, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        results.push({ engine: engineName, width, offlineBeforeFirstInput: true, scope: 'Recorded rising reference versus recorded falling example from the same attributed source; not a learner performance.',
          fullPassages: expectedFull, selectedPassages: selected, cancellation, downloads, assets, pageErrors: errors, externalRequests: external, offlineRequests, axeViolations: violations });
        console.log(JSON.stringify({ engine: engineName, width, fullPassages: 2, selectedPassages: 2, cancelledBeforeAttempt: true, wavUnchanged: true }));
      } finally { await context.close(); await new Promise(done => server.close(done)); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ results }, null, 2) + '\n');
