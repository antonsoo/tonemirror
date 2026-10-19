import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const [baseURL, output, mode = "after"] = process.argv.slice(2);
assert(
  baseURL && output,
  "Usage: node studies/file-channels/browser.mjs URL OUTPUT_DIR [before|after]",
);
const cache = fileURLToPath(new URL("./cache/", import.meta.url));
await mkdir(output, { recursive: true });
const workflows = [];
for (const [engine, browserType] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  const browser = await browserType.launch();
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({
          viewport: { width, height: 1050 },
          colorScheme: width === 375 ? "light" : "dark",
        }),
        page = await context.newPage();
      const errors = [],
        external = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => {
        if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== new URL(baseURL).origin)
          external.push(r.url());
      });
      await page.addInitScript(() => {
        window.channelProbe = { inputs: [], contours: [], playback: [] };
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          if (this.buffer)
            window.channelProbe.playback.push({
              pcm: this.buffer.getChannelData(0).slice(),
              rate: this.buffer.sampleRate,
            });
          return start.apply(this, args);
        };
        window.channelCsp = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          window.channelCsp.push(e.violatedDirective),
        );
        const Native = Worker;
        window.Worker = class extends Native {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", (e) => {
              if (e.data.type === "analyzed") window.channelProbe.contours.push(e.data.contour);
            });
          }
          postMessage(msg, ...rest) {
            if (msg.type === "analyze")
              window.channelProbe.inputs.push({ pcm: msg.pcm.slice(), rate: msg.sampleRate });
            return super.postMessage(msg, ...rest);
          }
        };
      });
      await page.goto(baseURL);
      await page.getByRole("group", { name: "Recorded Mandarin references" }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await context.setOffline(true);
      const input = page.getByLabel("Choose an audio file to load"),
        status = page.locator(".tm-status");
      async function upload(file) {
        await input.setInputFiles(path.join(cache, file));
        await expect(status).toContainText(`${file}`);
        await expect(status).toContainText(" — ");
      }
      async function measure() {
        return page.evaluate(async () => {
          const { pcm, rate } = window.channelProbe.inputs.at(-1),
            c = window.channelProbe.contours.at(-1);
          const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pcm))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          let energy = 0;
          for (const x of pcm) energy += x * x;
          return {
            sha256,
            samples: pcm.length,
            rate,
            rms: Math.sqrt(energy / pcm.length),
            voicedFrames: c.points.filter((p) => p.voiced).length,
            medianF0: c.medianF0,
          };
        });
      }
      async function download() {
        const expected = await measure(),
          pending = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download WAV", exact: true }).click();
        const item = await pending,
          bytes = await readFile(await item.path());
        let data;
        for (let at = 12; at + 8 <= bytes.length; ) {
          const size = bytes.readUInt32LE(at + 4);
          if (bytes.toString("ascii", at, at + 4) === "data")
            data = bytes.subarray(at + 8, at + 8 + size);
          at += 8 + size + (size % 2);
        }
        assert(data);
        assert.equal(createHash("sha256").update(data).digest("hex"), expected.sha256);
        assert.equal(bytes.readUInt16LE(22), 1);
        assert.equal(bytes.readUInt32LE(24), expected.rate);
        return {
          filename: item.suggestedFilename(),
          bytes: bytes.length,
          pcmSha256: expected.sha256,
          samples: expected.samples,
        };
      }
      await upload("mono.wav");
      const mono = await measure();
      assert(mono.voicedFrames > 30);
      await input.setInputFiles(path.join(cache, "opposite-phase.wav"));
      let phase;
      const selected = [];
      let separate = null;
      if (mode === "before") {
        await expect(status).toContainText("opposite-phase.wav —");
        phase = await measure();
        assert.equal(phase.rms, 0);
        assert.equal(phase.voicedFrames, 0);
      } else {
        await expect(status).toContainText("cancels almost all sound");
        await expect(status).toContainText("Previous clip kept");
        await expect(page.locator(".tm-clip-label")).toContainText("mono.wav");
        assert.equal((await measure()).sha256, mono.sha256);
        phase = { message: await status.textContent(), previousClipPreserved: true };
        if (engine === "chromium" && width === 1440)
          await page
            .locator("section.tm-panel")
            .first()
            .screenshot({ path: path.join(output, "phase-error.png") });
        await page.locator(".tm-file-channels summary").click();
        const choice = page.getByLabel("Channel for next file");
        for (const channel of [0, 1]) {
          await choice.selectOption(String(channel));
          await upload("opposite-phase.wav");
          const actual = await measure();
          assert.equal(actual.voicedFrames, mono.voicedFrames);
          assert(Math.abs(actual.medianF0 - mono.medianF0) < 0.0001);
          if (channel === 0) assert.equal(actual.sha256, mono.sha256);
          selected.push({ channel: channel + 1, ...actual, download: await download() });
        }
        await choice.selectOption("7");
        await input.setInputFiles(path.join(cache, "opposite-phase.wav"));
        await expect(status).toContainText("This file has 2 channels");
        await expect(status).toContainText("Previous clip kept");
        assert.equal((await measure()).sha256, selected[1].sha256);
        // Independent FFmpeg channel splits versus selecting those channels in
        // the same multichannel file through the real native browser decoder.
        await choice.selectOption("mix");
        await upload("left.wav");
        const left = await measure();
        await upload("right.wav");
        const right = await measure();
        await page.getByRole("tab", { name: "Reference", exact: true }).click();
        await choice.selectOption("0");
        await upload("separate-tones.wav");
        const first = await measure();
        assert.equal(first.sha256, left.sha256);
        await page.getByRole("tab", { name: "Your attempt", exact: true }).click();
        await choice.selectOption("1");
        await upload("separate-tones.wav");
        const second = await measure();
        assert.equal(second.sha256, right.sha256);
        await expect(page.locator(".tm-comparison-note")).toContainText("channel 1 of 2");
        await expect(page.locator(".tm-comparison-note")).toContainText("channel 2 of 2");
        separate = { left: first, right: second, download: await download() };
        await expect(page.locator(".tm-score")).toHaveText(/^\d+$/);
        const accessibility = await new AxeBuilder({ page }).analyze();
        assert.deepEqual(accessibility.violations, []);
        if (engine === "chromium" && width === 1440)
          await page
            .locator("section.tm-panel")
            .first()
            .screenshot({ path: path.join(output, "channels.png") });
        if (engine === "firefox" && width === 375)
          await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
        await page
          .locator("#audio-analysis")
          .getByRole("button", { name: /Play|Pause/ })
          .click();
        await expect.poll(() => page.evaluate(() => window.channelProbe.playback.length)).toBeGreaterThan(0);
        const playback = await page.evaluate(async () => {
          const { pcm, rate } = window.channelProbe.playback.at(-1);
          const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pcm))]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          return { sha256, rate, samples: pcm.length };
        });
        assert.equal(playback.sha256, second.sha256);
        assert.equal(playback.rate, second.rate);
        separate.playbackBuffer = playback;
        page.once("dialog", (dialog) => dialog.accept("Selected recorded channel"));
        await page.getByRole("button", { name: "Save current attempt", exact: true }).click();
        await expect(page.locator(".tm-library-list")).toContainText("Selected recorded channel");
        await page.getByRole("button", { name: "Use", exact: true }).click();
        await expect(page.locator(".tm-clip-label")).toContainText(
          "Reference: Selected recorded channel",
        );
        const restored = await measure();
        assert.equal(restored.sha256, second.sha256);
        separate.saved = { ...restored, download: await download() };
      }
      if (mode === "before" && engine === "chromium" && width === 1440)
        await page
          .locator("section.tm-panel")
          .first()
          .screenshot({ path: path.join(output, "phase.png") });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      workflows.push({
        engine,
        version: browser.version(),
        width,
        offline: true,
        mono,
        phase,
        selected,
        separate,
        errors,
        external,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert.deepEqual(await page.evaluate(() => window.channelCsp), []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  path.join(output, "browser.json"),
  JSON.stringify({ mode, workflows }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    mode,
    workflows: workflows.length,
    monoVoicing: workflows.map((w) => w.mono.voicedFrames),
    selectedVoicing: workflows.map((w) => w.selected.map((c) => c.voicedFrames)),
  }),
);
