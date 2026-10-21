# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.5.3"]
# ///
"""Compare explicit search floors to the pinned laryngeal reference contours.

Original odd PTDB speakers calibrate timing; even speakers are the original
comparison partition, not a newly untouched test set. FDA calibrates on all
100 utterances. No detector threshold or search-floor preset is fitted here.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import subprocess

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "real-voice"))
from refs import read_ptdb_ref, read_fda_fx, ptdb_ref_at, fda_ref_at

parser = argparse.ArgumentParser()
parser.add_argument("frames", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
cache = HERE.parent / "real-voice/cache"
# Validate original bytes and the FDA extraction, rather than trusting receipts
# emitted by the capture process or an earlier successful download.
subprocess.run([sys.executable, "-I", str(HERE.parent / "real-voice/fetch.py"), "--offline"], check=True)
hash_bytes = lambda value: hashlib.sha256(value).hexdigest()
receipts = [json.loads(p.read_text()) for p in sorted(args.frames.glob("shard-*.json"))]
assert receipts and {r["shard"] for r in receipts} == set(range(receipts[0]["shards"]))
assert all(r["sourceFiles"] == receipts[0]["sourceFiles"] and r["captureSha256"] == receipts[0]["captureSha256"] for r in receipts)
expected = {r["file"]: r for shard in receipts for r in shard["recordings"]}
assert len(expected) == sum(len(r["recordings"]) for r in receipts) == 580
assert set(p.name for p in args.frames.glob("*.json") if not p.name.startswith("shard-")) == set(expected)
assert all(r["sourceManifestSha256"] == hash_bytes((HERE.parent / "real-voice/manifest.json").read_bytes()) for r in receipts)

utterances = []
for name, receipt in sorted(expected.items()):
    data = (args.frames / name).read_bytes()
    assert hash_bytes(data) == receipt["sha256"]
    row = json.loads(data)
    assert row["audioSha256"] == receipt["audioSha256"]
    speaker, sid, corpus = row["speaker"], row["id"], row["corpus"]
    audio_path = cache / (f"ptdb/{speaker}/mic_{speaker}_{sid}.wav" if corpus == "ptdb" else f"fda-extracted/{speaker}/{sid}.sig")
    assert row["audioSha256"] == hash_bytes(audio_path.read_bytes())
    path = cache / (f"ptdb/{speaker}/ref_{speaker}_{sid}.f0" if corpus == "ptdb" else f"fda-extracted/{speaker}/{sid}.fx")
    row["reference"] = read_ptdb_ref(path) if corpus == "ptdb" else read_fda_fx(path)
    row["referenceSha256"] = hash_bytes(path.read_bytes())
    row["development"] = corpus == "ptdb" and int(speaker[1:]) % 2 == 1
    row["systems"] = {}
    assert len(row["settings"]) == 6
    for setting in row.pop("settings"):
        points = np.array(setting.pop("points"), dtype=np.float64)
        assert points.ndim == 2 and points.shape[1] == 3 and np.isfinite(points).all()
        assert np.all(points[:, 1] >= 0) and np.all((points[:, 2] >= 0) & (points[:, 2] <= 1))
        floor = setting["minFrequency"]
        frame_size = 2 * (row["sampleRate"] // floor)
        hop = round(row["sampleRate"] * .01)
        assert len(points) == (row["samples"] - frame_size) // hop + 1
        assert abs(setting["frameSeconds"] - frame_size / row["sampleRate"]) < 1e-12
        assert np.max(np.abs(points[:, 0] - (np.arange(len(points)) * hop + frame_size / 2) / row["sampleRate"])) < 1e-9
        row["systems"][f"{setting['algorithm']}-{floor}"] = (points[:, 0], points[:, 1], setting)
    assert set(row["systems"]) == {f"{a}-{f}" for a in ("yin", "mpm") for f in (40, 60, 90)}
    utterances.append(row)


def reference_at(row, times, offset):
    if row["corpus"] == "ptdb":
        return ptdb_ref_at(row["reference"], times, offset)
    return fda_ref_at(row["reference"], times, offset)


def valid(row, times, offset):
    if row["corpus"] == "ptdb":
        # Unknown reference coverage at either end is not observed unvoicing.
        return (times - offset >= 0) & (times - offset <= (len(row["reference"]) - 1) * .01 + 1e-9)
    return np.ones(len(times), dtype=bool)


def counts(reference, estimate):
    rv, ev = reference > 0, estimate > 0
    both = rv & ev
    cents = np.zeros_like(reference)
    cents[both] = np.abs(1200 * np.log2(estimate[both] / reference[both]))
    low = rv & (reference < 60)
    hit = both & (cents < 100)
    result = {"frames": len(reference), "referenceVoiced": int(rv.sum()), "referenceUnvoiced": int((~rv).sum()),
              "jointlyVoiced": int(both.sum()), "within100Cents": int(hit.sum()),
              "missedVoiced": int((rv & ~ev).sum()), "falseVoiced": int((~rv & ev).sum()),
              "grossErrors": int((both & (np.abs(estimate - reference) > .2 * reference)).sum()),
              "below60Reference": int(low.sum()), "below60Within100Cents": int((low & hit).sum())}
    return result


def summarize(c):
    pct = lambda numerator, denominator: 100 * numerator / denominator if denominator else None
    return {**c, "voicedWithin100CentsPct": pct(c["within100Cents"], c["referenceVoiced"]),
            "falseVoicedPct": pct(c["falseVoiced"], c["referenceUnvoiced"]),
            "missedVoicedPct": pct(c["missedVoiced"], c["referenceVoiced"]),
            "jointVoicedGrossErrorPct": pct(c["grossErrors"], c["jointlyVoiced"]),
            "below60Within100CentsPct": pct(c["below60Within100Cents"], c["below60Reference"])}


systems = sorted(utterances[0]["systems"])
calibration, results = {}, {}
grid = np.arange(-40, 61, dtype=np.float64) / 1000
for corpus in ("ptdb", "fda"):
    all_rows = [r for r in utterances if r["corpus"] == corpus]
    calibration_rows = [r for r in all_rows if corpus == "fda" or r["development"]]
    calibration[corpus], results[corpus] = {}, {}
    for system in systems:
        agreements = []
        for offset in grid:
            hit = total = 0
            for row in calibration_rows:
                times, frequency, _ = row["systems"][system]
                selected = valid(row, times, offset)
                reference = reference_at(row, times, offset)[selected]
                estimate = frequency[selected]
                c = counts(reference, estimate)
                hit += c["within100Cents"]
                total += c["referenceVoiced"]
            agreements.append(hit / total)
        offset = float(grid[int(np.argmax(agreements))])
        calibration[corpus][system] = {"offsetMs": offset * 1000, "calibrationRecordings": len(calibration_rows),
                                       "within100CentsFraction": max(agreements), "gridMs": [-40, 60, 1]}
        groups = {}
        for row in all_rows:
            times, frequency, _ = row["systems"][system]
            selected = valid(row, times, offset)
            c = counts(reference_at(row, times, offset)[selected], frequency[selected])
            names = ["all"] + (["development" if row["development"] else "comparison"] if corpus == "ptdb" else [])
            for group in names:
                aggregate = groups.setdefault(group, {key: 0 for key in c})
                for key, value in c.items():
                    aggregate[key] += value
        results[corpus][system] = {g: summarize(c) for g, c in groups.items()}

result = {"recordings": len(utterances), "settingsPerRecording": 6,
          "unchangedDefaultComparisons": len(utterances) * 2,
          "scope": "Descriptive agreement with supplied laryngeal references, on each setting's native frame grid. Not pronunciation, tone classification, a fresh held-out evaluation or a universally better setting.",
          "protocol": "Fit one timing offset per algorithm/floor/corpus on the original odd PTDB speakers, or all FDA recordings, maximizing supplied-reference voiced-frame agreement within 100 cents. Exclude PTDB frames outside either end of the reference. Use the same fixed presets and detector defaults. No floor is selected by these results.",
          "sourceManifestSha256": receipts[0]["sourceManifestSha256"], "detectorFiles": receipts[0]["sourceFiles"],
          "captureSha256": receipts[0]["captureSha256"], "scorerSha256": hash_bytes(Path(__file__).read_bytes()),
          "referenceReaderSha256": hash_bytes((HERE.parent / "real-voice/refs.py").read_bytes()),
          "python": sys.version.split()[0], "numpy": np.__version__, "captureRuntimes": sorted({r["node"] for r in receipts}), "calibration": calibration, "results": results,
          "frameFiles": [{**expected[name], "referenceSha256": row["referenceSha256"]} for name, row in zip(sorted(expected), utterances, strict=True)]}
args.output.write_text(json.dumps(result, indent=2) + "\n")
for corpus in results:
    for system, groups in results[corpus].items():
        print(corpus, system, json.dumps(groups["all"]))
