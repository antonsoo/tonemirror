import PitchWorker from "./pitchWorker.ts?worker&inline";
import type { AnalyzeResponse, WorkerRequest, WorkerResponse, CompareResponse } from "./pitchWorker.js";
import type { PitchAlgorithm, PitchContour } from "../core/types.js";
import { validateAudio } from "../audio/limits.js";
import { cancelled } from "../audio/cancellation.js";
import { DEFAULT_PITCH_FLOOR, validatePitchFloor } from "../audio/analysisSettings.js";

export const AUDIO_JOB_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Each owner uses its own client; cancelling one clip does not revoke another's work. */
export class PitchWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private createWorker(): Worker {
    const worker = new PitchWorker();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (!message || !Number.isInteger(message.requestId) || !["analyzed", "compared", "failed"].includes(message.type)) {
        this.fail(new Error("The audio analysis returned an unreadable result. Try again."));
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      pending.cleanup();
      if (message.type === "failed") pending.reject(new Error(message.error));
      else pending.resolve(message);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) this.fail(new Error("Audio analysis failed. Try loading the clip again or changing the algorithm."));
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.fail(new Error("The audio analysis result could not be read. Try again."));
    };
    return worker;
  }

  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private submit(request: WorkerRequest, signal?: AbortSignal, transfer: Transferable[] = []): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(cancelled()); return; }
      const abort = (): void => this.fail(cancelled());
      const timeout = setTimeout(() => this.fail(new Error("Audio analysis exceeded 60 seconds. Try a shorter phrase.")), AUDIO_JOB_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(request.requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        (this.worker ?? this.createWorker()).postMessage(request, transfer);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async analyze(pcm: Float32Array, sampleRate: number, algorithm: PitchAlgorithm, signal?: AbortSignal, minFrequency = DEFAULT_PITCH_FLOOR): Promise<AnalyzeResponse> {
    if (signal?.aborted) throw cancelled();
    validateAudio(pcm.length, sampleRate);
    validatePitchFloor(minFrequency);
    const transferPcm = pcm.slice();
    const result = await this.submit({ type: "analyze", requestId: this.nextId++, pcm: transferPcm, sampleRate, algorithm, minFrequency }, signal, [transferPcm.buffer]);
    if (result.type !== "analyzed" || !result.contour || !Array.isArray(result.contour.points) || !result.spectrogram || !Array.isArray(result.spectrogram.frames)) {
      this.fail(new Error("The audio analysis returned an unreadable result. Try again."));
      throw new Error("The audio analysis returned an unreadable result. Try again.");
    }
    return result;
  }

  async compare(reference: PitchContour, attempt: PitchContour, signal?: AbortSignal): Promise<CompareResponse> {
    const result = await this.submit({ type: "compare", requestId: this.nextId++, reference, attempt }, signal);
    if (result.type !== "compared" || !result.alignment || !Array.isArray(result.alignment.path)) {
      this.fail(new Error("The contour comparison returned an unreadable result. Try again."));
      throw new Error("The contour comparison returned an unreadable result. Try again.");
    }
    return result;
  }

  terminate(): void {
    this.fail(cancelled());
  }
}
