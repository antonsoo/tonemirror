/** Window functions used by the spectrogram (YIN/MPM use raw frames, per the
 * original papers, which rely on the difference/autocorrelation function's
 * own tapering rather than an explicit analysis window). */

export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  if (size === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

export function applyWindow(frame: Float32Array | Float64Array, window: Float64Array): Float64Array {
  const out = new Float64Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    out[i] = frame[i]! * window[i]!;
  }
  return out;
}
