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

A native-rate replay with the unchanged pitch methods shows a useful limitation:
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

Clean-checkout results and final captures will be retained beside this replay.
This is a source addition; publication status is verified separately.
