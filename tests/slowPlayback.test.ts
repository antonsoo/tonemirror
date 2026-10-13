import { describe, expect, it } from "vitest";
import { prepareHalfSpeed } from "../src/audio/slowPlayback.js";

function tone(rate: number, frequency: number, seconds = 1): Float32Array {
  return Float32Array.from({ length: Math.floor(rate * seconds) }, (_, i) => 0.3 * Math.sin(2 * Math.PI * frequency * i / rate));
}

// A crossing count is independent of ToneMirror's pitch tracker and the stretcher.
function frequency(pcm: Float32Array, rate: number): number {
  const start = Math.floor(rate * 0.25), end = Math.floor(pcm.length - rate * 0.25);
  let crossings = 0;
  for (let i = start; i < end; i++) if (pcm[i - 1]! < 0 && pcm[i]! >= 0) crossings++;
  return crossings * rate / (end - start);
}

describe("same-pitch half-speed preview", () => {
  it.each([8000, 16000, 22050, 44100, 48000, 96000])("retains a 220 Hz voice fundamental at %i Hz, without modifying the source", async rate => {
    const original = tone(rate, 220), copy = original.slice();
    const slow = await prepareHalfSpeed(original, rate);
    expect(slow.length).toBe(original.length * 2);
    expect(Math.abs(frequency(slow, rate) - 220)).toBeLessThan(1);
    expect(slow.every(Number.isFinite)).toBe(true);
    expect(original).toEqual(copy);
  });

  it("preserves silence and exact length for partial processing blocks", async () => {
    const source = new Float32Array(12345);
    expect(await prepareHalfSpeed(source, 16000)).toEqual(new Float32Array(24690));
  });

  it("keeps separate jobs independent and never caches a previous clip's audio", async () => {
    const outputs = await Promise.all([220, 440].map(f => prepareHalfSpeed(tone(16000, f), 16000)));
    expect(Math.abs(frequency(outputs[0]!, 16000) - 220)).toBeLessThan(1);
    expect(Math.abs(frequency(outputs[1]!, 16000) - 440)).toBeLessThan(1);
  });

  it("rejects damaged or out-of-bounds audio before processing", async () => {
    await expect(prepareHalfSpeed(new Float32Array([NaN]), 16000)).rejects.toThrow("finite");
    await expect(prepareHalfSpeed(new Float32Array(), 16000)).rejects.toThrow("no audio");
    await expect(prepareHalfSpeed(new Float32Array(16000 * 61), 16000)).rejects.toThrow("60 seconds");
  });
});
