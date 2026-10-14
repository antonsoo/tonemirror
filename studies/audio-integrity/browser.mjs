// Actual native decoding, IndexedDB and bundled workers; observers do not replace their results.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium, firefox, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { cases, floatWav, upload } from './fixtures.mjs';

const [distArg, outputArg, phase] = process.argv.slice(2);
assert(distArg && outputArg && ['before', 'after'].includes(phase),
  'Usage: node browser.mjs DIST OUTPUT_DIRECTORY before|after');
const dist = resolve(distArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const observations = [], views = [];
const seeded = [
  { id: 'legacy-nan', name: 'Saved invalid NaN', buffer: floatWav({ value: NaN }) },
  { id: 'legacy-infinity', name: 'Saved invalid infinity', buffer: floatWav({ value: Infinity, location: 'last' }) },
];

for (const [engine, type] of Object.entries({ chromium, firefox })) {
  const browser = await type.launch();
  try {
    for (const width of [1440, 375]) {
      const served = {}, loaded = {}, pendingAssets = [], errors = [], external = [], late = [];
      let offline = false;
      const server = createServer(async (request, response) => {
        const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/tonemirror\//, '') || 'index.html';
        if (name === 'seed.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Native storage fixture</title>'); return; }
        const path = resolve(dist, name);
        if (!path.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
        try {
          const bytes = await readFile(path);
          served[name] = { bytes: bytes.length, sha256: sha(bytes) };
          response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
          response.end(bytes);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: width === 1440 ? 'dark' : 'light' });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/tonemirror/seed.html`);
        await page.evaluate(async records => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('tonemirror', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('references', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
          });
          await new Promise((resolve, reject) => {
            const tx = db.transaction('references', 'readwrite');
            for (const record of records) tx.objectStore('references').put({ ...record, category: 'user', synthetic: false,
              sampleRate: 44100, createdAt: 1_791_939_600_000, pcmBuffer: Uint8Array.from(record.pcm).buffer, pcm: undefined });
            tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
          });
          db.close();
        }, seeded.map(item => ({ id: item.id, name: item.name, pcm: Array.from(item.buffer.subarray(58)) })));
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (!/^https?:/.test(request.url())) return;
          if (new URL(request.url()).origin !== origin) external.push(request.url());
          if (offline) late.push(request.url());
        });
        page.on('response', response => {
          if (!response.url().startsWith(origin)) return;
          pendingAssets.push((async () => {
            const name = new URL(response.url()).pathname.replace(/^\/tonemirror\//, '') || 'index.html';
            const bytes = await response.body();
            assert.equal(sha(bytes), sha(await readFile(resolve(dist, name))));
            loaded[name] = { bytes: bytes.length, sha256: sha(bytes) };
          })());
        });
        await page.addInitScript(() => {
          window.audioStudy = { jobs: [], decodes: [], playbacks: [], pending: [], violations: [], workerCount: 0, role: 'attempt' };
          const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
          document.addEventListener('securitypolicyviolation', event => window.audioStudy.violations.push(event.violatedDirective));
          const NativeContext = AudioContext;
          window.AudioContext = class extends NativeContext {
            async decodeAudioData(...args) {
              const result = await super.decodeAudioData(...args);
              const channels = [];
              for (let i = 0; i < result.numberOfChannels; i++) {
                const pcm = result.getChannelData(i);
                channels.push({ nonFinite: pcm.reduce((sum, value) => sum + Number(!Number.isFinite(value)), 0) });
              }
              window.audioStudy.decodes.push({ sampleRate: result.sampleRate, frames: result.length, channels });
              return result;
            }
          };
          const NativeWorker = Worker;
          const nativeStart = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function (...args) {
            const copy = this.buffer.getChannelData(0).slice();
            const record = { samples: copy.length, sampleRate: this.buffer.sampleRate,
              nonFinite: copy.reduce((count, value) => count + Number(!Number.isFinite(value)), 0),
              playbackRate: this.playbackRate.value };
            window.audioStudy.playbacks.push(record);
            window.audioStudy.pending.push(digest(copy.buffer).then(pcmSha256 => { record.pcmSha256 = pcmSha256; }));
            return nativeStart.apply(this, args);
          };
          window.Worker = class extends NativeWorker {
            constructor(...args) {
              super(...args); this.id = ++window.audioStudy.workerCount; this.records = new Map();
              this.addEventListener('message', event => {
                const record = this.records.get(event.data.requestId);
                if (!record) return;
                if (event.data.type === 'failed') { record.state = 'failed'; record.error = event.data.error; }
                else if (event.data.type === 'analyzed') {
                  record.state = 'analyzed';
                  const { contour, spectrogram } = event.data;
                  record.frames = contour.points.length; record.voiced = contour.points.filter(point => point.voiced).length;
                  const flat = new Float32Array(spectrogram.frames.reduce((size, frame) => size + frame.length, 0));
                  let at = 0; for (const frame of spectrogram.frames) { flat.set(frame, at); at += frame.length; }
                  window.audioStudy.pending.push(Promise.all([digest(new TextEncoder().encode(JSON.stringify(contour))), digest(flat.buffer)])
                    .then(([contourSha256, spectrogramSha256]) => Object.assign(record, { contourSha256, spectrogramSha256 })));
                }
              });
            }
            postMessage(message, ...args) {
              if (message.type === 'analyze') {
                const copy = message.pcm.slice();
                const record = { role: window.audioStudy.role, worker: this.id, requestId: message.requestId,
                  algorithm: message.algorithm, sampleRate: message.sampleRate, samples: copy.length,
                  nonFinite: copy.reduce((sum, value) => sum + Number(!Number.isFinite(value)), 0), state: 'pending' };
                window.audioStudy.lastInput = copy;
                window.audioStudy.jobs.push(record); this.records.set(message.requestId, record);
                window.audioStudy.pending.push(digest(copy.buffer).then(pcmSha256 => { record.pcmSha256 = pcmSha256; }));
              }
              return super.postMessage(message, ...args);
            }
          };
        });
        await page.goto(`${origin}/tonemirror/`);
        await page.getByLabel('Choose an audio file to load').waitFor({ state: 'attached' });
        await expect(page.locator('.tm-library-list')).toContainText('Saved invalid NaN');
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].map(font => font.load())); });
        await Promise.all(pendingAssets);
        await context.setOffline(true); offline = true;
        server.closeAllConnections(); await new Promise(done => server.close(done));
        const input = page.getByLabel('Choose an audio file to load');
        const label = page.locator('.tm-clip-label'), status = page.locator('.tm-status');
        const tab = role => page.getByRole('tab', { name: role === 'reference' ? 'Reference' : 'Your attempt', exact: true });
        async function select(role) { await tab(role).click(); await page.evaluate(role => { window.audioStudy.role = role; }, role); }
        async function waitComplete() {
          await page.waitForFunction(() => !/Reading|Decoding|Analyzing/.test(document.querySelector('.tm-status').textContent));
          await page.waitForFunction(() => window.audioStudy.jobs.at(-1)?.state !== 'pending');
          await page.waitForFunction(() => !document.querySelector('.tm-comparison-note').textContent.includes('Comparing'));
          await page.evaluate(async () => Promise.all(window.audioStudy.pending));
        }
        async function good(role) {
          await select(role); await input.setInputFiles(upload(`valid-${role}.wav`));
          await expect(status).toContainText(`valid-${role}.wav —`); await waitComplete();
        }
        async function capture(kind, id, role, algorithm, rejected, expectedScore) {
          await waitComplete();
          if (!rejected) await expect(page.locator('.tm-score')).toHaveText(expectedScore === 'numeric' ? /^\d+$/ : expectedScore);
          const job = await page.evaluate(() => window.audioStudy.jobs.at(-1));
          const clipLabel = await label.innerText(), score = await page.locator('.tm-score').innerText();
          const text = await status.innerText(), note = await page.locator('.tm-comparison-note').innerText();
          const agrees = rejected ? job.state === 'failed' && text.includes('invalid audio samples') &&
            clipLabel.includes(`valid-${role}.wav`) && !note.includes(id) :
            job.state === 'analyzed' && job.nonFinite === 0 && (expectedScore === 'numeric' ? /^\d+$/.test(score) : score === expectedScore);
          observations.push({ engine, width, algorithm, role, kind, id, expectedRejected: rejected,
            agrees, job, label: clipLabel, score, status: text, note,
            ...(kind === 'file' ? { nativeDecode: await page.evaluate(() => window.audioStudy.decodes.at(-1)) } : {}) });
        }
        const exports = [];
        for (const algorithm of ['yin', 'mpm']) {
          await page.getByLabel('Pitch detection algorithm').selectOption(algorithm);
          await good('attempt'); await good('reference');
          for (const role of ['attempt', 'reference']) {
            for (const [id, options, expectedScore] of [
              ['finite-voice', {}, '100'], ['genuine-silence-gap', { value: 0 }, 'numeric'],
              ['complete-silence', { silence: true }, 'Unavailable']
            ]) {
              await good(role === 'attempt' ? 'reference' : 'attempt'); await select(role);
              await input.setInputFiles(upload(`${id}.wav`, options));
              await expect(status).toContainText(`${id}.wav —`);
              await capture('control', id, role, algorithm, false, expectedScore);
            }
            await good(role === 'attempt' ? 'reference' : 'attempt');
            for (const item of cases) {
              await good(role); await input.setInputFiles(upload(`${item.id}.wav`, item));
              await capture('file', item.id, role, algorithm, true);
              if (algorithm === 'yin' && role === 'attempt' && item.id === 'nan-middle') {
                await page.screenshot({ path: resolve(output, `${engine}-${width}.png`), fullPage: true });
              }
            }
          }
          for (const item of seeded) {
            await good('attempt'); await good('reference');
            const jobsBefore = await page.evaluate(() => window.audioStudy.jobs.length);
            await page.locator('.tm-library-item').filter({ hasText: item.name }).getByRole('button', { name: 'Use', exact: true }).click();
            await page.waitForFunction(count => window.audioStudy.jobs.length > count, jobsBefore);
            await capture('saved', item.id, 'reference', algorithm, true);
          }
          // The preserved audio remains exportable, or baseline exposes its delayed failure.
          if (phase === 'after') {
            const expected = await page.evaluate(() => ({
              sha256: window.audioStudy.jobs.filter(job => job.role === 'reference' && job.state === 'analyzed').at(-1).pcmSha256,
            }));
            const played = [];
            for (const halfSpeed of [false, true]) {
              await page.getByLabel('half-speed').setChecked(halfSpeed);
              const before = await page.evaluate(() => window.audioStudy.playbacks.length);
              await page.getByRole('button', { name: '▶ Play', exact: true }).click();
              await expect(page.getByRole('button', { name: '⏸ Pause', exact: true })).toBeVisible();
              await page.waitForFunction(count => window.audioStudy.playbacks.length > count, before);
              await page.getByRole('button', { name: '⏸ Pause', exact: true }).click();
              await page.evaluate(async () => Promise.all(window.audioStudy.pending));
              const playback = await page.evaluate(() => window.audioStudy.playbacks.at(-1));
              assert.equal(playback.nonFinite, 0); assert.equal(playback.playbackRate, 1);
              assert.equal(playback.samples, halfSpeed ? 88200 : 44100);
              if (!halfSpeed) assert.equal(playback.pcmSha256, expected.sha256);
              played.push({ halfSpeed, ...playback });
            }
            await page.getByLabel('half-speed').uncheck();
            const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download WAV', exact: true }).click();
            const download = await event; const path = resolve(output, `${engine}-${width}-${algorithm}.wav`); await download.saveAs(path);
            const bytes = await readFile(path), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            let data;
            for (let at = 12; at + 8 <= bytes.length;) {
              const size = view.getUint32(at + 4, true);
              if (bytes.toString('ascii', at, at + 4) === 'data') data = bytes.subarray(at + 8, at + 8 + size);
              at += 8 + size + size % 2;
            }
            assert(data); assert.equal(sha(data), expected.sha256);
            exports.push({ algorithm, bytes: bytes.length, sha256: sha(bytes), pcmSha256: sha(data), previousValidPcmMatches: true, playbacks: played });
            page.once('dialog', dialog => dialog.accept(`Preserved ${algorithm} reference`));
            await page.getByRole('button', { name: 'Save current reference', exact: true }).click();
            await expect(page.locator('.tm-library-list')).toContainText(`Preserved ${algorithm} reference`);
            const savedClip = await page.evaluate(async name => {
              const db = await new Promise(resolve => { const request = indexedDB.open('tonemirror'); request.onsuccess = () => resolve(request.result); });
              const records = await new Promise(resolve => {
                const request = db.transaction('references').objectStore('references').getAll(); request.onsuccess = () => resolve(request.result);
              });
              db.close();
              const record = records.find(record => record.name === name);
              if (!record) throw new Error('The preserved clip was not saved.');
              return { name, sampleRate: record.sampleRate, bytes: record.pcmBuffer.byteLength,
                pcmSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', record.pcmBuffer)), value => value.toString(16).padStart(2, '0')).join('') };
            }, `Preserved ${algorithm} reference`);
            assert.equal(savedClip.pcmSha256, expected.sha256);
            exports.at(-1).savedClip = savedClip;
          } else {
            await page.getByRole('button', { name: 'Download WAV', exact: true }).click();
            await expect(page.locator('#download-note')).toContainText('invalid audio samples');
            exports.push({ algorithm, delayedExportFailure: await page.locator('#download-note').innerText() });
          }
          await good('reference'); await good('attempt');
          await expect(page.locator('.tm-score')).toHaveText('100');
        }
        const saved = await page.evaluate(async ids => {
          const db = await new Promise(resolve => { const request = indexedDB.open('tonemirror'); request.onsuccess = () => resolve(request.result); });
          const records = await Promise.all(ids.map(id => new Promise(resolve => {
            const request = db.transaction('references').objectStore('references').get(id); request.onsuccess = () => resolve(request.result);
          })));
          db.close();
          return Promise.all(records.map(async record => ({ id: record.id, bytes: record.pcmBuffer.byteLength,
            sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', record.pcmBuffer)), byte => byte.toString(16).padStart(2, '0')).join('') })));
        }, seeded.map(item => item.id));
        for (const record of saved) assert.equal(record.sha256, sha(seeded.find(item => item.id === record.id).buffer.subarray(58)));
        const violations = (await new AxeBuilder({ page }).analyze()).violations.map(row => row.id);
        assert.deepEqual(violations, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await Promise.all(pendingAssets); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(late, []);
        const policy = await page.evaluate(() => window.audioStudy.violations); assert.deepEqual(policy, []);
        views.push({ engine, browser: browser.version(), width, offlineAfterInitialLoad: true,
          served, loaded, exports, savedRecordBytesUnchanged: saved, finalRecoveryScore: '100',
          axeViolations: violations, overflow: false, pageErrors: errors, externalRequests: external,
          lateRequests: late, policyViolations: policy });
      } finally { server.closeAllConnections(); server.close(); await context.close(); }
    }
  } finally { await browser.close(); }
}
const result = { phase, node: process.version, workflows: observations.length,
  disagreements: observations.filter(row => !row.agrees).length, observations, views };
await writeFile(resolve(output, 'observations.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ phase, workflows: result.workflows, disagreements: result.disagreements, views: views.length }));
if (phase === 'after') assert.equal(result.disagreements, 0);
