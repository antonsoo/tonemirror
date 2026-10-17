# Recorded Mandarin practice

Choose a recorded mā, má, mǎ or mà near the audio inputs, then **Play reference**.
Switch to **Your attempt** and record the same syllable. This gives the workbench
an immediate recorded example; the generated tone and accent patterns remain
available separately and are still labeled synthetic.

## Recording and selection

The original is [*FourMandarinTones.ogg* by Wolfdog, 26 October 2019](https://commons.wikimedia.org/w/index.php?title=File:FourMandarinTones.ogg&oldid=1277043205),
licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The repository bundles the original 77,622 bytes unchanged. The description
identifies the syllable *ma* in four Mandarin tones; it does not establish the
speaker's native language. No endorsement by the creator is implied.
[Source revision, original URL and hashes](source.json) pin the input.

| Button | Selected source interval |
| --- | --- |
| mā, tone 1 | 0.400-1.250 s |
| má, tone 2 | 1.700-2.650 s |
| mǎ, tone 3 | 3.050-4.050 s |
| mà, tone 4 | 4.500-5.250 s |
| All four | Complete original recording |

These manually selected bounds fall in the quiet gaps around the syllables.
They are not phonetic boundary annotations. The browser decodes and averages
the two channels to mono at its own sample rate. A crop starts at the floored
sample and ends at the ceiled sample, retaining the available edge samples.
The recording and its decoded/cropped adaptations remain CC BY-SA 4.0;
ToneMirror's code remains MIT. [Distributed audio notice](../../public/audio-licenses.txt).

The recording bytes are embedded in the startup JavaScript. Choosing a tone
after loading the page requires no later audio download, including the first
selection after disconnecting. Loading or reloading the page itself still
needs access to the application or a browser cache.

## Credits that survive practice

The active clip shows its creator, source and license. Saved references retain
this information without changing the existing database version or loading
audio during library browsing. **Keep region** composes its new bounds with
the previously selected source interval; **Restore full clip** restores the
source still available in memory. Saving a crop stores that crop's audio,
not the complete original recording.

WAV exports preserve the decoded mono float samples. Standard RIFF INFO
`IART` holds the creator and `ICOP` holds a versioned credit with the title,
creator, source URL, license name/URL and optional source excerpt. `ICMT`
continues to identify decoded or synthetic audio. Renaming the WAV does not
remove the credit when it is reopened in ToneMirror. Recognized but damaged
or conflicting ToneMirror credits cause a visible import failure; the prior
loaded clip remains available.

Imported credits are file-supplied metadata, not authenticated provenance.
This reader recognizes ToneMirror's credit format, not every codec's tags or
every editor's copyright fields. Other editors can strip metadata. Keep the
source and license with any copies shared outside the application.

## What the contours establish

The tone labels come from the recording's description. They are not a new
pitch-tracker benchmark or a learner study. One isolated speaker's productions
do not cover regional variation, coarticulation, tone sandhi or ordinary speech.
The four-tone sequence contains four syllables and should not be passed to the
single-syllable tone helper as one example.

A [native-rate replay](results/contours.json) with the unchanged pitch methods shows a useful limitation:
the helper calls the recording's first tone **tone 2**, with heuristic strengths
about 0.38 for YIN and 0.42 for MPM. Both call the next three examples 2, 3 and 4.
These values are not calibrated probabilities. The first-tone contour has a
small rise; the falling and dipping examples include irregular pitch and
possible octave errors. No thresholds were adjusted to make this recording's
labels pass. Inspect and listen to the audio rather than using the helper as
a pronunciation judge.

## Browser replay

From a built checkout:

```sh
npm ci
npm run build
node studies/recorded-practice/browser.mjs dist /tmp/recorded-practice
```

The replay uses actual Chromium and Firefox decoders, workers, local storage,
playback and downloaded WAV files at 1440px and 375px. It independently decodes
the original Ogg file and compares every selected sample against the samples
analyzed by the app. It also checks saved-credit reload, successive trims,
algorithm changes, full restoration, and WAV reimport under a different name.
Network access is disabled after startup and during these operations; page
reload is tested separately with the application reachable again.

The visual contrast uses the recorded rising tone as reference and the recorded
falling tone as the attempt. It is a comparison of two source examples, not a
learner recording or evidence that a similarity score measures pronunciation.

A [fresh archive of `b370f5d`](results/clean-checks.json), installed with `npm ci`
under Node 24.21.0, passed lint, strict type checking, 223 unit tests, the
production build, and 96 browser scenarios. Four Firefox microphone scenarios
remain skipped because the deterministic test device is Chromium-specific.
The source-integrity helper's fixture checks passed too; it does not download
or verify the complete speech corpus in this fresh archive.

The [recorded-practice browser receipt](results/browser.json) retains all four
desktop/phone contexts and 48 exact-sample WAV downloads. Independent decoding
of all 48 files with FFmpeg produced [the same sample hashes](results/independent-decoding.json).
[One actual credited excerpt](results/credited-excerpt.wav) is retained under
the recording's CC BY-SA 4.0 license. Every selected crop also matched a
separate browser-native decode of the original Ogg file. No HTTP requests
occurred while disconnected, and there were no page errors, CSP violations,
axe violations or horizontal overflow in these four contexts.

All 30 production files matched the working build byte for byte. All 14
`src/core/*.ts` DSP/analysis files matched the previous public source; this
addition changes the available references and their credit handling, not pitch
tracking or scoring. The [desktop capture](../../docs/assets/recorded-practice/recorded-practice.png),
[Chromium phone](../../docs/assets/recorded-practice/chromium-375.png),
[Firefox desktop](../../docs/assets/recorded-practice/firefox-1440.png) and
[Firefox phone](../../docs/assets/recorded-practice/firefox-375.png) were visually
inspected.

## Publication

The source and [live demo](https://antonsoo.github.io/tonemirror/) include this
addition. Pages commit `3174c9c` deploys the clean build above. The
[public source check](results/public-source.json) verifies 16 pinned source,
recording and evidence files at `1e06b63`, with a clean checkout matching
`origin/main`. The
[canonical HTTP check](results/hosted-bytes.json) matched all 30 production
files, including the root page before and after the pass and explicit
`index.html`. The [hosted browser replay](results/hosted-browser.json) repeated
the four contexts and 48 exact WAV exports. Its five screenshots
[byte-match the inspected local captures](results/hosted-screenshots.json).

The browser verifier checks response bodies during startup, before changing
pages. The first hosted attempt exposed a verifier race while reading a body
after navigation; that incomplete attempt is not counted as a successful
capture. Reload and subsequent library use are exercised separately from
startup-byte verification. No runtime change was needed for that race.

The application remains npm-private at version 0.2.3. No registry release,
release tag or remote CI result is implied by source or Pages publication.
