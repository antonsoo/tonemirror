# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Listen to the reference followed by the attempt with a brief pause, using
  each selected passage once at normal speed. Schedule both on the same
  audio clock. Stop, file replacement, tab changes and individual playback
  cancel the sequence, including an attempt that has not started yet.
  Keep source samples, credits, loop markers, half-speed settings and the
  pitch comparison intact. [Native rendering and offline controls](studies/paired-listening/README.md).

- Practice with a recorded Mandarin voice: load any of four isolated tones or
  the full sequence and listen from the audio panel, including first use offline.
  Bundle Wolfdog's original recording under CC BY-SA 4.0. Carry its source,
  author, license and original excerpt coordinates through repeated trims,
  saved references, algorithm changes and renamed WAV reimports. Recognized
  damaged credits fail visibly while keeping the previous loaded clip.

- Start playback inside the selected practice loop even when the playhead is
  before it. Native loop bounds alone played the earlier audio once. Move a
  running source into a newly selected passage together with its cursor;
  preserve paused positions until Play and retain half-speed source coordinates.
  [Actual rendered samples and offline app workflows](studies/loop-entry/README.md).

- Reject non-finite decoded PCM in the analysis worker before replacing a clip.
  Damaged imports and saved recordings keep the previous valid audio and its
  comparison, saving and export; finite silence remains valid input.

- Preserve the voice's pitch during half-speed playback. Prepare and cache a
  local preview with the MIT-licensed Signalsmith Stretch engine; allow
  cancellation and recover from preparation failures. Loop bounds and the
  playhead retain original clip time, while analysis, saving and WAV export
  retain original samples. A native browser reproduction changes a 440 Hz
  source from the old 220 Hz result to 440 Hz at twice the duration.
  [Speech measurements, offline controls and limitations](studies/slow-playback/README.md).

- Download the focused clip as a float WAV, including microphone recordings,
  saved references and kept excerpts. Preserve the decoded mono samples at
  normal speed and retain synthetic-reference metadata when the file is
  reopened. Failed download preparation leaves the loaded audio available.
  [Recorded speech downloads and independent decoding](studies/wav-export/README.md).

- Extract a practice passage from either audio tab with **Keep region**, using
  a dragged region or keyboard time fields. Playback, comparison, classification
  and saving use the extracted audio. **Restore full clip** retains the source
  across repeated trims and algorithm changes until new audio is loaded. Save
  the focused reference directly, preserving synthetic labels. Failed and
  cancelled edits keep the last loaded clip.

- Align the playhead with native audio when resuming beyond a loop's end or
  moving a playing loop behind the cursor. These transitions enter at the loop's
  start; ordinary looping still preserves elapsed time. The reproduced browser
  mismatch exceeded one second. [Before/after audio measurements](studies/loop-playback/README.md).

- Calculate large-frame YIN differences and MPM correlations with FFTs while
  keeping their existing windows and pitch-selection rules. Reuse bounded FFT tables
  and retain direct sums for small or numerically delicate cases. A paired
  580-recording replay has no voicing changes or pitch changes at 0.001 Hz;
  actual browser uploads take less time on the measured speech fixtures.
  [Timings, compatibility checks and clean-build evidence](studies/pitch-correlation/README.md).

- Browse saved references through a metadata-only index instead of loading
  every recording's audio. **Use** reads just the selected recording, with
  cancellation and protection against older reads replacing newer selections.
  Existing records stay in place during the atomic index upgrade. Blocked
  upgrades, missing recordings and unreadable metadata have visible recovery
  messages. [Before/after and byte-preservation study](studies/library-loading/README.md).

- Include pitch-analysis and recorder code in the initial page load. A first
  local import, comparison, algorithm change or microphone recording can now
  start without a connection. Recorder Blob URLs are released on success and
  failure; microphone and worker ownership/recovery remain intact.
  [Stopped-server reproduction](studies/offline-start/README.md).

- `studies/real-voice/`: the pitch trackers measured on speech against a
  laryngograph reference (PTDB-TUG, 20 speakers, and the CSTR FDA database),
  beside pYIN and Praat. The fresh 580-recording comparison measures gross
  pitch error of the drawn contour at 1.94% (YIN) and 2.09% (MPM) on PTDB-TUG.
  No tracker setting was changed.
- Correct the benchmark's default 20% error tolerance to use relative Hz,
  rather than a symmetric cents interval; an 82 Hz estimate against 100 Hz
  is an 18% error. Explicit cents tolerances remain available. The real-voice
  scorer and diagnostic tools use the same corrected relative definition.
- Study fetching preserves and checks the pinned manifest, verifies partial
  downloads before saving, prepares the missing FDA extraction, and refuses
  changed or additional cached recordings. Report assembly checks complete
  corpus coverage and retains integer counts and frame-table hashes.
- Secondary reference-consensus analysis now uses actual nearest frames on
  the fitted common time basis, without extrapolating beyond either track.
- Updated the development source-map tooling to source-map-js 1.2.2; the
  locked dependency audit reports no vulnerabilities.
- File reads, microphone capture and worker jobs now have explicit limits.
  PCM WAV duration is checked before native decoding; all decoded formats
  are checked before downmixing. Recordings stop at 60 seconds and say so.
- Cancel stops obsolete workers and file reads. Native decode results are
  abandoned after cancellation. Reference and attempt jobs have independent
  ownership; matching also runs in a worker and can be cancelled or retried.
- A replacement is committed only after analysis and playback preparation
  succeed. Failed replacements keep the previous clip and comparison, with
  explicit retry controls. Spectrogram storage is bounded to 4,096 columns.
- Silence and single-frame contours now produce an unavailable score, rather
  than zero or a perfect match. Results show voicing and sampling counts.
  Long-contour sampling preserves the final point. Feedback distinguishes a
  uniformly slower phrase from a shallower pitch shape. It also flags movement
  against a level target and overly steep movement; absence of a matched
  feedback rule is no longer described as a close pitch match.
- Added independent exhaustive DTW path checks and browser regressions for
  cancellation, limits, separate audio slots, retained results, timeouts and
  automatic capture cleanup. Phone checks now include 320px layouts.

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
