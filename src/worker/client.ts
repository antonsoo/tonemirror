import type { AnalyzeRequest, AnalyzeResponse } from "./pitchWorker.js";
import type { PitchAlgorithm } from "../core/types.js";

/** Correlate requests and reject pending work if the worker fails. The next
 * analysis starts a fresh worker, so an error never strands the interface. */
export class PitchWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (response: AnalyzeResponse) => void; reject: (error: Error) => void }>();

  private createWorker(): Worker {
    const worker = new Worker(new URL("./pitchWorker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(event.data.requestId);
      if (pending) {
        this.pending.delete(event.data.requestId);
        pending.resolve(event.data);
      }
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  analyze(pcm: Float32Array, sampleRate: number, algorithm: PitchAlgorithm): Promise<AnalyzeResponse> {
    const requestId = this.nextId++;
    const request: AnalyzeRequest = { type: "analyze", requestId, pcm, sampleRate, algorithm };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      // Transfer the PCM buffer's copy (we keep our own reference elsewhere)
      // so the worker doesn't have to clone a potentially multi-second buffer.
      try {
        const transferPcm = pcm.slice();
        (this.worker ?? this.createWorker()).postMessage({ ...request, pcm: transferPcm }, [transferPcm.buffer]);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  terminate(): void {
    this.fail(new Error("Audio analysis cancelled."));
  }
}
