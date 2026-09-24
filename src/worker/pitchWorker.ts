/**
 * Web Worker that runs the heavy per-sample DSP - pitch tracking and the
 * spectrogram FFT - off the main thread, so recording/playback UI stays
 * smooth even on a longer clip. See src/worker/client.ts for the typed
 * wrapper the app talks to.
 */
import { trackPitch } from "../core/pitchTrack.js";
import { computeSpectrogram } from "../core/spectrogram.js";
import type { PitchAlgorithm } from "../core/types.js";

export interface AnalyzeRequest {
  type: "analyze";
  requestId: number;
  pcm: Float32Array;
  sampleRate: number;
  algorithm: PitchAlgorithm;
}

export interface AnalyzeResponse {
  type: "analyzed";
  requestId: number;
  contour: ReturnType<typeof trackPitch>;
  spectrogram: ReturnType<typeof computeSpectrogram>;
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const msg = event.data;
  if (msg.type !== "analyze") return;

  const contour = trackPitch(msg.pcm, { sampleRate: msg.sampleRate, algorithm: msg.algorithm });
  const spectrogram = computeSpectrogram(msg.pcm, msg.sampleRate, { fftSize: 1024, hopSize: 256 });

  const response: AnalyzeResponse = { type: "analyzed", requestId: msg.requestId, contour, spectrogram };
  self.postMessage(response);
};
