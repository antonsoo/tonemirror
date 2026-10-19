/** A zero-based file channel, or the existing all-channel average. */
export type AudioChannelChoice = "mix" | number;

interface DecodedChannels {
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Keep channel selection explicit: a mix can erase opposite-polarity speech
 * or combine speakers, neither of which establishes which voice was intended. */
export function selectAudioChannel(audio: DecodedChannels, choice: AudioChannelChoice = "mix"): Float32Array {
  const count = audio.numberOfChannels;
  if (choice !== "mix") {
    if (!Number.isInteger(choice) || choice < 0 || choice >= count) {
      throw new RangeError(`This file has ${count} channel${count === 1 ? "" : "s"}. Choose Mix all channels or Channel 1${count > 1 ? ` through ${count}` : ""}.`);
    }
    return audio.getChannelData(choice).slice();
  }
  if (count === 1) return audio.getChannelData(0).slice();
  const mono = new Float32Array(audio.length);
  let strongestEnergy = 0;
  for (let channel = 0; channel < count; channel++) {
    const data = audio.getChannelData(channel);
    let energy = 0;
    for (let i = 0; i < audio.length; i++) {
      const value = data[i]!;
      mono[i]! += value / count;
      energy += value * value;
    }
    strongestEnergy = Math.max(strongestEnergy, energy);
  }
  let mixedEnergy = 0;
  for (const value of mono) mixedEnergy += value * value;
  // A 40 dB RMS loss relative to the strongest channel indicates near-total
  // cancellation. Ignore numerical silence; do not silently pick a speaker.
  if (strongestEnergy > audio.length * 1e-12 && mixedEnergy < strongestEnergy * 1e-4) {
    throw new Error("Mixing these channels cancels almost all sound. Open File channels, choose an individual channel, and load the file again.");
  }
  return mono;
}
