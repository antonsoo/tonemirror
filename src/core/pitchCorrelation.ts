import { fft, nextPowerOfTwo } from "./fft.js";

// FFT setup costs more than the direct sums on small speech frames. These
// cutoffs choose an implementation, not a different analysis window or lag.
const MIN_FFT_LAG = 512;
const CANCELLATION_RATIO = 1e-12;

function differenceAt(frame: Float64Array, width: number, lag: number): number {
  let sum = 0;
  for (let j = 0; j < width; j++) {
    const delta = frame[j]! - frame[j + lag]!;
    sum += delta * delta;
  }
  return sum;
}

/** YIN's fixed-width sum of squared differences, including lag zero. */
export function differenceFunction(frame: Float64Array, maxLag: number): Float64Array {
  const width = frame.length - maxLag;
  const difference = new Float64Array(maxLag + 1);
  if (maxLag < MIN_FFT_LAG || width < MIN_FFT_LAG) {
    for (let lag = 1; lag <= maxLag; lag++) difference[lag] = differenceAt(frame, width, lag);
    return difference;
  }

  // Subtracting a constant leaves differences unchanged and avoids cancellation
  // from DC offset. Using an actual sample also makes a flat frame exactly zero.
  const shifted = Float64Array.from(frame, value => value - frame[0]!);
  const size = nextPowerOfTwo(frame.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(shifted.subarray(0, width));
  im.set(shifted);
  fft(re, im);

  // Pack real signals a (the fixed window) and b (the whole frame) as a+i*b.
  // Recover their spectra using conjugate symmetry, then form conj(A)*B.
  // N >= frame.length is sufficient: j+lag never wraps for the retained lags.
  for (let k = 0; k <= size / 2; k++) {
    const mirror = (size - k) % size;
    const aRe = 0.5 * (re[k]! + re[mirror]!);
    const aIm = 0.5 * (im[k]! - im[mirror]!);
    const bRe = 0.5 * (im[k]! + im[mirror]!);
    const bIm = 0.5 * (re[mirror]! - re[k]!);
    const real = aRe * bRe + aIm * bIm;
    const imaginary = aRe * bIm - aIm * bRe;
    re[k] = re[mirror] = real;
    im[k] = imaginary;
    im[mirror] = -imaginary;
  }
  fft(re, im, true);

  let anchorEnergy = 0;
  for (let j = 0; j < width; j++) anchorEnergy += shifted[j]! ** 2;
  let movingEnergy = anchorEnergy;
  for (let lag = 1; lag <= maxLag; lag++) {
    movingEnergy += shifted[lag + width - 1]! ** 2 - shifted[lag - 1]! ** 2;
    const energy = anchorEnergy + movingEnergy;
    const value = energy - 2 * re[lag]!;
    // Near-perfect repetition subtracts almost equal energies. Recompute such
    // lags directly instead of clipping away a small but real difference.
    difference[lag] = value <= CANCELLATION_RATIO * energy
      ? differenceAt(frame, width, lag)
      : value;
  }
  return difference;
}

/** MPM's autocorrelation normalized by both overlapping windows' energies. */
export function normalizedSquareDifference(frame: Float64Array, maxLag: number): Float64Array {
  const length = frame.length;
  const result = new Float64Array(maxLag + 1);
  // When the windows do not cover the whole frame, a large excluded middle
  // sample can swamp their correlation in the FFT. Keep those unusual windows
  // on the direct path (the app uses length == 2*maxLag).
  if (maxLag < MIN_FFT_LAG || 2 * maxLag > length) {
    for (let lag = 0; lag <= maxLag; lag++) {
      let correlation = 0;
      let energy = 0;
      for (let j = 0; j < length - lag; j++) {
        const a = frame[j]!;
        const b = frame[j + lag]!;
        correlation += a * b;
        energy += a * a + b * b;
      }
      result[lag] = energy === 0 ? 0 : 2 * correlation / energy;
    }
    return result;
  }

  // Padding through length+maxLag prevents circular wrap in every retained lag.
  const size = nextPowerOfTwo(length + maxLag);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(frame);
  fft(re, im);
  for (let k = 0; k < size; k++) {
    re[k] = re[k]! ** 2 + im[k]! ** 2;
    im[k] = 0;
  }
  fft(re, im, true);

  // Accumulate from both ends, avoiding subtraction of nearly equal prefix
  // totals when a window has much less energy than the complete frame.
  const prefix = new Float64Array(length + 1);
  const suffix = new Float64Array(length + 1);
  for (let j = 0; j < length; j++) {
    prefix[j + 1] = prefix[j]! + frame[j]! ** 2;
    const end = length - 1 - j;
    suffix[end] = suffix[end + 1]! + frame[end]! ** 2;
  }
  for (let lag = 0; lag <= maxLag; lag++) {
    const energy = prefix[length - lag]! + suffix[lag]!;
    let correlation = re[lag]!;
    // Exact zero crossings delimit MPM's candidate lobes. Do not let FFT
    // roundoff invent a crossing for a sparse or exactly periodic signal.
    if (energy > 0 && Math.abs(correlation) <= CANCELLATION_RATIO * energy) {
      correlation = 0;
      for (let j = 0; j < length - lag; j++) correlation += frame[j]! * frame[j + lag]!;
    }
    result[lag] = energy === 0 ? 0 : 2 * correlation / energy;
  }
  return result;
}
