// Close the actual static server after initial page load. Browser offline emulation
// alone did not stop Chromium's AudioWorklet fetch in the retained baseline probe.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from '@playwright/test';
const [distArg = 'dist', output = 'studies/offline-start/after.json', mode = 'verify', screenshots] = process.argv.slice(2);
const remote = /^https?:/.test(distArg);
const dist = remote ? null : resolve(distArg);
const fixture = fileURLToPath(new URL('../../examples/mandarin-tone2-reference.wav', import.meta.url));
const observe = mode === 'observe';
const online = mode === 'online';
const results = [];
if (screenshots) await mkdir(screenshots, { recursive: true });
function completedResultsHash(responses) {
  // Algorithm changes can also emit superseded mixed-algorithm comparisons.
  // Retain the two completed analyses and final comparison for the visible state.
  const completed = [...responses.filter(r => r.type === 'analyzed').slice(-2), responses.filter(r => r.type === 'compared').at(-1)];
  return createHash('sha256').update(JSON.stringify(completed.map(({ requestId: _id, ...result }) => JSON.stringify(result)).sort())).digest('hex');
}
async function serve() {
  if (remote) return { url: distArg, close: async () => {} };
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tonemirror\//, '') || 'index.html';
    const path = resolve(dist, name);
    if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
    try {
      const bytes = await readFile(path);
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let stopped = false;
  return { url: `http://127.0.0.1:${server.address().port}/tonemirror/`, async close() {
    if (stopped) return; stopped = true;
    server.closeAllConnections(); await new Promise(done => server.close(done));
  } };
}
for (const [engine, type] of Object.entries({ chromium, firefox })) {
  const browser = await type.launch({ args: engine === 'chromium' ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [] });
  try {
    for (const [scenario, width] of [['files', 1440], ['files', 375], ...(engine === 'chromium' ? [['microphone', 1440]] : [])]) {
      const server = await serve();
      const context = await browser.newContext({ viewport: { width, height: 950 } });
      try {
        const page = await context.newPage();
        const errors = [], lateRequests = [];
        let disconnected = false;
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (disconnected && /^https?:/.test(r.url())) lateRequests.push(new URL(r.url()).pathname); });
        await page.addInitScript(() => {
          window.audioResults = []; window.streams = []; window.workletUrls = []; window.revokedUrls = []; window.policyViolations = [];
          document.addEventListener('securitypolicyviolation', e => window.policyViolations.push(e.violatedDirective));
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); this.addEventListener('message', e => window.audioResults.push(e.data)); }
          };
          const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await capture(...args); window.streams.push(stream); return stream; };
          const addModule = AudioWorklet.prototype.addModule;
          AudioWorklet.prototype.addModule = function(url, ...args) { window.workletUrls.push(url); return addModule.call(this, url, ...args); };
          const revoke = URL.revokeObjectURL;
          URL.revokeObjectURL = function(url) { window.revokedUrls.push(url); return revoke.call(this, url); };
        });
        await page.goto(server.url);
        await page.getByRole('button', { name: '● Record', exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (!online) {
          await server.close(); disconnected = true;
          if (remote) await context.setOffline(true);
        }
        const input = page.getByLabel('Choose an audio file to load');
        const status = page.locator('.tm-status');
        const row = { engine, width, scenario, serverStoppedBeforeFirstUse: !online && !remote, hostedOfflineEmulation: !online && remote };
        if (scenario === 'files') {
          await input.setInputFiles(fixture);
          await page.waitForFunction(() => /Could not|\.wav —/.test(document.querySelector('.tm-status')?.textContent ?? ''));
          row.firstStatus = await status.innerText();
          row.loaded = !row.firstStatus.includes('Could not');
          if (row.loaded) {
            await page.getByRole('tab', { name: 'Reference', exact: true }).click();
            await input.setInputFiles(fixture);
            await page.waitForFunction(() => document.querySelector('.tm-score')?.textContent === '100');
            row.yinScore = await page.locator('.tm-score').innerText();
            row.yinResultsSha256 = completedResultsHash(await page.evaluate(() => window.audioResults));
            await page.getByLabel('Pitch detection algorithm').selectOption('mpm');
            await page.waitForFunction(() => document.querySelector('.tm-status')?.textContent === 'Pitch analysis updated (MPM).' && document.querySelector('.tm-score')?.textContent === '100');
            row.mpmScore = await page.locator('.tm-score').innerText();
            const responses = await page.evaluate(() => window.audioResults);
            row.workerResponses = responses.length;
            row.mpmResultsSha256 = completedResultsHash(responses);
            row.savedReferences = await page.locator('.tm-library-item').count();
            await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
            page.once('dialog', dialog => dialog.accept('Offline reference'));
            await page.getByRole('button', { name: 'Save current attempt' }).click();
            await page.getByRole('button', { name: 'Use', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.tm-clip-label')?.textContent.includes('Reference: Offline reference'));
            row.savedReferenceUsable = true;
            await page.getByRole('button', { name: 'Delete', exact: true }).click();
            await page.waitForFunction(() => document.querySelectorAll('.tm-library-item').length === 0);
            row.deletedReference = true;
            row.overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            if (screenshots && engine === 'chromium') await page.screenshot({ path: resolve(screenshots, `offline-comparison-${width}.png`), fullPage: true });
          }
          if (!observe) { assert.ok(row.loaded, JSON.stringify(row)); assert.equal(row.yinScore, '100'); assert.equal(row.mpmScore, '100'); assert.equal(row.savedReferences, 0); assert.ok(row.overflow <= 0); }
        } else {
          await page.getByRole('button', { name: '● Record', exact: true }).click();
          await page.waitForFunction(() => document.querySelector('.tm-status')?.textContent.includes('unavailable') || [...document.querySelectorAll('button')].some(b => b.textContent === '■ Stop'));
          row.firstStatus = (await status.innerText()).replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://localhost');
          row.started = await page.getByRole('button', { name: '■ Stop', exact: true }).isVisible();
          if (row.started) {
            // Wait for actual worklet PCM delivery, not just a recording-button transition.
            await page.waitForTimeout(500);
            await page.getByRole('button', { name: '■ Stop', exact: true }).click();
            await page.waitForFunction(() => /Recording \(.* — [0-9.]+s/.test(document.querySelector('.tm-status')?.textContent ?? ''));
            row.recordedStatus = await status.innerText();
            row.sampledFrames = await page.evaluate(() => window.audioResults.find(r => r.type === 'analyzed')?.contour.points.length);
            assert.ok(row.sampledFrames > 0);
          }
          row.tracksEnded = await page.evaluate(() => window.streams.length === 1 && window.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
          row.workletFromBlob = await page.evaluate(() => window.workletUrls.length === 1 && window.workletUrls[0].startsWith('blob:'));
          row.workletUrlRevoked = await page.evaluate(() => window.workletUrls.length === 1 && window.revokedUrls.includes(window.workletUrls[0]));
          if (!observe) { assert.ok(row.started, JSON.stringify(row)); assert.ok(row.tracksEnded); if (!online) { assert.ok(row.workletFromBlob); assert.ok(row.workletUrlRevoked); } }
        }
        row.lateRequests = lateRequests; row.pageErrors = errors;
        row.policyViolations = await page.evaluate(() => window.policyViolations);
        if (!observe) { assert.deepEqual(errors, []); assert.deepEqual(row.policyViolations, []); assert.ok(lateRequests.every(path => path.endsWith('.woff2'))); }
        results.push(row);
      } finally { await context.close(); await server.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(output, JSON.stringify({ node: process.version, mode, results }, null, 2) + '\n');
console.log(results);
