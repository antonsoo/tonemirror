/** Shared types for the pitch-tracking and comparison core. Kept dependency-free
 * and DOM-free so this module runs identically in Node (tests), a Worker, and
 * the main thread. */

/** One analysis frame's pitch estimate, before any smoothing/correction. */
export interface PitchFrame {
  /** Frame center time, in seconds from the start of the signal. */
  time: number;
  /** Estimated fundamental frequency in Hz, or null if unvoiced/undetermined. */
  f0: number | null;
  /** Detector confidence in [0, 1]; 1 = perfectly periodic. */
  confidence: number;
  /** Whether the frame was judged voiced (has a discernible pitch). */
  voiced: boolean;
  /** RMS amplitude of the frame, 0..1-ish (depends on input scale). */
  rms: number;
}

/** A frame after octave-error correction, median smoothing, and semitone
 * normalization relative to the contour's own voiced median. */
export interface ContourPoint {
  time: number;
  f0: number | null;
  /** Semitones relative to the contour's voiced median F0. Null if unvoiced. */
  semitone: number | null;
  voiced: boolean;
  confidence: number;
}

export interface PitchContour {
  points: ContourPoint[];
  /** Median F0 (Hz) over voiced frames, used as the semitone reference. */
  medianF0: number | null;
  hopSeconds: number;
  frameSeconds: number;
  sampleRate: number;
}

export type PitchAlgorithm = "yin" | "mpm";

export interface PitchTrackOptions {
  sampleRate: number;
  /** Analysis algorithm. Default "yin". */
  algorithm?: PitchAlgorithm;
  /** Minimum trackable frequency in Hz. Default 60 (low male voice floor). */
  minFrequency?: number;
  /** Maximum trackable frequency in Hz. Default 1000 (covers falsetto/child speech). */
  maxFrequency?: number;
  /** Hop size in seconds between analysis frames. Default 0.01 (10ms / 100Hz). */
  hopSeconds?: number;
  /** YIN absolute threshold for the cumulative mean normalized difference. Default 0.15. */
  yinThreshold?: number;
  /** MPM "k" clarity threshold for key-maximum picking. Default 0.93. */
  mpmClarityThreshold?: number;
  /** RMS below which a frame is forced unvoiced regardless of periodicity. Default 0.003. */
  silenceRms?: number;
  /** Median filter window (in frames, odd) applied to voiced F0. Default 5. */
  medianWindow?: number;
}
