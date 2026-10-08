/**
 * Re-run only the contour post-processing of the current checkout on saved raw detector output, so a
 * change to src/core/pitchTrack.ts can be scored without re-running YIN and MPM. trackPitch is
 * postProcessF0 over the voiced raw frames, so this reproduces trackPitch's contours exactly
 * (check.ts-style equality is asserted against the stored contours for the unchanged checkout).
 *
 *   tsx lab-postprocess.ts <repo-root> <in-dir> <out-dir>
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, inDir, outDir] = process.argv.slice(2) as [string, string, string];
const { postProcessF0 } = (await import(pathToFileURL(join(repoRoot, "src/core/pitchTrack.ts")).href)) as {
  postProcessF0: (f: (number | null)[], w?: number) => (number | null)[];
};
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(inDir).filter((x) => x.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(join(inDir, f), "utf8"));
  for (const alg of ["yin", "mpm"]) {
    const raw: (number | null)[] = j[alg].rawF0.map((v: number) => (v === 0 ? null : v));
    j[alg].contourF0 = postProcessF0(raw).map((v) => (v === null ? 0 : +v.toFixed(3)));
  }
  writeFileSync(join(outDir, f), JSON.stringify(j));
}
