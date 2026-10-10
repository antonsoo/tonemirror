"""Loading frame tables, building references on each system's own frame times, and the metrics."""
import json
from pathlib import Path

import numpy as np

from refs import fda_ref_at, ptdb_ref_at, read_fda_fx, read_ptdb_ref

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
GROSS_RELATIVE_ERROR = 0.2
OCTAVE_TOLERANCE_CENTS = 1200 * np.log2(1.2)
SEX = lambda spk: "F" if spk.startswith("F") or spk == "sb" else "M"  # noqa: E731
DEV = {f"{s}{n:02d}" for s in "FM" for n in (1, 3, 5, 7, 9)}  # odd-numbered PTDB-TUG speakers


def split_of(corpus, spk):
    return "development" if corpus == "ptdb" and spk in DEV else "held-out"


def load_ref(corpus, spk, sid):
    if corpus == "ptdb":
        return read_ptdb_ref(CACHE / "ptdb" / spk / f"ref_{spk}_{sid}.f0")
    return read_fda_fx(CACHE / "fda-extracted" / spk / f"{sid}.fx")


def ref_at(corpus, ref, times, offset):
    return ptdb_ref_at(ref, times, offset) if corpus == "ptdb" else fda_ref_at(ref, times, offset)


def ref_end(corpus, ref):
    """Last time (s, before offset) the reference file covers; frames beyond are not scored."""
    return (len(ref) - 1) * 0.01 if corpus == "ptdb" else float("inf")


def iter_utts(*dirs):
    """Merge per-utterance JSON written by different tools into {key: {system: (t, f0)}}."""
    merged = {}
    for d in dirs:
        for p in sorted(Path(d).glob("*.json")):
            j = json.loads(p.read_text())
            m = merged.setdefault(p.stem, {"meta": {k: j[k] for k in ("corpus", "speaker", "id", "sampleRate")}, "sys": {}})
            for name in ("yin", "mpm"):
                if name in j:
                    t = np.array(j[name]["t"])
                    m["sys"][f"{name}_raw"] = (t, np.array(j[name]["rawF0"]))
                    m["sys"][f"{name}_contour"] = (t, np.array(j[name]["contourF0"]))
            for name in ("pyin", "praat"):
                if name in j:
                    m["sys"][name] = (np.array(j[name]["t"]), np.array(j[name]["contourF0"]))
    return merged


def gross_pitch_error(est, ref):
    """More than 20% of reference Hz, on frames both sides call voiced.

    A symmetric 315.64-cent interval would incorrectly reject 82 Hz against
    100 Hz (18% error). Relative frequency error accepts 80 through 120 Hz.
    """
    return (est > 0) & (ref > 0) & (np.abs(est - ref) > GROSS_RELATIVE_ERROR * ref)


def nearest_frames(times, values, targets):
    """Nearest samples, with no extrapolation outside a tracker's time range."""
    if not len(times):
        return np.zeros_like(targets)
    right = np.clip(np.searchsorted(times, targets), 0, len(times) - 1)
    left = np.maximum(0, right - 1)
    nearest = np.where(np.abs(times[left] - targets) <= np.abs(times[right] - targets), left, right)
    return np.where((targets >= times[0]) & (targets <= times[-1]), values[nearest], 0)


def frame_stats(est, ref):
    """Per-frame arrays -> counts. est, ref: Hz with 0 = unvoiced."""
    rv, ev = ref > 0, est > 0
    both = rv & ev
    cents = np.zeros_like(est)
    cents[both] = 1200 * np.log2(est[both] / ref[both])
    gross = gross_pitch_error(est, ref)
    fine = both & ~gross
    return {
        "frames": len(est), "ref_voiced": int(rv.sum()), "ref_unvoiced": int((~rv).sum()),
        "both_voiced": int(both.sum()), "gross": int(gross.sum()),
        "halving": int((gross & (np.abs(cents + 1200) <= OCTAVE_TOLERANCE_CENTS)).sum()),
        "doubling": int((gross & (np.abs(cents - 1200) <= OCTAVE_TOLERANCE_CENTS)).sum()),
        "miss": int((rv & ~ev).sum()), "false_alarm": int((~rv & ev).sum()),
        "fine_n": int(fine.sum()), "fine_abs_sum": float(np.abs(cents[fine]).sum()),
        "fine_sq_sum": float((cents[fine] ** 2).sum()),
        "fine_abs": np.abs(cents[fine]),
    }


def add(a, b):
    out = {}
    for k in b:
        if k == "fine_abs":
            out[k] = np.concatenate([a.get(k, np.zeros(0)), b[k]])
        else:
            out[k] = a.get(k, 0) + b[k]
    return out


def summarise(s):
    pct = lambda n, d: round(100 * n / d, 2) if d else None  # noqa: E731
    fa = s["fine_abs"]
    return {
        "frames": s["frames"], "ref_voiced_frames": s["ref_voiced"],
        "both_voiced_frames": s["both_voiced"], "gross_error_frames": s["gross"],
        "octave_halving_frames": s["halving"], "octave_doubling_frames": s["doubling"],
        "voiced_called_unvoiced_frames": s["miss"], "unvoiced_called_voiced_frames": s["false_alarm"],
        "gross_error_pct": pct(s["gross"], s["both_voiced"]),
        "octave_halving_pct_of_voiced": pct(s["halving"], s["both_voiced"]),
        "octave_doubling_pct_of_voiced": pct(s["doubling"], s["both_voiced"]),
        "other_gross_pct_of_voiced": pct(s["gross"] - s["halving"] - s["doubling"], s["both_voiced"]),
        "voiced_called_unvoiced_pct": pct(s["miss"], s["ref_voiced"]),
        "unvoiced_called_voiced_pct": pct(s["false_alarm"], s["ref_unvoiced"]),
        "voicing_decision_error_pct": pct(s["miss"] + s["false_alarm"], s["frames"]),
        "fine_mae_cents": round(float(fa.mean()), 1) if len(fa) else None,
        "fine_median_cents": round(float(np.median(fa)), 1) if len(fa) else None,
    }


def score(utts, offsets, systems=None, keep=lambda meta: True):
    """offsets[corpus][system] in seconds. -> {system: {group: stats}} with groups: speaker keys, 'sex:F', 'split:development', 'all'."""
    res = {}
    for u in utts.values():
        meta = u["meta"]
        if not keep(meta):
            continue
        corpus, spk = meta["corpus"], meta["speaker"]
        ref = load_ref(corpus, spk, meta["id"])
        for sysname, (t, f0) in u["sys"].items():
            if systems and sysname not in systems:
                continue
            off = offsets[corpus][sysname]
            r = ref_at(corpus, ref, t, off)
            n = len(t)
            # drop frames past the end of the reference record
            ok = t - off <= ref_end(corpus, ref) + 1e-9
            st = frame_stats(f0[:n][ok], r[ok])
            for g in (f"{corpus}/{spk}", f"{corpus}/sex:{SEX(spk)}", f"{corpus}/{split_of(corpus, spk)}", f"{corpus}/all"):
                res.setdefault(sysname, {})
                res[sysname][g] = add(res[sysname].get(g, {}), st)
    return res
