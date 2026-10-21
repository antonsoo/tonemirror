import { chromium, firefox, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const [base, out, phase = "after"] = process.argv.slice(2);
assert(["before", "after"].includes(phase));
if (!base || !out)
  throw new Error("Usage: node studies/contour-axis/replay.mjs URL OUTPUT");
await mkdir(out, { recursive: true });
const rows = [];
for (const [name, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const dpr = width === 375 ? 2 : 1;
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        deviceScaleFactor: dpr,
        colorScheme: width === 375 ? "light" : "dark",
      });
      try {
        const page = await context.newPage();
        const errors = [],
          offlineRequests = [];
        let offline = false;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (r) => {
          if (offline && /^https?:/.test(r.url()))
            offlineRequests.push(r.url());
        });
        await page.addInitScript(() => {
          window.axisProbe = { labels: [], ink: [] };
          window.axisCsp = [];
          document.addEventListener("securitypolicyviolation", (e) =>
            window.axisCsp.push(e.violatedDirective),
          );
          const P = CanvasRenderingContext2D.prototype;
          const nativeClear = P.clearRect,
            nativeFill = P.fillText,
            nativeStroke = P.stroke,
            nativeBegin = P.beginPath,
            nativeMove = P.moveTo,
            nativeLine = P.lineTo;
          const isStage = (ctx) =>
            ctx.canvas === document.querySelector(".tm-stage-wrap canvas");
          P.clearRect = function (...args) {
            if (isStage(this)) window.axisProbe = { labels: [], ink: [] };
            return nativeClear.apply(this, args);
          };
          P.fillText = function (text, x, y, ...args) {
            if (isStage(this) && /^[+-]?\d+$/.test(text)) {
              const m = this.measureText(text);
              window.axisProbe.labels.push({
                text,
                x,
                y,
                top: y - m.actualBoundingBoxAscent,
                bottom: y + m.actualBoundingBoxDescent,
                font: this.font,
              });
            }
            return nativeFill.call(this, text, x, y, ...args);
          };
          P.beginPath = function (...args) {
            this.axisPath = [];
            return nativeBegin.apply(this, args);
          };
          P.moveTo = function (x, y) {
            this.axisPath ??= [];
            this.axisPath.push(["M", x, y]);
            return nativeMove.call(this, x, y);
          };
          P.lineTo = function (x, y) {
            this.axisPath ??= [];
            this.axisPath.push(["L", x, y]);
            return nativeLine.call(this, x, y);
          };
          P.stroke = function (...args) {
            if (isStage(this) && this.lineWidth > 1)
              window.axisProbe.ink.push({
                path: this.axisPath,
                width: this.lineWidth,
                alpha: this.globalAlpha,
                color: this.strokeStyle,
              });
            return nativeStroke.apply(this, args);
          };
        });
        await page.goto(base);
        await page.getByLabel("Pitch search floor").waitFor();
        await page.evaluate(async () => {
          await document.fonts.load('400 11px "IBM Plex Mono"');
          await document.fonts.ready;
        });
        await context.setOffline(true);
        offline = true;
        const file = new URL(
          "../real-voice/cache/ptdb/M03/mic_M03_sx102.wav",
          import.meta.url,
        );
        const bytes = await readFile(file);
        const manifest = JSON.parse(
          await readFile(
            new URL("../real-voice/manifest.json", import.meta.url),
          ),
        );
        const source = manifest.files.find(
          (f) => f.path === "ptdb/M03/mic_M03_sx102.wav",
        );
        if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
          throw new Error("Recording differs from pinned source");
        const rate = 48000,
          calibration = Buffer.alloc(44 + rate * 2 * 2);
        calibration.write("RIFF");
        calibration.writeUInt32LE(calibration.length - 8, 4);
        calibration.write("WAVEfmt ", 8);
        calibration.writeUInt32LE(16, 16);
        calibration.writeUInt16LE(1, 20);
        calibration.writeUInt16LE(1, 22);
        calibration.writeUInt32LE(rate, 24);
        calibration.writeUInt32LE(rate * 2, 28);
        calibration.writeUInt16LE(2, 32);
        calibration.writeUInt16LE(16, 34);
        calibration.write("data", 36);
        calibration.writeUInt32LE(calibration.length - 44, 40);
        for (let i = 0; i < rate * 2; i++)
          calibration.writeInt16LE(
            Math.round(10000 * Math.sin((2 * Math.PI * 80 * i) / rate)),
            44 + 2 * i,
          );
        for (const item of [
          {
            kind: "recorded-wide",
            name: "mic_M03_sx102.wav",
            bytes,
            sha256: source.sha256,
          },
          {
            kind: "synthetic-flat",
            name: "axis-flat-80hz-calibration.wav",
            bytes: calibration,
            sha256: createHash("sha256").update(calibration).digest("hex"),
          },
        ]) {
          for (const role of ["Reference", "Your attempt"]) {
            await page.getByRole("tab", { name: role, exact: true }).click();
            await page
              .getByLabel("Choose an audio file to load")
              .setInputFiles({
                name: item.name,
                mimeType: "audio/wav",
                buffer: item.bytes,
              });
            await expect(page.locator(".tm-status")).toContainText(
              `${item.name} —`,
            );
          }
          await expect(page.locator(".tm-comparison-note")).toContainText(
            "Voiced frames:",
          );
          const data = await page.evaluate(() => window.axisProbe);
          data.labels.sort((a, b) => a.y - b.y);
          const gaps = data.labels
            .slice(1)
            .map((b, i) => b.top - data.labels[i].bottom);
          const ys = data.labels.slice(1).map((b, i) => b.y - data.labels[i].y);
          const record = {
            kind: item.kind,
            sourceSha256: item.sha256,
            browser: name,
            browserVersion: browser.version(),
            width,
            dpr,
            labelCount: data.labels.length,
            minimumBaselineSpacing: Math.min(...ys),
            minimumGlyphGap: Math.min(...gaps),
            overlappingGlyphPairs: gaps.filter((g) => g < 0).length,
            labels: data.labels,
            inkSegments: data.ink.length,
            inkSha256: createHash("sha256")
              .update(JSON.stringify(data.ink))
              .digest("hex"),
            score: await page.locator(".tm-score").textContent(),
            pageErrors: errors,
            cspViolations: await page.evaluate(() => window.axisCsp),
            requestsWhileOffline: offlineRequests,
          };
          assert.deepEqual(errors, []);
          assert.deepEqual(record.cspViolations, []);
          assert.deepEqual(offlineRequests, []);
          assert.equal(record.score, "100");
          if (phase === "after" || item.kind === "synthetic-flat") {
            assert(record.minimumBaselineSpacing >= 22 - 1e-8);
            assert(record.minimumGlyphGap >= 0);
            assert.equal(record.overlappingGlyphPairs, 0);
          } else assert(record.overlappingGlyphPairs > 0);
          assert(record.labels.some((label) => label.text === "0"));
          rows.push(record);
          await page
            .locator("section")
            .filter({
              has: page.getByRole("heading", {
                name: "2. Compare contours",
                exact: true,
              }),
            })
            .screenshot({ path: `${out}/${name}-${width}-${item.kind}.png` });
          console.log(
            name,
            width,
            item.kind,
            record.labelCount,
            record.minimumBaselineSpacing,
            record.minimumGlyphGap,
            record.overlappingGlyphPairs,
          );
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${out}/canvas.json`,
  JSON.stringify(
    {
      base,
      phase,
      scriptSha256: createHash("sha256")
        .update(await readFile(new URL(import.meta.url)))
        .digest("hex"),
      records: rows,
    },
    null,
    2,
  ) + "\n",
);
