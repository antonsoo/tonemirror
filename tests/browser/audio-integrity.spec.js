import { test, expect } from '@playwright/test';
import { cases, upload } from '../../studies/audio-integrity/fixtures.mjs';

const fileInput = page => page.getByLabel('Choose an audio file to load');
const tab = (page, role) => page.getByRole('tab', { name: role === 'reference' ? 'Reference' : 'Your attempt', exact: true });

for (const algorithm of ['yin', 'mpm']) test(`${algorithm}: invalid decoded samples never replace usable audio`, async ({ page }) => {
  await page.goto('/tonemirror/');
  await page.getByLabel('Pitch detection algorithm').selectOption(algorithm);
  for (const role of ['attempt', 'reference']) {
    await tab(page, role).click();
    await fileInput(page).setInputFiles(upload(`valid-${role}.wav`));
    await expect(page.locator('.tm-status')).toContainText(`valid-${role}.wav —`);
  }
  await expect(page.locator('.tm-score')).toHaveText('100');
  for (const role of ['attempt', 'reference']) {
    await tab(page, role).click();
    for (const item of cases) {
      await fileInput(page).setInputFiles(upload(`${item.id}.wav`, item));
      await expect(page.locator('.tm-status')).toContainText('invalid audio samples');
      await expect(page.locator('.tm-status')).toContainText('Previous clip kept');
      await expect(page.locator('.tm-clip-label')).toContainText(`valid-${role}.wav`);
      await expect(page.locator('.tm-score')).toHaveText('100');
      await expect(page.locator('.tm-comparison-note')).toContainText('valid-attempt.wav');
      await expect(page.locator('.tm-comparison-note')).toContainText('valid-reference.wav');
    }
  }
  // Real zero-valued PCM is ordinary unvoiced audio, with an unavailable score.
  await tab(page, 'attempt').click();
  await fileInput(page).setInputFiles(upload('silence.wav', { silence: true }));
  await expect(page.locator('.tm-status')).toContainText('silence.wav —');
  await expect(page.locator('.tm-score')).toHaveText('Unavailable');
  await fileInput(page).setInputFiles(upload('recovered.wav'));
  await expect(page.locator('.tm-status')).toContainText('recovered.wav —');
  await expect(page.locator('.tm-score')).toHaveText('100');
});
