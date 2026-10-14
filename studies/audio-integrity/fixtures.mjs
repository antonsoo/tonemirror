// Constructed IEEE float WAVE files; independent of ToneMirror's export encoder.
export const cases = [
  { id: 'nan-middle', value: NaN, location: 'middle' },
  { id: 'infinity-middle', value: Infinity, location: 'middle' },
  { id: 'negative-infinity-middle', value: -Infinity, location: 'middle' },
  { id: 'nan-last', value: NaN, location: 'last' },
];

export function floatWav({ value, location = 'middle', channels = 1, silence = false } = {}) {
  const rate = 44100, frames = rate;
  const bytes = Buffer.alloc(58 + frames * channels * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(18, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('fact', 38); bytes.writeUInt32LE(4, 42); bytes.writeUInt32LE(frames, 46);
  bytes.write('data', 50); bytes.writeUInt32LE(frames * channels * 4, 54);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const damaged = value !== undefined && channel === channels - 1 &&
      (location === 'last' ? frame === frames - 1 : frame >= rate / 4 && frame < rate / 2);
    const sample = damaged ? value : silence ? 0 : 0.3 * Math.sin(2 * Math.PI * 220 * frame / rate);
    bytes.writeFloatLE(sample, 58 + (frame * channels + channel) * 4);
  }
  return bytes;
}

export const upload = (name, options) => ({ name, mimeType: 'audio/wav', buffer: floatWav(options) });
