import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const [distArg, cacheArg, outputArg, mode] = process.argv.slice(2);
assert.ok(distArg && cacheArg && outputArg && ['before', 'after'].includes(mode), 'DIST SPEECH_CACHE OUTPUT before|after');
const dist = resolve(distArg), cache = resolve(cacheArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(new URL('../real-voice/manifest.json', import.meta.url)));
const fixtures = ['ptdb/F01/mic_F01_sa1.wav', 'ptdb/M01/mic_M01_sa1.wav'].map(path => manifest.files.find(f => f.path === path));
for (const fixture of fixtures) assert.equal(hash(await readFile(resolve(cache, fixture.path))), fixture.sha256);
const results = [];
for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) for (const fixture of fixtures) {
      const served = {}, pending = [], assetErrors = [], errors = [], external = [], late = [];
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
      const context = await browser.newContext({ viewport: { width, height: 1100 }, colorScheme: width === 375 ? 'light' : 'dark' });
      const speaker = fixture.path.split('/')[1], prefix = `${engineName}-${width}-${speaker}`;
      try {
        const page = await context.newPage();
        let offline = false;
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (/^https?:/.test(r.url())) { if (offline) late.push(r.url()); if (new URL(r.url()).origin !== origin) external.push(r.url()); } });
        page.on('response', response => {
          if (!/^https?:/.test(response.url()) || response.status() !== 200) return;
          pending.push((async () => {
            const file = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await response.body(); assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))));
            served[file] = { bytes: bytes.length, sha256: hash(bytes) };
          })().catch(error => assetErrors.push(error.message)));
        });
        await page.addInitScript(() => {
          window.wavStudy = { inputs: [], violations: [] };
          document.addEventListener('securitypolicyviolation', e => window.wavStudy.violations.push(e.violatedDirective));
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            postMessage(message, ...rest) {
              if (message.type === 'analyze') window.wavStudy.inputs.push({ pcm: message.pcm.slice(), rate: message.sampleRate });
              return super.postMessage(message, ...rest);
            }
          };
        });
        await page.goto(`${origin}/tonemirror/`);
        await page.getByLabel('Choose an audio file to load').waitFor();
        await page.evaluate(async () => {
          // Firefox can defer an offscreen heading's face until it is scrolled into view.
          await Promise.all(['400 24px Fraunces', '500 24px Fraunces', '600 24px Fraunces', 'italic 500 24px Fraunces'].map(font => document.fonts.load(font)));
        });
        await page.evaluate(() => document.fonts.ready);
        await Promise.all(pending);
        await context.setOffline(true); await new Promise(done => server.close(done)); offline = true;
        const button = name => page.getByRole('button', { name, exact: true });
        const label = page.locator('.tm-clip-label'), fileInput = page.getByLabel('Choose an audio file to load');
        if (mode === 'after') await expect(button('Download WAV')).toBeDisabled();
        await fileInput.setInputFiles(resolve(cache, fixture.path));
        await expect(label).toContainText(`${speaker}_sa1.wav ·`);
        const exports = [];
        async function exportClip(stage) {
          const expected = await page.evaluate(async () => {
            const { pcm, rate } = window.wavStudy.inputs.at(-1);
            const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pcm))].map(b => b.toString(16).padStart(2, '0')).join('');
            return { sampleRate: rate, samples: pcm.length, pcmSha256: digest };
          });
          const event = page.waitForEvent('download');
          await button('Download WAV').focus(); await page.keyboard.press('Enter');
          const download = await event; assert.equal(await download.failure(), null);
          const destination = resolve(output, `${prefix}-${stage}.wav`); await download.saveAs(destination);
          const bytes = await readFile(destination);
          const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination], { encoding: 'utf8' });
          assert.equal(probe.status, 0, probe.stderr);
          const data = JSON.parse(probe.stdout), stream = data.streams[0];
          assert.equal(stream.codec_name, 'pcm_f32le'); assert.equal(stream.channels, 1);
          assert.equal(Number(stream.sample_rate), expected.sampleRate);
          const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', destination, '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 30 * 1024 * 1024 });
          assert.equal(decoded.status, 0, decoded.stderr.toString());
          assert.equal(decoded.stdout.length, expected.samples * 4); assert.equal(hash(decoded.stdout), expected.pcmSha256);
          exports.push({ stage, filename: download.suggestedFilename(), bytes: bytes.length, sha256: hash(bytes), ...expected, ffmpegSamplesMatch: true, codec: stream.codec_name, channels: stream.channels, metadata: data.format.tags });
          return destination;
        }
        if (mode === 'after') await exportClip('full');
        const hasRegionControls = await button('Keep region').count() === 1;
        if (mode === 'after' || hasRegionControls) {
          await page.getByLabel('Region start (s)').fill('3'); await page.getByLabel('Region end (s)').fill('4');
          await button('Loop region').click(); await page.getByLabel('half-speed').check();
          if (mode === 'after') { await exportClip('looped'); assert.equal(exports[0].sha256, exports[1].sha256); }
          await button('Keep region').click(); await expect(label).toContainText('· 1.00s');
        }
        if (mode === 'before') assert.equal(await button('Download WAV').count(), 0);
        else await exportClip('excerpt');
        const axe = (await new AxeBuilder({ page }).analyze()).violations;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(axe.length, 0); assert.equal(overflow, false);
        if (speaker === 'F01') await page.locator('#audio-analysis').screenshot({ path: resolve(output, `${engineName}-${width}.png`) });
        if (mode === 'after') {
          page.once('dialog', dialog => dialog.accept('Recorded speech excerpt'));
          await button('Save current attempt').click();
          await expect(page.locator('.tm-library-list')).toContainText('Recorded speech excerpt');
          await button('Restore full clip').click(); await expect(label).not.toContainText('[3.000');
          await exportClip('restored'); assert.equal(exports[0].sha256, exports[3].sha256);
          await button('Use').click(); await expect(label).toContainText('Reference: Recorded speech excerpt · 1.00s');
          const wav = await exportClip('saved'); assert.equal(exports[2].sha256, exports[4].sha256);
          await fileInput.setInputFiles(wav); await expect(label).toContainText(`${prefix}-saved.wav · 1.00s`);
          assert.equal(await page.evaluate(async () => {
            const { pcm } = window.wavStudy.inputs.at(-1);
            return [...new Uint8Array(await crypto.subtle.digest('SHA-256', pcm))].map(b => b.toString(16).padStart(2, '0')).join('');
          }), exports[4].pcmSha256);
          await page.locator('.tm-chip').first().click(); await expect(label).toContainText('(synthetic)');
          const synthetic = await exportClip('synthetic'); assert.match(exports[5].filename, /synthetic-reference/);
          const bytes = await readFile(synthetic);
          await fileInput.setInputFiles({ name: 'renamed.wav', mimeType: 'audio/wav', buffer: bytes });
          await expect(label).toContainText('renamed.wav (synthetic)');
        }
        await Promise.all(pending);
        assert.deepEqual(assetErrors, []); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(late, []);
        const violations = await page.evaluate(() => window.wavStudy.violations); assert.deepEqual(violations, []);
        results.push({ browser: engineName, version: browser.version(), width, fixture, mode, headingFontsLoadedBeforeOffline: true, hasRegionControls, exportControlCount: await button('Download WAV').count(), exports, axeViolations: axe.length, overflow, pageErrors: errors, cspViolations: violations, externalRequests: external, requestsAfterDisconnect: late, served });
        console.log(`${mode} ${prefix}: ${exports.length} WAV downloads verified`);
      } finally { await context.close(); if (server.listening) await new Promise(done => server.close(done)); }
    }
  } finally { await browser.close(); }
}
const version = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0];
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ mode, origin: process.env.TONEMIRROR_BROWSER_ORIGIN ?? 'local production build', ffmpeg: version, results }, null, 2) + '\n');
