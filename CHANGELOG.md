# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-09-24

Initial release.

- Pitch tracking core: YIN and McLeod Pitch Method (MPM) fundamental
  frequency estimators, octave-error correction, median smoothing, and
  semitone normalization relative to the speaker's own voiced median.
- Contour comparison: dynamic time warping between reference and attempt
  contours, a 0-100 similarity score, and rule-based localized feedback.
- Visualization: a signature "staff notation" contour overlay, plus a
  waveform + own-FFT spectrogram view with a synced playhead, loop region,
  and half-speed playback.
- Mandarin tone helper: a heuristic classifier for the four citation tones
  and the neutral tone.
- Ancient Greek (acute/circumflex) and Japanese (heiban/atamadaka/nakadaka/
  odaka) pitch-accent target templates, with a synthetic-voice generator for
  built-in practice references.
- Local-only storage: recordings and loaded files never leave the browser;
  saved references live in IndexedDB.
- Vitest suite covering the DSP core against synthetic signals with known
  ground truth (see the accuracy table in README.md).
