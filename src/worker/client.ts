import type { AnalyzeRequest, AnalyzeResponse } from "./pitchWorker.js";
import type { PitchAlgorithm } from "../core/types.js";

/** Typed, promise-based wrapper around pitchWorker.ts. One worker, one
 * in-flight-request-at-a-time queue keyed by requestId (simple and enough
 * for this app - a user analyzes one clip at a time). */
export class PitchWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (response: AnalyzeResponse) => void>();

  constructor() {
    this.worker = new Worker(new URL("./pitchWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
      const resolve = this.pending.get(event.data.requestId);
      if (resolve) {
        this.pending.delete(event.data.requestId);
        resolve(event.data);
      }
    };
  }

  analyze(pcm: Float32Array, sampleRate: number, algorithm: PitchAlgorithm): Promise<AnalyzeResponse> {
    const requestId = this.nextId++;
    const request: AnalyzeRequest = { type: "analyze", requestId, pcm, sampleRate, algorithm };
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      // Transfer the PCM buffer's copy (we keep our own reference elsewhere)
      // so the worker doesn't have to clone a potentially multi-second buffer.
      const transferPcm = pcm.slice();
      this.worker.postMessage({ ...request, pcm: transferPcm }, [transferPcm.buffer]);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
