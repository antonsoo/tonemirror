/* global innerWidth, crypto */
import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const pair = page => button(page, 'Play reference then attempt');
const stop = page => button(page, 'Stop listening');
const note = page => page.locator('#paired-listening-status');
function tone(hz = 220) {
  const rate = 48000, length = Math.round(rate * 1.2), wav = Buffer.alloc(44 + length * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34);
  wav.write('data', 36); wav.writeUInt32LE(length * 4, 40);
  for (let i = 0; i < length; i++) wav.writeFloatLE(.3 * Math.sin(2 * Math.PI * hz * i / rate), 44 + i * 4);
  return { name: `synthetic-${hz}Hz.wav`, mimeType: 'audio/wav', buffer: wav };
}
async function setup(page, context) {
  await page.goto('./');
  await page.evaluate(async () => { await Promise.allSettled(Array.from(document.fonts, f => f.load())); await document.fonts.ready; });
  await context.setOffline(true);
  await expect(pair(page)).toBeDisabled();
  await button(page, 'Load recorded má, tone 2').click();
  await expect(page.locator('.tm-clip-label')).toContainText('Recorded Mandarin má');
  await expect(pair(page)).toBeDisabled();
  await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
  await page.getByLabel('Choose an audio file to load').setInputFiles(tone());
  await expect(page.locator('.tm-status')).toContainText('synthetic-220Hz.wav —');
  await expect(pair(page)).toBeEnabled();
}
async function chooseRegion(page, start, end) {
  await page.getByLabel('Region start (s)').fill(String(start));
  await page.getByLabel('Region end (s)').fill(String(end));
  await button(page, 'Loop region').click();
}
async function startPair(page) {
  await pair(page).click();
  await expect(note(page)).toHaveText('Listening to the reference.');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.pairProbe = { inputs: [], starts: [], nodes: [], stops: [], errors: [], csp: [], slowJobs: 0, terminated: 0, holdSlow: false, holdResume: false, resumeWaiters: [], failSecond: false };
    window.addEventListener('error', event => window.pairProbe.errors.push(event.message));
    document.addEventListener('securitypolicyviolation', event => window.pairProbe.csp.push(event.violatedDirective));
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message.type === 'analyze') window.pairProbe.inputs.push({ pcm: message.pcm.slice(), rate: message.sampleRate });
        if (message.type === 'prepare-half-speed') {
          this.slow = true; window.pairProbe.slowJobs++;
          if (window.pairProbe.holdSlow) return;
        }
        return super.postMessage(message, ...rest);
      }
      terminate() { if (this.slow) window.pairProbe.terminated++; super.terminate(); }
    };
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function (...args) {
      const start = () => resume.apply(this, args);
      return window.pairProbe.holdResume ? new Promise((resolve, reject) => window.pairProbe.resumeWaiters.push(() => start().then(resolve, reject))) : start();
    };
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (window.pairProbe.failSecond && window.pairProbe.starts.length % 2 === 1) { window.pairProbe.failSecond = false; throw new Error('controlled second start failure'); }
      const index = window.pairProbe.nodes.push(this) - 1;
      window.pairProbe.starts.push({ index, when: args[0] ?? 0, now: this.context.currentTime, pcm: this.buffer.getChannelData(0).slice(),
        rate: this.buffer.sampleRate, playbackRate: this.playbackRate.value, loop: this.loop, offset: args[1] ?? 0 });
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.pairProbe.stops.push({ index: window.pairProbe.nodes.indexOf(this), at: this.context.currentTime });
      return stop.apply(this, args);
    };
  });
});
test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.pairProbe.errors)).toEqual([]);
  expect(await page.evaluate(() => window.pairProbe.csp)).toEqual([]);
});

test('first paired playback works offline, plays both selected passages once at normal speed, and keeps export samples', async ({ page, context }) => {
  await setup(page, context);
  await chooseRegion(page, .2, .7);
  await page.getByRole('tab', { name: 'Reference', exact: true }).click();
  await chooseRegion(page, .1, .6);
  await page.getByRole('checkbox', { name: 'half-speed, same pitch', exact: true }).check();
  await pair(page).focus(); await page.keyboard.press('Enter');
  await expect(note(page)).toHaveText('Listening to the reference.');
  const actual = await page.evaluate(() => {
    const p = window.pairProbe, [ref, att] = p.inputs;
    const expected = [ref.pcm.slice(Math.floor(.1 * ref.rate), Math.ceil(.6 * ref.rate)), att.pcm.slice(Math.floor(.2 * att.rate), Math.ceil(.7 * att.rate))];
    return { starts: p.starts.map((row, index) => ({ rate: row.rate, samples: row.pcm.length, playbackRate: row.playbackRate, loop: row.loop, offset: row.offset,
      when: row.when, matches: row.pcm.length === expected[index].length && row.pcm.every((v, i) => v === expected[index][i]) })), slowJobs: p.slowJobs };
  });
  expect(actual.starts).toHaveLength(2);
  for (const row of actual.starts) { expect(row.matches).toBe(true); expect(row.playbackRate).toBe(1); expect(row.loop).toBe(false); expect(row.offset).toBe(0); }
  expect(actual.starts[1].when - actual.starts[0].when - actual.starts[0].samples / actual.starts[0].rate).toBeCloseTo(.35, 10);
  expect(actual.slowJobs).toBe(0);
  await expect(note(page)).toHaveText('Finished listening to the reference and your attempt.');
  await expect(pair(page)).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Reference', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('checkbox', { name: 'half-speed, same pitch', exact: true })).toBeChecked();
  const pending = page.waitForEvent('download'); await button(page, 'Download WAV').click();
  const bytes = await readFile(await (await pending).path()); let pcm;
  for (let at = 12; at + 8 <= bytes.length;) { const size = bytes.readUInt32LE(at + 4); if (bytes.toString('ascii', at, at + 4) === 'data') pcm = bytes.subarray(at + 8, at + 8 + size); at += 8 + size + size % 2; }
  const expected = await page.evaluate(async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', window.pairProbe.inputs[0].pcm))].map(b => b.toString(16).padStart(2, '0')).join(''));
  expect(createHash('sha256').update(pcm).digest('hex')).toBe(expected);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('stop and tab changes revoke the future attempt and leave listening restartable', async ({ page, context }) => {
  await setup(page, context); await startPair(page); await stop(page).click();
  await expect(note(page)).toHaveText('Listening stopped.');
  let observed = await page.evaluate(() => ({ starts: window.pairProbe.starts.map(row => row.when), stops: window.pairProbe.stops.slice(-2) }));
  expect(observed.stops).toHaveLength(2); expect(observed.stops[1].at).toBeLessThan(observed.starts[1]);
  await startPair(page);
  await page.getByRole('tab', { name: 'Reference', exact: true }).click();
  await expect(note(page)).toHaveText('Listening stopped.'); await expect(pair(page)).toBeEnabled();
  observed = await page.evaluate(() => ({ starts: window.pairProbe.starts.map(row => row.when), stops: window.pairProbe.stops.slice(-2) }));
  expect(observed.stops[1].index).toBe(3); expect(observed.stops[1].at).toBeLessThan(observed.starts[3]);
});

test('cancelling a pending context resume prevents stale starts and can be retried', async ({ page, context }) => {
  await setup(page, context);
  await page.evaluate(() => { window.pairProbe.holdResume = true; });
  await pair(page).click(); await expect(note(page)).toHaveText('Preparing to listen…');
  await stop(page).click();
  await page.evaluate(() => { window.pairProbe.holdResume = false; for (const resume of window.pairProbe.resumeWaiters.splice(0)) resume(); });
  await expect(note(page)).toHaveText('Listening stopped.');
  expect(await page.evaluate(() => window.pairProbe.starts.length)).toBe(0);
  await startPair(page); expect(await page.evaluate(() => window.pairProbe.starts.length)).toBe(2);
});

test('paired listening terminates a pending slow preview; manual playback cancels the pair', async ({ page, context }) => {
  await setup(page, context);
  await page.evaluate(() => { window.pairProbe.holdSlow = true; });
  await page.getByRole('checkbox', { name: 'half-speed, same pitch', exact: true }).check();
  await button(page, '▶ Play').click(); await expect(button(page, 'Cancel playback')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.pairProbe.slowJobs)).toBe(1);
  await startPair(page);
  expect(await page.evaluate(() => window.pairProbe.terminated)).toBe(1);
  expect(await page.evaluate(() => window.pairProbe.starts.length)).toBe(2);
  await page.getByRole('checkbox', { name: 'half-speed, same pitch', exact: true }).uncheck();
  await expect(note(page)).toHaveText('Listening stopped.');
  await startPair(page); await button(page, '▶ Play').click();
  await expect(button(page, '⏸ Pause')).toBeVisible(); await expect(pair(page)).toBeEnabled();
  expect(await page.evaluate(() => window.pairProbe.starts.length)).toBe(5);
});

test('a failed second start or a replacement stops both passages and keeps the clips usable', async ({ page, context }) => {
  await setup(page, context);
  await page.evaluate(() => { window.pairProbe.failSecond = true; });
  await pair(page).click(); await expect(note(page)).toContainText('controlled second start failure'); await expect(pair(page)).toBeEnabled();
  await startPair(page);
  await page.getByLabel('Choose an audio file to load').setInputFiles(tone(330));
  await expect(page.locator('.tm-status')).toContainText('synthetic-330Hz.wav —'); await expect(note(page)).toHaveText('Listening stopped.');
  await startPair(page); await stop(page).click();
  await expect(pair(page)).toBeEnabled();
});
