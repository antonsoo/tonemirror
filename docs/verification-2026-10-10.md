# Audio and study source verification, 2026-10-10

The audio-ownership, bounded-work and feedback fixes were rechecked from a
fresh archive of `74b6a92d20da9945ed8cfecbe2a5b2334b774ead`. Preparing the
real-voice study exposed two reproducible defects in its verification tools:

| Input/workflow | Before | Corrected behavior |
| --- | --- | --- |
| Run the documented tracker after fetching the corpus | Missing `fda-extracted/rl`; exits before analysis | Pinned FDA archive prepares 100 waveform/reference pairs |
| Controlled cache replay with changed bytes and fixed original file selection | All 963 changed files accepted; expected manifest rewritten | Changed source refused; expected manifest preserved |
| Estimate 82 Hz against 100 Hz, default accuracy metric | Counts as more than 20% error | 18% error, inside the accepted interval |
| Cross-tracker consensus near frame boundaries | Next sample, ignoring fitted offset differences | Nearest sample at the same calibrated reference instant |

Implementation is in `5f0a0cd`. The [actual failed clean-start log](evidence/source-2026-10-10/missing-fda-before.txt)
has only its scratch-directory prefix relocated. Offline source controls
exercise changed cache bytes, a partial download, missing input, altered FDA
extractions and extra recordings. A missing frame-table set is refused by
the report assembler. The exact 80/120 Hz boundaries, the 82 Hz case and
cross-tracker time calibration have independent explicit expected values.

All 963 source files were hash-checked, totaling 366,357,392 bytes. One
reference file was fetched again from its recorded HTTP URL and matched its
hash. The complete corpus was processed afresh: 580 recordings through both
app trackers and both external baselines, producing 1,160 frame tables.
The [study report](../studies/real-voice/results.json) retains their hashes,
source/code hashes, Python package versions, error counts and denominators.
The [scoring comparison](evidence/source-2026-10-10/scoring-comparison.json)
applies both metric definitions to those same new frame tables. This
separates the measurement correction from any change in detector output.
The pitch trackers themselves were not changed.

A second fresh archive of `5f0a0cd` passed `npm ci`, lint, strict types,
133 tests in each of the default and German locales, and a production
build on Node 26.7.0/npm 12.0.1. Seven offline source-integrity controls
and four Python metric controls passed. The [synthetic benchmark](evidence/source-2026-10-10/synthetic-benchmark.txt)
was regenerated under the corrected default metric.

The browser-verified app passed 51 Chromium/Firefox workflows; three
Firefox simulated-microphone cases were explicitly skipped. Checks cover
cancellation, source ownership, retained completed clips, decoder and worker
failure, capture limits, unavailable scores, feedback and offline operation.
Desktop light and 320-pixel dark screenshots were opened and inspected.
All 31 final build files match that runtime build. See the
[verification manifest](evidence/source-2026-10-10/verification.json).

These checks do not validate real microphone hardware, tonal-language
pronunciation or native-decoder allocation limits. The study's original
rejected experiments are kept in git history with their former metric;
they were not mixed into this rerun. See the [study](../studies/real-voice/README.md)
for the complete commands and limitations.

Source publication does not deploy the public app: the repository's GitHub
Actions setting was checked and reports `enabled: false`. No hosted or
package release was performed in this verification.
