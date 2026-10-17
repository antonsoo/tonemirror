import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const label = page => page.locator(".tm-clip-label");
const credit = page => page.locator(".tm-audio-credit");

async function exported(page) {
  const event = page.waitForEvent("download"); await button(page, "Download WAV").click();
  const download = await event; expect(await download.failure()).toBeNull();
  return { name: "renamed.wav", mimeType: "audio/wav", buffer: await readFile(await download.path()) };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.recordedTest = { hold: false, jobs: 0 };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message.type === "analyze") {
          window.recordedTest.jobs++;
          if (window.recordedTest.hold) return;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  await page.goto("./");
});

test("recorded tones work on first use offline and carry credits through saving and WAV reimport", async ({ page, context }) => {
  await page.evaluate(() => document.fonts.ready);
  await context.setOffline(true);
  await expect(button(page, "Play reference")).toBeDisabled();
  for (const [syllable, tone] of [["mā", 1], ["má", 2], ["mǎ", 3], ["mà", 4]]) {
    await button(page, `Load recorded ${syllable}, tone ${tone}`).click();
    await expect(label(page)).toContainText(`Recorded Mandarin ${syllable} (tone ${tone})`);
    await expect(credit(page)).toContainText("Wolfdog (2019)");
    await expect(button(page, "Play reference")).toBeEnabled();
  }
  await page.getByLabel("Region start (s)").fill("0.1"); await page.getByLabel("Region end (s)").fill("0.3");
  await button(page, "Keep region").click(); await expect(label(page)).toContainText("· 0.20s");
  await expect(credit(page)).toContainText("4.600–4.800s");
  const wav = await exported(page);
  expect(wav.buffer.toString("utf8")).toContain('"licenseName":"CC BY-SA 4.0"');
  expect(wav.buffer.toString("utf8")).toContain('"creator":"Wolfdog (2019)"');
  page.once("dialog", dialog => dialog.accept("Recorded syllable"));
  await button(page, "Save current reference").click(); await expect(page.locator(".tm-library-list")).toContainText("Recorded syllable");
  await button(page, "Restore full clip").click(); await expect(label(page)).toContainText("Recorded Mandarin: four tones");
  await button(page, "Use").click(); await expect(label(page)).toContainText("Recorded syllable · 0.20s");
  await expect(credit(page)).toContainText("4.600–4.800s");
  await page.getByRole("tab", { name: "Your attempt", exact: true }).click();
  await page.getByLabel("Choose an audio file to load").setInputFiles(wav);
  await expect(label(page)).toContainText("renamed.wav · 0.20s"); await expect(credit(page)).toContainText("4.600–4.800s");
  await expect(page.locator(".tm-score")).toHaveText("100");
});

test("cancelled analysis and damaged credits keep the last recorded reference and its attribution", async ({ page }) => {
  await button(page, "Load recorded má, tone 2").click(); await expect(label(page)).toContainText("Recorded Mandarin má");
  const before = await label(page).textContent(), originalCredit = await credit(page).textContent();
  const wav = await exported(page);
  await page.evaluate(() => { window.recordedTest.hold = true; });
  await button(page, "Load recorded mǎ, tone 3").click();
  await expect.poll(() => page.evaluate(() => window.recordedTest.jobs)).toBe(2);
  await button(page, "Cancel work").click();
  await expect(label(page)).toHaveText(before); await expect(credit(page)).toHaveText(originalCredit);
  await page.evaluate(() => { window.recordedTest.hold = false; });
  const at = wav.buffer.indexOf('{"title"'); expect(at).toBeGreaterThan(0);
  wav.buffer[at] = 0x5b;
  await page.getByLabel("Choose an audio file to load").setInputFiles(wav);
  await expect(page.locator(".tm-status")).toContainText("audio credit is unreadable");
  await expect(label(page)).toHaveText(before); await expect(credit(page)).toHaveText(originalCredit);
  await page.getByLabel("Pitch detection algorithm").selectOption("mpm");
  await expect(page.locator(".tm-status")).toContainText("Pitch analysis updated");
  await expect(credit(page)).toHaveText(originalCredit);
});
