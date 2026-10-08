"""Merge the pieces into results.json.
python -I assemble.py <align.json> <scores.json> <diagnose-dev.json> <diagnose-heldout.json> <diagnose-fda.json> \
   <consensus-yin.json> <consensus-mpm.json> <experiments.txt> <octave-v1-scores.json> <octave-v2-scores.json> <out>
"""
import json
import sys
from pathlib import Path

a = [json.loads(Path(p).read_text()) if p.endswith(".json") else Path(p).read_text().splitlines() for p in sys.argv[1:11]]
align, scores, dd, dh, df, cy, cm, exp, v1, v2 = a
keep = ("ptdb/development", "ptdb/held-out", "fda/all")
res = {
    "alignment": align,
    "scores": scores["systems"],
    "diagnosis_yin_contour": {"development": dd, "held-out": dh, "fda": df},
    "reference_disputed_frames": {"yin_contour": cy, "mpm_contour": cm},
    "experiments": {
        "threshold_hysteresis_window_sweeps_development_only": exp,
        "octave_run_correction_v1_longest_run": {s: {g: v1["systems"][s][g] for g in keep} for s in ("yin_contour", "mpm_contour")},
        "octave_run_correction_v2_clip_median_prior": {s: {g: v2["systems"][s][g] for g in keep} for s in ("yin_contour", "mpm_contour")},
    },
}
Path(sys.argv[11]).write_text(json.dumps(res, indent=1) + "\n")
