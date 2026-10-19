import type { RecordedAudio } from "./recorder.js";
import { abortable, cancelled } from "./cancellation.js";
import { MAX_FILE_BYTES, validateAudio } from "./limits.js";
import { WAV_SOFTWARE, WAV_SYNTHETIC_COMMENT } from "./wav.js";
import { CREDIT_COMMENT_PREFIX, parseAudioCredit, type AudioCredit } from "./credit.js";
import { selectAudioChannel, type AudioChannelChoice } from "./channels.js";

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
function checkPcmWav(buffer: ArrayBuffer): { synthetic: boolean; credit?: AudioCredit } {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) return { synthetic: false };
  let format: { channels: number; rate: number; blockAlign: number } | undefined;
  let dataBytes = 0;
  const software = new Set<string>(), comments = new Set<string>(), credits = new Set<string>();
  let unreadableCredit = false;
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
    if (tag === 0x4c495354 && size >= 4 && view.getUint32(start) === 0x494e464f) {
      for (let at = start + 4; at + 8 <= start + size;) {
        const length = view.getUint32(at + 4, true), field = view.getUint32(at);
        if (length > start + size - at - 8) {
          const available = start + size - at - 8;
          const prefix = new TextDecoder().decode(new Uint8Array(buffer, at + 8, Math.min(available, CREDIT_COMMENT_PREFIX.length)));
          if (field === 0x49434f50 && prefix === CREDIT_COMMENT_PREFIX) unreadableCredit = true;
          break;
        }
        if (field === 0x49434f50) {
          const prefix = new TextDecoder().decode(new Uint8Array(buffer, at + 8, Math.min(length, CREDIT_COMMENT_PREFIX.length)));
          if (prefix === CREDIT_COMMENT_PREFIX) {
            if (length > 4096) unreadableCredit = true;
            else {
              try { credits.add(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buffer, at + 8, length)).replace(/\0$/, "")); }
              catch { unreadableCredit = true; }
            }
          }
        } else if (length <= 256 && (field === 0x49534654 || field === 0x49434d54)) {
          const text = new TextDecoder().decode(new Uint8Array(buffer, at + 8, length)).replace(/\0$/, "");
          (field === 0x49534654 ? software : comments).add(text);
        }
        at += 8 + length + length % 2;
      }
    }
    offset = start + size + (size % 2);
  }
  if (format) validateAudio(dataBytes / format.blockAlign, format.rate, format.channels);
  const fromToneMirror = software.size === 1 && software.has(WAV_SOFTWARE);
  const credit = fromToneMirror && credits.size === 1 ? parseAudioCredit([...credits][0]!) : undefined;
  if (fromToneMirror && (unreadableCredit || credits.size > 1 || (credits.size === 1 && !credit))) throw new Error("The WAV's ToneMirror audio credit is unreadable or ambiguous. Keep the original file and its source details.");
  return {
    synthetic: fromToneMirror && comments.size === 1 && comments.has(WAV_SYNTHETIC_COMMENT),
    ...(credit ? { credit } : {}),
  };
}

/** Decode a user-supplied audio file (wav/mp3/ogg/m4a - whatever the
 * browser's decodeAudioData supports) to mono PCM at the AudioContext's sample rate. */
export async function loadAudioFile(file: File, signal?: AbortSignal, channel: AudioChannelChoice = "mix"): Promise<RecordedAudio & { synthetic: boolean; credit?: AudioCredit; sourceChannels: number }> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Audio files must be 25 MiB or smaller. Choose a short phrase.");
  if (signal?.aborted) throw cancelled();
  const arrayBuffer = await readFile(file, signal);
  if (signal?.aborted) throw cancelled();
  const metadata = checkPcmWav(arrayBuffer);
  const context = new AudioContext();
  try {
    const audioBuffer = await abortable(context.decodeAudioData(arrayBuffer), signal);
    if (signal?.aborted) throw cancelled();
    const sampleRate = audioBuffer.sampleRate;
    validateAudio(audioBuffer.length, sampleRate, audioBuffer.numberOfChannels);
    const pcm = selectAudioChannel(audioBuffer, channel);
    if (signal?.aborted) throw cancelled();
    return { pcm, sampleRate, sourceChannels: audioBuffer.numberOfChannels, ...metadata };
  } finally {
    // A close failure must not erase a successful decode or the original error.
    try { await context.close(); } catch { /* No capture or playback nodes exist here. */ }
  }
}
