import { test, expect } from "@playwright/test";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import AxeBuilder from "@axe-core/playwright";

const fixture = fileURLToPath(new URL("../../examples/mandarin-tone2-attempt-late-rise.wav", import.meta.url));
const referenceFixture = fileURLToPath(new URL("../../examples/mandarin-tone2-reference.wav", import.meta.url));
const input = (page) => page.getByLabel("Choose an audio file to load");
const status = (page) => page.locator(".tm-status");
const label = (page) => page.locator(".tm-clip-label");
const save = (page) => page.getByRole("button", { name: "Save current attempt" });
const play = (page) => page.getByRole("button", { name: /Play|Pause/ });
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const library = (page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Your saved references" }) });

async function loadAttempt(page) {
  await input(page).setInputFiles(fixture);
  await expect(status(page)).toContainText("mandarin-tone2-attempt-late-rise.wav —");
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("getPageErrors", () => errors);
  await page.addInitScript(() => {
    window.policyViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => window.policyViolations.push(event.violatedDirective));
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === "skipped") return;
  expect(await page.evaluate(() => window.getPageErrors())).toEqual([]);
  expect(await page.evaluate(() => window.policyViolations)).toEqual([]);
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

test("switching tabs during decode keeps the file in its original slot", async ({ page }) => {
  await delayFirstDecode(page);
  await page.goto("./");
  await input(page).setInputFiles(fixture);
  await expect.poll(() => page.evaluate(() => typeof window.releaseDecode)).toBe("function");
  await tab(page, "Reference").click();
  await page.evaluate(() => window.releaseDecode());
  await expect(status(page)).toContainText("mandarin-tone2-attempt-late-rise.wav —");
  await expect(label(page)).toHaveText("Reference: no audio loaded");
  await expect(play(page)).toBeDisabled();
  await tab(page, "Your attempt").click();
  await expect(label(page)).toContainText("Your attempt: mandarin-tone2-attempt-late-rise.wav");
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

test("worker failure is visible and changing the algorithm starts a working replacement", async ({ page }) => {
  let fail = true;
  await page.route("**/pitchWorker-*.js", async (route) => {
    if (!fail) return route.continue();
    fail = false;
    await route.fulfill({ contentType: "text/javascript", body: 'throw new Error("Injected worker failure");' });
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
  await expect(status(page)).toContainText("Could not decode bad.wav");
  await expect(label(page)).toContainText("mandarin-tone2-attempt-late-rise.wav");
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
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
