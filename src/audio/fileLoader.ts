import type { RecordedAudio } from "./recorder.js";

/** Decode a user-supplied audio file (wav/mp3/ogg/m4a - whatever the
 * browser's decodeAudioData supports) to mono PCM at its native sample rate. */
export async function loadAudioFile(file: File): Promise<RecordedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const context = new AudioContext();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
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
    await context.close();
  }
}
