# tonemirror's pitch trackers on real voices

tonemirror draws a learner's pitch contour, and everything else in it rests on
that contour being right. Its accuracy table was measured on generated tones
and harmonic complexes, where both trackers make no gross errors at all. This
study measures them on people talking, against a reference that does not come
from the microphone: a laryngograph, which records the vocal folds directly.

**What came out**

- **On speech the contour is wrong on about one voiced frame in fifty.** Gross
  pitch error (more than 20% off) is 1.95% for YIN and 2.10% for MPM on 20
  speakers, as the app draws them. On generated signals the README reported
  0.0%.
- **That is level with Praat and behind pYIN.** On the same recordings Praat's
  autocorrelation tracker makes 2.21% gross errors and librosa's pYIN 1.10%.
  The voicing decision is wrong on 6.1% of frames for YIN, 4.9% for Praat and
  7.7% for pYIN.
- **Fine error is 9 cents at the median, not a fraction of a cent.** All four
  trackers land within 9 to 10 cents of the laryngograph, so much of that is
  the reference and the alignment, not the tracker.
- **The errors are in women's voices, and they are octave errors.** 3.1% gross
  error for the ten women against 0.75% for the ten men, most of it doubling.
  Men's voices are missed instead: 8.6% of their voiced frames are drawn as
  silence, against 4.0% of women's.
- **The post-processing earns its place.** The octave correction and median
  smoothing between the raw detector and the drawn contour take YIN from 3.73%
  gross error to 1.95% and MPM from 2.82% to 2.10%.
- **Nothing tried made it better on the held-out speakers.** Two further
  octave corrections made gross error worse on both halves. A stricter voicing
  cut-off trades missed frames for false ones. The trackers are unchanged.

## The data

| | Speakers | Utterances | Frames (10 ms) | Reference |
|---|---:|---:|---:|---|
| PTDB-TUG, Graz University of Technology | 10 women, 10 men | 480 (24 each) | 347,308 | F0 from the laryngograph signal, as distributed |
| FDA, CSTR Edinburgh | 1 woman, 1 man | all of it | 32,860 | F0 from the laryngograph, as distributed |

`fetch.py` downloads the microphone recordings and the reference F0 files
named in [`manifest.json`](manifest.json) (366 MB; PTDB-TUG has more
sentences per speaker, and 24 each are taken: the two every speaker reads and
22 spread evenly through the rest). PTDB-TUG is under the Open
Database License; the FDA page states no licence. Neither is redistributed
here.

PTDB-TUG's odd-numbered speakers are the development half and its
even-numbered speakers the held-out half. Everything that was tried was tried
on the development half.

## The measure

`run-tonemirror.ts` runs the trackers the way the app does: it calls
`trackPitch` with the sample rate and the algorithm and nothing else, so every
setting is the shipped default. "Raw" is the detector's frame-by-frame output;
"contour" is what is drawn, after octave correction and median smoothing.
`baselines.py` runs pYIN (librosa) and Praat's autocorrelation method
(parselmouth) on the same audio at the same 10 ms hop.

- **Gross pitch error**: of the frames both the reference and the tracker call
  voiced, the share more than 20% from the reference. Halving and doubling are
  counted within it.
- **Voicing decision error**: the share of all frames where one calls voiced
  what the other does not.
- **Fine error**: cents from the reference on the frames that are not gross
  errors.

A tracker's frame times and the reference's are not on the same clock: the
reference lags by about one analysis window. `align.py` finds, for each
tracker and each corpus, the single offset that makes voicing agree most often
(26 ms for YIN on PTDB-TUG, where agreement is 92% against 73% at zero), and
`score.py` applies it. Every tracker, the baselines included, gets its own best
offset, so none is penalised for where it stamps a frame.

## Results

PTDB-TUG, all 20 speakers (77,433 reference-voiced frames):

| | Gross error | halved | doubled | Voiced drawn as silence | Silence drawn as voiced | Voicing error | Fine error, median |
|---|---:|---:|---:|---:|---:|---:|---:|
| YIN, raw | 3.73% | 1.84% | 0.95% | 6.3% | 6.1% | 6.1% | 8.9 cents |
| **YIN, as drawn** | **1.95%** | 0.57% | 0.86% | 6.3% | 6.1% | 6.1% | 8.7 |
| MPM, raw | 2.82% | 1.17% | 0.82% | 8.3% | 5.2% | 5.9% | 8.8 |
| **MPM, as drawn** | **2.10%** | 0.52% | 0.84% | 8.3% | 5.2% | 5.9% | 9.1 |
| pYIN (librosa) | 1.10% | 0.06% | 0.93% | 11.5% | 6.7% | 7.7% | 10.1 |
| Praat, autocorrelation | 2.21% | 1.23% | 0.49% | 7.2% | 4.3% | 5.0% | 9.3 |

Gross error by half and by sex, as drawn:

| | Development | Held out | Women | Men | FDA |
|---|---:|---:|---:|---:|---:|
| YIN | 1.41% | 2.54% | 3.10% | 0.75% | 1.68% |
| MPM | 1.56% | 2.69% | 3.14% | 0.98% | 1.14% |
| pYIN | 0.39% | 1.90% | 2.02% | 0.09% | 0.54% |
| Praat | 1.45% | 3.03% | 3.73% | 0.60% | 1.15% |

The held-out speakers are harder for every tracker, the baselines included, so
the gap between the halves is the speakers and not a fit.

Where YIN's errors are, held-out half: reference pitch under 80 Hz, which is
creak, is drawn as silence 21% of the time and is grossly wrong 11% of the
time when drawn. And 44% of the voicing errors fall within three frames of a
place where the reference switches between voiced and unvoiced, which is 14%
of the frames: much of the voicing error is a disagreement about where a
vowel starts and stops.

## What was tried

On the development speakers only, then checked on the held-out ones
(`experiments/`):

- **A longer octave correction** that moves a whole run of frames when it sits
  an octave from its neighbours. YIN's gross error as drawn went from 1.41% to
  1.60% on the development half and from 2.54% to 3.21% on the held-out half.
- **The same with a clipped median as the prior**: 2.68% and 5.25%.
- **The voicing cut-off.** Raising it from the shipped 0.5 to 0.6 lowers raw
  gross error on the development half from 3.24% to 2.68% and voicing error
  from 5.4% to 4.7%, and draws 7.8% of voiced frames as silence where it drew
  5.2%. For an app whose job is to show a learner their contour, more missing
  contour is not obviously better, and it was left alone.

Both patches are kept as files, not applied.

## What this does not show

- **A learner's microphone in a room.** These are studio recordings of read
  sentences, in English, by adults.
- **Tones.** Nothing here measures whether a Mandarin tone or a pitch accent
  is recognised from the contour. No freely licensed set of labelled tone
  recordings was found.
- **An exact reference.** The laryngograph F0 is itself an estimate, and its
  voicing boundaries differ from every tracker's by a frame or two. The 9
  cents all four trackers share is a floor from the reference and alignment.
- **A fair race with pYIN and Praat.** They ran with their defaults apart
  from the app's 60 to 1,000 Hz search range and its 10 ms hop, and each got
  its own alignment offset.

## Reproduce

```sh
git clone https://github.com/antonsoo/tonemirror && cd tonemirror && npm ci
python3 -I studies/real-voice/fetch.py                        # 366 MB into studies/real-voice/cache/
npx tsx studies/real-voice/run-tonemirror.ts . /tmp/frames 0 1
# in a virtual environment with librosa and praat-parselmouth, run with an empty environment:
python -I studies/real-voice/baselines.py /tmp/frames 0 1
```

`align.py`, `score.py`, `diagnose.py` and `consensus.py` turn those frame
tables into the pieces of [`results.json`](results.json), and `assemble.py`
joins them; the header of each script gives its arguments. `results.json` has
every speaker and every figure above.

## Sources

- PTDB-TUG: Pirker, Wohlmayr, Petrik and Pernkopf, "A Pitch Tracking Corpus
  with Evaluation on Multipitch Tracking Scenario", Interspeech 2011.
  <https://www.spsc.tugraz.at/databases-and-tools/ptdb-tug-pitch-tracking-database-from-graz-university-of-technology.html>
- FDA: the Fundamental Frequency Determination Algorithm evaluation database,
  CSTR, University of Edinburgh. <https://www.cstr.ed.ac.uk/research/projects/fda/>
