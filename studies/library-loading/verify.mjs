// Synthetic storage workload, real browsers, actual production build.
// Timing ends before the separate byte-preservation and audio-path audit.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium, firefox } from "@playwright/test";

const [
  distArg = "dist",
  output = "/tmp/library-loading.json",
  mode = "verify",
  screenshots,
] = process.argv.slice(2);
assert.ok(["verify", "baseline"].includes(mode));
const dist = resolve(distArg);
const results = [];
if (screenshots) await mkdir(screenshots, { recursive: true });
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function serve() {
  const server = createServer(async (request, response) => {
    const name =
      new URL(request.url, "http://localhost").pathname.replace(
        /^\/tonemirror\//,
        "",
      ) || "index.html";
    const path = resolve(dist, name);
    if (!path.startsWith(dist + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(path);
      response.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          }[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let stopped = false;
  return {
    url: `http://127.0.0.1:${server.address().port}/tonemirror/`,
    async close() {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

for (const [engine, type] of Object.entries({ chromium, firefox })) {
  const browser = await type.launch();
  try {
    for (const width of [1440, 375]) {
      const server = await serve();
      const context = await browser.newContext({
        viewport: { width, height: 950 },
      });
      try {
        const page = await context.newPage();
        const pageErrors = [],
          lateRequests = [];
        let stopped = false;
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("request", (r) => {
          if (stopped && /^https?:/.test(r.url()))
            lateRequests.push(new URL(r.url()).pathname);
        });
        await page.addInitScript(() => {
          const evidence = (window.evidence = {
            pcmBytes: 0,
            reads: [],
            listReadyMs: null,
            firstReadMs: null,
            opens: [],
            maxTimerLagMs: 0,
            audit: false,
          });
          window.audioHashes = [];
          window.audioHashJobs = [];
          window.playbackStarts = 0;
          window.policyViolations = [];
          document.addEventListener("securitypolicyviolation", (e) =>
            window.policyViolations.push(e.violatedDirective),
          );
          window.hashBytes = async (data) =>
            Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
              (b) => b.toString(16).padStart(2, "0"),
            ).join("");
          const open = IDBFactory.prototype.open;
          IDBFactory.prototype.open = function (...args) {
            const start = performance.now(),
              request = open.apply(this, args);
            let upgradeStart = null;
            request.addEventListener("upgradeneeded", () => {
              upgradeStart = performance.now();
            });
            request.addEventListener("success", () => {
              if (!evidence.audit)
                evidence.opens.push({
                  version: request.result.version,
                  elapsedMs: performance.now() - start,
                  upgradeMs:
                    upgradeStart === null
                      ? null
                      : performance.now() - upgradeStart,
                });
            });
            return request;
          };
          for (const name of ["getAll", "get"]) {
            const original = IDBObjectStore.prototype[name];
            IDBObjectStore.prototype[name] = function (...args) {
              const start = performance.now(),
                tracked = this.name === "references" && !evidence.audit;
              if (tracked && evidence.firstReadMs === null)
                evidence.firstReadMs = start;
              const request = original.apply(this, args);
              request.addEventListener("success", () => {
                if (!tracked) return;
                const rows = Array.isArray(request.result)
                  ? request.result
                  : [request.result];
                const bytes = rows.reduce(
                  (sum, row) => sum + (row?.pcmBuffer?.byteLength ?? 0),
                  0,
                );
                evidence.pcmBytes += bytes;
                evidence.reads.push({
                  operation: name,
                  bytes,
                  records: rows.length,
                  elapsedMs: performance.now() - start,
                });
              });
              return request;
            };
          }
          const openKeyCursor = IDBIndex.prototype.openKeyCursor;
          IDBIndex.prototype.openKeyCursor = function (...args) {
            const start = performance.now(),
              tracked = !evidence.audit;
            if (tracked && evidence.firstReadMs === null)
              evidence.firstReadMs = start;
            const request = openKeyCursor.apply(this, args);
            let records = 0;
            request.addEventListener("success", () => {
              if (!tracked) return;
              if (request.result) records++;
              else
                evidence.reads.push({
                  operation: "openKeyCursor",
                  bytes: 0,
                  records,
                  elapsedMs: performance.now() - start,
                });
            });
            return request;
          };
          new MutationObserver(() => {
            if (
              document.querySelectorAll(".tm-library-item").length === 100 &&
              evidence.listReadyMs === null
            )
              evidence.listReadyMs = performance.now();
          }).observe(document, { childList: true, subtree: true });
          let last = performance.now();
          window.timer = setInterval(() => {
            const now = performance.now();
            evidence.maxTimerLagMs = Math.max(
              evidence.maxTimerLagMs,
              now - last - 16,
            );
            last = now;
          }, 16);
          const WorkerClass = Worker;
          window.Worker = class extends WorkerClass {
            constructor(...args) {
              super(...args);
              this.addEventListener("message", (e) => {
                if (e.data.type !== "analyzed") return;
                const { contour, spectrogram } = e.data;
                const { frames, ...metadata } = spectrogram;
                const bytes = new Uint8Array(
                  frames.reduce((n, f) => n + f.byteLength, 0),
                );
                let offset = 0;
                for (const f of frames) {
                  bytes.set(
                    new Uint8Array(f.buffer, f.byteOffset, f.byteLength),
                    offset,
                  );
                  offset += f.byteLength;
                }
                window.audioHashJobs.push(
                  Promise.all([
                    window.hashBytes(
                      new TextEncoder().encode(JSON.stringify(contour)),
                    ),
                    window.hashBytes(
                      new TextEncoder().encode(JSON.stringify(metadata)),
                    ),
                    window.hashBytes(bytes),
                  ]).then((hashes) =>
                    window.audioHashes.push({
                      kind: "result",
                      hashes,
                      contourPoints: contour.points.length,
                      spectrumFrames: frames.length,
                    }),
                  ),
                );
              });
            }
            postMessage(message, ...args) {
              if (message.type === "analyze")
                window.audioHashJobs.push(
                  window.hashBytes(message.pcm).then((hash) =>
                    window.audioHashes.push({
                      kind: "input",
                      hash,
                      sampleRate: message.sampleRate,
                      algorithm: message.algorithm,
                    }),
                  ),
                );
              return super.postMessage(message, ...args);
            }
          };
          const copy = AudioBuffer.prototype.copyToChannel;
          AudioBuffer.prototype.copyToChannel = function (pcm, ...args) {
            window.audioHashJobs.push(
              window
                .hashBytes(pcm)
                .then((hash) =>
                  window.audioHashes.push({ kind: "playback", hash }),
                ),
            );
            return copy.call(this, pcm, ...args);
          };
          const start = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function (...args) {
            window.playbackStarts++;
            return start.apply(this, args);
          };
        });

        await page.route("**/_study-seed.html", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Synthetic storage fixture</title>",
          }),
        );
        await page.goto(new URL("_study-seed.html", server.url).href);
        const seed = await page.evaluate(async () => {
          const db = await new Promise((resolve, reject) => {
            const r = indexedDB.open("tonemirror", 1);
            r.onupgradeneeded = () =>
              r.result.createObjectStore("references", { keyPath: "id" });
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          const hashes = [];
          for (let i = 0; i < 100; i++) {
            const pcm = new Float32Array(48000 * 10);
            for (let n = 0; n < pcm.length; n++)
              pcm[n] =
                0.2 * Math.sin((2 * Math.PI * (120 + i * 2) * n) / 48000);
            const metadata = {
              id: `ref-${String(i).padStart(3, "0")}`,
              name: `Synthetic phrase ${i}`,
              category: "user",
              synthetic: true,
              sampleRate: 48000,
              createdAt: i + 1,
            };
            hashes.push({
              ...metadata,
              pcmSha256: await window.hashBytes(pcm),
            });
            await new Promise((resolve, reject) => {
              const tx = db.transaction("references", "readwrite");
              tx.objectStore("references").put({
                ...metadata,
                pcmBuffer: pcm.buffer,
              });
              tx.oncomplete = resolve;
              tx.onabort = () => reject(tx.error);
            });
          }
          db.close();
          return hashes;
        });

        const runs = [];
        for (let i = 0; i < 3; i++) {
          await page.goto(server.url);
          await page.waitForFunction(
            () => document.querySelectorAll(".tm-library-item").length === 100,
          );
          runs.push(
            await page.evaluate(() => {
              clearInterval(window.timer);
              const { audit, ...data } = window.evidence;
              return {
                ...data,
                readyElapsedMs: data.listReadyMs - data.firstReadMs,
              };
            }),
          );
          if (mode === "verify") assert.equal(runs.at(-1).pcmBytes, 0);
          else assert.equal(runs.at(-1).pcmBytes, 192000000);
        }
        const order = await page
          .locator(".tm-library-item > span:first-child")
          .allTextContents();
        assert.deepEqual(
          order,
          [...seed].reverse().map((row) => `${row.name} ${row.category}`),
        );
        await page.evaluate(() => document.fonts.ready);
        await server.close();
        stopped = true;

        // Independent whole-record audit, deliberately excluded from measured reads/times.
        async function audit() {
          return page.evaluate(async () => {
            window.evidence.audit = true;
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open("tonemirror");
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error);
            });
            try {
              const records = [];
              for (let i = 0; i < 100; i++) {
                const row = await new Promise((resolve, reject) => {
                  const tx = db.transaction("references", "readonly"),
                    r = tx
                      .objectStore("references")
                      .get(`ref-${String(i).padStart(3, "0")}`);
                  tx.oncomplete = () => resolve(r.result);
                  tx.onabort = () => reject(tx.error);
                });
                if (row) {
                  const { pcmBuffer, ...metadata } = row;
                  records.push({
                    ...metadata,
                    pcmSha256: await window.hashBytes(pcmBuffer),
                  });
                }
              }
              return { version: db.version, records };
            } finally {
              db.close();
              window.evidence.audit = false;
            }
          });
        }
        const upgraded = await audit();
        assert.deepEqual(upgraded.records, seed);
        assert.equal(upgraded.version, mode === "baseline" ? 1 : 2);
        const beforeUseBytes = await page.evaluate(
          () => window.evidence.pcmBytes,
        );
        await page
          .locator(".tm-library-item")
          .first()
          .getByRole("button", { name: "Use", exact: true })
          .click();
        await page.waitForFunction(() =>
          document
            .querySelector(".tm-clip-label")
            ?.textContent.includes("Synthetic phrase 99 (synthetic)"),
        );
        const usePcmBytes =
          (await page.evaluate(() => window.evidence.pcmBytes)) -
          beforeUseBytes;
        assert.equal(usePcmBytes, mode === "verify" ? 1920000 : 0);
        await page.getByRole("button", { name: /Play|Pause/ }).click();
        await page.waitForFunction(() => window.playbackStarts === 1);
        await page.getByRole("button", { name: /Play|Pause/ }).click();
        const audio = await page.evaluate(async () => {
          await Promise.all(window.audioHashJobs);
          return window.audioHashes.sort((a, b) =>
            a.kind.localeCompare(b.kind),
          );
        });
        assert.equal(
          audio.find((a) => a.kind === "input").hash,
          seed.at(-1).pcmSha256,
        );
        assert.equal(
          audio.find((a) => a.kind === "playback").hash,
          seed.at(-1).pcmSha256,
        );
        assert.ok(audio.find((a) => a.kind === "result").contourPoints > 0);
        assert.ok(audio.find((a) => a.kind === "result").spectrumFrames > 0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        assert.ok(overflow <= 0);
        if (screenshots) {
          await page.locator("#audio-analysis").screenshot({
            path: resolve(screenshots, `${engine}-${width}-analysis.png`),
          });
          await page
            .locator(".tm-library-list")
            .locator("..")
            .screenshot({
              path: resolve(screenshots, `${engine}-${width}-library.png`),
            });
        }
        const beforeDeleteBytes = await page.evaluate(
          () => window.evidence.pcmBytes,
        );
        await page
          .locator(".tm-library-item")
          .first()
          .getByRole("button", { name: "Delete", exact: true })
          .click();
        await page.waitForFunction(
          () => document.querySelectorAll(".tm-library-item").length === 99,
        );
        const deletePcmBytes =
          (await page.evaluate(() => window.evidence.pcmBytes)) -
          beforeDeleteBytes;
        assert.equal(deletePcmBytes, mode === "verify" ? 0 : 190080000);
        const remaining = await audit();
        assert.deepEqual(remaining.records, seed.slice(0, -1));
        const policyViolations = await page.evaluate(
          () => window.policyViolations,
        );
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(policyViolations, []);
        assert.deepEqual(lateRequests, []);
        results.push({
          engine,
          version: browser.version(),
          width,
          records: 100,
          sampleRate: 48000,
          secondsPerRecord: 10,
          storedPcmBytes: 192000000,
          runs,
          seed,
          orderSha256: sha(order),
          upgrade: {
            version: upgraded.version,
            checkedRecords: 100,
            unchanged: true,
            manifestSha256: sha(upgraded.records),
          },
          usePcmBytes,
          audio,
          deletePcmBytes,
          afterDelete: {
            checkedRecords: 99,
            unchanged: true,
            manifestSha256: sha(remaining.records),
          },
          serverStoppedBeforeUse: true,
          overflow,
          lateRequests,
          pageErrors,
          policyViolations,
        });
        console.log({
          engine,
          width,
          listBytes: runs.map((r) => r.pcmBytes),
          readToListMs: runs.map((r) => Math.round(r.readyElapsedMs)),
          usePcmBytes,
          deletePcmBytes,
        });
      } finally {
        await context.close();
        await server.close();
      }
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  output,
  JSON.stringify({ node: process.version, mode, results }, null, 2) + "\n",
);
