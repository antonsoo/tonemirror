// Exercise the production app with real browser decoders, workers, storage and downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep, extname } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const [distArg, outputArg] = process.argv.slice(2);
assert.ok(distArg && outputArg, 'Usage: node studies/recorded-practice/browser.mjs DIST OUTPUT');
const dist = resolve(distArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(await readFile(new URL('./source.json', import.meta.url)));
const original = await readFile(new URL('../../src/references/FourMandarinTones.ogg', import.meta.url));
assert.equal(hash(original), source.recording.sha256);
const results = [];

function wavContents(bytes) {
  const info = {};
  let data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    assert.ok(start + size <= bytes.length);
    const tag = bytes.toString('ascii', offset, offset + 4);
    if (tag === 'data') data = bytes.subarray(start, start + size);
    if (tag === 'LIST' && bytes.toString('ascii', start, start + 4) === 'INFO') {
      for (let at = start + 4; at + 8 <= start + size;) {
        const length = bytes.readUInt32LE(at + 4);
        assert.ok(at + 8 + length <= start + size);
        info[bytes.toString('ascii', at, at + 4)] = bytes.toString('utf8', at + 8, at + 8 + length).replace(/\0$/, '');
        at += 8 + length + length % 2;
      }
    }
    offset += 8 + size + size % 2;
  }
  assert.ok(data);
  const prefix = 'ToneMirror audio credit v1: ';
  assert.ok(info.ICOP.startsWith(prefix));
  const credit = JSON.parse(info.ICOP.slice(prefix.length));
  assert.equal(credit.sourceUrl, source.recording.sourcePage);
  assert.equal(credit.licenseUrl, source.recording.licenseUrl);
  assert.equal(credit.creator, 'Wolfdog (2019)');
  return { info, credit, data };
}

for (const [engineName, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const errors = [], csp = [], external = [], offlineRequests = [], assets = {}, pending = [];
      let disconnected = false;
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
          if (disconnected) offlineRequests.push(request.url());
          if (new URL(request.url()).origin !== origin) external.push(request.url());
        });
        page.on('response', response => {
          if (disconnected || response.status() !== 200 || !response.url().startsWith(origin)) return;
          pending.push((async () => {
            const file = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await response.body();
            assert.equal(hash(bytes), hash(await readFile(resolve(dist, file))));
            assets[file] = { bytes: bytes.length, sha256: hash(bytes) };
          })());
        });
        await page.addInitScript(() => {
          window.recordedProbe = { inputs: [], contours: [] };
          const NativeWorker = Worker;
          window.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args);
              this.addEventListener('message', event => {
                if (event.data.type === 'analyzed') window.recordedProbe.contours.push(event.data.contour);
              });
            }
            postMessage(message, ...rest) {
              if (message.type === 'analyze') window.recordedProbe.inputs.push({ pcm: message.pcm.slice(), rate: message.sampleRate });
              return super.postMessage(message, ...rest);
            }
          };
          document.addEventListener('securitypolicyviolation', event => { window.recordedCsp ??= []; window.recordedCsp.push(event.violatedDirective); });
        });
        await page.goto(`${origin}/tonemirror/`);
        await page.getByRole('group', { name: 'Recorded Mandarin references' }).waitFor();
        await page.evaluate(async () => {
          await Promise.all(['400 24px Fraunces', '500 24px Fraunces', '600 24px Fraunces', 'italic 500 24px Fraunces'].map(font => document.fonts.load(font)));
          await document.fonts.ready;
        });
        await Promise.all(pending);
        await context.setOffline(true); disconnected = true;
        const button = name => page.getByRole('button', { name, exact: true });
        const label = page.locator('.tm-clip-label'), creditText = page.locator('.tm-audio-credit');
        const fileInput = page.getByLabel('Choose an audio file to load');
        const exports = [];
        const downloads = {};
        async function download(stage) {
          const expected = await page.evaluate(async () => {
            const { pcm, rate } = window.recordedProbe.inputs.at(-1);
            const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pcm))].map(b => b.toString(16).padStart(2, '0')).join('');
            return { sha256, samples: pcm.length, rate };
          });
          const event = page.waitForEvent('download'); await button('Download WAV').click();
          const item = await event; assert.equal(await item.failure(), null);
          const path = resolve(output, `${prefix}-${stage}.wav`); await item.saveAs(path);
          const bytes = await readFile(path), parsed = wavContents(bytes);
          assert.equal(hash(parsed.data), expected.sha256); assert.equal(parsed.data.length, expected.samples * 4);
          assert.equal(bytes.readUInt32LE(24), expected.rate);
          const entry = { stage, filename: item.suggestedFilename(), bytes: bytes.length, sha256: hash(bytes), pcm: expected, credit: parsed.credit, info: parsed.info };
          exports.push(entry); downloads[stage] = path;
          return entry;
        }

        // Independent decoding of the original file, without the app's file/crop helpers.
        const decoded = await page.evaluate(async encoded => {
          const binary = atob(encoded), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          const decoder = new AudioContext();
          try {
            const buffer = await decoder.decodeAudioData(bytes.buffer), mono = new Float32Array(buffer.length);
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
              const samples = buffer.getChannelData(ch);
              for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / buffer.numberOfChannels;
            }
            window.recordedOracle = { pcm: mono, rate: buffer.sampleRate };
            return { rate: buffer.sampleRate, channels: buffer.numberOfChannels, samples: buffer.length };
          } finally { await decoder.close(); }
        }, original.toString('base64'));
        const tones = [];
        await expect(button('Play reference')).toBeDisabled();
        for (const selection of source.selections) {
          const name = `Load recorded ${selection.syllable}, tone ${selection.tone}`;
          await button(name).focus(); await page.keyboard.press('Enter');
          await expect(label).toContainText(`Recorded Mandarin ${selection.syllable} (tone ${selection.tone}) ·`);
          await expect(creditText).toContainText('Wolfdog (2019)');
          const match = await page.evaluate(async selection => {
            const { pcm: all, rate } = window.recordedOracle;
            const start = Math.floor(selection.start * rate), end = Math.min(all.length, Math.ceil(selection.end * rate));
            const actual = window.recordedProbe.inputs.at(-1).pcm;
            const expected = all.slice(start, end);
            const hash = async pcm => [...new Uint8Array(await crypto.subtle.digest('SHA-256', pcm))].map(b => b.toString(16).padStart(2, '0')).join('');
            const contour = window.recordedProbe.contours.at(-1);
            return { exact: actual.length === expected.length && actual.every((v, i) => Object.is(v, expected[i])), sha256: await hash(expected), start, end,
              frames: contour.points.length, voiced: contour.points.filter(p => p.voiced).length, medianF0: contour.medianF0 };
          }, selection);
          assert.equal(match.exact, true); assert.ok(match.voiced > 10);
          const entry = await download(`tone${selection.tone}`);
          assert.equal(entry.pcm.sha256, match.sha256);
          assert.equal(entry.credit.excerpt.start, match.start / decoded.rate);
          assert.equal(entry.credit.excerpt.end, match.end / decoded.rate);
          tones.push({ ...selection, ...match });
        }
        await button('Play reference').click(); await expect(button('Pause reference')).toBeVisible();
        await button('Pause reference').click();
        await button('Load recorded four-tone sequence').click(); await expect(label).toContainText('Recorded Mandarin: four tones ·');
        const full = await download('full'); assert.equal(full.pcm.samples, decoded.samples); assert.equal(full.credit.excerpt, undefined);

        await button('Load recorded mǎ, tone 3').click(); await expect(label).toContainText('Recorded Mandarin mǎ');
        await page.getByLabel('Region start (s)').fill('0.1'); await page.getByLabel('Region end (s)').fill('0.5');
        await button('Keep region').click(); await expect(label).toContainText('· 0.40s');
        const crop = await download('crop');
        assert.ok(Math.abs(crop.credit.excerpt.start - 3.15) <= 1 / decoded.rate);
        assert.ok(Math.abs(crop.credit.excerpt.end - 3.55) <= 1 / decoded.rate);
        page.once('dialog', dialog => dialog.accept('Recorded mǎ excerpt'));
        await button('Save current reference').click(); await expect(page.locator('.tm-library-list')).toContainText('Recorded mǎ excerpt');
        await button('Restore full clip').click(); await expect(label).toContainText('Recorded Mandarin: four tones');
        const restored = await download('restored'); assert.equal(restored.sha256, full.sha256);
        await button('Use').click(); await expect(label).toContainText('Reference: Recorded mǎ excerpt · 0.40s');
        const saved = await download('saved'); assert.equal(saved.sha256, crop.sha256);
        await page.getByLabel('Pitch detection algorithm').selectOption('mpm'); await expect(page.locator('.tm-status')).toContainText('Pitch analysis updated');
        const mpm = await download('mpm'); assert.equal(mpm.sha256, saved.sha256);
        await page.getByLabel('Region start (s)').fill('0.05'); await page.getByLabel('Region end (s)').fill('0.2');
        await button('Keep region').click(); await expect(label).toContainText('· 0.15s');
        const recrop = await download('recrop');
        assert.ok(Math.abs(recrop.credit.excerpt.start - 3.20) <= 2 / decoded.rate);
        assert.ok(Math.abs(recrop.credit.excerpt.end - 3.35) <= 2 / decoded.rate);

        await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
        await fileInput.setInputFiles(downloads.tone4); await expect(label).toContainText(`${prefix}-tone4.wav ·`);
        await expect(creditText).toContainText('4.500');
        const imported = await download('reimported'); assert.equal(imported.sha256, exports.find(e => e.stage === 'tone4').sha256);
        await button('Load recorded má, tone 2').click(); await expect(label).toContainText('Recorded Mandarin má');
        await expect(page.locator('.tm-score')).not.toHaveText('—');
        const score = await page.locator('.tm-score').textContent();
        const axe = (await new AxeBuilder({ page }).analyze()).violations;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.deepEqual(axe, []); assert.equal(overflow, false);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: resolve(output, `${prefix}.png`), fullPage: true });
        if (engineName === 'chromium' && width === 1440) {
          await page.setViewportSize({ width, height: 1600 });
          const comparison = await page.locator('section').filter({ has: page.getByRole('heading', { name: '2. Compare contours' }) }).boundingBox();
          await page.screenshot({ path: resolve(output, 'recorded-practice.png'), clip: { x: 0, y: 0, width, height: Math.ceil(comparison.y + comparison.height + 20) } });
        }
        assert.deepEqual(offlineRequests, []);
        csp.push(...await page.evaluate(() => window.recordedCsp ?? []));

        // Reload needs access to the app again; saved audio/credits survive separately.
        disconnected = false; await context.setOffline(false); await page.reload();
        await expect(page.locator('.tm-library-item')).toContainText('Recorded mǎ excerpt');
        await Promise.all(pending); await context.setOffline(true); disconnected = true;
        await button('Use').click(); await expect(label).toContainText('Recorded mǎ excerpt · 0.40s');
        await expect(creditText).toContainText('3.150–3.550s');
        const reloaded = await download('reloaded'); assert.equal(reloaded.sha256, saved.sha256);
        csp.push(...await page.evaluate(() => window.recordedCsp ?? []));
        assert.deepEqual(errors, []); assert.deepEqual(csp, []); assert.deepEqual(external, []); assert.deepEqual(offlineRequests, []);
        results.push({ browser: engineName, version: browser.version(), width, decoded, tones, exports, contrastScore: score,
          contrast: 'Recorded tone 2 as reference and recorded tone 4 as attempt; no learner recording or pronunciation accuracy claim.',
          pageErrors: errors, cspViolations: csp, externalRequests: external, requestsWhileOffline: offlineRequests, axeViolations: axe.length, overflow, served: assets });
        console.log(`${prefix}: ${exports.length} exact WAV exports, four independent crop checks, offline playback and saved-credit reload passed`);
      } finally { await context.close(); await new Promise(done => server.close(done)); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'browser.json'), JSON.stringify({ source, origin: process.env.TONEMIRROR_BROWSER_ORIGIN ?? 'local production build', results }, null, 2) + '\n');
