# Native file-channel verification, 2026-10-19

Implementation `9c7d90bd83aaa7bc23c38d45ced891915ff4a34b` adds explicit
channel selection and refuses a mix that nearly cancels its input. The
[recorded-source study](../studies/file-channels/README.md) retains the
native decoder reproduction, producer commands, hashes and inspected images.
The same valid opposite-polarity stereo file gives zero voiced frames before
and 227 on either selected channel after, in Chromium and Firefox.

A clean `git archive` of that commit, with no copied dependencies or compiled
files, was installed with Node 24.21.0 and npm 11.19.0:

| Check | Observed result |
| --- | --- |
| `npm ci` | 140 packages installed; zero reported audit vulnerabilities |
| Lint, strict types and production build | Passed |
| Unit suite, default and German locale | 231 tests in 23 files each |
| Existing source-integrity controls | 7 passed |
| Production Chromium/Firefox suite | 112 passed; 4 Firefox simulated-microphone cases skipped |
| Built files versus working Node 26 build | All 30 byte-identical |
| Fresh native recorded-channel study on the clean build | All 4 workflows passed; JSON results identical |

Commands:

```sh
npm ci
npm run lint
npm run typecheck
npm test
LC_ALL=de_DE.UTF-8 LANG=de_DE.UTF-8 npm test
python3 -I studies/real-voice/test_sources.py
npm run test:browser
python3 studies/file-channels/prepare.py
npm run preview -- --host 127.0.0.1 --port 4259 --strictPort
```

The dedicated study was then run against that preview. It checks actual
native-decoded PCM, voicing, independently split FFmpeg channels, sixteen
WAV downloads, playback buffers and saved-reference reloads. Each fresh page
disconnects before importing. Channel selection and destination are also
changed during a held real decode in the regular suite; the original
request choices prevail. The loaded clip survives cancellation and
unavailable-channel errors.

The [verification receipt](../studies/file-channels/verification.json) retains
all thirty build hashes. Desktop dark and 375-pixel light screenshots were
opened and inspected. The expanded section wraps without document overflow;
its controls use the existing visual system. All four dedicated accessibility
scans report no violations. Phone width is not a phone CPU measurement.

The selection concerns decoded file channels, not speaker separation. The
recorded controls route one speaker's voice, rather than establishing
multi-speaker performance or pronunciation accuracy. Native decoder memory
and codec support keep their existing limits. Actual microphone hardware
was not evaluated. This is a private static application; no registry package
or release tag was created.

Build command: `npm run build`. Deployable directory: `dist/`, base `/tonemirror/`.
Hosted bytes and workflows require separate publication evidence.

## Public app

Source was pushed and the clean build appended to `gh-pages` as `336834b`,
with parent `720f7fd`. All 31 previous asset files remain byte-identical.
The [canonical HTTP receipt](../studies/file-channels/hosted-bytes.json)
checks both entry URLs and all 30 current files against the clean build.
Four fresh Chromium/Firefox desktop/phone workflows then ran against the
public site, disconnecting before imports. Their full numeric results match
the working and clean local reports, including sixteen sample-exact WAV
exports, native playback buffers and saved-reference reloads.
[Public workflow receipt](../studies/file-channels/hosted-browser.json),
[publication boundaries](../studies/file-channels/publication.json).
No registry release or tag was created.
