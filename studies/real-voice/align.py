"""Estimate the time offset between each corpus's reference F0 and the frame times of the trackers.

Offset d means: PTDB record i describes time i*10 ms + d; FDA contour times are shifted by d.
For each d on a 1 ms grid, score = share of reference-voiced frames where the estimate is voiced
and within 100 cents of the reference. The best d is taken on the PTDB-TUG development speakers
(PTDB) or on all FDA files (FDA has no development split; the offset is not a tracker parameter).
Systems are compared so a tracker-specific bias shows up as disagreement between them.

python -I align.py <out-dir>... > align.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir; this is our own code only

import numpy as np

from lib import DEV, iter_utts, load_ref, ref_at

utts = iter_utts(*sys.argv[1:])
grid = np.arange(-0.040, 0.0601, 0.001)
systems = ["yin_contour", "mpm_contour", "pyin", "praat"]
res = {}
for corpus in ("ptdb", "fda"):
    use = [u for u in utts.values() if u["meta"]["corpus"] == corpus and (corpus == "fda" or u["meta"]["speaker"] in DEV)]
    refs = [load_ref(corpus, u["meta"]["speaker"], u["meta"]["id"]) for u in use]
    res[corpus] = {}
    for s in systems:
        score = []
        for d in grid:
            hit = tot = 0
            for u, r in zip(use, refs):
                if s not in u["sys"]:
                    continue
                t, f = u["sys"][s]
                rr = ref_at(corpus, r, t, d)
                rv = rr > 0
                if corpus == "ptdb":
                    rv &= (t - d) <= (len(r) - 1) * 0.01
                ok = rv & (f > 0)
                c = np.abs(1200 * np.log2(np.where(ok, f, 1) / np.where(ok, rr, 1)))
                hit += int((ok & (c < 100)).sum())
                tot += int(rv.sum())
            score.append(hit / tot)
        score = np.array(score)
        res[corpus][s] = {"best_offset_ms": round(float(grid[score.argmax()] * 1000), 1),
                          "best_agreement": round(float(score.max()), 4),
                          "agreement_at_zero": round(float(score[np.argmin(abs(grid))]), 4),
                          "curve_ms_to_agreement": {f"{g*1000:.0f}": round(float(v), 4) for g, v in zip(grid[::5], score[::5])}}
print(json.dumps(res, indent=1))
