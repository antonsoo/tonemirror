import { afterEach, describe, expect, it, vi } from "vitest";
import { MicRecorder } from "../src/audio/recorder.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn<() => Promise<MediaStream>>().mockResolvedValue(stream);
  const context = {
    state: "running", sampleRate: 22050,
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
  };
  const node = {
    port: { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: vi.fn() },
    disconnect: vi.fn(),
  };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", vi.fn(function () { return context; }));
  vi.stubGlobal("AudioWorkletNode", vi.fn(function () { return node; }));
  return { recorder: new MicRecorder(), track, stream, getUserMedia, context, node };
}

afterEach(() => vi.unstubAllGlobals());

describe("microphone ownership", () => {
  it("stops tracks and closes the context if loading the worklet fails", async () => {
    const { recorder, track, context } = setup();
    context.audioWorklet.addModule.mockRejectedValue(new Error("worklet failed"));
    await expect(recorder.start()).rejects.toThrow("worklet failed");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(recorder.isRecording()).toBe(false);
    context.audioWorklet.addModule.mockResolvedValue(undefined);
    await recorder.start();
    expect(recorder.isRecording()).toBe(true);
    await recorder.cancel();
  });

  it("deduplicates overlapping starts while permission is pending", async () => {
    const { recorder, getUserMedia, stream } = setup();
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const first = recorder.start();
    expect(recorder.start()).toBe(first);
    expect(getUserMedia).toHaveBeenCalledOnce();
    permission.resolve(stream);
    await first;
    expect(recorder.isRecording()).toBe(true);
    await recorder.cancel();
  });

  it("disposes a late permission grant without cancelling a newer recording", async () => {
    const { recorder, getUserMedia, stream, track } = setup();
    const permission = deferred<MediaStream>();
    const lateTrack = { stop: vi.fn() };
    getUserMedia.mockReturnValueOnce(permission.promise).mockResolvedValue(stream);
    const first = expect(recorder.start()).rejects.toMatchObject({ name: "AbortError" });
    await recorder.cancel();
    await recorder.start();
    permission.resolve({ getTracks: () => [lateTrack] } as unknown as MediaStream);
    await first;
    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    expect(recorder.isRecording()).toBe(true);
    await recorder.cancel();
  });

  it("cancels during worklet setup and never connects the cancelled stream", async () => {
    const { recorder, context, track } = setup();
    const worklet = deferred<void>();
    context.audioWorklet.addModule.mockReturnValue(worklet.promise);
    const start = expect(recorder.start()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(context.audioWorklet.addModule).toHaveBeenCalledOnce());
    await recorder.cancel();
    worklet.resolve();
    await start;
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("returns captured samples and releases capture even if closing the context fails", async () => {
    const { recorder, node, track, context } = setup();
    await recorder.start();
    node.port.onmessage!({ data: new Float32Array([0.25, -0.5]) });
    node.port.onmessage!({ data: new Float32Array([0.75]) });
    context.close.mockRejectedValue(new Error("already closed"));
    const audio = await recorder.stop();
    expect(audio).toEqual({ pcm: new Float32Array([0.25, -0.5, 0.75]), sampleRate: 22050 });
    expect(recorder.isRecording()).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(node.port.onmessage).toBeNull();
    expect(node.port.close).toHaveBeenCalledOnce();
  });

  it("can retry after permission is denied", async () => {
    const { recorder, getUserMedia } = setup();
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(recorder.start()).rejects.toMatchObject({ name: "NotAllowedError" });
    await recorder.start();
    expect(recorder.isRecording()).toBe(true);
    await recorder.cancel();
  });
});
