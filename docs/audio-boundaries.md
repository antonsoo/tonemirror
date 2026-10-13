# Audio ownership, limits and unavailable measurements

Each reference/attempt slot owns its file read, decode and pitch job. Changing
tabs does not change that owner. A newer operation in the same slot revokes the
old one, and each slot has its own worker, so one stalled job cannot block the
other. The last committed clip stays visible and playable until a replacement
has both analysis and a prepared playback buffer. Failure or cancellation keeps
that clip; the waveform label and comparison source names identify what is
actually loaded. Failed extraction can be retried without selecting the file
again.

The saved-reference library lists metadata through an IndexedDB key cursor.
Only **Use** reads the chosen recording's PCM, with the same ownership and
cancellation rules as a file import. The first opening after upgrading the
source creates a metadata index over the existing records atomically. Another
old tab can block that upgrade; close it and retry the library. The upgrade
does not rewrite the audio records. A count check reports unindexable legacy
metadata instead of silently hiding recordings. The browser can still evict
site data, and cancelling a read is not a promise to stop internal disk work.
[Stored-byte and offline-browser evidence](../studies/library-loading/README.md).

```text
file / capture / saved clip
             |
             v
       validate dimensions
             |
             v
     analyze in slot worker ---- failure / cancel ---> keep previous clip
             |
             v
      prepare playback buffer
             |
             v
       commit complete clip
             |
             v
    compare immutable contours in a separate worker
```

The comparison worker captures both contours. Replacing either committed clip
cancels an obsolete comparison. Cancel and failure leave the loaded audio
available for retry. Algorithm changes prepare replacements through the same
path; if one fails, the source note continues to name the algorithm used for
each retained clip. Audio and analysis are not saved automatically; saving a
reference remains an explicit, named action. The theme preference is remembered.

| Boundary | Limit / behavior |
| --- | --- |
| Encoded file | 25 MiB before reading |
| Clip duration | 60 seconds; imports are rejected rather than truncated |
| Sample rate | Integer 8,000-96,000 Hz |
| Channels | 1-8; downmixed by channel average |
| Decoded PCM | At most 64 MiB across channels before making a mono copy |
| Microphone | Stops and releases capture at 60 seconds of received samples; the clip name records the limit |
| Worker job | 60-second timeout, with explicit cancel and retry |
| Spectrogram | At most 4,096 time columns covering the clip; adaptive hop for long clips |
| Contour matching | At most 6,000 voiced samples per contour, preserving both endpoints |

PCM/float WAV chunk metadata is inspected before starting the native decoder,
so an oversized declared duration is rejected early. For other codecs, the
browser must return the decoded buffer before dimensions can be validated.
This is **not a hard memory ceiling for the browser's decoder**.
[`decodeAudioData`](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)
works on complete file data and offers no AbortSignal argument. Cancelling
abandons the result, observes any late rejection and closes the context;
it does not claim to preempt native codec allocation. Decoding also resamples
to the audio context's sample rate. Saved clips are validated on use.

The recorder's cap counts received samples, not elapsed wall-clock time: a
suspended audio context does not invent missing samples. The browser tests
exercise real capture cleanup using Chromium's simulated microphone and an
accelerated synthetic delivery; no claim is made about real room acoustics or
hardware timing from those tests.

An alignment requires at least two usable, strictly time-ordered voiced points
from each contour. Otherwise `score`, `meanCostPerStep` and `totalCost` are
`null`; the UI says **Unavailable**. Nonfinite observations are excluded;
contradictory time order and unrepresentable DTW cost are explicit errors.
The result retains original frame counts, usable voiced counts and aligned
sample counts. Thinning is an approximation, with no general error bound.

Similarity is `round(100 * exp(-meanCost / 2.8))` on relative semitone pitch
shape after time alignment. It is not a pronunciation grade or a probability.
Slope feedback uses each contour's own voiced time span; uniform speaking-rate
changes alone do not imply a shallow rise/fall. The peak-timing heuristic
remains relative to the voiced span. Direction and steepness checks work in
both directions, including movement against a level target. An absence of
feedback does not establish a close match: localized deviations can escape
these rules while contributing to the score and remaining in the overlay.
Neither mechanism evaluates words,
phonemes, tone sandhi, or how natural the speech sounds.


After the initial page loads, analysis workers start from bundled local blobs.
The recorder registers its bundled JavaScript source separately in each audio
context and revokes the temporary Blob URL after registration settles, including
failure. Its JavaScript retains JSDoc type checking. CSP permits local blobs for
scripts and workers; network connections remain restricted to the same origin.
JavaScript `eval` and general inline scripts remain disallowed. The bundled
Signalsmith Stretch engine uses the narrower `wasm-unsafe-eval` permission to
compile its embedded WASM inside a worker.

Half-speed preparation uses the same 60-second source limit, with an output
of exactly twice the decoded mono frame count (up to 120 seconds of playback).
It has a 60-second deadline and a disposable worker so cancellation releases
the engine's memory. The preview is held only by the current clip's player;
source PCM, saved audio and exported WAVs are unchanged. It consumes additional
memory and can introduce time-stretching artifacts. See the
[measured speech and browser checks](../studies/slow-playback/README.md).

This is not an offline installer or service worker. An uncached page reload
still needs the site, and a font subset not loaded before disconnection falls
back to a system font. [A real stopped-server check](../studies/offline-start/README.md)
covers first file loads, both pitch algorithms, saved references, and a first
microphone capture using Chromium's test device.
