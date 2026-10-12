# ToneMirror's pitch trackers on real voices

This study measures the pitch contour against a laryngograph reference,
which estimates frequency from vocal-fold vibration. The recordings are
studio English speech: 480 utterances from 20 PTDB-TUG speakers and 100
utterances from two FDA speakers. These results do not measure tone
classification, learner pronunciation, or a room microphone.

The 2026-10-10 rerun used all 580 recordings for YIN, MPM, pYIN and Praat.
It corrected the gross-error calculation: **20% means
`abs(estimateHz - referenceHz) > 0.2 * referenceHz`**. Previously the code
used a symmetric 315.64-cent threshold, which wrongly counted 82 Hz against
100 Hz as more than 20% off. The detectors and their post-processing have
not changed. Lower error percentages here are a measurement correction,
not improved pitch tracking.

The later [correlation performance study](../pitch-correlation/README.md)
replays all 580 recordings against the faster implementation without changing
pitch decisions at the table's 0.001 Hz output precision. That study measures
runtime and numerical compatibility; the accuracy results below remain the
original pinned measurement.

## Inputs and provenance

[`manifest.json`](manifest.json) pins 963 source files by URL, byte count and
SHA-256, totaling 366,357,392 bytes. PTDB-TUG includes all 20 speakers, with
24 sentences per speaker: the two shared sentences and 22 originally chosen
at even spacing through each speaker's remaining sentence list. The recorded
manifest now defines the subset; a changing server directory cannot change it.

`fetch.py` verifies existing files, checks downloaded bytes before saving,
and extracts the 100 FDA waveform/reference pairs required by the trackers.
Changed sources, altered extracted files and additional unrecorded recordings
are errors. A complete cache works offline. The manifest is never rewritten.
The previous fetcher accepted changed cached bytes as new hashes and omitted
the FDA extraction needed by the next documented command.

PTDB-TUG is under the Open Database License. The FDA project page states no
licence. The recordings are not redistributed here. The
[current result](results.json) retains the source-manifest hash, analysis-code
hashes, package versions, hashes of all 1,160 newly generated frame tables,
integer error counts and denominators. The assembler refuses an incomplete
or different utterance set.

## Measurement

`run-tonemirror.ts` calls the same `trackPitch` core and defaults as the app.
Raw output precedes octave correction and median smoothing; the contour is
after both. Audio enters at each corpus's native sample rate. A browser may
resample during decoding, so this does not measure that decoder's output.

- **Gross pitch error:** relative frequency error above 20%, among frames
  both reference and tracker call voiced. Exactly 20% is not gross.
- **Halving/doubling:** gross errors within 315.64 cents of one octave below
  or above the reference. These categories use pitch distance, separately
  from the relative-frequency gross-error threshold.
- **Voicing error:** frames where only one side calls the signal voiced,
  divided by all compared frames.
- **Fine error:** absolute cents error on jointly voiced frames that are
  not gross errors. Mean and median are both retained; the table uses median.

The reference and tracker frame stamps need alignment. `align.py` fits one
constant offset per tracker and corpus on a 1 ms grid, maximizing the share
of reference-voiced frames also called voiced and within 100 cents. PTDB-TUG
uses only the pre-existing development partition (odd-numbered speakers);
FDA uses all its recordings. Even-numbered PTDB-TUG speakers remain the
comparison partition. No tracker parameters were tuned during this rerun.
For YIN/PTDB-TUG, the offset is 26 ms, raising this agreement from 73.07%
to 92.49%. This is temporal calibration, not independent voicing accuracy.

Trackers retain their own frame grids: YIN/MPM compare 347,308 PTDB-TUG
frames, pYIN 347,788, and Praat 346,704. Their jointly voiced denominators
also differ. The JSON records every denominator; the results are descriptive
point estimates, without a significance test or confidence interval.

## Results

PTDB-TUG, all 20 speakers:

| Tracker | Gross error | Halved | Doubled | Voiced as silence | Silence as voiced | Voicing error | Fine median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| YIN, raw | 3.72% | 1.84% | 0.95% | 6.29% | 6.08% | 6.13% | 8.9 cents |
| YIN, contour | 1.94% | 0.57% | 0.86% | 6.29% | 6.08% | 6.13% | 8.7 cents |
| MPM, raw | 2.81% | 1.17% | 0.82% | 8.30% | 5.21% | 5.90% | 8.8 cents |
| MPM, contour | 2.09% | 0.52% | 0.84% | 8.30% | 5.21% | 5.90% | 9.1 cents |
| pYIN, librosa | 1.10% | 0.06% | 0.93% | 11.50% | 6.65% | 7.73% | 10.1 cents |
| Praat, autocorrelation | 2.21% | 1.23% | 0.49% | 7.15% | 4.32% | 4.95% | 9.3 cents |

Gross error by subset, using the drawn contour for YIN/MPM:

| Tracker | Development | Held out | Female speakers | Male speakers | FDA |
| --- | ---: | ---: | ---: | ---: | ---: |
| YIN | 1.40% | 2.53% | 3.09% | 0.74% | 1.61% |
| MPM | 1.54% | 2.68% | 3.12% | 0.98% | 1.10% |
| pYIN | 0.39% | 1.90% | 2.02% | 0.09% | 0.43% |
| Praat | 1.45% | 3.02% | 3.72% | 0.60% | 1.06% |

The contour post-processing reduces gross errors for both app trackers on
this corpus. Female speakers have higher gross-error rates in this sample;
YIN misses more voiced frames for male speakers (8.55%, versus 4.02%).
These subset differences do not establish general performance by sex.

YIN's held-out reference pitches below 80 Hz are missed 21.1% of the time;
when both sides call them voiced, 11.4% have gross errors. This frequency
band alone does not establish creaky phonation. Similar fine-error medians
across trackers do not establish an irreducible reference-error floor.

The secondary consensus check now compares actual nearest frames after
applying each tracker's fitted offset. The previous code selected the next
frame and ignored the offset difference. It finds pYIN and Praat agree with
YIN on 375 of YIN's 1,599 gross-error frames across both corpora, and with
MPM on 407 of 1,608. Agreement between estimators is a reason to inspect a
recording, not proof that the reference is wrong.

The two rejected octave-correction patches remain under `experiments/`.
Their [original measurements](https://github.com/antonsoo/tonemirror/blob/74b6a92d20da9945ed8cfecbe2a5b2334b774ead/studies/real-voice/results.json)
used the former symmetric cents threshold. They were not rerun here and
are not mixed into the current comparison. Neither patch is applied.

## Reproduce

From the repository root, prepare the app and the pinned Python environment:

```sh
npm ci
uv venv --python 3.12 studies/real-voice/cache/venv
uv pip install --python studies/real-voice/cache/venv/bin/python -r studies/real-voice/requirements.txt
python3 -I studies/real-voice/fetch.py
```

The fetch is about 366 MB with an empty cache. `--offline` verifies a complete
cache and prepares FDA without network access. `--cache PATH` supports source
verification elsewhere; the analysis scripts read their own study's `cache/`.

Use a new output directory so old frame tables cannot be mixed into this run:

```sh
study_python=studies/real-voice/cache/venv/bin/python
study_out=$(mktemp -d studies/real-voice/cache/reproduction.XXXXXX)
npx tsx studies/real-voice/run-tonemirror.ts . "$study_out/frames" 0 1
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 "$study_python" -I studies/real-voice/baselines.py "$study_out/baselines" 0 1
"$study_python" -I studies/real-voice/align.py "$study_out/frames" "$study_out/baselines" > "$study_out/align.json"
"$study_python" -I studies/real-voice/score.py "$study_out/align.json" "$study_out/scores.json" "$study_out/frames" "$study_out/baselines"
for partition in development held-out fda; do
  "$study_python" -I studies/real-voice/diagnose.py "$study_out/align.json" yin_contour "$partition" "$study_out/frames" > "$study_out/diagnose-$partition.json"
done
for tracker in yin mpm; do
  "$study_python" -I studies/real-voice/consensus.py "$study_out/align.json" "${tracker}_contour" "$study_out/frames" "$study_out/baselines" > "$study_out/consensus-$tracker.json"
done
"$study_python" -I studies/real-voice/assemble.py "$study_out/align.json" "$study_out/scores.json" "$study_out/diagnose-development.json" "$study_out/diagnose-held-out.json" "$study_out/diagnose-fda.json" "$study_out/consensus-yin.json" "$study_out/consensus-mpm.json" "$study_out/frames" "$study_out/baselines" "$study_out/results.json"
```

The final two tracker arguments are shard index and shard count. The verified
rerun used two ordinary processes per tracker command (`0 2` and `1 2`),
writing disjoint utterances. Scores, alignment and assembly run after both
finish. The study dependencies are pinned in `requirements.txt`.

Run `python3 -I studies/real-voice/test_sources.py` for offline corruption,
partial-download and extraction controls. The study environment can also run
`test_metrics.py` for the exact 20% boundaries and nearest-frame calibration.

## Sources

- PTDB-TUG: Pirker, Wohlmayr, Petrik and Pernkopf, "A Pitch Tracking Corpus
  with Evaluation on Multipitch Tracking Scenario", Interspeech 2011.
  <https://www.spsc.tugraz.at/databases-and-tools/ptdb-tug-pitch-tracking-database-from-graz-university-of-technology.html>
- FDA: the Fundamental Frequency Determination Algorithm evaluation database,
  CSTR, University of Edinburgh. <https://www.cstr.ed.ac.uk/research/projects/fda/>
