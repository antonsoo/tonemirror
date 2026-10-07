# Local verification, 2026-10-07

Verified implementation `d542906` in a fresh detached checkout, with a clean
`npm ci` on Node 24.21.0. The app remains version 0.2.3. These changes have not
been pushed, released or deployed.

| Check | Result |
| --- | --- |
| ESLint and strict TypeScript | Passed |
| Vitest, default locale environment | 124 passed |
| Vitest, `LC_ALL=de_DE.UTF-8 LANG=de_DE.UTF-8` | 124 passed |
| Production build | Passed |
| Chromium 153.0.8010.12 and Firefox 155.0 | 51 passed, 3 skipped, no retries or failures |
| Axe, 320/1280px, light/dark comparison screens and silent-input screens | 10 scenarios, no findings |
| Page errors, CSP violations and off-origin requests | Zero in all completed browser scenarios |
| Locked dependency audit | Zero reported vulnerabilities |
| Fresh-checkout and working-checkout builds | All 31 output files have identical SHA-256 hashes |
| Synthetic pitch benchmark | Seven conditions, both YIN and MPM; recorded below |

The three skipped scenarios require Chromium's simulated microphone: failed
worklet setup, a permission request cancelled before capture arrives, and the
60-second sample cap. All three pass in Chromium. The cap test keeps the real
capture/worklet lifecycle but substitutes an accelerated synthetic PCM delivery;
it checks exact retained length, released tracks and the bounded spectrogram,
not real microphone quality or wall-clock timing. The remaining scenarios run
in both engines.

Browser checks exercise storage denial and retry, explicit named saves,
overlapping decodes, tab and algorithm ownership, worker failure and timeout,
retained playback after a failed replacement, immediate cancellation and late
results, separate workers for the two slots, cancelled/retried matching, file
limits, silent-input evidence, keyboard controls and offline reuse after loading.
The WAV duration check verifies that a 61-second PCM file is rejected before
native decoding. No audio is saved automatically.

An independent DTW oracle enumerates every admissible path for 1,521 pairs of
short sequences. Other regressions check unavailable scores, finite costs,
strict time coordinates, preserved sampling endpoints and pacing-independent
slope feedback. A level target against an ideal rising contour previously
returned score 33 with a claim of a close match. That case now identifies the
direction difference; excessive rises/falls are also covered. An isolated pitch
spike verifies that no matching feedback rule is not interpreted as a close
match. Separately generated sine/glide WAVs exercise the full decoder, pitch
tracker and comparison worker in both browsers.

The [synthetic accuracy output](accuracy-2026-10-07.txt) records detector behavior,
including degradation at 0 dB signal-to-noise ratio. Synthetic fixtures and these
heuristic scores are not evidence of pronunciation assessment accuracy. Native
decoding of compressed audio still has no general allocation ceiling or abort
mechanism; the limits and cancellation boundary are documented in
[audio boundaries](audio-boundaries.md).

Screenshots were opened and inspected:

- [320px light, Chromium](assets/audio-mobile-2026-10-07.png)
- [1280px dark, Firefox](assets/audio-desktop-2026-10-07.png)

Reproduce with `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run test:browser`, `npm run bench` and `npm audit`. Install the browser
engines with `npx playwright install chromium firefox` first if needed.
[Machine evidence and artifact hashes](verification-2026-10-07.json) and
[individual browser results](browser-verification-2026-10-07.json) preserve the
measured environments and outcomes.
