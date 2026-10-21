// Actual recorded-file workflow. Direct core replay checks worker plumbing;
// score.py separately measures agreement with supplied laryngeal references.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { trackPitch } from '../../src/core/pitchTrack.ts';

const [distArg, outputArg] = process.argv.slice(2);
assert.ok(distArg && outputArg, 'Usage: tsx studies/pitch-floor/browser.mjs DIST OUTPUT');
const dist = resolve(distArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../real-voice/manifest.json', import.meta.url)));
const recordings = ['ptdb/M09/mic_M09_si2071.wav', 'ptdb/M02/mic_M02_si759.wav'];
const sources = [];
for (const path of recordings) {
  const entry = manifest.files.find(file => file.path === path);
  assert.ok(entry);
  const bytes = await readFile(new URL(`../real-voice/cache/${path}`, import.meta.url));
  assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
  sources.push({ ...entry, bytes });
}
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
const results = [];
try {
  for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch();
    try {
      for (const width of [1440, 375]) for (const source of sources) {
        const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme: width === 375 ? 'light' : 'dark' });
        const prefix = `${engineName}-${width}-${source.path.split('/')[1]}`;
        const errors = [], external = [], offlineRequests = [], assets = {}, pending = [], assetErrors = [];
        let offline = false, captureAssets = true;
        try {
          const page = await context.newPage();
          page.on('pageerror', error => errors.push(error.message));
          page.on('request', request => {
            if (!/^https?:/.test(request.url())) return;
            if (offline) offlineRequests.push(request.url());
            if (new URL(request.url()).origin !== origin) external.push(request.url());
          });
          page.on('response', response => {
            if (!captureAssets || response.status() !== 200 || new URL(response.url()).origin !== origin) return;
            pending.push((async () => {
              const file = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
              const bytes = await response.body();
              assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))), `Served ${file}`);
              assets[file] = { bytes: bytes.length, sha256: hash(bytes) };
            })().catch(error => assetErrors.push(error.message)));
          });
          await page.addInitScript(() => {
            window.floorStudy = { inputs: [], violations: [] };
            document.addEventListener('securitypolicyviolation', event => window.floorStudy.violations.push(event.violatedDirective));
            const NativeWorker = Worker;
            window.Worker = class extends NativeWorker {
              constructor(...args) {
                super(...args);
                this.pending = new Map();
                this.addEventListener('message', event => {
                  if (event.data.type === 'analyzed') this.pending.get(event.data.requestId).contour = event.data.contour;
                });
              }
              postMessage(message, ...rest) {
                if (message.type === 'analyze') {
                  const input = { pcm: message.pcm.slice(), sampleRate: message.sampleRate, algorithm: message.algorithm, minFrequency: message.minFrequency };
                  this.pending.set(message.requestId, input); window.floorStudy.inputs.push(input);
                }
                return super.postMessage(message, ...rest);
              }
            };
          });
          await page.goto(`${origin}/tonemirror/`);
          await page.getByRole('heading', { name: '1. Get some audio' }).waitFor();
          await page.evaluate(async () => {
            await Promise.all(['400 24px Fraunces', '500 24px Fraunces', '600 24px Fraunces', 'italic 500 24px Fraunces'].map(font => document.fonts.load(font)));
            await document.fonts.ready;
          });
          for (let settled = 0; settled < pending.length;) {
            const batch = pending.slice(settled); settled = pending.length; await Promise.all(batch);
          }
          captureAssets = false; assert.deepEqual(assetErrors, []);
          await context.setOffline(true); offline = true;
          const button = name => page.getByRole('button', { name, exact: true });
          const tab = name => page.getByRole('tab', { name, exact: true });
          const floor = page.getByLabel('Pitch search floor'), label = page.locator('.tm-clip-label');
          const note = page.locator('.tm-comparison-note'), status = page.locator('.tm-status');
          const stages = [], exports = [];
          let captured = 0, originalPcm, rate;
          async function verify(stage, expectedFloors, expectedPcm) {
            const inputs = await page.evaluate(start => window.floorStudy.inputs.slice(start).map(input => {
              if (!input.contour) throw new Error('Worker result not complete');
              const bytes = new Uint8Array(input.pcm.buffer);
              let binary = '';
              for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
              return { sampleRate: input.sampleRate, algorithm: input.algorithm, minFrequency: input.minFrequency, pcm: btoa(binary), contour: input.contour };
            }), captured);
            captured += inputs.length;
            assert.deepEqual(inputs.map(input => input.minFrequency).sort(), [...expectedFloors].sort(), stage);
            for (const input of inputs) {
              const bytes = Buffer.from(input.pcm, 'base64');
              const pcm = Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
              if (!originalPcm) { originalPcm = pcm; rate = input.sampleRate; }
              assert.equal(input.sampleRate, rate);
              assert.equal(hash(bytes), hash(new Uint8Array((expectedPcm ?? originalPcm).buffer)), `${stage}: decoded samples preserved`);
              const expected = trackPitch(pcm, { sampleRate: rate, algorithm: input.algorithm, minFrequency: input.minFrequency });
              assert.equal(expected.points.length, input.contour.points.length);
              let maxFrequencyDelta = 0;
              for (const [i, point] of expected.points.entries()) {
                const actual = input.contour.points[i];
                assert.equal(actual.time, point.time); assert.equal(actual.voiced, point.voiced);
                assert.equal(actual.f0 === null, point.f0 === null);
                if (point.f0 !== null) maxFrequencyDelta = Math.max(maxFrequencyDelta, Math.abs(actual.f0 - point.f0));
                assert.ok(Math.abs(actual.confidence - point.confidence) < 1e-8);
              }
              assert.ok(maxFrequencyDelta < 1e-6);
              stages.push({ stage, algorithm: input.algorithm, floor: input.minFrequency, sampleRate: rate, samples: pcm.length, pcmSha256: hash(bytes),
                frames: input.contour.points.length, voiced: input.contour.points.filter(p => p.voiced).length,
                below60Estimates: input.contour.points.filter(p => p.f0 !== null && p.f0 < 60).length,
                contourSha256: hash(JSON.stringify(input.contour)), directCoreMaxHzDelta: maxFrequencyDelta });
            }
          }
          async function wav(stage) {
            const event = page.waitForEvent('download'); await button('Download WAV').click();
            const item = await event; assert.equal(await item.failure(), null);
            const bytes = await readFile(await item.path());
            const result = { stage, bytes: bytes.length, sha256: hash(bytes) }; exports.push(result); return result;
          }
          for (const role of ['Reference', 'Your attempt']) {
            await tab(role).click(); await expect(floor).toHaveValue('60');
            await page.getByLabel('Choose an audio file to load').setInputFiles({ name: source.path.split('/').at(-1), mimeType: 'audio/wav', buffer: source.bytes });
            await expect(status).toContainText(`${source.path.split('/').at(-1)} —`);
            await verify(`load-${role}`, [60]);
          }
          await expect(note).toContainText('Voiced frames:');
          const baseline = await wav('original-60');
          await floor.selectOption('40'); await expect(status).toContainText('Pitch analysis updated');
          await expect(note).toContainText('Pitch floors: reference 60 Hz; attempt 40 Hz');
          await verify('attempt-40', [40]);
          assert.equal((await wav('attempt-40')).sha256, baseline.sha256);
          await expect(note).toContainText('Voiced frames:');
          const sameAudioScore = await page.locator('.tm-score').textContent();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
          const axe = (await new AxeBuilder({ page }).analyze()).violations;
          assert.equal(overflow, false); assert.deepEqual(axe, []);
          await page.screenshot({ path: resolve(output, `${prefix}.png`), fullPage: true });
          if (engineName === 'chromium' && width === 1440 && source.path.includes('/M09/')) {
            await page.setViewportSize({ width, height: 1800 });
            await page.evaluate(() => window.scrollTo(0, 0));
            const comparison = await page.locator('section').filter({ has: page.getByRole('heading', { name: '2. Compare contours' }) }).boundingBox();
            await page.screenshot({ path: resolve(output, 'pitch-floor.png'), clip: { x: 0, y: 0, width, height: Math.ceil(comparison.y + comparison.height + 20) } });
          }
          await page.getByLabel('Region start (s)').fill('0.5'); await page.getByLabel('Region end (s)').fill('1.5');
          await button('Keep region').click(); await expect(label).toContainText('· 1.00s · YIN, 40 Hz');
          await verify('kept-region-40', [40], originalPcm.slice(Math.floor(.5 * rate), Math.ceil(1.5 * rate)));
          await button('Restore full clip').click(); await expect(label).toContainText('40 Hz search floor');
          await expect(status).toContainText(`${source.path.split('/').at(-1)} —`);
          await verify('restored-40', [40]); assert.equal((await wav('restored-40')).sha256, baseline.sha256);
          await page.getByLabel('Pitch detection algorithm').selectOption('mpm');
          await expect(status).toContainText('Pitch analysis updated'); await expect(note).toContainText('Voiced frames:');
          await verify('algorithm-change', [60, 40]);
          await expect(note).toContainText('reference 60 Hz; attempt 40 Hz');
          await floor.selectOption('60'); await expect(status).toContainText('Pitch analysis updated');
          await verify('attempt-restored-60', [60]); assert.equal((await wav('restored-60-mpm')).sha256, baseline.sha256);
          await tab('Reference').click(); await expect(floor).toHaveValue('60');
          assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(offlineRequests, []);
          const csp = await page.evaluate(() => window.floorStudy.violations); assert.deepEqual(csp, []);
          results.push({ browser: engineName, browserVersion: browser.version(), width, source: { path: source.path, bytes: source.bytes.length, sha256: source.sha256 },
            stages, exports, sameAudioScore, scoreScope: 'Same recorded utterance in both tabs with different search floors; no learner or pronunciation claim.',
            pageErrors: errors, cspViolations: csp, externalRequests: external, requestsWhileOffline: offlineRequests, axeViolations: axe.length, overflow, served: assets });
          console.log(`${prefix}: ${stages.length} recorded analyses match direct core replay, independent floors and exact WAV bytes passed offline`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(done => server.close(done)); }
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ origin: process.env.TONEMIRROR_BROWSER_ORIGIN ?? 'local production build',
  scriptSha256: hash(await readFile(new URL(import.meta.url))),
  scope: 'Worker plumbing on actual browser-decoded recordings. Native-rate laryngeal-reference accuracy is measured separately by score.py.', results }, null, 2) + '\n');
