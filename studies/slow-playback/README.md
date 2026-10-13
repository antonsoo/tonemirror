# Half-speed without an octave drop

The previous player set `AudioBufferSourceNode.playbackRate` to 0.5. On a
pitch-practice tool this changes the reference voice's pitch while slowing it:
a 440 Hz source becomes 220 Hz. The new player prepares a twice-length preview
with Signalsmith Stretch, then plays it at native rate. Normal audio, analysis,
stored references and downloaded WAVs retain the original samples.

## Rendered audio

`native.mjs` bundles the checkout's actual `ClipPlayer` and renders its output
through Chromium and Firefox `OfflineAudioContext`. The before checkout is
`96f6b5f118f8270129556853ef6a20103090109a`. Frequency is measured from interpolated
zero crossings, independently of ToneMirror's pitch tracker.

| Input | Previous half-speed | Prepared half-speed |
| --- | --- | --- |
| 440 Hz, one second | 220 Hz, two seconds | 440.00011 Hz, two seconds |
| Linear 220-440 Hz glide, two seconds | Pitch lowered with speed | Probed frequencies within 20 cents of the source-time expectation |
| Three 440 Hz bursts at 0.25, 1, 1.75 seconds | Bursts slow and lower | Energy centroids within 0.34 ms of 0.5, 2, 3.5 seconds |

Both engines meet these checks. These finite synthetic probes do not prove
exact timing on arbitrary speech or preserve transient shapes.
[Before](native-before.json), [after](native-after.json) and the original
[440 Hz reproduction](baseline.json) retain unrounded measurements.

## Recorded speech and edge cases

`render.ts` verifies SHA-256 and size against the existing real-voice manifest
for **all 480 PTDB-TUG microphone recordings**, covering 20 speakers and 24
sentences each. It writes stretched PCM only to a scratch directory. No source
or derived corpus audio is redistributed. The source database is credited and
its ODbL/DbCL terms recorded in the [real-voice study](../real-voice/README.md).

`score.py` uses Praat autocorrelation through parselmouth 0.4.7, with a 60-1000 Hz
range and a 10 ms hop. For each source frame it selects the nearest output
frame at twice the source time. There is no fitted time offset or pitch tuning.
The reference here is Praat's estimate on the original audio, **not** the
corpus laryngograph labels. Tracker errors can appear in either signal.

| Measurement | Result | Denominator |
| --- | ---: | --- |
| Median absolute pitch difference | 7.37 cents | 79,520 jointly voiced frames |
| 95th percentile absolute difference | 73.02 cents | Same jointly voiced frames |
| Difference greater than 100 cents | 2,568 (3.23%) | Same jointly voiced frames |
| Difference greater than 600 cents | 1,126 | Same jointly voiced frames |
| Median signed difference | +3.69 cents | Same jointly voiced frames |
| Voicing disagreements | 8,646 (2.48%) | All 348,140 compared frames |

This is a pitch-preservation check, not a listening study, an independent
ground-truth F0 accuracy estimate or a pronunciation score. Speech can sound
different: transients soften, amplitudes change, and short boundaries can
have artifacts. The app's analysis remains on the original PCM.
[results.json](results.json) includes every recording and both voicing counts.

Additional deterministic probes cover 80, 220, 440 and 880 Hz at six rates
from 8 to 96 kHz: maximum absolute measured pitch change is 0.012 cents.
Twenty-one clips from 1 to 200 ms at three sample rates retain nonzero energy
and exactly twice their original frame count. Their RMS ratios vary; these
very short signals are not evidence of audible quality. Silence, odd final
processing blocks, concurrent independent jobs and invalid samples have
focused regression checks.

One sequential pass on a Ryzen 7 7800X3D / WSL2 machine (14 visible logical
CPUs, 47.05 GiB visible RAM, Node 26.7.0) prepared a 60-second sine in 170 ms
at 8 kHz, 1,050 ms at 48 kHz and 2,400 ms at 96 kHz. Each returned finite
PCM with exactly twice the source frame count. These are local observations,
not device-independent latency promises. The two-times preview consumes
additional memory; the disposable worker releases its WASM heap on completion
or cancellation.

## Integration and provenance

The pinned MIT engine and its upstream adapter/license receipts are described
in [src/vendor](../../src/vendor/README.md) and [upstream.json](upstream.json).
Its embedded WASM is unchanged. The distributed binary was fetched and hashed,
not rebuilt locally from C++. Its wrapper's trailing CommonJS/AMD registration
is replaced with an ES module export. Vite bundles it into the initial page
load so first use works without a network connection. CSP permits WASM
compilation (`wasm-unsafe-eval`); JavaScript eval remains disallowed.

Preparation runs in one disposable worker per request, with a 60-second
deadline. Cancelling, replacing the clip, switching audio tabs or leaving the
page terminates pending work. Worker crashes and unreadable results produce a
visible error and permit retry. Prepared audio is cached only in the current
player; no extra IndexedDB records are written.

The native rate remains 1 in both modes. Logical source time advances at 0.5
for a slow preview; offsets and loop points are doubled in that buffer. For
example, the original 3-4 second region loops over preview seconds 6-8. The
existing loop-entry behavior is retained. Browser regression checks also
compare downloaded WAV data bytes to the original decoded PCM.

`browser.mjs` serves the built app, verifies every fetched asset against disk,
loads its fonts, then shuts down the server and disables network access before
importing real speech or preparing a preview. It checks keyboard controls,
cached pause/resume, loop mapping, axe and overflow in Chromium and Firefox
at 1440px dark and 375px light. At desktop it also cancels a real 60-second
preparation and successfully retries it. In the clean build, cancellation's
control round trip took 45-49 ms; retry preparation took 1.01-1.13 seconds.
The eight-second speech preview took 161-194 ms across the four runs. These
single observations include worker startup and are not mobile-device benchmarks.

[browser-after.json](browser-after.json) retains all four workflows and served
asset hashes. There were no observed page errors, external requests, requests
after disconnection, CSP violations, horizontal overflow or axe violations.
All four screenshots were inspected:

| Browser | Desktop dark | Phone light |
| --- | --- | --- |
| Chromium 153.0.8010.12 | [1440px](../../docs/assets/slow-playback-chromium-1440.png) | [375px](../../docs/assets/slow-playback-chromium-375.png) |
| Firefox 155.0 | [1440px](../../docs/assets/slow-playback-firefox-1440.png) | [375px](../../docs/assets/slow-playback-firefox-375.png) |

## Clean source verification

[verification.json](verification.json) records a fresh 264-file archive of
implementation `bf893b3eb0f610a20d5c3fa3ed0826e23b363e95`. With Node 24.21.0 and
npm 12.0.1, a locked install, lint, type checking, all 211 unit checks, build,
the accuracy report and all 86 browser checks passed. Four Firefox microphone
cases are explicitly skipped because the deterministic microphone is supplied
only by Chromium. The 16 new playback cases run in both engines.

All archived source files remained byte-identical after the checks. All 30
built files match the workspace build; the browser study checks the eight
assets it actually fetched in each run. The JS bundle is 157.81 kB (66.37 kB
gzip), up from 58.86 kB. The final evidence commit changes documentation and
receipts only. No package release or hosted deployment is part of this work.

The receipt also records corrected study/integration assumptions: ESM versus
CommonJS registration, browser decoding at the context sample rate, and an
initial shell invocation that never reached installation. Retained results
come from the completed checks, not those failed attempts.

## Replay

From the repository root, with its locked Node dependencies installed:

```sh
study_out=/tmp/tonemirror-slow-playback
mkdir -p "$study_out/before"
git archive 96f6b5f118f8270129556853ef6a20103090109a | tar -x -C "$study_out/before"
node studies/slow-playback/native.mjs "$study_out/before" "$study_out/native-before.json" before
node studies/slow-playback/native.mjs . "$study_out/native-after.json" after
python3 -I studies/real-voice/fetch.py --offline
npx tsx studies/slow-playback/render.ts "$study_out/render"
uv venv --python 3.12 "$study_out/venv"
uv pip install --python "$study_out/venv/bin/python" numpy==2.3.3 praat-parselmouth==0.4.7 soundfile==0.13.1
"$study_out/venv/bin/python" -I studies/slow-playback/score.py "$study_out/render" "$study_out/results.json"
npm run build
node studies/slow-playback/browser.mjs dist studies/real-voice/cache "$study_out/browser"
```

For the corpus cache setup see the real-voice study; offline verification
requires those recordings already present. Browser binaries must be installed
for the project's Playwright version. Unit/browser checks run separately with
`npm test` and `npm run test:browser`.
