import { prepareHalfSpeed } from "../audio/slowPlayback.js";

export type SlowPlaybackResponse = { pcm: Float32Array } | { error: string };
self.onmessage = (event: MessageEvent<{ type: "prepare-half-speed"; pcm: Float32Array; sampleRate: number }>) => {
  void prepareHalfSpeed(event.data.pcm, event.data.sampleRate).then(pcm => {
    self.postMessage({ pcm }, { transfer: [pcm.buffer] });
  }).catch((error: unknown) => {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  });
};
