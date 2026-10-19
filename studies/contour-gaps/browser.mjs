/** Native worker results and canvas paths, offline after page/font loading.
 * node browser.mjs DIST INPUT_CHECKOUT OUTPUT_DIRECTORY baseline|verify
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium, firefox } from '@playwright/test';
import { observeContourDrawing, readContourDrawing } from '../../tests/browser/contour-observer.js';

const [distArg, inputsArg, outputArg, mode = 'verify'] = process.argv.slice(2);
assert.ok(distArg && inputsArg && outputArg && ['baseline', 'verify'].includes(mode), 'browser.mjs DIST INPUT_CHECKOUT OUTPUT_DIRECTORY baseline|verify');
const dist = resolve(distArg), inputs = resolve(inputsArg), output = resolve(outputArg);
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtures = [
  { id: 'four-mandarin-tones', path: 'src/references/FourMandarinTones.ogg', credit: 'Wolfdog (2019), CC BY-SA 4.0; see src/references/recorded.ts' },
  { id: 'ptdb-f01-sa1', path: 'studies/real-voice/cache/ptdb/F01/mic_F01_sa1.wav', credit: 'PTDB-TUG F01/sa1, Open Database License; see studies/real-voice/manifest.json' },
];
await mkdir(output, { recursive: true });
const captures = [], served = new Map();
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tonemirror\//, '') || 'index.html';
  const path = resolve(dist, name);
  if (!path.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    served.set(name, { path: name, bytes: bytes.length, sha256: sha(bytes) });
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = process.env.TONEMIRROR_STUDY_URL ?? `http://127.0.0.1:${server.address().port}/tonemirror/`;
try {
  for (const [engine, type] of Object.entries({ chromium, firefox })) {
    const browser = await type.launch();
    try {
      for (const width of [1440, 375]) for (const fixture of fixtures) for (const algorithm of ['yin', 'mpm']) {
        console.log(`${mode}: ${engine} ${width} ${fixture.id} ${algorithm}`);
        const context = await browser.newContext({ viewport: { width, height: 1050 }, reducedMotion: 'reduce' });
        const page = await context.newPage(), errors = [], networkAfterDisconnect = [], external = [];
        let offline = false;
        const assets = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => {
          if (!/^https?:/.test(r.url())) return;
          if (offline) networkAfterDisconnect.push(r.url());
          if (new URL(r.url()).origin !== new URL(url).origin) external.push(r.url());
        });
        page.on('response', r => {
          if (!/^https?:/.test(r.url())) return;
          assets.push((async () => {
            const name = new URL(r.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await r.body();
            assert.equal(sha(bytes), sha(await readFile(resolve(dist, name))), name);
            served.set(name, { path: name, bytes: bytes.length, sha256: sha(bytes) });
          })());
        });
        try {
          await page.addInitScript(observeContourDrawing);
          await page.goto(url);
          await page.getByLabel('Choose an audio file to load').waitFor({ state: 'attached' });
          await page.evaluate(() => document.fonts.ready);
          await Promise.all(assets);
          await context.setOffline(true);
          offline = true;
          await page.getByLabel('Pitch detection algorithm').selectOption(algorithm);
          const bytes = await readFile(resolve(inputs, fixture.path));
          for (const [i, tab] of ['Reference', 'Your attempt'].entries()) {
            await page.getByRole('tab', { name: tab, exact: true }).click();
            await page.getByLabel('Choose an audio file to load').setInputFiles({ name: fixture.id + extname(fixture.path), mimeType: extname(fixture.path) === '.ogg' ? 'audio/ogg' : 'audio/wav', buffer: bytes });
            await page.waitForFunction(n => window.gapStudy.contours.length >= n, i + 1);
          }
          await page.waitForFunction(() => document.querySelector('.tm-score')?.textContent === '100');
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
          const result = await page.evaluate(readContourDrawing);
          const illegalReference = result.gaps.reduce((sum, g) => sum + g.referenceConnections, 0);
          const illegalAttempt = result.gaps.reduce((sum, g) => sum + g.alignedAttemptConnections, 0);
          assert.ok(result.gaps.length > 0);
          if (mode === 'verify') { assert.equal(illegalReference, 0); assert.equal(illegalAttempt, 0); }
          else assert.ok(illegalAttempt > 0);
          assert.deepEqual(errors, []); assert.deepEqual(result.violations, []);
          assert.deepEqual(external, []); assert.deepEqual(networkAfterDisconnect, []); assert.equal(result.overflow, 0);
          assert.deepEqual(result.contours[0], result.contours[1]);
          const id = `${engine}-${width}-${fixture.id}-${algorithm}`;
          const trace = gzipSync(JSON.stringify({ gaps: result.gaps, segments: result.segments }), { level: 9 });
          await writeFile(resolve(output, id + '.json.gz'), trace);
          if (fixture.id === 'four-mandarin-tones' && algorithm === 'yin') await page.screenshot({ path: resolve(output, `${engine}-${width}.png`), fullPage: true });
          captures.push({ id, engine, browser: browser.version(), width, fixture: { id: fixture.id, path: fixture.path, credit: fixture.credit, bytes: bytes.length, sha256: sha(bytes) }, algorithm, nativeSampleRate: result.pcm[0].sampleRate, decodedSamples: result.pcm[0].samples.length, pcmSha256: sha(JSON.stringify(result.pcm[0])), contourSha256: sha(JSON.stringify(result.contours[0])), alignmentSha256: sha(JSON.stringify(result.alignment)), score: result.visibleScore, gaps: result.gaps, illegalReferenceConnections: illegalReference, illegalAttemptConnections: illegalAttempt, nativeTrace: { path: id + '.json.gz', bytes: trace.length, sha256: sha(trace) }, errors, policyViolations: result.violations, networkAfterDisconnect, externalRequests: external, overflow: result.overflow });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ mode, node: process.version, surface: process.env.TONEMIRROR_STUDY_URL ?? 'local production build', captures, servedFiles: [...served.values()] }, null, 2) + '\n');
console.log(`${captures.length} offline native-audio comparisons; ${captures.reduce((n, c) => n + c.illegalAttemptConnections, 0)} aligned connections over unvoiced intervals.`);
