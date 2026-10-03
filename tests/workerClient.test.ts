import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PitchWorkerClient } from "../src/worker/client.js";
import type { AnalyzeResponse } from "../src/worker/pitchWorker.js";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: AnalyzeResponse }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}

beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
afterEach(() => vi.unstubAllGlobals());
const pcm = new Float32Array([0.1, 0.2]);

describe("analysis worker recovery", () => {
  it("rejects all pending requests on a worker error and recovers on the next request", async () => {
    const client = new PitchWorkerClient();
    const first = expect(client.analyze(pcm, 22050, "yin")).rejects.toThrow("Audio analysis failed");
    const second = expect(client.analyze(pcm, 22050, "mpm")).rejects.toThrow("Audio analysis failed");
    const failed = FakeWorker.instances[0]!;
    failed.onerror!({ preventDefault: vi.fn() });
    await Promise.all([first, second]);
    expect(failed.terminate).toHaveBeenCalledOnce();
    const third = client.analyze(pcm, 22050, "yin");
    const fresh = FakeWorker.instances[1]!;
    const result = { type: "analyzed", requestId: 3 } as AnalyzeResponse;
    failed.onmessage!({ data: result });
    fresh.onmessage!({ data: result });
    await expect(third).resolves.toBe(result);
  });

  it("rejects unreadable worker messages instead of waiting forever", async () => {
    const client = new PitchWorkerClient();
    const result = expect(client.analyze(pcm, 22050, "yin")).rejects.toThrow("could not be read");
    FakeWorker.instances[0]!.onmessageerror!();
    await result;
  });

  it("rejects pending work when terminated, and can start again", async () => {
    const client = new PitchWorkerClient();
    const result = expect(client.analyze(pcm, 22050, "yin")).rejects.toThrow("cancelled");
    client.terminate();
    await result;
    const next = expect(client.analyze(pcm, 22050, "yin")).rejects.toThrow("cancelled");
    expect(FakeWorker.instances).toHaveLength(2);
    client.terminate();
    await next;
  });

  it("rejects every pending request if sending to the worker fails", async () => {
    const client = new PitchWorkerClient();
    const first = expect(client.analyze(pcm, 22050, "yin")).rejects.toThrow("transfer failed");
    FakeWorker.instances[0]!.postMessage.mockImplementation(() => { throw new Error("transfer failed"); });
    await expect(client.analyze(pcm, 22050, "mpm")).rejects.toThrow("transfer failed");
    await first;
    expect(pcm.length).toBe(2);
  });

  it("settles construction failures as analysis errors", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("worker blocked"); } });
    const client = new PitchWorkerClient();
    await expect(client.analyze(pcm, 22050, "yin")).rejects.toThrow("worker blocked");
  });
});
