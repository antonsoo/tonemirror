"""pYIN (librosa) and Praat's autocorrelation method (parselmouth) on the cached recordings,
at the app's search range (60-1000 Hz) and the same 10 ms hop. Writes the same JSON layout as
run-tonemirror.ts (keys "pyin" and "praat": t, contourF0 with 0 = unvoiced).

Run from the scratch venv under `env -i`:
  python -I baselines.py <out-dir> <shard> <n-shards>
"""
import json
import sys
from pathlib import Path

import numpy as np
import librosa
import parselmouth
import soundfile as sf

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
FMIN, FMAX, HOP_S = 60.0, 1000.0, 0.01


def items():
    for spk in sorted(d.name for d in (CACHE / "ptdb").iterdir() if len(d.name) == 3):
        for f in sorted((CACHE / "ptdb" / spk).glob("*.wav")):
            yield "ptdb", spk, f.stem.split("_", 2)[2], f
    for spk in ("rl", "sb"):
        for f in sorted((CACHE / "fda-extracted" / spk).glob("*.sig")):
            yield "fda", spk, f.stem, f


def load(corpus, path):
    if corpus == "ptdb":
        x, sr = sf.read(path, dtype="float32")
        return x, sr
    raw = np.fromfile(path, dtype=">i2").astype(np.float32) / 32768.0
    return raw, 20000


def main():
    out_dir, shard, n = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    for k, (corpus, spk, sid, path) in enumerate(items()):
        if k % n != shard:
            continue
        x, sr = load(corpus, path)
        hop = round(HOP_S * sr)
        frame_length = 2 * (int(sr // FMIN) + 1)  # about twice the longest lag, as the app does
        f0, _voiced, _p = librosa.pyin(x, fmin=FMIN, fmax=FMAX, sr=sr, frame_length=frame_length, hop_length=hop)
        t = librosa.times_like(f0, sr=sr, hop_length=hop)
        res = {"corpus": corpus, "speaker": spk, "id": sid, "sampleRate": sr,
               "pyin": {"t": t.tolist(), "contourF0": np.nan_to_num(f0, nan=0.0).round(3).tolist()}}
        snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=sr)
        pitch = snd.to_pitch_ac(time_step=HOP_S, pitch_floor=FMIN, pitch_ceiling=FMAX)
        res["praat"] = {"t": pitch.xs().tolist(),
                        "contourF0": np.round(pitch.selected_array["frequency"], 3).tolist()}
        (out_dir / f"{corpus}_{spk}_{sid}.json").write_text(json.dumps(res))


if __name__ == "__main__":
    main()
