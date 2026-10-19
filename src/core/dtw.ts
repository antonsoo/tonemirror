import type { PitchContour } from "./types.js";

export interface DtwSample {
  time: number;
  semitone: number;
  /** No observed voiced continuity from the preceding sample. */
  breakBefore?: true;
}

export interface DtwStep {
  /** Index into the reference's voiced-sample array. */
  refIndex: number;
  /** Index into the attempt's voiced-sample array. */
  attemptIndex: number;
}

export interface AlignmentResult {
  /** Warping path from (0,0) to (n-1,m-1), monotonic in both indices. */
  path: DtwStep[];
  /** Total accumulated |semitone difference| cost along the path. */
  totalCost: number | null;
  /** totalCost / path length - the scale-free distance used for scoring. */
  meanCostPerStep: number | null;
  /** 0-100 similarity score derived from meanCostPerStep. */
  score: number | null;
  sampling: {
    reference: { frames: number; voiced: number; aligned: number };
    attempt: { frames: number; voiced: number; aligned: number };
  };
  reference: DtwSample[];
  attempt: DtwSample[];
  feedback: string[];
}

/** Keep voiced samples in order, retaining discontinuities for drawing. */
export function toDtwSamples(contour: PitchContour): DtwSample[] {
  const out: DtwSample[] = [];
  let previousIndex = -1;
  const hop = Math.max(1, Math.round(contour.hopSeconds * contour.sampleRate)) / contour.sampleRate;
  for (let i = 0; i < contour.points.length; i++) {
    const p = contour.points[i]!;
    // A semitone that is not a number has no distance to anything: one of them would turn the
    // whole alignment's cost, and the score, into NaN.
    if (p.voiced && p.semitone !== null && Number.isFinite(p.semitone) && Number.isFinite(p.time) && p.time >= 0) {
      if (out.length && p.time <= out[out.length - 1]!.time) throw new Error("Voiced contour times must be strictly increasing.");
      const previous = out[out.length - 1];
      const gap = previous && (i !== previousIndex + 1 || p.time - previous.time > hop * 1.5);
      out.push({ time: p.time, semitone: p.semitone, ...(gap ? { breakBefore: true as const } : {}) });
      previousIndex = i;
    }
  }
  return out;
}

/**
 * The most voiced samples a contour is aligned with: a minute of continuous
 * speech at the default 10 ms hop. Alignment takes time and memory in
 * proportion to the two lengths multiplied. Longer contours supplied to the
 * core API are sampled evenly to this size, including both endpoints. This
 * approximation has no general error bound. Browser clips fit below the
 * limit and keep every usable voiced point.
 */
export const MAX_ALIGNED_SAMPLES = 6000;

function thinned(samples: DtwSample[]): DtwSample[] {
  if (samples.length <= MAX_ALIGNED_SAMPLES) return samples;
  const out: DtwSample[] = [];
  // Keep both endpoints: the final pitch movement must not vanish at the limit.
  let previous = -1;
  for (let i = 0; i < MAX_ALIGNED_SAMPLES; i++) {
    const index = Math.floor(i * (samples.length - 1) / (MAX_ALIGNED_SAMPLES - 1));
    // A selected endpoint may itself be contiguous while the discarded samples
    // include a gap. Thinning must not turn that missing observation into ink.
    let gap = false;
    for (let j = previous + 1; j <= index; j++) gap ||= samples[j]!.breakBefore === true;
    const sample = samples[index]!;
    out.push(gap ? { ...sample, breakBefore: true } : sample);
    previous = index;
  }
  return out;
}

const DIAGONAL = 0;
const UP = 1;
const LEFT = 2;

/**
 * Classic dynamic time warping (Sakoe & Chiba's DP formulation) between two
 * 1-D sequences, with a symmetric step pattern (match / insertion / deletion,
 * unit cost per step) and Euclidean (here, absolute-value) local cost.
 * Returns the minimum-cost path and its cost.
 */
export function dtwAlign(a: number[], b: number[]): { path: DtwStep[]; totalCost: number } {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return { path: [], totalCost: 0 };
  if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) throw new Error("DTW samples must be finite numbers.");

  // above[j] = min cumulative cost to align a[0..i-1) with b[0..j); row[j] the same for a[0..i).
  // Filling a row needs only the row above it, so two rows are kept rather than the whole
  // table, plus one byte per cell saying which neighbor its best path came from, which is all
  // the backtrack reads.
  let above = new Float64Array(m + 1).fill(Infinity);
  let row = new Float64Array(m + 1);
  above[0] = 0;
  const cameFrom = new Uint8Array(n * m);

  for (let i = 1; i <= n; i++) {
    const value = a[i - 1]!;
    const offset = (i - 1) * m - 1;
    row[0] = Infinity;
    for (let j = 1; j <= m; j++) {
      const diag = above[j - 1]!;
      const up = above[j]!;
      const left = row[j - 1]!;
      const local = Math.abs(value - b[j - 1]!);
      // Ties go to the diagonal, then to "up".
      if (diag <= up && diag <= left) {
        row[j] = local + diag;
        cameFrom[offset + j] = DIAGONAL;
      } else if (up <= left) {
        row[j] = local + up;
        cameFrom[offset + j] = UP;
      } else {
        row[j] = local + left;
        cameFrom[offset + j] = LEFT;
      }
    }
    [above, row] = [row, above];
  }

  // Backtrack from (n,m) to (0,0).
  const path: DtwStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    path.push({ refIndex: i - 1, attemptIndex: j - 1 });
    const step = cameFrom[(i - 1) * m + (j - 1)]!;
    if (step === DIAGONAL) {
      i--;
      j--;
    } else if (step === UP) {
      i--;
    } else {
      j--;
    }
  }
  path.reverse();

  if (!Number.isFinite(above[m]!)) throw new Error("DTW cost is outside the representable numeric range.");
  return { path, totalCost: above[m]! };
}

/** Maps mean per-step semitone cost to a 0-100 score. A perfect match (cost 0)
 * scores 100; the exponential decay means small divergences (under ~1
 * semitone average) still score highly, while a 4+ semitone average miss
 * drops below 25. `scale` is the e-folding distance in semitones (2.8 maps
 * to about 37), chosen against synthetic tone fixtures, not human judgments. */
function costToScore(meanCostPerStep: number, scale = 2.8): number {
  return Math.round(100 * Math.exp(-meanCostPerStep / scale));
}

interface Segment {
  name: string;
  startFrac: number;
  endFrac: number;
}

const SEGMENTS: Segment[] = [
  { name: "the start", startFrac: 0, endFrac: 1 / 3 },
  { name: "the middle", startFrac: 1 / 3, endFrac: 2 / 3 },
  { name: "the end", startFrac: 2 / 3, endFrac: 1 },
];

function slope(samples: DtwSample[], fromIdx: number, toIdx: number): number {
  if (toIdx <= fromIdx) return 0;
  const dt = samples[toIdx]!.time - samples[fromIdx]!.time;
  if (dt <= 0) return 0;
  const span = samples[samples.length - 1]!.time - samples[0]!.time;
  return (samples[toIdx]!.semitone - samples[fromIdx]!.semitone) / (dt / span);
}

/** Below this pitch range (semitones) a contour has no peak worth timing. */
const MIN_PEAK_RANGE = 1;

/**
 * Where a contour's highest point falls, as a fraction of its voiced span
 * (first to last voiced sample), or null if the contour moves less than
 * MIN_PEAK_RANGE. Measured from the first voiced sample, not from the clip's
 * start, so a pause before speaking doesn't push the peak later.
 */
function peakFraction(samples: DtwSample[]): number | null {
  let peakIdx = 0;
  let min = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!.semitone;
    if (v > samples[peakIdx]!.semitone) peakIdx = i;
    if (v < min) min = v;
  }
  if (samples[peakIdx]!.semitone - min < MIN_PEAK_RANGE) return null;
  const t0 = samples[0]!.time;
  const span = samples[samples.length - 1]!.time - t0;
  return span > 0 ? (samples[peakIdx]!.time - t0) / span : null;
}

/** Simple, honest, rule-based feedback: for each third of the phrase, compare
 * the direction and steepness of the reference's pitch movement to the
 * attempt's (mapped through the DTW path), plus a check on where each
 * contour's peak falls. Every rule is a direct comparison of measured
 * slopes/peaks - no ML, no hidden scoring. */
function buildFeedback(reference: DtwSample[], attempt: DtwSample[], path: DtwStep[]): string[] {
  const feedback: string[] = [];
  if (reference.length < 2 || attempt.length < 2 || path.length < 2) {
    return ["Not enough voiced signal to compare - try a longer or louder recording."];
  }

  for (const seg of SEGMENTS) {
    const startPathIdx = Math.floor(seg.startFrac * (path.length - 1));
    const endPathIdx = Math.max(startPathIdx + 1, Math.floor(seg.endFrac * (path.length - 1)));
    const refStart = path[startPathIdx]!.refIndex;
    const refEnd = path[endPathIdx]!.refIndex;
    const attStart = path[startPathIdx]!.attemptIndex;
    const attEnd = path[endPathIdx]!.attemptIndex;

    const refSlope = slope(reference, refStart, refEnd);
    const attSlope = slope(attempt, attStart, attEnd);

    const flatThreshold = 1.5; // semitones per voiced-span fraction; overall pace is not pitch shape
    const refDirection = refSlope > flatThreshold ? "rising" : refSlope < -flatThreshold ? "falling" : "flat";
    const attDirection = attSlope > flatThreshold ? "rising" : attSlope < -flatThreshold ? "falling" : "flat";

    if (refDirection !== "flat" && attDirection === "flat") {
      feedback.push(`At ${seg.name} of the phrase, the reference is ${refDirection} but yours stays flat.`);
    } else if (refDirection === "flat" && attDirection !== "flat") {
      feedback.push(`At ${seg.name} of the phrase, the reference stays flat but your pitch is ${attDirection}.`);
    } else if (refDirection !== "flat" && attDirection !== "flat" && refDirection !== attDirection) {
      feedback.push(`At ${seg.name} of the phrase, your pitch moves the opposite way from the reference (${refDirection} expected, you went ${attDirection}).`);
    } else if (refDirection !== "flat" && attDirection === refDirection && Math.abs(attSlope) < 0.55 * Math.abs(refSlope)) {
      feedback.push(`At ${seg.name} of the phrase, the ${refDirection === "rising" ? "rise" : "fall"} is too shallow compared to the reference.`);
    } else if (refDirection !== "flat" && attDirection === refDirection && Math.abs(refSlope) < 0.55 * Math.abs(attSlope)) {
      feedback.push(`At ${seg.name} of the phrase, your ${refDirection === "rising" ? "rise" : "fall"} is steeper than the reference's.`);
    }
  }

  // Peak-timing check: where, as a fraction of the voiced phrase, does each
  // contour hit its max? Only meaningful when both contours actually move: a
  // flat contour's "peak" is wherever the jitter happens to be highest (and
  // the flat-vs-moving case is already reported above).
  const refPeak = peakFraction(reference);
  const attPeak = peakFraction(attempt);
  if (refPeak !== null && attPeak !== null) {
    const peakDelta = attPeak - refPeak;
    if (peakDelta > 0.15) {
      feedback.push("Your pitch peak comes later than the reference's - try starting the rise sooner.");
    } else if (peakDelta < -0.15) {
      feedback.push("Your pitch peak comes earlier than the reference's - try holding the rise a bit longer.");
    }
  }

  if (feedback.length === 0) {
    feedback.push("No direction, steepness or peak-timing difference flagged. Compare the overlaid contours for local differences.");
  }
  return feedback;
}

export interface WarpedPoint {
  /** Reference time, normalized to [0, 1] over the reference's voiced span. */
  t: number;
  referenceSemitone: number;
  /** Attempt semitone value(s) mapped onto this reference instant, averaged
   * over a continuous run of DTW steps that aligns to it (a reference frame
   * can align to several attempt frames when the attempt runs slower there).
   * Distinct voiced runs can produce separate points at the same t. */
  attemptSemitone: number;
  /** Start a new stroke when either source has a gap. */
  breakBefore?: true;
}

/** Time-warps the attempt onto the reference's timeline using the DTW path,
 * for the "overlay after alignment" visualization. */
export function warpedOverlay(result: AlignmentResult): WarpedPoint[] {
  const { reference, attempt, path } = result;
  if (reference.length === 0 || path.length === 0) return [];
  const t0 = reference[0]!.time;
  const span = reference[reference.length - 1]!.time - t0 || 1;

  const out: WarpedPoint[] = [];
  let refIndex = -1;
  let previousAttempt = -1;
  let sum = 0;
  let count = 0;
  let breakBefore = false;
  const flush = (): void => {
    if (!count) return;
    out.push({
      t: (reference[refIndex]!.time - t0) / span,
      referenceSemitone: reference[refIndex]!.semitone,
      attemptSemitone: sum / count,
      ...(breakBefore ? { breakBefore: true as const } : {}),
    });
  };
  for (const step of path) {
    const refChanged = step.refIndex !== refIndex;
    const gap =
      (refChanged && reference[step.refIndex]!.breakBefore === true) ||
      (step.attemptIndex !== previousAttempt && attempt[step.attemptIndex]!.breakBefore === true);
    if (refChanged || gap) {
      flush();
      refIndex = step.refIndex;
      sum = 0;
      count = 0;
      breakBefore = gap && out.length > 0;
    }
    sum += attempt[step.attemptIndex]!.semitone;
    count++;
    previousAttempt = step.attemptIndex;
  }
  flush();
  return out;
}

/**
 * Aligns the attempt's voiced contour to the reference's and scores it. The
 * result's `reference` and `attempt` are the samples that were aligned (the
 * ones `path` indexes): every voiced sample, or an evenly spaced selection of
 * MAX_ALIGNED_SAMPLES that includes both endpoints.
 */
export function compareContours(reference: PitchContour, attempt: PitchContour): AlignmentResult {
  const refVoiced = toDtwSamples(reference);
  const attVoiced = toDtwSamples(attempt);
  const refSamples = thinned(refVoiced);
  const attSamples = thinned(attVoiced);
  const sampling = {
    reference: { frames: reference.points.length, voiced: refVoiced.length, aligned: refSamples.length },
    attempt: { frames: attempt.points.length, voiced: attVoiced.length, aligned: attSamples.length },
  };

  if (refSamples.length < 2 || attSamples.length < 2) {
    return {
      path: [],
      totalCost: null,
      meanCostPerStep: null,
      score: null,
      sampling,
      reference: refSamples,
      attempt: attSamples,
      feedback: ["Not enough voiced signal to compare - try a longer or louder recording."],
    };
  }

  const { path, totalCost } = dtwAlign(
    refSamples.map((s) => s.semitone),
    attSamples.map((s) => s.semitone),
  );
  const meanCostPerStep = path.length > 0 ? totalCost / path.length : Infinity;
  const score = costToScore(meanCostPerStep);
  const feedback = buildFeedback(refSamples, attSamples, path);

  return { path, totalCost, meanCostPerStep, score, sampling, reference: refSamples, attempt: attSamples, feedback };
}
