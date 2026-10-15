/* global indexedDB, innerWidth */
import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import AxeBuilder from "@axe-core/playwright";

// Three synthetic seconds: level, rising, falling. The middle second is a
// useful independent target for both the audio slice and the new comparison.
function phrase() {
  const rate = 48000, length = 3 * rate, wav = Buffer.alloc(44 + length * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(length * 2, 40);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate, hz = t < 1 ? 160 : t < 2 ? 140 + 100 * (t - 1) : 240 - 100 * (t - 2);
    phase += 2 * Math.PI * hz / rate;
    wav.writeInt16LE(Math.round(Math.sin(phase) * 14000), 44 + i * 2);
  }
  return { name: "synthetic-phrase.wav", mimeType: "audio/wav", buffer: wav };
}

const status = (page) => page.locator(".tm-status");
const label = (page) => page.locator(".tm-clip-label");
const input = (page) => page.getByLabel("Choose an audio file to load");
const button = (page, name) => page.getByRole("button", { name, exact: true });
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
async function region(page, start, end) {
  await page.getByLabel("Region start (s)").fill(String(start));
  await page.getByLabel("Region end (s)").fill(String(end));
}
async function keep(page, start, end, duration) {
  await region(page, start, end);
  await button(page, "Keep region").focus();
  await page.keyboard.press("Enter");
  await expect(label(page)).toContainText(`· ${duration.toFixed(2)}s`);
  await expect(button(page, "Restore full clip")).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.regionProbe = { inputs: [], playback: null, errors: [], violations: [], hold: false, fail: false };
    window.addEventListener("error", e => window.regionProbe.errors.push(e.message));
    document.addEventListener("securitypolicyviolation", e => window.regionProbe.violations.push(e.violatedDirective));
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message.type === "analyze") {
          if (window.regionProbe.fail) { window.regionProbe.fail = false; throw new Error("injected trim failure"); }
          window.regionProbe.inputs.push({ pcm: message.pcm.slice(), sampleRate: message.sampleRate, algorithm: message.algorithm });
          if (window.regionProbe.hold) return;
        }
        return super.postMessage(message, ...rest);
      }
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.regionProbe.playback = this.buffer.getChannelData(0).slice();
      window.regionProbe.loop = { enabled: this.loop, start: this.loopStart, end: this.loopEnd };
      window.regionProbe.offset = args[1] ?? 0;
      return start.apply(this, args);
    };
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.regionProbe.errors)).toEqual([]);
  expect(await page.evaluate(() => window.regionProbe.violations)).toEqual([]);
});

test("first playback and active edits enter the chosen passage at both speeds", async ({ page, context }) => {
  await page.goto("./");
  await context.setOffline(true);
  await input(page).setInputFiles(phrase());
  await expect(button(page, "▶ Play")).toBeEnabled();
  await region(page, 1, 2);
  await button(page, "Loop region").click();
  await button(page, "▶ Play").click();
  expect(await page.evaluate(() => window.regionProbe.offset)).toBe(1);
  await region(page, 2.4, 2.8);
  await button(page, "Loop region").click();
  expect(await page.evaluate(() => window.regionProbe.offset)).toBeCloseTo(2.4, 5);
  await expect(button(page, "⏸ Pause")).toBeVisible();
  await button(page, "Clear loop").click();
  await expect(button(page, "⏸ Pause")).toBeVisible();
  await button(page, "⏸ Pause").click();
  await input(page).setInputFiles(phrase());
  await expect(button(page, "▶ Play")).toBeEnabled();
  await region(page, 1, 2);
  await button(page, "Loop region").click();
  await page.getByRole("checkbox", { name: "half-speed, same pitch", exact: true }).check();
  await button(page, "▶ Play").click();
  await expect(page.locator("#playback-note")).toContainText("pitch preserved");
  expect(await page.evaluate(() => window.regionProbe.offset)).toBe(2);
  expect(await page.evaluate(() => window.regionProbe.loop)).toEqual({ enabled: true, start: 2, end: 4 });
});

for (const width of [1440, 375]) test(`extract, compare, play, save and restore offline at ${width}px`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: width === 375 ? "light" : "dark" });
  await page.goto("./");
  const requests = [];
  page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await context.setOffline(true);
  await input(page).setInputFiles(phrase());
  await expect(label(page)).toContainText("· 3.00s");
  await button(page, "Classify current attempt").click();
  await expect(page.locator(".tm-tone-badge")).not.toHaveText("?");
  await region(page, 1, 2);
  await button(page, "Loop region").focus();
  await page.keyboard.press("Enter");
  await button(page, "▶ Play").click();
  await button(page, "⏸ Pause").click();
  expect(await page.evaluate(() => window.regionProbe.loop)).toEqual({ enabled: true, start: 1, end: 2 });
  await keep(page, 1, 2, 1);
  await expect(page.locator(".tm-tone-badge")).toHaveText("?");
  await button(page, "Classify current attempt").click();
  await expect(page.locator(".tm-tone-badge")).toHaveText("2");
  await expect(label(page)).toContainText("[1.000–2.000s]");
  await tab(page, "Reference").click();
  await expect(button(page, "Save current reference")).toBeDisabled();
  await input(page).setInputFiles(phrase());
  await expect(label(page)).toContainText("· 3.00s");
  await keep(page, 1, 2, 1);
  await expect(page.locator(".tm-score")).toHaveText("100");
  await button(page, "▶ Play").click();
  await button(page, "⏸ Pause").click();
  page.once("dialog", dialog => dialog.accept("Selected rising second"));
  await button(page, "Save current reference").click();
  await expect(page.locator(".tm-library-list")).toContainText("Selected rising second");
  const evidence = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("tonemirror"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const saved = await new Promise((resolve, reject) => {
      const get = db.transaction("references").objectStore("references").getAll();
      get.onsuccess = () => resolve(get.result[0]); get.onerror = () => reject(get.error);
    });
    db.close();
    const original = window.regionProbe.inputs[0];
    const expected = original.pcm.slice(original.sampleRate, 2 * original.sampleRate);
    const analyzed = window.regionProbe.inputs[1].pcm;
    const playback = window.regionProbe.playback;
    const mismatches = pcm => pcm.length === expected.length ? pcm.reduce((n, v, i) => n + Number(v !== expected[i]), 0) : -1;
    return { originalSamples: original.pcm.length, selectedSamples: expected.length, sampleRate: original.sampleRate,
      analyzedMismatches: mismatches(analyzed), playbackMismatches: mismatches(playback), storedMismatches: mismatches(new Float32Array(saved.pcmBuffer)) };
  });
  expect(evidence.analyzedMismatches).toBe(0);
  expect(evidence.playbackMismatches).toBe(0);
  expect(evidence.storedMismatches).toBe(0);
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator("#audio-analysis").screenshot({ path: testInfo.outputPath("practice-region.png") });
  await testInfo.attach("sample-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });

  // Repeated edits are relative to the current excerpt, with labels tied to the
  // original timeline. Algorithm changes must retain the original for restore.
  await keep(page, 0.25, 0.75, 0.5);
  await expect(label(page)).toContainText("[1.250–1.750s]");
  await page.getByLabel("Pitch detection algorithm").selectOption("mpm");
  await expect(status(page)).toHaveText("Pitch analysis updated (MPM).");
  await expect(button(page, "Restore full clip")).toBeEnabled();
  await button(page, "Restore full clip").click();
  await expect(label(page)).toContainText("Reference: synthetic-phrase.wav · 3.00s");
  await expect(button(page, "Restore full clip")).toBeHidden();
  expect(await page.evaluate(() => {
    const inputs = window.regionProbe.inputs;
    const restored = inputs.at(-1);
    return restored.pcm.length === inputs[0].pcm.length && restored.pcm.every((value, i) => value === inputs[0].pcm[i]);
  })).toBe(true);
  await tab(page, "Your attempt").click();
  await expect(label(page)).toContainText("[1.000–2.000s]");
  await expect(button(page, "Restore full clip")).toBeEnabled();
  // Only the excerpt was persisted. It loads as a standalone reference after reload.
  await context.setOffline(false);
  await page.reload();
  await button(page, "Use").click();
  await expect(label(page)).toContainText("Selected rising second · 1.00s");
  await expect(button(page, "Restore full clip")).toBeHidden();
});

test("invalid bounds, failed and cancelled edits preserve the current clip", async ({ page }) => {
  await page.goto("./");
  await input(page).setInputFiles(phrase());
  await expect(label(page)).toContainText("· 3.00s");
  for (const [start, end] of [["", "2"], ["-1", "2"], ["2", "1"], ["1", "4"]]) {
    await region(page, start, end);
    await expect(button(page, "Keep region")).toBeDisabled();
    await expect(button(page, "Loop region")).toBeDisabled();
  }
  await region(page, 1, 2);
  await page.evaluate(() => { window.regionProbe.fail = true; });
  await button(page, "Keep region").click();
  await expect(status(page)).toContainText("Previous clip kept");
  await expect(label(page)).toContainText("· 3.00s");
  await expect(button(page, "Restore full clip")).toBeHidden();
  await button(page, "Retry audio analysis").click();
  await expect(label(page)).toContainText("· 1.00s");
  await region(page, 0.1, 0.9);
  await page.evaluate(() => { window.regionProbe.hold = true; });
  await button(page, "Keep region").click();
  await expect(button(page, "Keep region")).toBeDisabled();
  await expect(button(page, "Save current attempt")).toBeDisabled();
  await button(page, "Cancel work").click();
  await expect(label(page)).toContainText("· 1.00s");
  await page.evaluate(() => { window.regionProbe.hold = false; });
  await button(page, "Restore full clip").click();
  await expect(label(page)).toContainText("· 3.00s");
  await keep(page, 1, 2, 1);
  await input(page).setInputFiles(phrase());
  await expect(label(page)).toContainText("· 3.00s");
  await expect(button(page, "Restore full clip")).toBeHidden();
});

test("dragged regions can be kept, and saved synthetic references retain their label", async ({ page }) => {
  await page.goto("./");
  await page.locator(".tm-chip").first().click();
  await expect(label(page)).toContainText("(synthetic)");
  const canvas = page.locator("#audio-analysis canvas"), box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + 20);
  await page.mouse.up();
  await expect(button(page, "Keep region")).toBeEnabled();
  await button(page, "Keep region").click();
  await expect(label(page)).toContainText("· 0.30s");
  page.once("dialog", dialog => dialog.accept("Synthetic excerpt"));
  await button(page, "Save current reference").click();
  await expect(page.locator(".tm-library-list")).toContainText("Synthetic excerpt");
  await button(page, "Use").click();
  await expect(label(page)).toContainText("Synthetic excerpt (synthetic)");
  await expect(button(page, "Restore full clip")).toBeHidden();
});
