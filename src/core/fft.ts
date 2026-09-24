/**
 * A minimal, dependency-free radix-2 Cooley-Tukey FFT.
 *
 * Iterative, in-place, bit-reversal permutation followed by butterfly passes.
 * This is the classic textbook formulation (Cooley & Tukey, 1965, "An
 * Algorithm for the Machine Calculation of Complex Fourier Series"); nothing
 * exotic, but it is *our* implementation rather than a library, per the
 * project's goal of doing the DSP from scratch.
 *
 * Operates on separate real/imaginary Float64Array buffers of length N,
 * where N must be a power of two.
 */

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Smallest power of two that is >= n. */
export function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

/**
 * In-place FFT. `re`/`im` are overwritten with the transform.
 * `inverse` performs the inverse transform (with 1/N scaling).
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length) throw new Error("fft: re/im length mismatch");
  if (!isPowerOfTwo(n)) throw new Error(`fft: length ${n} is not a power of two`);
  if (n <= 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angleStep = (sign * 2 * Math.PI) / len;
    // Precompute twiddle factors for this stage.
    const wRe = new Float64Array(half);
    const wIm = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const angle = angleStep * k;
      wRe[k] = Math.cos(angle);
      wIm[k] = Math.sin(angle);
    }
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const evenIdx = start + k;
        const oddIdx = start + k + half;
        const evenRe = re[evenIdx]!;
        const evenIm = im[evenIdx]!;
        const oddRe = re[oddIdx]!;
        const oddIm = im[oddIdx]!;
        const twRe = wRe[k]!;
        const twIm = wIm[k]!;
        const tRe = oddRe * twRe - oddIm * twIm;
        const tIm = oddRe * twIm + oddIm * twRe;
        re[evenIdx] = evenRe + tRe;
        im[evenIdx] = evenIm + tIm;
        re[oddIdx] = evenRe - tRe;
        im[oddIdx] = evenIm - tIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i]! /= n;
      im[i]! /= n;
    }
  }
}

/**
 * Real-input magnitude spectrum of one frame, zero-padded to the next power
 * of two if needed. Returns magnitudes for bins [0, N/2] inclusive (DC to
 * Nyquist), i.e. length floor(N/2) + 1 where N is the padded FFT size.
 */
export function magnitudeSpectrum(frame: Float64Array | Float32Array): Float64Array {
  const n = nextPowerOfTwo(frame.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(frame);
  fft(re, im, false);
  const bins = n / 2 + 1;
  const mag = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    mag[i] = Math.hypot(re[i]!, im[i]!);
  }
  return mag;
}
