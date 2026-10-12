import { describe, expect, it } from "vitest";
import { encodeWav, wavFilename } from "../src/audio/wav.js";

describe("portable clip audio", () => {
  it("retains subarray samples, including values outside integer PCM's range", () => {
    const source = new Float32Array([99, -1.25, -0, 0.0000001, 1.25, 99]);
    const pcm = source.subarray(1, 5), view = new DataView(encodeWav(pcm, 48000));
    const samples = [];
    for (let at = 12; at < view.byteLength;) {
      const size = view.getUint32(at + 4, true);
      if (view.getUint32(at) === 0x64617461) {
        for (let i = 0; i < size; i += 4) samples.push(view.getFloat32(at + 8 + i, true));
      }
      at += 8 + size + size % 2;
    }
    expect(samples).toEqual([...pcm]);
    expect(source[0]).toBe(99);
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
  });

  it("rejects nonfinite samples and invalid clip sizes instead of exporting damaged audio", () => {
    for (const bad of [NaN, Infinity, -Infinity]) expect(() => encodeWav(new Float32Array([bad]), 44100)).toThrow("invalid audio samples");
    expect(() => encodeWav(new Float32Array(), 44100)).toThrow("no audio");
    expect(() => encodeWav(new Float32Array(1), 44100.5)).toThrow("sample rate");
    expect(() => encodeWav(new Float32Array(48000 * 60 + 1), 48000)).toThrow("60 seconds");
  });

  it("keeps role and synthetic identity in portable filenames", () => {
    expect(wavFilename("CON.wav", "attempt", false)).toBe("tonemirror-attempt-CON.wav");
    expect(wavFilename("../../rise:fall?.wav", "reference", true)).toBe("tonemirror-synthetic-reference-..-..-rise-fall-.wav");
    expect(wavFilename("汉语.wav", "reference", false)).toBe("tonemirror-reference-汉语.wav");
    expect(wavFilename("...", "attempt", false)).toBe("tonemirror-attempt-clip.wav");
  });
});
