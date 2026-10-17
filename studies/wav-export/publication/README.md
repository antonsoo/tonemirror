# Delivering audio export in the public demo

Before deployment, the live demo was checked against its actual Pages branch
`95b8bdc0863e88e13049487f114637aa76640ce4`. It imported the two hash-pinned
PTDB-TUG F01/M01 recordings after going offline, but offered neither
**Download WAV** nor **Keep region**. The source already has those workflows.
The [public-before receipt](wav-public-before/browser.json) records eight
actual imports in Chromium/Firefox at 1440 and 375 px, with fetched assets
compared against that exact branch. No export is invented for the old build.

A fresh archive of source `07754ca184f3e94e5217e9e58b8f72286aa00a1c` was
installed with Node 24.21.0 and npm 11.19.0. Lint, strict TypeScript, 217 unit
tests, build and 92 browser workflows passed. Four Firefox microphone cases
are skipped; Chromium uses its test device. This does not verify a physical
microphone. [The clean-check receipt](clean-checks.json) hashes unedited logs.
Publication harness changes do not change application code or build inputs.

The [local recorded-speech replay](wav-local/browser.json) completed 48 actual
WAV downloads: full clip, looped/half-speed clip, one-second kept passage,
restored full clip, saved reference and synthetic reference. FFprobe identifies
mono 32-bit float WAV; FFmpeg independently decodes every file and matches the
exact samples sent to the real analysis worker. Playback speed does not change
the download. Renaming and reopening a synthetic download preserves its label.
The static server is stopped before the first speech import. All eight browser
workflows have no requests afterward, page/CSP errors, accessibility violations
or horizontal overflow. All eight local/public-before screenshots were opened
and inspected; desktop and 375 px controls and clip provenance remain readable.

These English recordings test audio handling, not Mandarin or pitch-accent
accuracy. Their URLs, licenses and hashes come from the
[existing real-voice manifest](../../real-voice/manifest.json). Downloaded speech
WAVs remain in the local scratch directory; the committed receipts retain hashes
and sample comparisons. No physical microphone or listening-quality claim is
made.

Build with `npm ci` and `npm run build`; complete static output is `dist/`.
To repeat the hosted recorded-speech workflow after deployment:

```sh
TONEMIRROR_BROWSER_ORIGIN=https://antonsoo.github.io node studies/wav-export/browser.mjs dist studies/real-voice/cache /tmp/tonemirror-hosted after
```

The harness compares fetched public bytes with `dist`, disconnects before the
first import, and verifies real downloads. A `before` replay against an older
build records absent region/export controls explicitly. Hosted freshness is
verified separately below. No registry release or tag is created.
