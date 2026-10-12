"""Create the repeated-speech stress WAV, without redistributing source audio.

python3 studies/pitch-correlation/fixtures.py OUTPUT.wav
Run studies/real-voice/fetch.py first. Repetition is not natural long speech.
"""
import hashlib
import sys
import wave
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "real-voice/cache/ptdb/F01/mic_F01_sa1.wav"
assert hashlib.sha256(source.read_bytes()).hexdigest() == "4d06714d605aafdd4f5923170b182b25879c42fe9f5275e7c076134f4f490fc1"
with wave.open(str(source), "rb") as stream:
    params = stream.getparams()
    pcm = stream.readframes(params.nframes)
assert params.nchannels == 1 and params.sampwidth == 2 and params.framerate == 48000
length = params.framerate * 60 * 2
with wave.open(sys.argv[1], "wb") as stream:
    stream.setparams(params)
    stream.writeframes((pcm * ((length + len(pcm) - 1) // len(pcm)))[:length])
assert hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest() == "2b8048990449550557c1b941de1ca00f8513aa6cc2761fc6e97eb20ea4a2274f"
