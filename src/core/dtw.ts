import type { PitchContour } from "./types.js";

export interface DtwSample {
  time: number;
  semitone: number;
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
  totalCost: number;
  /** totalCost / path length - the scale-free distance used for scoring. */
  meanCostPerStep: number;
  /** 0-100 similarity score derived from meanCostPerStep. */
  score: number;
  reference: DtwSample[];
  attempt: DtwSample[];
  feedback: string[];
}

/** Pull out only the voiced (time, semitone) samples a contour has, in order. */
export function toDtwSamples(contour: PitchContour): DtwSample[] {
  const out: DtwSample[] = [];
  for (const p of contour.points) {
    if (p.voiced && p.semitone !== null) out.push({ time: p.time, semitone: p.semitone });
  }
  return out;
}

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

  // cost[i][j] = min cumulative cost to align a[0..i) with b[0..j)
  const cost = new Float64Array((n + 1) * (m + 1)).fill(Infinity);
  const at = (i: number, j: number): number => i * (m + 1) + j;
  cost[at(0, 0)] = 0;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const local = Math.abs(a[i - 1]! - b[j - 1]!);
      const best = Math.min(cost[at(i - 1, j)]!, cost[at(i, j - 1)]!, cost[at(i - 1, j - 1)]!);
      cost[at(i, j)] = local + best;
    }
  }

  // Backtrack from (n,m) to (0,0).
  const path: DtwStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    path.push({ refIndex: i - 1, attemptIndex: j - 1 });
    const diag = cost[at(i - 1, j - 1)]!;
    const up = cost[at(i - 1, j)]!;
    const left = cost[at(i, j - 1)]!;
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up <= left) {
      i--;
    } else {
      j--;
    }
  }
  path.reverse();

  return { path, totalCost: cost[at(n, m)]! };
}

/** Maps mean per-step semitone cost to a 0-100 score. A perfect match (cost 0)
 * scores 100; the exponential decay means small divergences (under ~1
 * semitone average) still score highly, while a 4+ semitone average miss
 * (roughly "wrong tone entirely") drops below 25. `scale` is the "half-life"
 * in semitones, chosen empirically against the synthetic tone fixtures. */
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
  return (samples[toIdx]!.semitone - samples[fromIdx]!.semitone) / dt;
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

    const flatThreshold = 1.5; // semitones/sec - below this we call it "flat"
    const refDirection = refSlope > flatThreshold ? "rising" : refSlope < -flatThreshold ? "falling" : "flat";
    const attDirection = attSlope > flatThreshold ? "rising" : attSlope < -flatThreshold ? "falling" : "flat";

    if (refDirection !== "flat" && attDirection === "flat") {
      feedback.push(`At ${seg.name} of the phrase, the reference is ${refDirection} but yours stays flat.`);
    } else if (refDirection !== "flat" && attDirection !== "flat" && refDirection !== attDirection) {
      feedback.push(`At ${seg.name} of the phrase, your pitch moves the opposite way from the reference (${refDirection} expected, you went ${attDirection}).`);
    } else if (refDirection !== "flat" && attDirection === refDirection && Math.abs(attSlope) < 0.55 * Math.abs(refSlope)) {
      feedback.push(`At ${seg.name} of the phrase, the ${refDirection === "rising" ? "rise" : "fall"} is too shallow compared to the reference.`);
    }
  }

  // Peak-timing check: where (as a fraction of the phrase) does each contour hit its max?
  let refPeakIdx = 0;
  for (let i = 1; i < reference.length; i++) if (reference[i]!.semitone > reference[refPeakIdx]!.semitone) refPeakIdx = i;
  let attPeakIdx = 0;
  for (let i = 1; i < attempt.length; i++) if (attempt[i]!.semitone > attempt[attPeakIdx]!.semitone) attPeakIdx = i;

  const refPeakFrac = reference[refPeakIdx]!.time / reference[reference.length - 1]!.time;
  const attPeakFrac = attempt[attPeakIdx]!.time / attempt[attempt.length - 1]!.time;
  const peakDelta = attPeakFrac - refPeakFrac;

  if (peakDelta > 0.15) {
    feedback.push("Your pitch peak comes later than the reference's - try starting the rise sooner.");
  } else if (peakDelta < -0.15) {
    feedback.push("Your pitch peak comes earlier than the reference's - try holding the rise a bit longer.");
  }

  if (feedback.length === 0) {
    feedback.push("Shape and timing closely track the reference - nice work.");
  }
  return feedback;
}

export function compareContours(reference: PitchContour, attempt: PitchContour): AlignmentResult {
  const refSamples = toDtwSamples(reference);
  const attSamples = toDtwSamples(attempt);

  if (refSamples.length === 0 || attSamples.length === 0) {
    return {
      path: [],
      totalCost: 0,
      meanCostPerStep: Infinity,
      score: 0,
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

  return { path, totalCost, meanCostPerStep, score, reference: refSamples, attempt: attSamples, feedback };
}
