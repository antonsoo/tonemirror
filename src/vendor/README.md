# Signalsmith Stretch

`signalsmith-stretch.mjs` is the upstream self-contained Emscripten module at
[`a670068d9aeb64913331d5cc29337b19a457a7df`](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/a670068d9aeb64913331d5cc29337b19a457a7df/web/emscripten/main.js),
with its trailing CommonJS/AMD registration replaced by
`export default SignalsmithStretch;`. The WASM is embedded;
it requires no runtime download. This is the DSP module, not the upstream
AudioWorklet playback wrapper. ToneMirror runs it in a cancellable worker,
prepares a two-times-length preview, and keeps its existing Web Audio controls.

The upstream file is 98,451 bytes with SHA-256
`f4af9d616062c67dbfe6a98d9bfd39f0149246f02c111122a10936f5c63d5cf6`.
This records the distributed binary's provenance, not a reproducible local C++
build. The upstream [C++ adapter](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/a670068d9aeb64913331d5cc29337b19a457a7df/web/emscripten/main.cpp)
defines the buffer and latency interface; the declarations here cover only
the methods used by ToneMirror. Original MIT notices for Stretch and Linear
ship in [`public/audio-licenses.txt`](../../public/audio-licenses.txt).
