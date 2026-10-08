"""Score every system against the reference F0 and write results JSON.

python -I score.py <align.json> <out-json> <frame-dir>...
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir; our own code only

import numpy as np

from lib import iter_utts, score, summarise

align = json.loads(Path(sys.argv[1]).read_text())
# each system is scored at its own best offset: YIN and MPM stamp a frame by its centre but compare the
# first half of the frame with the second shifted by tau, so their evidence sits earlier than the stamp
# (about 7 ms against pYIN and Praat on PTDB-TUG)
offsets = {c: {s: v["best_offset_ms"] / 1000 for s, v in align[c].items()} for c in align}
# raw detector tables share the offset of the contour table of the same algorithm
for c in offsets:
    for a in ("yin", "mpm"):
        offsets[c][f"{a}_raw"] = offsets[c][f"{a}_contour"]
utts = iter_utts(*sys.argv[3:])
raw = score(utts, offsets)
out = {"offsets_s": offsets, "systems": {}}
for sysname, groups in raw.items():
    out["systems"][sysname] = {g: summarise(s) for g, s in sorted(groups.items())}
Path(sys.argv[2]).write_text(json.dumps(out, indent=1) + "\n")
print("offsets", offsets)
for sysname, groups in out["systems"].items():
    for g in ("ptdb/development", "ptdb/held-out", "fda/all"):
        s = groups.get(g)
        if s:
            print(f"{sysname:12s} {g:17s} GPE {s['gross_error_pct']:5.1f}  half {s['octave_halving_pct_of_voiced']:4.1f} dbl {s['octave_doubling_pct_of_voiced']:4.1f}  V->U {s['voiced_called_unvoiced_pct']:5.1f} U->V {s['unvoiced_called_voiced_pct']:5.1f}  VDE {s['voicing_decision_error_pct']:5.1f}  fine {s['fine_mae_cents']}")
