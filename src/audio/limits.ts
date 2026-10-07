/** Browser practice clips are short; reject oversized inputs without truncating them. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 60;
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_AUDIO_CHANNELS = 8;
export const MAX_SPECTROGRAM_FRAMES = 4096;

export function validateAudio(length: number, sampleRate: number, channels = 1): void {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
    throw new Error("Use audio with a sample rate between 8 and 96 kHz.");
  }
  if (!Number.isInteger(length) || length <= 0) throw new Error("This clip contains no audio samples.");
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_AUDIO_CHANNELS) {
    throw new Error(`Use audio with at most ${MAX_AUDIO_CHANNELS} channels.`);
  }
  if (length / sampleRate > MAX_AUDIO_SECONDS) {
    throw new Error(`Choose a phrase of ${MAX_AUDIO_SECONDS} seconds or less. Longer clips are not truncated.`);
  }
  if (length * channels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_BYTES) {
    throw new Error("Decoded audio exceeds 64 MiB. Choose a shorter clip or fewer channels.");
  }
}
