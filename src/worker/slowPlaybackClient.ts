import SlowWorker from "./slowPlaybackWorker.ts?worker&inline";
import type { SlowPlaybackResponse } from "./slowPlaybackWorker.js";
import { validateAudio } from "../audio/limits.js";
import { cancelled } from "../audio/cancellation.js";

/** One disposable job owns its worker. A cancellation never leaves DSP running. */
export function prepareSlowPlayback(pcm: Float32Array, sampleRate: number, signal: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: Error, value?: Float32Array): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker?.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const abort = (): void => finish(cancelled());
    const timer = setTimeout(() => finish(new Error("Slow playback preparation exceeded 60 seconds. Try a shorter phrase.")), 60_000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      validateAudio(pcm.length, sampleRate);
      worker = new SlowWorker();
      worker.onerror = event => { event.preventDefault(); finish(new Error("Slow playback preparation failed.")); };
      worker.onmessageerror = () => finish(new Error("The slow playback result could not be read."));
      worker.onmessage = (event: MessageEvent<SlowPlaybackResponse>) => {
        const reply: unknown = event.data;
        if (reply && typeof reply === "object" && "error" in reply && typeof reply.error === "string") finish(new Error(reply.error));
        else if (reply && typeof reply === "object" && "pcm" in reply && reply.pcm instanceof Float32Array && reply.pcm.length === pcm.length * 2) finish(undefined, reply.pcm);
        else finish(new Error("Slow playback returned an unreadable result."));
      };
      const copy = pcm.slice();
      worker.postMessage({ type: "prepare-half-speed", pcm: copy, sampleRate }, [copy.buffer]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
