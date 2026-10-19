# Keep missing pitch observations out of the drawing

At baseline `fe8c07d`, comparing the full bundled four-tone recording with itself
drew the aligned attempt as one connected pitch stroke. The native detector
supplied no voiced frames through several pauses, including intervals of
0.66, 0.70 and 0.71 seconds. The reference already broke at the longer gaps;
the attempt visibly crossed them. Short unvoiced intervals could also be
bridged by the raw drawing's former three-hop threshold.

The corrected source retains discontinuities through extraction of voiced DTW
samples, the core API's optional thinning, alignment aggregation and the canvas
renderer. A gap in either clip ends the stroke. Separate voiced attempt runs
are averaged separately when DTW maps them to the same reference instant.
They can produce separate points at the same normalized time; no line joins
those points. No styling, playback, recording or pitch-detector setting changed.

| Recorded four-tone sequence compared with itself | |
| --- | --- |
| [Before, Chromium desktop](results/browser-before/chromium-1440.png) | [After, Chromium desktop](results/browser-after/chromium-1440.png) |
| [Before, Firefox phone width](results/browser-before/firefox-375.png) | [After, Firefox phone width](results/browser-after/firefox-375.png) |

## Fresh recorded-speech replay

The existing fetcher first reverified all 963 pinned source files, totaling
366,357,392 bytes, and prepared the 100 FDA waveform/reference pairs offline:
[source receipt](results/source-verification.txt). The
[real-voice study](../real-voice/README.md) documents the frozen subset, source
URLs, licences and limits. PTDB-TUG contains 480 studio English utterances from
20 speakers; FDA contributes 100 utterances from two speakers. Recordings are
not redistributed here.

[corpus.ts](corpus.ts) runs fresh pitch extraction for both YIN and MPM on
each recording, at its native sample rate. The detector modules must be
byte-identical between revisions. That fresh contour enters both the old and
corrected comparison cores. This controls the input to the alignment, rather
than treating a previous study's generated frame tables as current evidence.

| Measured property | Result |
| --- | ---: |
| Original recordings | 580 |
| Paired recording/algorithm comparisons | 1,160 |
| Native detector frames across both trackers | 763,220 |
| Unvoiced intervals crossed by the old aligned drawing | 17,170 |
| Such intervals crossed after the correction | 0 |
| Comparisons with unchanged paths, costs, scores and feedback | 1,160 |

The missing intervals come from the native contour's observed frame identities,
independently of the new gap metadata. Each complete alignment is compared after
excluding only that new metadata. [Per-recording results](results/corpus.json)
retain original-input, contour and unchanged-alignment hashes. The run compares
each recording with itself so that every drawn connection has an unambiguous
reference interval. Separate controls cover an attempt-only gap, a reference-only
gap, aggregation across a gap at one reference time, skipped nonfinite frames,
and gaps skipped by thinning: [core controls](../../tests/contourGaps.test.ts).

[pairs.ts](pairs.ts) also checks 78 differently timed real-speech comparisons:
the shared `sa1` sentence across speakers and `sa1` versus `sa2` within each
speaker, for both algorithms. All numeric alignments remain identical. An
independent grouping oracle uses the original frame indices to partition the
path into contiguous runs, then averages within each reference-time group.
Every corrected overlay agrees exactly, including separate attempt runs that
meet at the same reference time: [paired results](results/pairs.json). These
are implementation checks on known audio, not a study of learner accuracy.

This is a drawing correction. It does not evaluate whether the detector's
voicing decisions were physically correct, improve F0 estimates, calibrate the
score, or establish pronunciation quality. DTW still compares voiced pitch
shape and can compress or discard pause duration. A break in its aligned
stroke does not measure how long the attempt paused in real time.

## Native browser paths

Chromium and Firefox each ran at 1440 and 375 pixels, with YIN and MPM, on:

- The bundled [Wolfdog (2019) recording](https://commons.wikimedia.org/w/index.php?title=File:FourMandarinTones.ogg&oldid=1277043205), CC BY-SA 4.0.
- PTDB-TUG `F01/sa1`, with its waveform pinned in the existing source manifest,
  under ODbL 1.0 / DbCL 1.0. Its original audio is not included here.

These are 16 comparison workflows per revision, including 32 real file imports.
Every fresh page disconnects after loading before either file import. The
observer records actual worker contours, comparison results and the canvas's
native `moveTo`/`lineTo` calls. It calls the original methods unchanged. Missing
intervals come from native frame identities; no product gap flag is used to
decide whether a line crosses an unvoiced interval.

The [paired comparison](results/browser-comparison.json) finds **208 unsupported
aligned connections before, zero after**, with identical decoded PCM, complete
contours, alignment paths, costs, scores and feedback. Raw/reference strokes
also preserve every observed gap after correction. There were no page errors,
CSP violations, post-disconnect requests, off-origin requests or document
overflow. A phone-width viewport is not a phone CPU measurement.

The [before](results/browser-before/browser.json) and
[after](results/browser-after/browser.json) records include input hashes,
all observed gaps and fetched asset hashes. Compressed native canvas traces
are adjacent to those manifests; their byte counts and SHA-256 digests are
recorded. The [browser regression](../../tests/browser/contour-gaps.spec.js)
checks both algorithms with the bundled recording in the regular browser suite.
All screenshots are actual production-app output with recorded speech.

## API detail

`DtwSample` and `WarpedPoint` gain optional `breakBefore: true` metadata.
Numeric DTW still uses the same voiced semitone sequences. The overlay can
return multiple points at one normalized reference time when different voiced
attempt runs meet there. Consumers should end their current stroke before
drawing a point marked `breakBefore`; dropping that flag recreates the defect.
Thinning carries a gap forward even when the selected endpoint itself was
contiguous with its immediate predecessor in the original array.

## Reproduce

With dependencies installed and the source cache verified as described by the
real-voice study:

```sh
python3 -I studies/real-voice/fetch.py --offline
npx tsx studies/contour-gaps/corpus.ts /path/to/fe8c07d . /tmp/contour-gaps-corpus.json
npx tsx studies/contour-gaps/pairs.ts /path/to/fe8c07d . /tmp/contour-gaps-pairs.json
npm run build
node studies/contour-gaps/browser.mjs dist . /tmp/contour-gaps-browser verify
npx playwright test tests/browser/contour-gaps.spec.js
```

The baseline checkout must have its own built `dist/`; pass that to the browser
script and use the final `baseline` argument. The input-checkout argument points
to the verified recordings. Set `TONEMIRROR_STUDY_URL` to exercise a hosted
page; fetched response bodies must still match the supplied tested `dist/`.
Source, clean build, hosted bytes and observed browser behavior are separate
verification boundaries. No npm release is implied by these source changes.
