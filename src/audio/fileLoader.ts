import type { RecordedAudio } from "./recorder.js";
import { abortable, cancelled } from "./cancellation.js";
import { MAX_FILE_BYTES, validateAudio } from "./limits.js";

function readFile(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = (): void => { reader.abort(); reject(cancelled()); };
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    reader.onload = () => { cleanup(); resolve(reader.result as ArrayBuffer); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error("Could not read the audio file.")); };
    reader.onabort = () => { cleanup(); reject(cancelled()); };
    if (signal?.aborted) { reject(cancelled()); return; }
    signal?.addEventListener("abort", abort, { once: true });
    try { reader.readAsArrayBuffer(file); } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

/** PCM WAV describes its decoded size before the native decoder allocates it.
 * Other codecs still require the post-decode check; this is not a general demuxer. */
function checkPcmWav(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) return;
  let format: { channels: number; rate: number; blockAlign: number } | undefined;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const tag = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (size > view.byteLength - start) throw new Error("WAV chunk exceeds the file's available bytes.");
    if (tag === 0x666d7420 && size >= 16) {
      let code = view.getUint16(start, true);
      if (code === 0xfffe && size >= 40) code = view.getUint16(start + 24, true);
      if (code === 1 || code === 3) {
        format = { channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), blockAlign: view.getUint16(start + 12, true) };
      }
    }
    if (tag === 0x64617461) dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (format) validateAudio(dataBytes / format.blockAlign, format.rate, format.channels);
}

/** Decode a user-supplied audio file (wav/mp3/ogg/m4a - whatever the
 * browser's decodeAudioData supports) to mono PCM at the AudioContext's sample rate. */
export async function loadAudioFile(file: File, signal?: AbortSignal): Promise<RecordedAudio> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Audio files must be 25 MiB or smaller. Choose a short phrase.");
  if (signal?.aborted) throw cancelled();
  const arrayBuffer = await readFile(file, signal);
  if (signal?.aborted) throw cancelled();
  checkPcmWav(arrayBuffer);
  const context = new AudioContext();
  try {
    const audioBuffer = await abortable(context.decodeAudioData(arrayBuffer), signal);
    if (signal?.aborted) throw cancelled();
    const sampleRate = audioBuffer.sampleRate;
    validateAudio(audioBuffer.length, sampleRate, audioBuffer.numberOfChannels);
    if (audioBuffer.numberOfChannels === 1) {
      return { pcm: audioBuffer.getChannelData(0).slice(), sampleRate };
    }
    // Downmix to mono by averaging channels.
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i]! += data[i]! / audioBuffer.numberOfChannels;
    }
    return { pcm: mono, sampleRate };
  } finally {
    // A close failure must not erase a successful decode or the original error.
    try { await context.close(); } catch { /* No capture or playback nodes exist here. */ }
  }
}
