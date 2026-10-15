// Native PCM and cursor checks; node native.mjs SOURCE_ROOT OUTPUT.json [--baseline]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const [rootArg, output, mode] = process.argv.slice(2);
assert.ok(rootArg && output);
const root = resolve(rootArg), baseline = mode === "--baseline";
const require = createRequire(join(root, "package.json"));
const ts = require("typescript");
const { chromium, firefox } = require("@playwright/test");
const source = await readFile(join(root, "src/audio/playback.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText.replace("export class ClipPlayer", "class ClipPlayer") + "\nglobalThis.ClipPlayer = ClipPlayer;";
const results = [];
for (const [engine, launcher] of Object.entries({ chromium, firefox })) {
  const browser = await launcher.launch();
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent("<button>Check native playback</button>");
    await page.addScriptTag({ content: code });
    const offline = await page.evaluate(async () => {
      const rows = [];
      for (const sampleRate of [8000, 44100, 48000]) for (const half of [false, true]) {
        const rate = half ? 0.5 : 1;
        // A synthetic sample encodes source time as (amplitude - 0.05) * 8.
        // The twice-length ramp checks prepared-buffer coordinates, not stretch quality.
        const pcm = Float32Array.from({ length: 4 * sampleRate }, (_, i) => 0.05 + i / (8 * sampleRate));
        const slow = Float32Array.from({ length: 8 * sampleRate }, (_, i) => 0.05 + i / (16 * sampleRate));
        for (const offset of [0, 0.5, 1, 1.5, 2, 3, 4]) {
          const frames = 4096, context = new OfflineAudioContext(1, frames, sampleRate);
          const player = new ClipPlayer(context);
          player.load(pcm, sampleRate); player.loadHalfSpeed(slow); player.setHalfSpeed(half);
          player.setLoopRegion({ start: 0.25, end: 0.5 }); player.play(offset);
          const cursorStart = player.currentPositionSeconds();
          const actual = (await context.startRendering()).getChannelData(0);
          const reference = new OfflineAudioContext(1, frames, sampleRate);
          const node = reference.createBufferSource(), data = half ? slow : pcm;
          const buffer = reference.createBuffer(1, data.length, sampleRate); buffer.copyToChannel(data, 0);
          node.buffer = buffer; node.loop = true; node.loopStart = 1 / rate; node.loopEnd = 2 / rate;
          node.connect(reference.destination);
          // Selection semantics are independent of ClipPlayer's returned cursor.
          const expectedStart = offset >= 1 && offset < 2 ? offset : 1;
          node.start(0, expectedStart / rate);
          const expected = (await reference.startRendering()).getChannelData(0);
          let sampleMismatches = 0, maxSampleDifference = 0;
          for (let i = 0; i < frames; i++) {
            const difference = Math.abs(actual[i] - expected[i]);
            sampleMismatches += Number(difference > 1e-7); maxSampleDifference = Math.max(maxSampleDifference, difference);
          }
          const cursorEnd = player.currentPositionSeconds();
          const expectedEnd = 1 + ((expectedStart - 1 + frames / sampleRate * rate) % 1);
          rows.push({ sampleRate, half, offset, expectedStart, cursorStart, cursorEnd, expectedEnd,
            firstSample: actual[0], expectedFirstSample: expected[0], frames, sampleMismatches, maxSampleDifference,
            matches: sampleMismatches === 0 && Math.abs(cursorStart - expectedStart) < 1e-9 && Math.abs(cursorEnd - expectedEnd) < 1e-9 });
          player.stop(); node.disconnect();
        }
      }
      return rows;
    });
    await page.evaluate(() => {
      document.querySelector("button").onclick = async () => {
        try {
          const rows = [];
          for (const scenario of [
            { name: "enable-before-start", offset: 0, loop: null, next: { start: 0.25, end: 0.5 } },
            { name: "move-start-ahead", offset: 0.4, loop: { start: 0, end: 0.75 }, next: { start: 0.25, end: 0.5 } },
            { name: "enable-after-end", offset: 3, loop: null, next: { start: 0.25, end: 0.5 } },
            { name: "enable-inside", offset: 1.2, loop: null, next: { start: 0.25, end: 0.5 } },
            { name: "clear-loop", offset: 1.9, loop: { start: 0.25, end: 0.5 }, next: null },
          ]) for (const half of [false, true]) {
            const context = new AudioContext({ sampleRate: 8000 }); await context.resume();
            let analyser;
            const create = context.createBufferSource.bind(context);
            context.createBufferSource = () => {
              const node = create(), connect = node.connect.bind(node);
              node.connect = destination => {
                analyser = context.createAnalyser(); analyser.fftSize = 32;
                connect(analyser); return analyser.connect(destination);
              };
              return node;
            };
            const player = new ClipPlayer(context), sr = 8000;
            player.load(Float32Array.from({ length: sr * 4 }, (_, i) => 0.05 + i / (8 * sr)), sr);
            player.loadHalfSpeed(Float32Array.from({ length: sr * 8 }, (_, i) => 0.05 + i / (16 * sr)));
            player.setHalfSpeed(half); player.setLoopRegion(scenario.loop); player.play(scenario.offset);
            const wait = async duration => {
              const target = context.currentTime + duration, deadline = performance.now() + 5000;
              while (context.currentTime < target) {
                if (performance.now() > deadline) throw new Error("Native audio clock did not advance");
                await new Promise(done => setTimeout(done, 8));
              }
            };
            try {
              await wait(0.16);
              const before = player.currentPositionSeconds(); player.setLoopRegion(scenario.next);
              const immediatelyAfter = player.currentPositionSeconds(), observations = [];
              await wait(0.08);
              for (let i = 0; i < 6; i++) {
                await wait(0.032);
                const samples = new Float32Array(32); analyser.getFloatTimeDomainData(samples);
                const native = (samples.at(-1) - 0.05) * 8, cursor = player.currentPositionSeconds();
                observations.push({ native, cursor, errorSeconds: Math.abs(native - cursor),
                  inside: scenario.next === null || (native >= 1 - 1e-5 && native < 2 + 1e-5) });
              }
              const maxErrorSeconds = Math.max(...observations.map(row => row.errorSeconds));
              rows.push({ scenario: scenario.name, half, before, immediatelyAfter, observations, maxErrorSeconds,
                toleranceSeconds: 0.064, matches: maxErrorSeconds <= 0.064 && observations.every(row => row.inside) });
            } finally { player.stop(); await context.close(); }
          }
          globalThis.loopResult = { rows };
        } catch (error) { globalThis.loopResult = { error: String(error) }; }
      };
    });
    await page.click("button"); await page.waitForFunction(() => globalThis.loopResult, null, { timeout: 60000 });
    const live = await page.evaluate(() => globalThis.loopResult);
    assert.equal(live.error, undefined); assert.deepEqual(errors, []);
    results.push({ engine, version: browser.version(), offline, live: live.rows, errors });
    console.log(`${engine}: ${offline.filter(r => r.matches).length}/${offline.length} offline; ${live.rows.filter(r => r.matches).length}/${live.rows.length} live`);
  } finally { await browser.close(); }
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const count = (kind, match) => results.reduce((n, r) => n + r[kind].filter(t => !match || t.matches).length, 0);
await writeFile(output, JSON.stringify({ baseline, synthetic: true, sourceSha256: hash(source),
  driverSha256: hash(await readFile(fileURLToPath(import.meta.url))), offlineCases: count("offline"), offlineMatches: count("offline", true),
  liveCases: count("live"), liveMatches: count("live", true),
  scope: "Native digital rendering and source-time cursor; prepared synthetic ramps test half-speed coordinates, not acoustic or stretch quality.", results,
}, null, 2) + "\n");
if (!baseline) for (const result of results) {
  assert.ok(result.offline.every(row => row.matches), JSON.stringify(result.offline.filter(row => !row.matches)));
  assert.ok(result.live.every(row => row.matches), JSON.stringify(result.live.filter(row => !row.matches)));
}
