"""Readers for the two reference formats, giving reference F0 on an arbitrary time grid."""
import re
from pathlib import Path

import numpy as np

PTDB_HOP = 0.01  # Snack/RAPT frame step, PTDB-TUG report section 7.2


def read_ptdb_ref(path: Path) -> np.ndarray:
    """Four columns per 10 ms record: f0 (0 = unvoiced), voicing, rms, peak normalised xcorr."""
    rows = [l.split() for l in path.read_text().splitlines() if l.strip()]
    return np.array([float(r[0]) for r in rows])


def ptdb_ref_at(f0: np.ndarray, times: np.ndarray, offset: float) -> np.ndarray:
    """Reference F0 at `times`. Record i is taken to describe time i*PTDB_HOP + offset (offset is
    estimated by align.py). Linear interpolation between neighbouring records; a time is voiced only
    when both neighbouring records are voiced, so voicing edges are not smeared. 0 = unvoiced or
    outside the file."""
    pos = (times - offset) / PTDB_HOP
    i0 = np.floor(pos).astype(int)
    w = pos - i0
    out = np.zeros_like(times)
    ok = (i0 >= 0) & (i0 + 1 < len(f0))
    a = np.zeros_like(times)
    b = np.zeros_like(times)
    a[ok] = f0[i0[ok]]
    b[ok] = f0[i0[ok] + 1]
    both = ok & (a > 0) & (b > 0)
    out[both] = a[both] * (1 - w[both]) + b[both] * w[both]
    return out


def read_fda_fx(path: Path) -> list[tuple[np.ndarray, np.ndarray]]:
    """XMG contour: ASCII header up to ^L, then 'ms Hz' pairs; a line '=' breaks the contour.
    Returns voiced segments as (times in s, f0 in Hz)."""
    text = path.read_bytes().decode("latin-1")
    body = text.split("\x0c", 1)[1]
    segs, cur = [], []
    for line in body.splitlines():
        line = line.strip()
        if not line:
            continue
        if line == "=":
            if cur:
                segs.append(cur)
            cur = []
            continue
        m = re.match(r"^([\d.]+)\s+([\d.]+)$", line)
        if m:
            cur.append((float(m.group(1)) / 1000.0, float(m.group(2))))
    if cur:
        segs.append(cur)
    return [(np.array([p[0] for p in s]), np.array([p[1] for p in s])) for s in segs if len(s) >= 2]


def fda_ref_at(segs: list[tuple[np.ndarray, np.ndarray]], times: np.ndarray, offset: float) -> np.ndarray:
    """Linear interpolation inside each voiced segment; 0 outside. The contour is shifted by `offset`."""
    out = np.zeros_like(times)
    for t, f in segs:
        m = (times >= t[0] + offset) & (times <= t[-1] + offset)
        out[m] = np.interp(times[m] - offset, t, f)
    return out
