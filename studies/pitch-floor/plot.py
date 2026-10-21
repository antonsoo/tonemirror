# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.5.3", "matplotlib==3.10.8"]
# ///
"""Plot one explicitly selected low-pitch example, including remaining errors."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "real-voice"))
from refs import read_ptdb_ref

parser = argparse.ArgumentParser()
parser.add_argument("frames", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
summary = json.loads((HERE / "results/summary.json").read_text())
row = json.loads((args.frames / "ptdb_M09_si2071.json").read_text())
ref_path = HERE.parent / "real-voice/cache/ptdb/M09/ref_M09_si2071.f0"
ref = read_ptdb_ref(ref_path)
times = np.arange(len(ref)) * .01
fig, axes = plt.subplots(2, 1, figsize=(10, 6.6), sharex=True, sharey=True, layout="constrained")
for axis, algorithm in zip(axes, ("yin", "mpm"), strict=True):
    selected = (times >= 3) & (times <= 3.9)
    axis.plot(times[selected], np.where(ref[selected] > 0, ref[selected], np.nan), color="#24282e", linewidth=2.5, label="Supplied laryngeal reference")
    for floor, color, marker in ((60, "#ad4d2a", "o"), (40, "#126c83", ".")):
        setting = next(s for s in row["settings"] if s["algorithm"] == algorithm and s["minFrequency"] == floor)
        points = np.array(setting["points"])
        # Plot against reference time using the recorded corpus fit. This does
        # not independently establish the clock or measure browser latency.
        x = points[:, 0] - summary["calibration"]["ptdb"][f"{algorithm}-{floor}"]["offsetMs"] / 1000
        y = np.where(points[:, 1] > 0, points[:, 1], np.nan)
        selected = (x >= 3) & (x <= 3.9)
        axis.plot(x[selected], y[selected], color=color, marker=marker, markersize=3, linewidth=1, alpha=.85, label=f"{floor} Hz search floor")
    axis.set_title(algorithm.upper(), loc="left", fontsize=11, fontweight="bold")
    axis.set_ylabel("Fundamental frequency (Hz)")
    axis.set_yscale("log"); axis.set_ylim(40, 1000); axis.set_xlim(3, 3.9)
    axis.set_yticks([40, 60, 100, 200, 400, 800], ["40", "60", "100", "200", "400", "800"])
    axis.grid(alpha=.2); axis.axhline(60, color="#7c7c7c", linestyle=":", linewidth=.8)
    axis.spines[["top", "right"]].set_visible(False)
axes[0].legend(loc="upper left", fontsize=8, framealpha=.95)
axes[-1].set_xlabel("Time in the supplied reference (seconds); each curve uses its fitted corpus offset")
fig.suptitle("A lower search floor recovers part of a low-pitched passage\nPTDB-TUG M09 / si2071; remaining pitch errors are shown", fontsize=13)
args.output.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(args.output, dpi=150, metadata={"Software": "Matplotlib", "Description": "Selected native-rate example; unvoiced estimates are gaps. PTDB-TUG source under ODbL/DbCL 1.0; see study README."})
print(json.dumps({"matplotlib": matplotlib.__version__, "figureSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "referenceSha256": hashlib.sha256(ref_path.read_bytes()).hexdigest()}))
