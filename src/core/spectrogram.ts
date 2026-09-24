import { magnitudeSpectrum } from "./fft.js";
import { applyWindow, hannWindow } from "./window.js";

export interface SpectrogramOptions {
  fftSize?: number;
  hopSize?: number;
  /** Noise floor for the dB scale; magnitudes below this are clamped. */
  floorDb?: number;
}

export interface Spectrogram {
  /** frames[i] is a magnitude-in-dB array of length fftSize/2 + 1, for the frame at times[i]. */
  frames: Float64Array[];
  times: number[];
  /** Frequency (Hz) of bin k is k * freqStep. */
  freqStep: number;
  floorDb: number;
}

export function computeSpectrogram(
  signal: Float32Array | Float64Array,
  sampleRate: number,
  options: SpectrogramOptions = {},
): Spectrogram {
  const fftSize = options.fftSize ?? 1024;
  const hopSize = options.hopSize ?? 256;
  const floorDb = options.floorDb ?? -90;
  const window = hannWindow(fftSize);

  const frames: Float64Array[] = [];
  const times: number[] = [];

  if (signal.length < fftSize) {
    return { frames, times, freqStep: sampleRate / fftSize, floorDb };
  }

  for (let start = 0; start + fftSize <= signal.length; start += hopSize) {
    const slice = signal.subarray(start, start + fftSize);
    const windowed = applyWindow(slice, window);
    const mag = magnitudeSpectrum(windowed);
    const db = new Float64Array(mag.length);
    for (let i = 0; i < mag.length; i++) {
      const value = 20 * Math.log10(Math.max(mag[i]!, 1e-12));
      db[i] = Math.max(value, floorDb);
    }
    frames.push(db);
    times.push((start + fftSize / 2) / sampleRate);
  }

  return { frames, times, freqStep: sampleRate / fftSize, floorDb };
}
