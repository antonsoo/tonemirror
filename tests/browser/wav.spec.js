/* global URL, crypto */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL("../../examples/mandarin-tone2-attempt-late-rise.wav", import.meta.url));
const button = (page, name) => page.getByRole("button", { name, exact: true });
const download = page => button(page, "Download WAV");
const input = page => page.getByLabel("Choose an audio file to load");
const label = page => page.locator(".tm-clip-label");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.wavProbe = { inputs: [], hold: false, revoked: [] };
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        if (message.type === "analyze") {
          if (window.wavProbe.hold) return;
          window.wavProbe.inputs.push({ pcm: message.pcm.slice(), rate: message.sampleRate });
        }
        return super.postMessage(message, ...rest);
      }
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { window.wavProbe.revoked.push(url); revoke(url); };
  });
  await page.goto("./");
});

async function saveDownload(page) {
  const pending = page.waitForEvent("download");
  await download(page).focus(); await page.keyboard.press("Enter");
  const result = await pending;
  expect(await result.failure()).toBeNull();
  const bytes = await readFile(await result.path());
  const expected = await page.evaluate(async () => {
    const { pcm, rate } = window.wavProbe.inputs.at(-1);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pcm))].map(v => v.toString(16).padStart(2, "0")).join("");
    return { hash, rate, samples: pcm.length };
  });
  expect(bytes.readUInt32LE(24)).toBe(expected.rate);
  let data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString("ascii", at, at + 4) === "data") data = bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  expect(data.length).toBe(expected.samples * 4);
  expect(createHash("sha256").update(data).digest("hex")).toBe(expected.hash);
  return { name: result.suggestedFilename(), mimeType: "audio/wav", buffer: bytes };
}

test("downloads focused audio, preserves synthetic provenance after rename and leaves audio after export failure", async ({ page }) => {
  await expect(download(page)).toBeDisabled();
  await input(page).setInputFiles(fixture);
  await expect(download(page)).toBeEnabled();
  await page.getByRole("tab", { name: "Reference", exact: true }).click();
  await expect(download(page)).toBeDisabled();
  await page.locator(".tm-chip").first().click();
  await expect(label(page)).toContainText("(synthetic)");
  const wav = await saveDownload(page);
  expect(wav.name).toContain("synthetic-reference-");
  await expect.poll(() => page.evaluate(() => window.wavProbe.revoked.length)).toBe(1);
  await input(page).setInputFiles({ ...wav, name: "renamed.wav" });
  await expect(label(page)).toContainText("renamed.wav (synthetic)");
  const before = await label(page).textContent();
  await page.evaluate(() => {
    window.createUrl = URL.createObjectURL;
    URL.createObjectURL = () => { throw new Error("injected download failure"); };
  });
  await download(page).click();
  await expect(page.locator("#download-note")).toContainText("Could not prepare the WAV download");
  await expect(label(page)).toHaveText(before);
  await page.evaluate(() => { URL.createObjectURL = window.createUrl; });
  await saveDownload(page);
  await expect(page.locator("#download-note")).toContainText("WAV download started");
  await page.evaluate(() => { window.wavProbe.hold = true; });
  await input(page).setInputFiles(fixture);
  await expect(download(page)).toBeDisabled();
  await button(page, "Cancel work").click();
  await expect(download(page)).toBeEnabled();
  await expect(label(page)).toHaveText(before);
});

test("microphone capture can leave browser storage as exact-sample WAV", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium supplies the deterministic test microphone.");
  await button(page, "● Record").click();
  await expect(button(page, "■ Stop")).toBeVisible();
  await expect(page.locator(".tm-status")).toHaveText("Recording your attempt…");
  // Wait for actual worklet samples, not a manufactured app clip.
  await page.waitForTimeout(500);
  await button(page, "■ Stop").click();
  await expect(download(page)).toBeEnabled();
  await expect(label(page)).toContainText("Recording (");
  const wav = await saveDownload(page);
  expect(wav.name).toContain("tonemirror-attempt-Recording");
  expect(wav.buffer.length).toBeGreaterThan(1000);
});
