# Contributing

## Setup

```sh
npm install
npm run dev
```

## Before opening a PR

```sh
npm run lint
npm run typecheck
npm test
npx playwright install chromium firefox
npm run test:browser
```

All checks must pass. The browser command builds the production site before
testing it. `.github/workflows/ci.yml` defines the same checks for push/PR;
run them locally when Actions is unavailable.

## Project layout

- `src/core/` - pure TypeScript DSP and comparison logic (no DOM, runs in
  Node/Worker/browser alike). This is where most correctness work lives.
- `src/worker/` - the Web Worker that runs pitch tracking + spectrogram
  analysis off the main thread, and its typed client.
- `src/audio/` - microphone capture (AudioWorklet), file decoding, and
  playback.
- `src/ui/` - canvas rendering and small DOM helpers.
- `src/storage/` - the IndexedDB reference library.
- `tests/` - Vitest specs, mostly against synthetic signals with known
  ground truth (see `src/core/synth.ts` and `src/core/metrics.ts`).
- `tests/browser/` - Playwright workflows and accessibility checks against the
  production build. Capture tests use Chromium's simulated microphone; the
  remaining workflows run in both Chromium and Firefox.
- `scripts/accuracy-report.ts` - regenerates the accuracy table in
  README.md (`npm run bench`).

## Style

- TypeScript `strict` + `noUncheckedIndexedAccess`; keep `npm run typecheck`
  clean.
- Keep `src/core/` free of DOM/Worker/browser globals so it stays testable
  in plain Node.
- Comments explain *why*, not *what*.

## Community and private reports

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Anton Soloviev
maintains this project and handles conduct reports at
[anton@praviel.com](mailto:anton@praviel.com).

Use the bug or improvement forms for public issues. For a suspected security
vulnerability or a conduct concern, email the maintainer privately with the
repository name and relevant details. Do not post credentials, personal data,
private logs, or confidential documents in a public issue.
