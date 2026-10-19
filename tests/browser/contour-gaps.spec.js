import { test, expect } from '@playwright/test';
import { fileURLToPath, URL } from 'node:url';
import { observeContourDrawing, readContourDrawing } from './contour-observer.js';

const recording = fileURLToPath(new URL('../../src/references/FourMandarinTones.ogg', import.meta.url));

for (const algorithm of ['yin', 'mpm']) test(`${algorithm}: native contour ink preserves unvoiced intervals after alignment`, async ({ page, context }) => {
  await page.addInitScript(observeContourDrawing);
  await page.goto('./');
  await page.evaluate(() => document.fonts.ready);
  await context.setOffline(true);
  await page.getByLabel('Pitch detection algorithm').selectOption(algorithm);
  for (const [i, tab] of ['Reference', 'Your attempt'].entries()) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.getByLabel('Choose an audio file to load').setInputFiles(recording);
    await page.waitForFunction(n => window.gapStudy.contours.length >= n, i + 1);
  }
  await expect(page.locator('.tm-score')).toHaveText('100');
  const result = await page.evaluate(readContourDrawing);
  expect(result.gaps.length).toBeGreaterThan(0);
  expect(result.gaps.some(g => g.nextVoicedTime - g.lastVoicedTime > 0.6)).toBe(true);
  expect(result.gaps.every(g => g.referenceConnections === 0 && g.alignedAttemptConnections === 0)).toBe(true);
  expect(result.overflow).toBe(0);
  expect(result.violations).toEqual([]);
});
