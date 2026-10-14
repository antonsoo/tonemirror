# Damaged decoded audio cannot become a completed practice clip

At baseline `a952c734`, both Chromium and Firefox decode a constructed
one-second IEEE float WAV with a quarter-second of NaN or infinite samples.
The native decoder retains **11,025 non-finite samples** at 44,100 Hz.
ToneMirror commits it as the attempt and reports **100**, using 69 of 97 voiced
frames after the invalid region was treated as unvoiced. Export then rejects
the same clip's invalid PCM. A single invalid sample at the end can fall beyond
the detector's last window and remain entirely absent from the displayed
voicing count.

The browser's completed-clip boundary now requires finite PCM throughout the
buffer. Validation runs in the existing slot worker before pitch and
spectrogram analysis. A failed file/saved-recording replacement keeps the
previous clip's samples, label, comparison and available actions. The stored
recording is not rewritten or deleted. Genuine silence stays valid and has an
unavailable score when it supplies no voiced frames.

This correction does not change the standalone pitch routines' robust handling
of partial signals, the relative pitch-shape heuristic, or phonetic accuracy.
The damaged fixtures are constructed counterexamples, not production incidents.
It checks decoded PCM, rather than proving that every encoded file is intact;
the browser's native decoder still has its documented allocation/cancellation
limits in [audio boundaries](../../docs/audio-boundaries.md).

## Reproduction

```sh
npm ci --ignore-scripts && npm run build
node studies/audio-integrity/browser.mjs dist /tmp/audio-integrity after
```

For the baseline, build `git archive a952c734` and pass its `dist` directory,
using `before` instead of `after`.

[`fixtures.mjs`](fixtures.mjs) constructs IEEE float WAVE bytes independently
of the application's export encoder. The format tag, channel/frame alignment
and floating-point container follow
[Microsoft's WAVEFORMATEX documentation](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex).
The fixtures include NaN, both infinities, a single last-sample NaN, finite
voiced audio, real zero-valued gaps and complete silence. All source waveforms
are synthetic sine waves, not recorded speech.

[`browser.mjs`](browser.mjs) uses the production build, native `decodeAudioData`,
native IndexedDB and the bundled workers. Observers record the actual decoded
non-finite counts, submitted PCM digests, worker responses and unchanged valid
contour/spectrogram digests. They never substitute decoder or worker results.
It checks both reference/attempt slots and YIN/MPM, with Chromium/Firefox at
1440 and 375 px. Two damaged legacy recordings are seeded into a native v1
database, exercising the existing metadata-index upgrade and selected-record
load path. The backend correction adds no storage migration.

After initial code/font loading, the server is shut down and the context is
offline. Served and browser-loaded assets are byte-matched with the tested
build. The replay checks preserved WAV export bytes, saving, final recovery,
unchanged legacy recording bytes, accessibility, overflow, script/CSP failures
and external/late requests. The baseline captures its delayed export failure.
