import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const [beforePath, afterPath, output] = process.argv.slice(2);
const before = JSON.parse(await readFile(beforePath, "utf8"));
const after = JSON.parse(await readFile(afterPath, "utf8"));
assert.equal(before.mode, "baseline");
assert.equal(after.mode, "verify");
assert.equal(before.results.length, 4);
assert.equal(after.results.length, 4);
const results = before.results.map((old, i) => {
  const next = after.results[i];
  for (const field of [
    "engine",
    "version",
    "width",
    "seed",
    "audio",
    "orderSha256",
    "afterDelete",
  ]) {
    assert.deepEqual(
      next[field],
      old[field],
      `${old.engine}/${old.width}: ${field}`,
    );
  }
  assert.equal(next.upgrade.manifestSha256, old.upgrade.manifestSha256);
  assert.equal(next.upgrade.checkedRecords, 100);
  assert.equal(next.afterDelete.checkedRecords, 99);
  assert.equal(next.upgrade.version, 2);
  assert.equal(old.upgrade.version, 1);
  for (const run of next.runs) assert.equal(run.pcmBytes, 0);
  for (const run of old.runs) assert.equal(run.pcmBytes, 192000000);
  assert.equal(next.usePcmBytes, 1920000);
  assert.equal(next.deletePcmBytes, 0);
  assert.equal(old.deletePcmBytes, 190080000);
  for (const row of [old, next]) {
    assert.equal(row.serverStoppedBeforeUse, true);
    for (const field of ["lateRequests", "pageErrors", "policyViolations"])
      assert.deepEqual(row[field], []);
    assert.ok(row.overflow <= 0);
  }
  return {
    engine: next.engine,
    width: next.width,
    version: next.version,
    sameStoredRecords: true,
    sameListOrder: true,
    sameRemainingRecordsAfterDelete: true,
    sameWorkerInput: true,
    samePlaybackInput: true,
    sameContourAndSpectrogram: true,
    recordingManifestSha256: next.upgrade.manifestSha256,
    workerInputSha256: next.audio.find((a) => a.kind === "input").hash,
    workerResultSha256: next.audio.find((a) => a.kind === "result").hashes,
  };
});
await writeFile(output, JSON.stringify({ results }, null, 2) + "\n");
console.log(
  `${results.length} browser/width cases: complete stored metadata/PCM, ordering, selected worker/playback input and analysis unchanged`,
);
