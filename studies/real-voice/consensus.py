"""For frames where a tracker is >20% off the reference: how often do both independent trackers (pYIN, Praat)
agree with each other (within 50 cents) and with the tracker under test rather than with the reference?
That would point to a reference error (RAPT on the laryngograph), not a tracker error.

python -I consensus.py <align.json> <system> <frame-dir>...
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir; our own code only

import numpy as np

from lib import GROSS_CENTS, iter_utts, load_ref, ref_at

align = json.loads(Path(sys.argv[1]).read_text())
off = {c: {s: v["best_offset_ms"] / 1000 for s, v in align[c].items()} for c in align}
system = sys.argv[2]
utts = iter_utts(*sys.argv[3:])
tot = defaultdict(lambda: [0, 0, 0])
for u in utts.values():
    m = u["meta"]
    if system not in u["sys"] or "pyin" not in u["sys"] or "praat" not in u["sys"]:
        continue
    ref = load_ref(m["corpus"], m["speaker"], m["id"])
    def on_grid(name):
        t, f = u["sys"][name]
        return t, f, ref_at(m["corpus"], ref, t, off[m["corpus"]][name])
    t, f, r = on_grid(system)
    # other trackers sampled on the system's frame times by nearest frame
    others = []
    for name in ("pyin", "praat"):
        t2, f2 = u["sys"][name]
        idx = np.clip(np.searchsorted(t2, t), 0, len(t2) - 1)
        others.append(f2[idx])
    ok = (r > 0) & (f > 0)
    if m["corpus"] == "ptdb":
        ok &= (t - off["ptdb"][system]) <= (len(ref) - 1) * 0.01
    c = np.where(ok, 1200 * np.log2(np.where(ok, f, 1) / np.where(ok, r, 1)), 0)
    gross = ok & (np.abs(c) > GROSS_CENTS)
    a, b = others
    both = (a > 0) & (b > 0) & (np.abs(1200 * np.log2(np.where(a > 0, a, 1) / np.where(b > 0, b, 1))) < 50)
    side = both & (np.abs(1200 * np.log2(np.where(both, a, 1) / np.where(gross, f, 1))) < 100)
    key = m["speaker"] if m["corpus"] == "ptdb" else m["corpus"] + "/" + m["speaker"]
    tot[key][0] += int(gross.sum()); tot[key][1] += int((gross & side).sum()); tot[key][2] += int(ok.sum())
out = {k: {"gross_frames": v[0], "pyin_and_praat_agree_with_tracker": v[1], "both_voiced_frames": v[2]} for k, v in sorted(tot.items())}
a = sum(v[0] for v in tot.values()); b = sum(v[1] for v in tot.values())
out["_all"] = {"gross_frames": a, "pyin_and_praat_agree_with_tracker": b, "share": round(b / a, 3)}
print(json.dumps(out, indent=1))
