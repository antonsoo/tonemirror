# First audio use after losing the connection

ToneMirror kept pitch analysis in a lazily fetched worker and microphone capture
in a lazily fetched AudioWorklet. The old offline browser check loaded both
clips and the comparison worker before disconnecting, then reused those workers.
A newly opened page could not start its first file analysis offline.

This study reproduces the failure against the actual served site and a fresh
production build of source revision `43a1dc7`. The local fixture closes its HTTP
server **before any file or microphone is used**, with `Cache-Control: no-store`.
It uses the existing synthetic Mandarin reference WAV, not a human recording.

| Fresh page, then server stopped | Before | After |
| --- | --- | --- |
| First file import, Chromium, 1440/375 px | Analysis worker fetch fails | Clip loads; YIN and MPM comparisons finish |
| First file import, Firefox, 1440/375 px | Analysis worker fetch fails | Clip loads; YIN and MPM comparisons finish |
| First microphone recording, Chromium test device | AudioWorklet fetch fails | Worklet delivers PCM; analysis finishes; microphone tracks stop |

The five cases are retained in [`before.json`](before.json) and
[`after.json`](after.json). Each file workflow imports the same clip into both
slots, switches algorithms, explicitly saves/uses/deletes a local reference,
and checks for page errors, CSP violations and horizontal overflow. Both
algorithms report 100 for this self-comparison. No audio is persisted before
the explicit save, and the saved record is deleted before closing the context.
The microphone is Chromium's deterministic test device; this does not validate
physical microphone quality or every platform's permission behavior.

## Why stopping the server matters

[`hosted-before.json`](hosted-before.json) records failed first imports in
Chromium and Firefox using Playwright's offline emulation. Chromium's microphone
still started: in this environment its AudioWorklet fetch was not blocked by
that emulation. A successful button transition under simulated offline mode
therefore was not enough evidence. Closing the real local server exposed the
recorder's fetch failure. The after capture uses the same stronger boundary.

## Change

- Vite's [inline worker import](https://vite.dev/guide/features#web-workers)
  bundles pitch-analysis and matching code with the page. Reference, attempt and
  comparison retain their separate workers and cancellation/retry ownership.
- The small recorder module is JavaScript with JSDoc type checking, imported as
  text. Each audio context loads it from a local Blob through
  [`AudioWorklet.addModule`](https://developer.mozilla.org/en-US/docs/Web/API/Worklet/addModule).
  The Blob URL is revoked in `finally`, whether registration succeeds or fails.
- CSP permits local `blob:` scripts for the audio worklet and `blob:` workers
  for analysis. Other network origins remain disallowed; no `eval`, general
  inline script permission, service worker or new runtime dependency is added.
- The existing browser regression now disconnects before the first import and
  checks algorithm changes too. Worker-failure fixtures exercise actual blob
  workers instead of intercepting asset filenames that no longer exist.

The app now fetches its processing code at initial load. The JS total moves
from 51,885 bytes across three files to roughly 53 kB in the main bundle;
[`bundle-sizes.json`](bundle-sizes.json) records exact files and hashes. The
initial main-script download grows from about 14.8 kB to 19.2 kB compressed.

## Same audio calculations

[`online-before.json`](online-before.json) runs the baseline with its server
still available. [`dsp-unchanged.json`](dsp-unchanged.json) compares the complete
two analysis payloads and final visible comparison for each algorithm against
the offline fixed build: eight browser/width/algorithm cases match exactly by
SHA-256. Each browser is compared with itself, since native audio decoding can
differ between engines. Request IDs, delivery order and superseded intermediate
comparisons during algorithm switching are excluded. This is a transport check
on one synthetic WAV, not a new accuracy study. The DSP source did not change.

Desktop and phone screenshots from the actual stopped-server run were opened
and inspected: [desktop](../../docs/assets/offline-start/offline-comparison-1440.png),
[phone](../../docs/assets/offline-start/offline-comparison-375.png).

## Reproduce

```sh
npm ci
npm run build
node studies/offline-start/verify.mjs dist /tmp/offline-start.json
```

The script starts only loopback servers and closes each after page load. It
requires the Chromium and Firefox engines used by this repository's browser
checks. To record the old failure, build `43a1dc7` separately and run:

```sh
node studies/offline-start/verify.mjs /path/to/baseline/dist /tmp/before.json observe
node studies/offline-start/verify.mjs /path/to/baseline/dist /tmp/online.json online
```

It also accepts a served URL in place of `dist`. For that mode it uses browser
offline emulation and records that weaker boundary separately; the microphone
checks additionally require its module URL to be a local Blob and revoked.

## Boundaries

The page must first load. This does not install an offline app, promise an
uncached offline reload, or bypass microphone permission. An unloaded font
subset can fall back to a system font; the workflows allow only optional font
requests after disconnection. Browser-specific codecs and native decoders keep
the limits documented in [audio boundaries](../../docs/audio-boundaries.md).
