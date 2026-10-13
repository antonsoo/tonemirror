import { test, expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

function tone(frequency = 220, seconds = 2) {
  const rate = 48000, length = Math.round(rate * seconds), buffer = Buffer.alloc(44 + length * 4);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(32, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(length * 4, 40);
  for (let i = 0; i < length; i++) buffer.writeFloatLE(0.3 * Math.sin(2 * Math.PI * frequency * i / rate), 44 + i * 4);
  return { name: `synthetic-${frequency}Hz.wav`, mimeType: "audio/wav", buffer };
}
const button = (page, name) => page.getByRole("button", { name, exact: true });
const half = page => page.getByRole("checkbox", { name: "half-speed, same pitch", exact: true });
const input = page => page.getByLabel("Choose an audio file to load");

test.beforeEach(async ({ page }) => {
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:4192/")) requests.push(request.url()); });
  await page.exposeFunction("slowErrors", () => errors);
  await page.exposeFunction("slowRequests", () => requests);
  await page.addInitScript(() => {
    window.slowProbe = { jobs: 0, terminated: 0, starts: [], hold: false, fail: false, violations: [], source: null };
    document.addEventListener("securitypolicyviolation", event => window.slowProbe.violations.push(event.violatedDirective));
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message.type === "analyze") window.slowProbe.source = { pcm: message.pcm.slice(), rate: message.sampleRate };
        if (message.type === "prepare-half-speed") {
          this.slowJob = true; window.slowProbe.jobs++;
          if (window.slowProbe.hold) return;
          if (window.slowProbe.malformed) {
            window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: 1 })), 0);
            return;
          }
          if (window.slowProbe.crash) {
            window.setTimeout(() => this.dispatchEvent(new ErrorEvent("error", { message: "controlled worker failure", cancelable: true })), 0);
            return;
          }
          if (window.slowProbe.fail) {
            window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: { error: "controlled preparation failure" } })), 0);
            return;
          }
        }
        return super.postMessage(message, ...rest);
      }
      terminate() { if (this.slowJob) window.slowProbe.terminated++; super.terminate(); }
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer) {
        const pcm = this.buffer.getChannelData(0), rate = this.buffer.sampleRate;
        let crossings = 0;
        const first = Math.floor(rate * 0.25), last = pcm.length - first;
        for (let i = first; i < last; i++) if (pcm[i - 1] < 0 && pcm[i] >= 0) crossings++;
        window.slowProbe.starts.push({ samples: pcm.length, rate, hz: crossings * rate / (last - first),
          playbackRate: this.playbackRate.value, offset: args[1] ?? 0, loopStart: this.loopStart, loopEnd: this.loopEnd, loop: this.loop });
      }
      return start.apply(this, args);
    };
  });
  await page.goto("./");
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.slowErrors())).toEqual([]);
  expect(await page.evaluate(() => window.slowRequests())).toEqual([]);
  expect(await page.evaluate(() => window.slowProbe.violations)).toEqual([]);
});

test("first same-pitch playback works offline, uses its cache, and exports original samples", async ({ page, context }) => {
  await context.setOffline(true);
  await input(page).setInputFiles(tone());
  await expect(button(page, "▶ Play")).toBeEnabled();
  await half(page).check();
  await button(page, "▶ Play").click();
  await expect(page.locator("#playback-note")).toContainText("pitch preserved");
  const actual = await page.evaluate(() => ({ start: window.slowProbe.starts.at(-1), jobs: window.slowProbe.jobs, terminated: window.slowProbe.terminated, original: window.slowProbe.source.pcm.length }));
  expect(actual.start.samples).toBe(actual.original * 2);
  expect(actual.start.playbackRate).toBe(1);
  expect(Math.abs(actual.start.hz - 220)).toBeLessThan(1);
  expect(actual.jobs).toBe(1); expect(actual.terminated).toBe(1);
  await button(page, "⏸ Pause").click();
  await button(page, "▶ Play").click();
  await expect(button(page, "⏸ Pause")).toBeVisible();
  expect(await page.evaluate(() => window.slowProbe.jobs)).toBe(1);
  const pending = page.waitForEvent("download"); await button(page, "Download WAV").click();
  const bytes = await readFile(await (await pending).path());
  let data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString("ascii", at, at + 4) === "data") data = bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  const expectedHash = await page.evaluate(async () => [...new Uint8Array(await window.crypto.subtle.digest("SHA-256", window.slowProbe.source.pcm))].map(v => v.toString(16).padStart(2, "0")).join(""));
  expect(data.length).toBe(actual.original * 4);
  expect(createHash("sha256").update(data).digest("hex")).toBe(expectedHash);
});

test("source-time regions survive speed changes and a replacement gets its own preview", async ({ page }) => {
  await input(page).setInputFiles(tone(220, 4));
  await expect(button(page, "▶ Play")).toBeEnabled();
  await page.getByLabel("Region start (s)").fill("1"); await page.getByLabel("Region end (s)").fill("2");
  await button(page, "Loop region").click(); await half(page).check(); await button(page, "▶ Play").click();
  await expect(button(page, "⏸ Pause")).toBeVisible();
  let actual = await page.evaluate(() => window.slowProbe.starts.at(-1));
  expect(actual.loop).toBe(true); expect(actual.loopStart).toBe(2); expect(actual.loopEnd).toBe(4);
  await half(page).uncheck(); await expect(button(page, "⏸ Pause")).toBeVisible();
  actual = await page.evaluate(() => window.slowProbe.starts.at(-1));
  expect(actual.loopStart).toBe(1); expect(actual.loopEnd).toBe(2); expect(actual.playbackRate).toBe(1);
  await button(page, "⏸ Pause").click();
  await input(page).setInputFiles(tone(440)); await expect(page.locator(".tm-status")).toContainText("synthetic-440Hz.wav —");
  await half(page).check(); await button(page, "▶ Play").click(); await expect(button(page, "⏸ Pause")).toBeVisible();
  expect(await page.evaluate(() => window.slowProbe.jobs)).toBe(2);
  expect(Math.abs(await page.evaluate(() => window.slowProbe.starts.at(-1).hz) - 440)).toBeLessThan(1);
});

test("cancelling or switching clips terminates preparation and never starts stale audio", async ({ page }) => {
  await input(page).setInputFiles(tone()); await expect(button(page, "▶ Play")).toBeEnabled();
  await page.evaluate(() => { window.slowProbe.hold = true; });
  await half(page).check(); await button(page, "▶ Play").click();
  await expect.poll(() => page.evaluate(() => window.slowProbe.jobs)).toBe(1);
  await button(page, "Cancel playback").click();
  expect(await page.evaluate(() => window.slowProbe.terminated)).toBe(1);
  await button(page, "▶ Play").click(); await expect.poll(() => page.evaluate(() => window.slowProbe.jobs)).toBe(2);
  await page.getByRole("tab", { name: "Reference", exact: true }).click();
  expect(await page.evaluate(() => window.slowProbe.terminated)).toBe(2);
  expect(await page.evaluate(() => window.slowProbe.starts)).toEqual([]);
  await page.getByRole("tab", { name: "Your attempt", exact: true }).click();
  await page.evaluate(() => { window.slowProbe.hold = false; });
  await button(page, "▶ Play").click(); await expect(button(page, "⏸ Pause")).toBeVisible();
});

test("preparation failure is explicit and normal-speed playback can recover", async ({ page }) => {
  await input(page).setInputFiles(tone()); await expect(button(page, "▶ Play")).toBeEnabled();
  await page.evaluate(() => { window.slowProbe.fail = true; });
  await half(page).check(); await button(page, "▶ Play").click();
  await expect(page.locator("#playback-note")).toContainText("controlled preparation failure");
  expect(await page.evaluate(() => window.slowProbe.starts)).toEqual([]);
  await half(page).uncheck(); await button(page, "▶ Play").click(); await expect(button(page, "⏸ Pause")).toBeVisible();
  expect(await page.evaluate(() => window.slowProbe.starts.at(-1).samples)).toBe(await page.evaluate(() => window.slowProbe.source.pcm.length));
});

for (const [mode, message] of [["malformed", "unreadable result"], ["crash", "preparation failed"], ["hold", "exceeded 60 seconds"]]) {
  test(`${mode} preparation releases the worker and allows a fresh attempt`, async ({ page }) => {
    await input(page).setInputFiles(tone()); await expect(button(page, "▶ Play")).toBeEnabled();
    if (mode === "hold") await page.clock.install();
    await page.evaluate(mode => { window.slowProbe[mode] = true; }, mode);
    await half(page).check(); await button(page, "▶ Play").click();
    await expect.poll(() => page.evaluate(() => window.slowProbe.jobs)).toBe(1);
    if (mode === "hold") await page.clock.fastForward(60_001);
    await expect(page.locator("#playback-note")).toContainText(message);
    expect(await page.evaluate(() => window.slowProbe.terminated)).toBe(1);
    expect(await page.evaluate(() => window.slowProbe.starts)).toEqual([]);
    await page.evaluate(mode => { window.slowProbe[mode] = false; }, mode);
    await button(page, "▶ Play").click(); await expect(button(page, "⏸ Pause")).toBeVisible();
    expect(await page.evaluate(() => window.slowProbe.jobs)).toBe(2);
  });
}

test("leaving the page cancels an in-flight preview", async ({ page }) => {
  await input(page).setInputFiles(tone()); await expect(button(page, "▶ Play")).toBeEnabled();
  await page.evaluate(() => { window.slowProbe.hold = true; });
  await half(page).check(); await button(page, "▶ Play").click();
  await expect.poll(() => page.evaluate(() => window.slowProbe.jobs)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  expect(await page.evaluate(() => window.slowProbe.terminated)).toBe(1);
  expect(await page.evaluate(() => window.slowProbe.starts)).toEqual([]);
});
