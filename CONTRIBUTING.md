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
npm run build
```

All four must pass; `.github/workflows/ci.yml` runs the same checks on push/PR.

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
- `scripts/accuracy-report.ts` - regenerates the accuracy table in
  README.md (`npm run bench`).

## Style

- TypeScript `strict` + `noUncheckedIndexedAccess`; keep `npm run typecheck`
  clean.
- Keep `src/core/` free of DOM/Worker/browser globals so it stays testable
  in plain Node.
- Comments explain *why*, not *what*.
