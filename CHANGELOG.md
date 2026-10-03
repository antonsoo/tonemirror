# Changelog

All notable changes to this project are documented in this file.

## [0.2.3] - 2026-10-03

### Fixed

- Cancelling the save dialog now saves nothing. Blank names are rejected;
  storage failures are visible and the saved-reference library can retry.
  Database connections close on failed or aborted transactions.
- Microphone setup failures and cancelled permission requests release their
  tracks and audio contexts, including permission grants that arrive late.
  Concurrent starts share one capture request; leaving the page stops capture.
- Recordings and files stay assigned to the tab selected when they started.
  Older decoding and analysis results cannot replace newer choices. A failed
  analysis worker reports an error and is replaced on the next analysis.
- Pause retains the playback position. Speed changes and clearing a loop
  preserve elapsed playback; switching tabs pauses the previous clip, and each
  clip keeps its own loop. Pending playback cannot restart after a tab switch.
- Replacing or reanalyzing audio clears the previous tone classification and
  comparison while the current results are pending.

### Changed

- The waveform names its clip and duration. Audio tabs support arrow keys,
  Home, and End, and saved references select the Reference tab when used.
- Regression tests cover audio resource cleanup, playback timing, worker
  failures, and storage transactions. Production browser tests exercise the
  app in Chromium and Firefox, including light/dark desktop and mobile
  accessibility checks; Chromium uses a simulated microphone for capture tests.

## [0.2.2] - 2026-10-02

### Changed

- The page's fonts are served by the page itself. They came from Google Fonts,
  the one request the page made to another origin; the same font files (every
  subset, as Google serves them to a current browser) are now in
  `src/fonts/`, with their SIL Open Font License texts. Nothing looks
  different: screenshots before and after match. The page now loads with
  every other host blocked.

### Security

- The built page carries a Content-Security-Policy. Scripts, styles, fonts and
  workers load from the page's own origin only, and `connect-src 'self'` has
  the browser refuse to send what you give the page to any other host, even
  for a script injected through a bug in how the page renders a file. Inline
  event handlers and `eval` are not allowed. Every control was exercised
  in Chromium and Firefox with a listener for policy violations: none.

### Accessibility

- Checked with axe-core (WCAG 2.1 A and AA, and its best-practice rules) in light and dark,
  at desktop and phone widths: no findings now. The page has a `main`
  landmark, and the Record button keeps its deep red in the dark theme (its
  label was 2.7:1 on the lighter red; 5.4:1 now).

## [0.2.1] - 2026-10-01

### Fixed

- Playback of a long clip dropped frames: the waveform and the spectrogram
  image were rebuilt from every sample and every spectrogram cell on each
  animation frame, only to move the playhead. In headless Chromium a 60 s
  clip played at about 30 frames a second and a 200 s clip at about 12.
  Both are now computed once per clip, and both clips play at 60.
- Comparing two long clips froze the page: the alignment filled a table of
  doubles the size of the two contours multiplied, about 2 GB for two
  200 s clips, which held the main thread for 2.7 s. It now keeps two rows
  and one byte per cell, with the same path and cost as before, and a
  contour with more than 6,000 voiced samples (a minute of speech) is
  thinned before it is aligned. The same step now takes about 0.4 s.
  The thinning lowers the score by a point or two (up to four on the
  contours measured); shorter contours are aligned exactly as before.
- A NaN or infinite sample reached the pitch detectors. A 32-bit float WAV
  can hold them, and Chromium's decoder passes them through. With YIN, a
  frame holding one came back with a NaN confidence, some such frames were
  called voiced on a pitch read off the infinity, and one pattern tested
  (an infinite sample every 700, alternating in sign) produced a NaN pitch
  and with it a NaN similarity score. With either detector the frame's
  level was reported as NaN or Infinity. Such a frame is now unvoiced at
  level 0, a NaN semitone is left out of the alignment, and the
  spectrogram draws the frame as empty.
- The waveform was drawn from a whole number of samples per pixel, which
  left the end of the clip off the view (and, for a clip of fewer samples
  than pixels, drew it squeezed to the left). It now spans the view.

## [0.2.0] - 2026-09-30

### Fixed

- The peak-timing feedback measured each contour's peak as a fraction of the
  clip from its first sample, not from where the voice starts, so a pause
  before speaking (the usual way a recording begins) pushed the attempt's
  peak later and produced "your pitch peak comes later" for a well-timed
  attempt. It is now measured across each contour's voiced span.
- A flat attempt got peak-timing advice ("try holding the rise a bit longer")
  on top of the "yours stays flat" feedback, from wherever its jitter peaked.
  The check now needs both contours to move at least a semitone.

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
