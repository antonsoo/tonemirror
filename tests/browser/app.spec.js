import { test, expect } from "@playwright/test";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { writeFile, truncate } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";

const fixture = fileURLToPath(new URL("../../examples/mandarin-tone2-attempt-late-rise.wav", import.meta.url));
const referenceFixture = fileURLToPath(new URL("../../examples/mandarin-tone2-reference.wav", import.meta.url));
const input = (page) => page.getByLabel("Choose an audio file to load");
const status = (page) => page.locator(".tm-status");
const label = (page) => page.locator(".tm-clip-label");
const save = (page) => page.getByRole("button", { name: "Save current attempt" });
const play = (page) => page.locator("#audio-analysis").getByRole("button", { name: /Play|Pause/ });
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const library = (page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Your saved references" }) });

async function loadAttempt(page) {
  await input(page).setInputFiles(fixture);
  await expect(status(page)).toContainText("mandarin-tone2-attempt-late-rise.wav —");
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== "http://127.0.0.1:4192") externalRequests.push(request.url());
  });
  await page.exposeFunction("getPageErrors", () => errors);
  await page.exposeFunction("getExternalRequests", () => externalRequests);
  await page.addInitScript(() => {
    window.policyViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => window.policyViolations.push(event.violatedDirective));
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === "skipped") return;
  expect(await page.evaluate(() => window.getPageErrors())).toEqual([]);
  expect(await page.evaluate(() => window.policyViolations)).toEqual([]);
  expect(await page.evaluate(() => window.getExternalRequests())).toEqual([]);
});

test("cancel saves nothing; confirmed names persist across reload and can be deleted", async ({ page }) => {
  await page.goto("./");
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry saved references" })).toBeHidden();
  await loadAttempt(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await save(page).click();
  await expect(library(page)).toContainText("No saved references yet");
  page.once("dialog", (dialog) => dialog.accept("   "));
  await save(page).click();
  await expect(library(page)).toContainText("Give the reference a name");
  page.once("dialog", (dialog) => dialog.accept("  My practice  "));
  await save(page).click();
  await expect(library(page).getByRole("status")).toHaveText("Saved My practice on this device.");
  await page.reload();
  await expect(page.locator(".tm-library-item")).toHaveCount(1);
  await expect(page.locator(".tm-library-item")).toContainText("My practice");
  await library(page).getByRole("button", { name: "Use", exact: true }).click();
  await expect(tab(page, "Reference")).toHaveAttribute("aria-selected", "true");
  await expect(label(page)).toContainText("Reference: My practice");
  await library(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(library(page)).toContainText("No saved references yet");
});

test("denied storage leaves audio usable and the library can retry", async ({ page }) => {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      if (!window.allowStorage) throw new DOMException("Storage denied", "SecurityError");
      return open.apply(this, args);
    };
  });
  await page.goto("./");
  await expect(library(page)).toContainText("Saved references are unavailable");
  await loadAttempt(page);
  await expect(play(page)).toBeEnabled();
  await page.evaluate(() => { window.allowStorage = true; });
  await page.getByRole("button", { name: "Retry saved references" }).click();
  await expect(library(page)).toContainText("No saved references yet");
  await expect(page.getByRole("button", { name: "Retry saved references" })).toBeHidden();
});

test("an aborted save reports failure, writes nothing, and allows retry", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (!window.allowSave) this.transaction.abort();
      return request;
    };
  });
  await page.goto("./");
  await loadAttempt(page);
  page.once("dialog", (dialog) => dialog.accept("Failed save"));
  await save(page).click();
  await expect(library(page)).toContainText("Could not save the reference");
  await expect(page.locator(".tm-library-item")).toHaveCount(0);
  await expect(save(page)).toBeEnabled();
  await page.evaluate(() => { window.allowSave = true; });
  page.once("dialog", (dialog) => dialog.accept("Retry works"));
  await save(page).click();
  await expect(page.locator(".tm-library-item")).toHaveCount(1);
});

async function delayFirstDecode(page) {
  await page.addInitScript(() => {
    const decode = AudioContext.prototype.decodeAudioData;
    const close = AudioContext.prototype.close;
    window.closedDecoders = 0;
    AudioContext.prototype.close = async function () {
      await close.call(this);
      window.closedDecoders++;
    };
    let count = 0;
    AudioContext.prototype.decodeAudioData = async function (...args) {
      const first = ++count === 1;
      const audio = await decode.apply(this, args);
      if (first) await new Promise((resolve) => { window.releaseDecode = resolve; });
      return audio;
    };
  });
}

test("changing the channel and tab during decode preserves both original choices", async ({ page }) => {
  await delayFirstDecode(page);
  await page.goto("./");
  await page.locator(".tm-file-channels summary").click();
  const channel = page.getByLabel("Channel for next file");
  await channel.selectOption("0");
  await input(page).setInputFiles(fixture);
  await expect.poll(() => page.evaluate(() => typeof window.releaseDecode)).toBe("function");
  await channel.selectOption("7");
  await tab(page, "Reference").click();
  await page.evaluate(() => window.releaseDecode());
  await expect(status(page)).toContainText("mandarin-tone2-attempt-late-rise.wav (channel 1 of 1) —");
  await expect(label(page)).toHaveText("Reference: no audio loaded");
  await expect(play(page)).toBeDisabled();
  await tab(page, "Your attempt").click();
  await expect(label(page)).toContainText("Your attempt: mandarin-tone2-attempt-late-rise.wav (channel 1 of 1)");
  await expect(play(page)).toBeEnabled();
});

test("an older decode cannot replace the newer file or its status", async ({ page }) => {
  await delayFirstDecode(page);
  await page.goto("./");
  await input(page).setInputFiles(fixture);
  await expect.poll(() => page.evaluate(() => typeof window.releaseDecode)).toBe("function");
  await input(page).setInputFiles(referenceFixture);
  await expect(status(page)).toContainText("mandarin-tone2-reference.wav —");
  await page.evaluate(() => window.releaseDecode());
  // Let the deliberately released decoder complete and its context close.
  await expect.poll(() => page.evaluate(() => window.closedDecoders)).toBe(2);
  await expect(label(page)).toContainText("Your attempt: mandarin-tone2-reference.wav");
  await expect(status(page)).toContainText("mandarin-tone2-reference.wav —");
});

test("opposite-polarity stereo keeps the previous clip and can be loaded by channel", async ({ page }) => {
  // A native, IEEE-float WAV control. Both channels contain the same synthetic
  // 220 Hz tone, at opposite polarity. The real browser decoder is not mocked.
  const rate = 22050, frames = rate, bytes = Buffer.alloc(44 + frames * 8);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    const value = 0.2 * Math.sin(2 * Math.PI * 220 * i / rate);
    bytes.writeFloatLE(value, 44 + i * 8); bytes.writeFloatLE(-value, 48 + i * 8);
  }
  const stereo = { name: "opposite.wav", mimeType: "audio/wav", buffer: bytes };
  await page.goto("./");
  await loadAttempt(page);
  await input(page).setInputFiles(stereo);
  await expect(status(page)).toContainText("cancels almost all sound");
  await expect(status(page)).toContainText("Previous clip kept");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
  await expect(play(page)).toBeEnabled();
  await page.locator(".tm-file-channels summary").click();
  const channel = page.getByLabel("Channel for next file");
  await channel.selectOption("0"); await input(page).setInputFiles(stereo);
  await expect(label(page)).toContainText("opposite.wav (channel 1 of 2)");
  await expect(status(page)).toContainText("opposite.wav (channel 1 of 2) — 1.00s");
  await channel.selectOption("7"); await input(page).setInputFiles(stereo);
  await expect(status(page)).toContainText("This file has 2 channels");
  await expect(label(page)).toContainText("opposite.wav (channel 1 of 2)");
});

test("worker failure is visible and changing the algorithm starts a working replacement", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    let fail = true;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const failedUrl = fail ? URL.createObjectURL(new Blob(['throw new Error("Injected worker failure");'], { type: "text/javascript" })) : null;
        fail = false;
        super(failedUrl ?? url, options);
        if (failedUrl) this.addEventListener("error", () => URL.revokeObjectURL(failedUrl));
      }
    };
  });
  await page.goto("./");
  await input(page).setInputFiles(fixture);
  await expect(status(page)).toContainText("Audio analysis failed");
  await page.getByLabel("Pitch detection algorithm").selectOption("mpm");
  await expect(status(page)).toHaveText("Pitch analysis updated (MPM).");
  await page.getByRole("button", { name: "Classify current attempt" }).click();
  await expect(page.locator(".tm-tone-badge")).not.toHaveText("?");
});

test("a late result from the previous algorithm cannot replace the current contour", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    let first = true;
    window.Worker = class extends NativeWorker {
      set onmessage(listener) {
        super.onmessage = (event) => {
          if (!first) return listener.call(this, event);
          first = false;
          // A distinguishable, valid unvoiced result from the older request.
          event.data.contour.points = [];
          event.data.contour.medianF0 = null;
          window.releaseOldAnalysis = () => listener.call(this, event);
        };
      }
    };
  });
  await page.goto("./");
  await input(page).setInputFiles(fixture);
  await expect.poll(() => page.evaluate(() => typeof window.releaseOldAnalysis)).toBe("function");
  await page.getByLabel("Pitch detection algorithm").selectOption("mpm");
  await expect(status(page)).toHaveText("Pitch analysis updated (MPM).");
  await page.evaluate(() => window.releaseOldAnalysis());
  await page.getByRole("button", { name: "Classify current attempt" }).click();
  await expect(page.locator(".tm-tone-badge")).not.toHaveText("?");
  await expect(status(page)).toHaveText("Pitch analysis updated (MPM).");
});

test("switching away and back cancels playback that is still waiting for audio permission", async ({ page }) => {
  await page.addInitScript(() => {
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = async function () {
      if (window.delayPlayback) await new Promise((resolve) => { window.releasePlayback = resolve; });
      await resume.call(this);
      window.resumedPlayback = true;
    };
  });
  await page.goto("./");
  await loadAttempt(page);
  await page.evaluate(() => { window.delayPlayback = true; });
  await play(page).click();
  await expect.poll(() => page.evaluate(() => typeof window.releasePlayback)).toBe("function");
  await tab(page, "Reference").click();
  await tab(page, "Your attempt").click();
  await page.evaluate(() => window.releasePlayback());
  await expect.poll(() => page.evaluate(() => window.resumedPlayback)).toBe(true);
  await expect(play(page)).toHaveText("▶ Play");
});

test("keyboard tabs pause playback and keep loop regions with their own clip", async ({ page }) => {
  await page.goto("./");
  await loadAttempt(page);
  const canvas = page.locator("#audio-analysis canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 20, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Clear loop" })).toBeEnabled();
  await play(page).click();
  await expect(play(page)).toContainText("Pause");
  await tab(page, "Your attempt").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Reference")).toBeFocused();
  await expect(play(page)).toContainText("Play");
  await expect(page.getByRole("button", { name: "Clear loop" })).toBeDisabled();
  await page.keyboard.press("Home");
  await expect(tab(page, "Your attempt")).toBeFocused();
  await expect(play(page)).toContainText("Play");
  await expect(page.getByRole("button", { name: "Clear loop" })).toBeEnabled();
  await page.getByRole("button", { name: "Clear loop" }).click();
  await expect(page.getByRole("button", { name: "Clear loop" })).toBeDisabled();
});

test("new analysis clears stale tone classification and comparison", async ({ page }) => {
  await page.goto("./");
  await loadAttempt(page);
  await page.getByRole("button", { name: "Classify current attempt" }).click();
  await expect(page.locator(".tm-tone-badge")).not.toHaveText("?");
  await page.getByLabel("Pitch detection algorithm").selectOption("mpm");
  await expect(page.locator(".tm-tone-badge")).toHaveText("?");
  await expect(status(page)).toHaveText("Pitch analysis updated (MPM).");
  await tab(page, "Reference").click();
  await input(page).setInputFiles(referenceFixture);
  await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
  await tab(page, "Your attempt").click();
  await input(page).setInputFiles({ name: "bad.wav", mimeType: "audio/wav", buffer: Buffer.from([0, 1, 2]) });
  await expect(status(page)).toContainText("Could not load bad.wav");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 812 }]) {
  for (const theme of ["light", "dark"]) {
    test(`comparison remains accessible at ${viewport.width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      const externalRequests = [];
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== "http://127.0.0.1:4192") externalRequests.push(request.url());
      });
      await page.goto("./");
      await loadAttempt(page);
      await tab(page, "Reference").click();
      await input(page).setInputFiles(referenceFixture);
      await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
      await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loaded");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
      expect(results.violations).toEqual([]);
      expect(externalRequests).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`comparison-${theme}-${viewport.width}.png`), fullPage: true });
    });
  }
}

test.describe("real microphone lifecycle with a browser-provided test device", () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Chromium supplies the deterministic test microphone.");
    await page.addInitScript(() => {
      window.capturedStreams = [];
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await capture(...args);
        window.capturedStreams.push(stream);
        return stream;
      };
    });
  });

  test("worklet failure releases microphone tracks and the next recording succeeds", async ({ page }) => {
    await page.addInitScript(() => {
      const addModule = AudioWorklet.prototype.addModule;
      let fail = true;
      AudioWorklet.prototype.addModule = function (...args) {
        if (fail) { fail = false; return Promise.reject(new Error("worklet failed")); }
        return addModule.apply(this, args);
      };
    });
    await page.goto("./");
    await page.getByRole("button", { name: "● Record", exact: true }).click();
    await expect(status(page)).toContainText("Microphone unavailable: worklet failed");
    expect(await page.evaluate(() => window.capturedStreams[0].getTracks().every((track) => track.readyState === "ended"))).toBe(true);
    await page.getByRole("button", { name: "● Record", exact: true }).click();
    await expect(page.getByRole("button", { name: "■ Stop", exact: true })).toBeVisible();
    await tab(page, "Reference").click();
    await page.getByRole("button", { name: "■ Stop", exact: true }).click();
    await expect(status(page)).toContainText("Recording (");
    await expect(label(page)).toHaveText("Reference: no audio loaded");
    await tab(page, "Your attempt").click();
    await expect(label(page)).toContainText("Your attempt: Recording (");
    expect(await page.evaluate(() => window.capturedStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
  });

  test("cancelling a pending request releases a microphone that arrives later", async ({ page }) => {
    await page.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        await new Promise((resolve) => { window.allowMicrophone = resolve; });
        return capture(...args);
      };
    });
    await page.goto("./");
    await page.getByRole("button", { name: "● Record", exact: true }).click();
    await page.getByRole("button", { name: "Cancel microphone" }).click();
    await page.evaluate(() => window.allowMicrophone());
    await expect.poll(() => page.evaluate(() => window.capturedStreams.length)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.capturedStreams[0].getTracks().every((track) => track.readyState === "ended"))).toBe(true);
    await expect(page.getByRole("button", { name: "● Record", exact: true })).toBeVisible();
    await expect(label(page)).toHaveText("Your attempt: no audio loaded");
  });
});

function silentWav(seconds, sampleRate = 8000) {
  const samples = Math.round(seconds * sampleRate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

async function referenceAndAttempt(page) {
  await loadAttempt(page);
  await tab(page, "Reference").click();
  await input(page).setInputFiles(referenceFixture);
  await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
}

test("silence has an unavailable score and visible voicing evidence", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("./");
  await input(page).setInputFiles({ name: "silence.wav", mimeType: "audio/wav", buffer: silentWav(0.5) });
  await expect(status(page)).toContainText("silence.wav —");
  await tab(page, "Reference").click();
  await input(page).setInputFiles(referenceFixture);
  await expect(page.locator(".tm-score")).toHaveText("Unavailable");
  await expect(page.locator(".tm-feedback-list")).toContainText("Not enough voiced signal");
  await expect(page.locator(".tm-comparison-note")).toContainText(/0\/\d+ attempt/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]).analyze()).violations).toEqual([]);
});

test("a level target and rising audio do not receive reassuring feedback", async ({ page }) => {
  // Independent PCM fixtures: a one-second 180 Hz sine and a one-octave glide.
  // Both go through the browser decoder, pitch detector and comparison worker.
  function signalWav(rising) {
    const rate = 22050;
    const bytes = silentWav(1, rate);
    let phase = 0;
    for (let i = 0; i < rate; i++) {
      const frequency = rising ? 180 * 2 ** ((-6 + 12 * i / (rate - 1)) / 12) : 180;
      phase += 2 * Math.PI * frequency / rate;
      const fade = Math.min(1, i / 220, (rate - i - 1) / 220);
      bytes.writeInt16LE(Math.round(8000 * fade * Math.sin(phase)), 44 + i * 2);
    }
    return bytes;
  }
  await page.goto("./");
  await input(page).setInputFiles({ name: "rising-sine.wav", mimeType: "audio/wav", buffer: signalWav(true) });
  await expect(status(page)).toContainText("rising-sine.wav —");
  await tab(page, "Reference").click();
  await input(page).setInputFiles({ name: "level-sine.wav", mimeType: "audio/wav", buffer: signalWav(false) });
  await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
  // The detector's tiny fluctuations in the level signal can change the DTW
  // path length; its heuristic score need not equal the ideal contour's 33.
  expect(Number(await page.locator(".tm-score").innerText())).toBeLessThan(70);
  await expect(page.locator(".tm-feedback-list")).toContainText("reference stays flat but your pitch is rising");
  await expect(page.locator(".tm-feedback-list")).not.toContainText("closely follows");
});

test("long decoded audio is refused without replacing the loaded clip", async ({ page }) => {
  await page.addInitScript(() => {
    window.decodeCalls = 0;
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (...args) { window.decodeCalls++; return decode.apply(this, args); };
  });
  await page.goto("./");
  await loadAttempt(page);
  await input(page).setInputFiles({ name: "too-long.wav", mimeType: "audio/wav", buffer: silentWav(61) });
  await expect(status(page)).toContainText("60 seconds or less");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
  expect(await page.evaluate(() => window.decodeCalls)).toBe(1);
  await expect(play(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "Cancel work" })).toBeHidden();
  await input(page).setInputFiles(referenceFixture);
  await expect(status(page)).toContainText("mandarin-tone2-reference.wav —");
});

test("encoded size limits apply before decoding and retain the current source", async ({ page }, testInfo) => {
  const oversized = testInfo.outputPath("oversized.wav");
  await writeFile(oversized, "");
  await truncate(oversized, 25 * 1024 * 1024 + 1);
  await page.goto("./");
  await loadAttempt(page);
  await input(page).setInputFiles(oversized);
  await expect(status(page)).toContainText("25 MiB or smaller");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
  await expect(page.getByRole("button", { name: "Cancel work" })).toBeHidden();
});

test("cancelling a decoder returns immediately and ignores its late result", async ({ page }) => {
  await delayFirstDecode(page);
  await page.goto("./");
  await input(page).setInputFiles(fixture);
  await expect.poll(() => page.evaluate(() => typeof window.releaseDecode)).toBe("function");
  await page.getByRole("button", { name: "Cancel work" }).click();
  await expect(status(page)).toContainText("Cancelled");
  await expect(label(page)).toHaveText("Your attempt: no audio loaded");
  await input(page).setInputFiles(referenceFixture);
  await expect(status(page)).toContainText("mandarin-tone2-reference.wav —");
  await page.evaluate(() => window.releaseDecode());
  await expect(label(page)).toContainText("mandarin-tone2-reference.wav");
});

test("a stuck reference worker cannot block the attempt slot", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    let first = true;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.hold = first;
        first = false;
      }
      postMessage(...args) {
        if (!this.hold) super.postMessage(...args);
      }
    };
  });
  await page.goto("./");
  await tab(page, "Reference").click();
  await input(page).setInputFiles(referenceFixture);
  await expect(status(page)).toContainText("Analyzing");
  await tab(page, "Your attempt").click();
  await loadAttempt(page);
  await expect(play(page)).toBeEnabled();
  await page.getByRole("button", { name: "Cancel work" }).click();
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
  await tab(page, "Reference").click();
  await input(page).setInputFiles(referenceFixture);
  await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
});

test("a failed analysis preserves the previous clip, score and playback", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (window.failNextAnalysis && message.type === "analyze") {
          window.failNextAnalysis = false;
          throw new Error("injected replacement failure");
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  await page.goto("./");
  await referenceAndAttempt(page);
  const before = await page.locator(".tm-score").innerText();
  await tab(page, "Your attempt").click();
  await page.evaluate(() => { window.failNextAnalysis = true; });
  await input(page).setInputFiles(referenceFixture);
  await expect(status(page)).toContainText("Previous clip kept");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
  await expect(page.locator(".tm-score")).toHaveText(before);
  await expect(play(page)).toBeEnabled();
  await page.getByRole("button", { name: "Retry audio analysis" }).click();
  await expect(status(page)).toHaveText("Pitch analysis updated (YIN).");
  await expect(label(page)).toContainText("mandarin-tone2-reference.wav");
  await expect(page.locator(".tm-score")).toHaveText("100");
});

test("contour matching can be cancelled and retried while page controls remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.holdComparison = true;
    window.comparisonTerminations = 0;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        this.matchesContours = message.type === "compare";
        if (this.matchesContours && window.holdComparison) { window.comparisonWaiting = true; return; }
        return super.postMessage(message, ...rest);
      }
      terminate() {
        if (this.matchesContours) window.comparisonTerminations++;
        return super.terminate();
      }
    };
  });
  await page.goto("./");
  await loadAttempt(page);
  await tab(page, "Reference").click();
  await input(page).setInputFiles(referenceFixture);
  await expect.poll(() => page.evaluate(() => window.comparisonWaiting)).toBe(true);
  await expect(page.locator(".tm-score")).toHaveText("—");
  await page.getByRole("button", { name: "Toggle light/dark theme" }).click();
  await page.getByRole("button", { name: "Cancel work" }).click();
  await expect(page.locator(".tm-comparison-note")).toContainText("Comparison cancelled");
  expect(await page.evaluate(() => window.comparisonTerminations)).toBe(1);
  await page.evaluate(() => { window.holdComparison = false; });
  await page.getByRole("button", { name: "Retry comparison" }).click();
  await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
  await expect(page.locator(".tm-comparison-note")).toContainText("not a pronunciation grade");
});

test("a worker timeout is recoverable and keeps the previous audio", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (window.holdAnalysis && message.type === "analyze") { window.analysisWaiting = true; return; }
        return super.postMessage(message, ...rest);
      }
    };
  });
  await page.goto("./");
  await loadAttempt(page);
  await page.clock.install();
  await page.evaluate(() => { window.holdAnalysis = true; });
  await input(page).setInputFiles(referenceFixture);
  await expect.poll(() => page.evaluate(() => window.analysisWaiting)).toBe(true);
  await page.clock.runFor(60_001);
  await expect(status(page)).toContainText("exceeded 60 seconds");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
  await page.evaluate(() => { window.holdAnalysis = false; });
  await page.getByRole("button", { name: "Retry audio analysis" }).click();
  await expect(status(page)).toHaveText("Pitch analysis updated (YIN).");
  await expect(label(page)).toContainText("mandarin-tone2-reference.wav");
});

test("capture stops at its sample limit and names the boundary in the loaded clip", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium supplies the deterministic test microphone.");
  await page.addInitScript(() => {
    window.limitStreams = [];
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context, ...args) {
        super(context, ...args);
        const port = this.port;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(port), "onmessage");
        let delivered = false;
        Object.defineProperty(port, "onmessage", {
          set(listener) {
            descriptor.set.call(port, listener && ((event) => {
              if (!delivered) {
                delivered = true;
                listener(new MessageEvent("message", { data: new Float32Array(context.sampleRate * 60 + 128) }));
              } else listener(event);
            }));
          },
        });
      }
    };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      set onmessage(listener) {
        super.onmessage = (event) => {
          if (event.data.type === "analyzed") window.limitSpectrogram = {
            frames: event.data.spectrogram.frames.length,
            lastTime: event.data.spectrogram.times.at(-1),
          };
          listener.call(this, event);
        };
      }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await capture(...args);
      window.limitStreams.push(stream);
      return stream;
    };
  });
  // Accelerate the real worklet's first delivery to 60 seconds of synthetic silence.
  // This checks sample-budget cleanup, not physical microphone accuracy.
  await page.goto("./");
  await page.getByRole("button", { name: "● Record", exact: true }).click();
  await expect(status(page)).toContainText("stopped at 60s limit", { timeout: 15_000 });
  await expect(label(page)).toContainText("60.00s");
  await expect(page.getByRole("button", { name: "● Record", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.limitStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
  const spectrogram = await page.evaluate(() => window.limitSpectrogram);
  expect(spectrogram.frames).toBeLessThanOrEqual(4096);
  expect(spectrogram.frames).toBeGreaterThan(4000);
  expect(spectrogram.lastTime).toBeGreaterThan(59.95);
});

test("first imports, comparison and algorithm changes work offline without persisting audio", async ({ page, context }) => {
  await page.goto("./");
  // Disconnect before any audio or worker is loaded, including the comparison worker.
  await context.setOffline(true);
  await referenceAndAttempt(page);
  await tab(page, "Your attempt").click();
  await input(page).setInputFiles(referenceFixture);
  await expect(status(page)).toContainText("mandarin-tone2-reference.wav —");
  await expect(page.locator(".tm-score")).toHaveText("100");
  await page.getByLabel("Pitch detection algorithm").selectOption("mpm");
  await expect(status(page)).toHaveText("Pitch analysis updated (MPM).");
  await expect(page.locator(".tm-score")).toHaveText("100");
  expect(await page.locator(".tm-library-item").count()).toBe(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }))).not.toContain("mandarin");
  await context.setOffline(false);
});
