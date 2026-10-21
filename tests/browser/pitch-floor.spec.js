/* global innerWidth */
import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

// A calibration signal with a known period, not a recorded voice or learner.
function lowTone() {
  const rate = 48000, samples = rate * 2, b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 50 * i / rate)), 44 + i * 2);
  return { name: 'synthetic-50hz-calibration.wav', mimeType: 'audio/wav', buffer: b };
}

const input = page => page.getByLabel('Choose an audio file to load');
const floor = page => page.getByLabel('Pitch search floor');
const note = page => page.locator('.tm-comparison-note');
async function loadBoth(page) {
  for (const name of ['Reference', 'Your attempt']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await input(page).setInputFiles(lowTone());
    await expect(page.locator('.tm-status')).toContainText('synthetic-50hz-calibration.wav —');
  }
}
async function wav(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download WAV', exact: true }).click();
  const result = await pending;
  return readFile(await result.path());
}
async function observe(page) {
  await page.addInitScript(() => {
    window.floorProbe = { analyzed: [], inputs: [], violations: [], failNext: false, hold: false };
    document.addEventListener('securitypolicyviolation', event => window.floorProbe.violations.push(event.violatedDirective));
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data.type === 'analyzed') window.floorProbe.analyzed.push(event.data.contour);
        });
      }
      postMessage(message, ...args) {
        if (message.type === 'analyze') {
          window.floorProbe.inputs.push({ floor: message.minFrequency, pcm: message.pcm.slice() });
          if (window.floorProbe.failNext) { window.floorProbe.failNext = false; throw new Error('injected range-analysis failure'); }
          if (window.floorProbe.hold) return;
        }
        return super.postMessage(message, ...args);
      }
    };
  });
}

for (const algorithm of ['yin', 'mpm']) for (const width of [375, 1440]) {
  test(`${algorithm}: offline 50 Hz recovery at ${width}px preserves audio and the default`, async ({ page, context }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await observe(page);
    await page.goto('./');
    await context.setOffline(true);
    await expect(floor(page)).toHaveValue('60');
    await page.getByLabel('Pitch detection algorithm').selectOption(algorithm);
    await loadBoth(page);
    await expect(note(page)).toContainText('Pitch floors: reference 60 Hz; attempt 60 Hz');
    const originalWav = await wav(page);
    const before = await page.evaluate(() => window.floorProbe.analyzed.at(-1).points.filter(p => p.f0 !== null && Math.abs(p.f0 - 50) < 1).length);
    expect(before).toBe(0);
    await floor(page).selectOption('40');
    await expect(note(page)).toContainText('Pitch floors: reference 60 Hz; attempt 40 Hz');
    await expect(page.locator('.tm-clip-label')).toContainText('40 Hz search floor');
    const after = await page.evaluate(() => window.floorProbe.analyzed.at(-1).points.filter(p => p.f0 !== null && Math.abs(p.f0 - 50) < 1).length);
    expect(after).toBeGreaterThan(150);
    expect(await wav(page)).toEqual(originalWav);
    await page.getByRole('tab', { name: 'Reference', exact: true }).click();
    await expect(floor(page)).toHaveValue('60');
    await floor(page).selectOption('40');
    await expect(note(page)).toContainText('reference 40 Hz; attempt 40 Hz');
    await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
    await expect(floor(page)).toHaveValue('40');
    await floor(page).selectOption('90');
    await expect(note(page)).toContainText('reference 40 Hz; attempt 90 Hz');
    await floor(page).selectOption('60');
    await expect(note(page)).toContainText('reference 40 Hz; attempt 60 Hz');
    expect(await page.evaluate(() => {
      const { analyzed, inputs } = window.floorProbe;
      const first = analyzed[0], last = analyzed.at(-1);
      return JSON.stringify(first) === JSON.stringify(last)
        && inputs.every(request => request.pcm.every((value, i) => value === inputs[0].pcm[i]));
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => window.floorProbe.violations)).toEqual([]);
    expect(errors).toEqual([]);
    await page.locator('section').filter({ has: page.getByRole('heading', { name: '1. Get some audio' }) })
      .screenshot({ path: testInfo.outputPath('pitch-floor-controls.png') });
  });
}

test('a failed or cancelled floor change keeps each clip labelled with its actual analysis', async ({ page, context }) => {
  await observe(page);
  await page.goto('./');
  await context.setOffline(true);
  await loadBoth(page);
  await page.evaluate(() => { window.floorProbe.failNext = true; });
  await floor(page).selectOption('40');
  await expect(page.locator('.tm-status')).toContainText('Audio update incomplete');
  await expect(note(page)).toContainText('reference 60 Hz; attempt 60 Hz');
  await page.getByRole('button', { name: 'Retry audio analysis', exact: true }).click();
  await expect(note(page)).toContainText('reference 60 Hz; attempt 40 Hz');
  await page.getByRole('tab', { name: 'Reference', exact: true }).click();
  await floor(page).selectOption('40');
  await expect(note(page)).toContainText('reference 40 Hz; attempt 40 Hz');
  await page.getByRole('tab', { name: 'Your attempt', exact: true }).click();
  await expect(page.locator('.tm-score')).toHaveText('100');
  await page.evaluate(() => { window.floorProbe.hold = true; });
  await floor(page).selectOption('90');
  await page.getByRole('button', { name: 'Cancel work', exact: true }).click();
  await expect(page.locator('.tm-status')).toContainText('Cancelled');
  await expect(note(page)).toContainText('reference 40 Hz; attempt 40 Hz');
  await expect(page.locator('.tm-clip-label')).toContainText('40 Hz search floor');
  await expect(page.getByRole('button', { name: 'Download WAV', exact: true })).toBeEnabled();
});
