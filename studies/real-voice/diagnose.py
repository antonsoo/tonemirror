"""Where do yin_contour's errors sit? Breakdown on a chosen speaker set (the development set when tuning).

python -I diagnose.py <align.json> <system> <split: development|held-out|fda> <frame-dir>...
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir; our own code only

import numpy as np

from lib import OCTAVE_TOLERANCE_CENTS, gross_pitch_error, iter_utts, load_ref, ref_at, split_of

align = json.loads(Path(sys.argv[1]).read_text())
offsets = {c: {s: v["best_offset_ms"] / 1000 for s, v in align[c].items()} for c in align}
for c in offsets:
    for a in ("yin", "mpm"):
        offsets[c][f"{a}_raw"] = offsets[c][f"{a}_contour"]
system, which = sys.argv[2], sys.argv[3]
utts = iter_utts(*sys.argv[4:])

bands = [(0, 80), (80, 100), (100, 130), (130, 170), (170, 220), (220, 300), (300, 1e9)]
agg = defaultdict(lambda: defaultdict(int))
bound = defaultdict(int)  # voicing-decision errors by distance to the nearest reference voicing change


def bump(cat, key, **kw):
    for k, v in kw.items():
        agg[(cat, key)][k] += v


for u in utts.values():
    m = u["meta"]
    sp = split_of(m["corpus"], m["speaker"])
    if (which == "fda") != (m["corpus"] == "fda") or (which != "fda" and sp != which):
        continue
    if system not in u["sys"]:
        continue
    t, f = u["sys"][system]
    ref = load_ref(m["corpus"], m["speaker"], m["id"])
    r = ref_at(m["corpus"], ref, t, offsets[m["corpus"]][system])
    if m["corpus"] == "ptdb":
        keep = (t - offsets["ptdb"][system]) <= (len(ref) - 1) * 0.01
        t, f, r = t[keep], f[keep], r[keep]
    n = len(t)
    rv = r > 0
    # position inside each reference voiced run: frames since run start / until run end
    start = np.zeros(n, int); end = np.zeros(n, int)
    c = 0
    for i in range(n):
        c = c + 1 if rv[i] else 0
        start[i] = c
    c = 0
    for i in range(n - 1, -1, -1):
        c = c + 1 if rv[i] else 0
        end[i] = c
    change = np.where(rv[1:] != rv[:-1])[0] + 0.5
    dist = np.min(np.abs(np.arange(n)[:, None] - change[None, :]), axis=1) if len(change) else np.full(n, 99.0)
    for i in range(n):
        err = (rv[i] and f[i] <= 0) or ((not rv[i]) and f[i] > 0)
        bound["frames"] += 1
        bound["errors"] += int(err)
        if dist[i] <= 3:
            bound["frames_within_3"] += 1
            bound["errors_within_3"] += int(err)
    for i in range(n):
        sex = "F" if m["speaker"].startswith("F") or m["speaker"] == "sb" else "M"
        if rv[i]:
            band = next(f"{lo:.0f}-{hi:.0f}" if hi < 1e8 else f">{lo:.0f}" for lo, hi in bands if lo <= r[i] < hi)
            pos = "onset(1-4)" if start[i] <= 4 else ("offset(last4)" if end[i] <= 4 else "middle")
            miss = f[i] <= 0
            cents = 0 if miss else 1200 * np.log2(f[i] / r[i])
            gross = bool(gross_pitch_error(f[i], r[i]))
            for cat, key in (("ref band Hz", band), ("position in voiced run", pos), ("sex", sex)):
                bump(cat, key, n=1, miss=int(miss), gross=int(gross), both=int(not miss),
                     dbl=int(gross and abs(cents - 1200) <= OCTAVE_TOLERANCE_CENTS), half=int(gross and abs(cents + 1200) <= OCTAVE_TOLERANCE_CENTS))
        else:
            bump("unvoiced ref: est voiced", sex, n=1, fa=int(f[i] > 0))
out = {}
for (cat, key), v in sorted(agg.items()):
    if "n" in v and "fa" not in v:
        out.setdefault(cat, {})[key] = {"ref_voiced_frames": v["n"], "voiced_called_unvoiced_pct": round(100 * v["miss"] / v["n"], 1),
                                       "gross_pct_of_both": round(100 * v["gross"] / max(v["both"], 1), 1),
                                       "halving_frames": v["half"], "doubling_frames": v["dbl"]}
    else:
        out.setdefault(cat, {})[key] = {"frames": v["n"], "false_alarm_pct": round(100 * v["fa"] / v["n"], 1)}
out["voicing decision errors vs reference voicing boundaries"] = {
    "frames": bound["frames"], "errors": bound["errors"],
    "share_of_frames_within_3_frames_of_a_boundary_pct": round(100 * bound["frames_within_3"] / bound["frames"], 1),
    "share_of_errors_within_3_frames_of_a_boundary_pct": round(100 * bound["errors_within_3"] / max(bound["errors"], 1), 1)}
print(json.dumps(out, indent=1))
