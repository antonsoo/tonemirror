"""Generate native WAV channel controls from the credited, vendored recording.

These are derived controls, not naturally captured stereo conversations.
No pitch synthesis or pitch/time modification is used.
"""

import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
CACHE = HERE / "cache"
CACHE.mkdir(exist_ok=True)
source = ROOT / "src/references/FourMandarinTones.ogg"
credit = json.loads((ROOT / "studies/recorded-practice/source.json").read_text())[
    "recording"
]
assert hashlib.sha256(source.read_bytes()).hexdigest() == credit["sha256"]
ffmpeg = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
controls = []


def make(name, input_name, filters, description, complex_filter=False):
    path = CACHE / name
    input_path = source if input_name is None else CACHE / input_name
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(input_path)]
    args += ["-filter_complex" if complex_filter else "-af", filters]
    if complex_filter:
        args += ["-map", "[out]"]
    args += ["-c:a", "pcm_f32le", "-y", str(path)]
    subprocess.run(args, check=True)
    probe = json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=sample_rate,channels,duration",
                "-of",
                "json",
                str(path),
            ],
            text=True,
        )
    )["streams"][0]
    controls.append(
        {
            "file": name,
            "description": description,
            "input": source.name if input_name is None else input_name,
            "filter": filters,
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            **probe,
        }
    )


make(
    "mono.wav",
    None,
    "pan=mono|c0=0.5*c0+0.5*c1",
    "Original recording averaged to one channel",
)
make(
    "opposite-phase.wav",
    "mono.wav",
    "pan=stereo|c0=c0|c1=-1*c0",
    "Same recorded voice on both channels with opposite polarity",
)
make(
    "separate-tones.wav",
    "mono.wav",
    "[0:a]asplit[a][b];[a]atrim=start=0.4:end=1.25,asetpts=PTS-STARTPTS,apad=whole_dur=1[left];"
    "[b]atrim=start=4.35:end=5.3,asetpts=PTS-STARTPTS,apad=whole_dur=1[right];"
    "[left][right]amerge=inputs=2[out]",
    "Recorded tone 1 on channel 1 and recorded tone 4 on channel 2, padded to one second",
    True,
)
make(
    "left.wav",
    "separate-tones.wav",
    "pan=mono|c0=c0",
    "Independent FFmpeg channel 1 split",
)
make(
    "right.wav",
    "separate-tones.wav",
    "pan=mono|c0=c1",
    "Independent FFmpeg channel 2 split",
)
manifest = {
    "source": credit,
    "producer": ffmpeg,
    "derivedControls": True,
    "changes": "Channel averaging, polarity inversion, excerpting, padding and channel routing only; no generated voice or pitch shifting.",
    "derivativeLicense": "CC BY-SA 4.0",
    "controls": controls,
}
(HERE / "source.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(
    json.dumps(
        {
            "controls": len(controls),
            "producer": ffmpeg,
            "sourceSha256": credit["sha256"],
        }
    )
)
