import { describe, expect, it } from "vitest";
import { selectAudioChannel } from "../src/audio/channels.js";

const decoded = (...channels: Float32Array[]) => ({
  numberOfChannels: channels.length,
  length: channels[0]!.length,
  getChannelData: (index: number) => channels[index]!,
});

describe("file-channel choices", () => {
  it("refuses near-total cancellation and leaves an explicit channel available", () => {
    const left = new Float32Array([0.25, -0.5, 0.75, -0.125]);
    const right = left.map(value => -value);
    const audio = decoded(left, right);
    expect(() => selectAudioChannel(audio)).toThrow("cancels almost all sound");
    const selected = selectAudioChannel(audio, 0);
    expect(selected).toEqual(left);
    expect(selected).not.toBe(left);
    expect(selectAudioChannel(audio, 1)).toEqual(right);
  });

  it("keeps actual stereo silence as ordinary unvoiced audio", () => {
    expect(selectAudioChannel(decoded(new Float32Array(4), new Float32Array(4)))).toEqual(new Float32Array(4));
  });

  it("never reads a missing channel or guesses a replacement", () => {
    const audio = { numberOfChannels: 2, length: 1, getChannelData: () => { throw new Error("should not read"); } };
    expect(() => selectAudioChannel(audio, 7)).toThrow("This file has 2 channels");
  });
});
