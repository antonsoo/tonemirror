# Listen to the reference and attempt together

After loading both clips, choose **Play reference then attempt** above the
contour plot. The reference plays first, followed by a 350 ms pause and the
attempt. Each clip uses its selected loop once, or its complete audio when
no loop is selected. This sequence always plays at normal speed. Individual
playback keeps its own half-speed setting and paused position.

**Stop listening**, changing audio tabs, loading or recording a new clip,
editing a loop, changing the analysis algorithm, or starting individual
playback cancels the sequence. That includes a future attempt whose start
has already been scheduled. A failed start leaves both clips available for
retry. The control does not trim, save, resample for analysis, reclassify or
change either recording's credit.

![Recorded rising reference followed by the falling example](../../docs/assets/paired-listening/paired-listening.png)

The illustration compares recorded má and mà from the same attributed
[Wolfdog recording](../recorded-practice/README.md). It demonstrates a rising
versus falling contrast, not a learner performance or a pronunciation grade.
Both recordings are CC BY-SA 4.0; their source, original excerpt coordinates
and credit survive download and reimport. The pitch plot still contains the
original tracker's errors. No pitch detector or score threshold changed.

## Audio clock and cancellation

[`PairedPlayer`](../../src/audio/pairedPlayback.ts) copies each selected passage
into a native buffer and schedules both source nodes against one audio clock.
The second start is the first start plus the reference duration plus 350 ms.
No JavaScript timer or `onended` callback launches the attempt. UI rendering
can lag without shifting the already scheduled audio gap. Native Web Audio
handles any sample-rate conversion needed for the output device.

Normalized loop markers are rounded to whole samples. Bounds entered in
seconds have already been floored/ceiled by the region control. Neither
source PCM nor the stored loop markers change. Stopping detaches completion
callbacks, stops both nodes and disconnects them. Pending context activation
is cancellable and cannot later start an obsolete pair.

## Native rendering evidence

[`native.mjs`](native.mjs) bundles the actual production scheduler and its
validation dependency, then runs real browser audio contexts. Synthetic
positive and negative ramps distinguish the reference from the attempt.
Independent expected sample arrays specify the passages, silence and stop
boundaries; they do not use the scheduler's returned cursor to choose them.

[Retained native results](results/native.json):

| Browser | Exact digital renders | Live cancellation controls | Unavailable offline controls |
|---|---:|---:|---:|
| Chromium | 40 | 4 | 0 |
| Firefox | 16 | 4 | 24 |

The 56 renders cover 8, 44.1, 48 and 96 kHz, full clips and selected passages.
All match their independently constructed sample arrays within 1e-7, with
zero mismatches; source arrays remain unchanged. Natural completion fires
once. Explicit stops do not report natural completion.

Chromium also supports suspending the offline render during the reference,
gap and attempt, so exact stop boundaries can be checked in its digital
output. This Firefox version lacks `OfflineAudioContext.suspend`; those 24
controls remain unavailable, rather than being counted as passing. Both
browsers' live audio clocks separately exercise all four cancellation points.
After a 64 ms observation allowance, the analyser reports exact digital silence
through the time when the future attempt would have ended. Future attempts
are stopped before their scheduled start. These are native digital checks,
not a microphone, acoustic-device or human-listening assessment.

## Production workflow

[`browser.mjs`](browser.mjs) loads the production build in Chromium and
Firefox at 1440 pixels in dark mode and 375 pixels in light mode, then
disconnects before the first input. It loads the recorded falling tone,
exports it, replaces the reference with the recorded rising tone, and loads
the credited falling WAV as the attempt. Both complete and separately selected
passages play once. Scheduled buffers exactly match the corresponding loaded
PCM or selection. The second node's start preserves the 350 ms gap.

[Browser results](results/browser.json) retain startup asset hashes, native
buffer comparisons, cancellation times and 12 WAV download hashes. Each
attempt's WAV is byte-identical before and after listening. No extra analysis
or slow-preview jobs run. All four screenshots and the comparison-panel
capture were inspected. No page errors, CSP violations, requests after
disconnection, external requests, horizontal page overflow or axe violations
were observed in these contexts. These are four presentations of the same
two source excerpts, not additional speakers or independent audio samples.

The ten focused [browser scenarios](../../tests/browser/paired-listening.spec.js)
also exercise cancellation during pending context activation, takeover from
a held slow-preview worker, manual-playback takeover, source replacement,
a failed second native start and retry. The initial study driver tried to
click Stop specifically inside the short gap; one click arrived after the
attempt had started. The retained future-cancellation replay stops during
the reference; native clock controls cover the gap separately.

## Reproduce

```sh
npm ci
npm run build
npx playwright test tests/browser/paired-listening.spec.js
node studies/paired-listening/native.mjs . /tmp/paired-native.json
node studies/paired-listening/browser.mjs dist /tmp/paired-browser
```

The native harness uses the esbuild version pinned transitively in the
application lockfile to bundle the source; production gains no dependency.
The private application version remains 0.2.3. Build, public-source and hosted
verification receipts are recorded separately when those checks complete.
