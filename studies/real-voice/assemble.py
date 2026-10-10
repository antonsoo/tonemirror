"""Assemble the current comparison after checking complete frame-table coverage.

python -I assemble.py <align.json> <scores.json> <diagnose-dev.json> <diagnose-heldout.json> <diagnose-fda.json> \
    <consensus-yin.json> <consensus-mpm.json> <frames-dir> <baselines-dir> <out.json>

Rejected exploratory patches are historical evidence in git, not current results.
"""

import hashlib
import importlib.metadata
import json
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expected_items():
    manifest = json.loads((HERE / "manifest.json").read_text())
    expected = {}
    for row in manifest["files"]:
        path = Path(row["path"])
        if path.suffix == ".wav":
            _, speaker, sid = path.stem.split("_", 2)
            expected[f"ptdb_{speaker}_{sid}"] = ("ptdb", speaker, sid)
    archive = next(
        row for row in manifest["files"] if row["path"] == "fda/fda_eval.tar.gz"
    )
    path = HERE / "cache" / archive["path"]
    if path.stat().st_size != archive["bytes"] or digest(path) != archive["sha256"]:
        raise ValueError("FDA archive does not match the pinned manifest")
    with tarfile.open(path, "r:gz") as source:
        for member in source:
            path = Path(member.name)
            if (
                member.isfile()
                and path.suffix == ".sig"
                and path.parent.name in {"rl", "sb"}
            ):
                expected[f"fda_{path.parent.name}_{path.stem}"] = (
                    "fda",
                    path.parent.name,
                    path.stem,
                )
    if len(expected) != 580:
        raise ValueError("Expected 480 PTDB-TUG and 100 FDA recordings")
    return expected


def frame_manifest(directory, expected, algorithms):
    paths = sorted(Path(directory).glob("*.json"))
    if {p.stem for p in paths} != set(expected):
        raise ValueError(
            f"Frame tables must cover the exact 580 recorded utterances: {directory}"
        )
    files = {}
    for path in paths:
        data = json.loads(path.read_text())
        if (
            tuple(data[key] for key in ("corpus", "speaker", "id"))
            != expected[path.stem]
        ):
            raise ValueError(
                f"Frame table identity disagrees with its filename: {path.name}"
            )
        if not all(name in data for name in algorithms):
            raise ValueError(f"Missing tracker in {path.name}")
        files[path.name] = digest(path)
    return {"utterances": len(paths), "sha256ByFile": files}


def main():
    if len(sys.argv) != 11:
        raise SystemExit(__doc__)
    align, scores, dd, dh, df, cy, cm = [
        json.loads(Path(p).read_text()) for p in sys.argv[1:8]
    ]
    expected = expected_items()
    tables = {
        "tonemirror": frame_manifest(sys.argv[8], expected, ["yin", "mpm"]),
        "baselines": frame_manifest(sys.argv[9], expected, ["pyin", "praat"]),
    }
    result = {
        "metric": {
            "grossPitchError": "abs(estimateHz - referenceHz) > 0.2 * referenceHz; jointly voiced frames only",
            "octaveClassification": "gross errors within 1200*log2(1.2) cents of -1200 or +1200 cents",
            "fineError": "absolute cents error on jointly voiced frames that are not gross errors",
            "consensusSampling": "nearest frame after each tracker's fitted time offset, without extrapolation",
        },
        "provenance": {
            "sourceManifestSha256": digest(HERE / "manifest.json"),
            "pythonPackages": {
                name: importlib.metadata.version(name)
                for name in ["numpy", "librosa", "praat-parselmouth", "soundfile"]
            },
            "codeSha256": {
                str(p.relative_to(REPO)): digest(p)
                for p in [
                    *sorted((REPO / "src/core").glob("*.ts")),
                    *sorted(HERE.glob("*.py")),
                    HERE / "run-tonemirror.ts",
                ]
            },
            "frameTables": tables,
        },
        "alignment": align,
        "scores": scores["systems"],
        "diagnosis_yin_contour": {"development": dd, "held-out": dh, "fda": df},
        "reference_disputed_frames": {"yin_contour": cy, "mpm_contour": cm},
    }
    Path(sys.argv[10]).write_text(json.dumps(result, indent=1) + "\n")


if __name__ == "__main__":
    main()
