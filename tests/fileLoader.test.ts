import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAudioFile } from "../src/audio/fileLoader.js";
import { MAX_AUDIO_SECONDS, MAX_FILE_BYTES, validateAudio } from "../src/audio/limits.js";

class Reader {
  static instances: Reader[] = [];
  static hold = false;
  result = new ArrayBuffer(8);
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error = null;
  abort = vi.fn(() => this.onabort?.());
  readAsArrayBuffer = vi.fn(() => { if (!Reader.hold) queueMicrotask(() => this.onload?.()); });
  constructor() { Reader.instances.push(this); }
}

function setup() {
  Reader.instances = [];
  Reader.hold = false;
  vi.stubGlobal("FileReader", Reader);
  const audio = {
    sampleRate: 22050, length: 3, numberOfChannels: 1,
    getChannelData: vi.fn(() => new Float32Array([0.5, -0.25, 0.75])),
  };
  const context = { decodeAudioData: vi.fn().mockResolvedValue(audio), close: vi.fn().mockResolvedValue(undefined) };
  const constructor = vi.fn(function () { return context; });
  vi.stubGlobal("AudioContext", constructor);
  const file = { size: 8 } as File;
  return { audio, context, constructor, file };
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded audio decoding", () => {
  it("rejects large encoded files before reading or constructing a decoder", async () => {
    const { constructor } = setup();
    await expect(loadAudioFile({ size: MAX_FILE_BYTES + 1 } as File)).rejects.toThrow("25 MiB");
    expect(Reader.instances).toHaveLength(0);
    expect(constructor).not.toHaveBeenCalled();
  });

  it.each([
    { length: 22050 * 61, numberOfChannels: 1, sampleRate: 22050, message: "60 seconds" },
    { length: 3, numberOfChannels: 9, sampleRate: 22050, message: "8 channels" },
    { length: 0, numberOfChannels: 1, sampleRate: 22050, message: "no audio" },
    { length: 3, numberOfChannels: 1, sampleRate: NaN, message: "sample rate" },
    { length: 96000 * 60, numberOfChannels: 4, sampleRate: 96000, message: "64 MiB" },
  ])("checks decoded dimensions before copying samples: $message", async ({ length, numberOfChannels, sampleRate, message }) => {
    const { audio, context, file } = setup();
    Object.assign(audio, { length, numberOfChannels, sampleRate });
    await expect(loadAudioFile(file)).rejects.toThrow(message);
    expect(audio.getChannelData).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("cancels a pending file read before decoding", async () => {
    const { file, constructor } = setup();
    Reader.hold = true;
    const controller = new AbortController();
    const result = expect(loadAudioFile(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(Reader.instances[0]!.abort).toHaveBeenCalledOnce();
    expect(constructor).not.toHaveBeenCalled();
  });

  it("abandons native decoding promptly and observes its late rejection", async () => {
    const { context, file } = setup();
    let reject!: (error: Error) => void;
    context.decodeAudioData.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const controller = new AbortController();
    const result = expect(loadAudioFile(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    controller.abort();
    await result;
    expect(context.close).toHaveBeenCalledOnce();
    reject(new Error("decoder completed after cancellation"));
    await Promise.resolve();
  });

  it("downmixes by channel average and keeps decoded audio if closing fails", async () => {
    const { audio, context, file } = setup();
    audio.numberOfChannels = 2;
    audio.getChannelData.mockReturnValueOnce(new Float32Array([1, -1, 0])).mockReturnValueOnce(new Float32Array([0, 1, 1]));
    context.close.mockRejectedValue(new Error("already closed"));
    await expect(loadAudioFile(file)).resolves.toEqual({ pcm: new Float32Array([0.5, 0, 0.5]), sampleRate: 22050 });
  });

  it("accepts the exact duration boundary and rejects one excess sample", () => {
    expect(() => validateAudio(48000 * MAX_AUDIO_SECONDS, 48000)).not.toThrow();
    expect(() => validateAudio(48000 * MAX_AUDIO_SECONDS + 1, 48000)).toThrow("60 seconds");
  });
});
