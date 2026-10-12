/** Alternating native baselines and candidates; run alone, not during tests.
 * tsx benchmark.ts BASELINE CANDIDATE OUTPUT
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, release } from 'node:os';
const [baseline, candidate, output] = process.argv.slice(2);
const modules = await Promise.all([baseline, candidate].map(root => import(pathToFileURL(resolve(root!, 'src/core/pitchTrack.ts')).href)));
const results = [];
for (const sampleRate of [8000, 16000, 44100, 48000, 96000]) {
  const pcm = Float32Array.from({ length: sampleRate * 10 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 180 * i / sampleRate) + 0.15 * Math.sin(2 * Math.PI * 360 * i / sampleRate));
  for (const algorithm of ['yin', 'mpm']) {
    const options = { sampleRate, algorithm };
    for (const mod of modules) mod.trackPitch(pcm.subarray(0, sampleRate), options);
    const times: number[][] = [[], []]; let frames = 0;
    for (let iteration = 0; iteration < 5; iteration++) {
      for (const revision of iteration % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now(); const contour = modules[revision]!.trackPitch(pcm, options);
        times[revision]!.push(performance.now() - start); frames = contour.points.length;
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
    results.push({ sampleRate, algorithm, seconds: 10, frames, beforeMs: times[0], afterMs: times[1], beforeMedianMs: median(times[0]!), afterMedianMs: median(times[1]!), speedup: median(times[0]!) / median(times[1]!) });
    console.error(results.at(-1));
  }
}
writeFileSync(output!, JSON.stringify({ node: process.version, os: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, fixture: 'Synthetic voiced harmonic signal: 180 Hz + second harmonic; warm one second per implementation, then five alternating full 10-second analyses. Wall time, no concurrent study jobs.', results }, null, 2) + '\n');
