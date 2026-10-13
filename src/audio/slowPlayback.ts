import createStretch from "../vendor/signalsmith-stretch.mjs";
import { validateAudio } from "./limits.js";

/** A playback-only preview: no resampling, pitch shift, or change to stored PCM.
 * The DSP's input/output latency is removed after feeding enough zero tail to
 * flush it. The preview has exactly twice as many frames as its source.
 * Run in a disposable worker so cancellation also releases the WASM heap.
 */
export async function prepareHalfSpeed(pcm: Float32Array, sampleRate: number): Promise<Float32Array> {
  validateAudio(pcm.length, sampleRate);
  if (!pcm.every(Number.isFinite)) throw new Error("Slow playback needs finite audio samples.");
  const stretch = await createStretch();
  stretch._presetDefault(1, sampleRate);
  stretch._reset();
  const inputBlock = 512;
  const outputBlock = inputBlock * 2;
  const pointer = stretch._setBuffers(1, outputBlock);
  const latency = stretch._inputLatency() * 2 + stretch._outputLatency();
  const output = new Float32Array(pcm.length * 2);
  const total = output.length + latency;
  let inputOffset = 0;
  for (let offset = 0; offset < total; offset += outputBlock) {
    // Emscripten can grow memory. Reacquire views instead of retaining a stale buffer.
    const input = new Float32Array(stretch.HEAP8.buffer, pointer, inputBlock);
    input.fill(0);
    input.set(pcm.subarray(inputOffset, inputOffset + inputBlock));
    stretch._process(inputBlock, outputBlock);
    const rendered = new Float32Array(stretch.HEAP8.buffer, pointer + outputBlock * 4, outputBlock);
    const first = Math.max(0, latency - offset);
    const end = Math.min(outputBlock, total - offset);
    if (end > first) output.set(rendered.subarray(first, end), Math.max(0, offset - latency));
    inputOffset += inputBlock;
  }
  if (!output.every(Number.isFinite)) throw new Error("Slow playback could not produce finite audio samples.");
  return output;
}
