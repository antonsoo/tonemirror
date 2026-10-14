/** Pitch extraction, spectrograms and contour matching run away from the page thread. */
import { trackPitch } from "../core/pitchTrack.js";
import { computeSpectrogram } from "../core/spectrogram.js";
import { compareContours, type AlignmentResult } from "../core/dtw.js";
import { MAX_SPECTROGRAM_FRAMES, validateAudio, validateAudioSamples } from "../audio/limits.js";
import type { PitchAlgorithm, PitchContour } from "../core/types.js";

export interface AnalyzeRequest {
  type: "analyze";
  requestId: number;
  pcm: Float32Array;
  sampleRate: number;
  algorithm: PitchAlgorithm;
}
export interface CompareRequest {
  type: "compare";
  requestId: number;
  reference: PitchContour;
  attempt: PitchContour;
}
export interface AnalyzeResponse {
  type: "analyzed";
  requestId: number;
  contour: ReturnType<typeof trackPitch>;
  spectrogram: ReturnType<typeof computeSpectrogram>;
}
export interface CompareResponse {
  type: "compared";
  requestId: number;
  alignment: AlignmentResult;
}
export type WorkerRequest = AnalyzeRequest | CompareRequest;
export type WorkerResponse = AnalyzeResponse | CompareResponse | { type: "failed"; requestId: number; error: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "compare") {
      const response: CompareResponse = { type: "compared", requestId: msg.requestId, alignment: compareContours(msg.reference, msg.attempt) };
      self.postMessage(response);
    } else if (msg.type === "analyze") {
      validateAudio(msg.pcm.length, msg.sampleRate);
      validateAudioSamples(msg.pcm);
      const contour = trackPitch(msg.pcm, { sampleRate: msg.sampleRate, algorithm: msg.algorithm });
      const hopSize = Math.max(256, Math.ceil((msg.pcm.length - 1024) / (MAX_SPECTROGRAM_FRAMES - 1)));
      const spectrogram = computeSpectrogram(msg.pcm, msg.sampleRate, { fftSize: 1024, hopSize });
      const response: AnalyzeResponse = { type: "analyzed", requestId: msg.requestId, contour, spectrogram };
      self.postMessage(response, { transfer: spectrogram.frames.map((frame) => frame.buffer) });
    }
  } catch (error) {
    self.postMessage({ type: "failed", requestId: msg.requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
