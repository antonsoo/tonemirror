import { observeCanvasSize } from "./canvas.js";
import { cssVar } from "./theme.js";
import type { PitchContour } from "../core/types.js";
import type { WarpedPoint } from "../core/dtw.js";

export interface ContourStageData {
  reference: PitchContour | null;
  attempt: PitchContour | null;
  /** After-alignment overlay from dtw.warpedOverlay; when present, the
   * attempt is drawn warped onto the reference's timeline instead of its
   * own raw timeline. */
  warped: WarpedPoint[] | null;
}

interface PlotArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const TICK_STEP = 3; // semitones between gridlines
const MIN_HALF_RANGE = 4; // never zoom in tighter than +-4 st, even for a near-flat contour

/** Picks a symmetric, 3-semitone-tick-aligned y-range that fits the data with
 * a little headroom, instead of a fixed +-12 st range - a small tone's real
 * excursion (a few semitones) would otherwise look nearly flat. */
function autoRange(valuesLists: number[][]): number {
  let maxAbs = 0;
  for (const values of valuesLists) {
    for (const v of values) maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  const target = Math.max(MIN_HALF_RANGE, maxAbs);
  let half = Math.ceil(target / TICK_STEP) * TICK_STEP;
  // If the data reaches (within a whisker of) the rounded boundary, add one
  // more tick of headroom so the line isn't flush against the top/bottom rule.
  if (half - target < TICK_STEP * 0.25) half += TICK_STEP;
  return half;
}

function semitoneToY(semitone: number, plot: PlotArea, halfRange: number): number {
  const usable = plot.bottom - plot.top;
  const clamped = Math.max(-halfRange, Math.min(halfRange, semitone));
  return plot.top + usable * (1 - (clamped + halfRange) / (2 * halfRange));
}

function drawStaff(ctx: CanvasRenderingContext2D, plot: PlotArea, halfRange: number): void {
  ctx.save();
  ctx.strokeStyle = cssVar("--color-border");
  ctx.lineWidth = 1;
  ctx.font = `11px ${cssVar("--font-mono")}`;
  ctx.fillStyle = cssVar("--color-text-muted");
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let semitone = -halfRange; semitone <= halfRange; semitone += TICK_STEP) {
    const y = semitoneToY(semitone, plot, halfRange);
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.globalAlpha = semitone === 0 ? 0.55 : 0.22;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Labels live in the left gutter, outside the plotted lines, so they
    // never collide with the ink strokes.
    const label = semitone === 0 ? "0" : semitone > 0 ? `+${semitone}` : `${semitone}`;
    ctx.fillText(label, plot.left - 10, y);
  }
  ctx.restore();
}

/** Small, once-per-chart y-axis caption, rotated along the left edge - the
 * unit ("semitones relative to speaker median") is stated once here instead
 * of repeating "st (median)" on every tick label. */
function drawAxisCaption(ctx: CanvasRenderingContext2D, plot: PlotArea): void {
  ctx.save();
  ctx.font = `11px ${cssVar("--font-mono")}`;
  ctx.fillStyle = cssVar("--color-text-muted");
  ctx.globalAlpha = 0.85;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.translate(14, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("semitones re: speaker median", 0, 0);
  ctx.restore();
}

/** Draws a contour as a variable-width "ink" stroke: thicker and more opaque
 * where the detector was confident, thinner and fainter where it wasn't. */
function drawInkStroke(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number; confidence: number }[],
  color: string,
  glow: string,
): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const conf = (a.confidence + b.confidence) / 2;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55 + 0.45 * conf;
    ctx.lineWidth = 1.5 + 2.5 * conf;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function contourToPoints(
  contour: PitchContour,
  plot: PlotArea,
  halfRange: number,
): { x: number; y: number; confidence: number }[] {
  const voiced = contour.points.filter((p) => p.voiced && p.semitone !== null);
  if (voiced.length === 0) return [];
  const t0 = voiced[0]!.time;
  const span = voiced[voiced.length - 1]!.time - t0 || 1;
  const segments: { x: number; y: number; confidence: number }[][] = [[]];
  let lastTime = t0;
  for (const p of voiced) {
    // Break the stroke where there's a real time gap (an unvoiced stretch),
    // so we don't draw a straight line across silence.
    if (p.time - lastTime > contour.hopSeconds * 3) segments.push([]);
    lastTime = p.time;
    const x = plot.left + ((p.time - t0) / span) * (plot.right - plot.left);
    const y = semitoneToY(p.semitone!, plot, halfRange);
    segments[segments.length - 1]!.push({ x, y, confidence: p.confidence });
  }
  return segments.flatMap((seg, i) => (i === 0 ? seg : [{ x: NaN, y: NaN, confidence: 0 }, ...seg]));
}

function drawSegmented(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number; confidence: number }[],
  color: string,
  glow: string,
): void {
  let run: { x: number; y: number; confidence: number }[] = [];
  for (const p of points) {
    if (Number.isNaN(p.x)) {
      drawInkStroke(ctx, run, color, glow);
      run = [];
    } else {
      run.push(p);
    }
  }
  drawInkStroke(ctx, run, color, glow);
}

export function createContourStage(canvas: HTMLCanvasElement): {
  render: (data: ContourStageData) => void;
  destroy: () => void;
} {
  let latest: ContourStageData = { reference: null, attempt: null, warped: null };

  const paint = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
    ctx.clearRect(0, 0, width, height);

    const plot: PlotArea = { left: 74, right: width - 16, top: 18, bottom: height - 18 };

    const refSemitones = latest.reference
      ? latest.reference.points.filter((p) => p.voiced && p.semitone !== null).map((p) => p.semitone!)
      : [];
    const attSemitones = latest.warped
      ? latest.warped.map((w) => w.attemptSemitone)
      : latest.attempt
        ? latest.attempt.points.filter((p) => p.voiced && p.semitone !== null).map((p) => p.semitone!)
        : [];
    const halfRange = autoRange([refSemitones, attSemitones]);

    drawStaff(ctx, plot, halfRange);
    drawAxisCaption(ctx, plot);

    const refColor = cssVar("--color-reference");
    const refGlow = cssVar("--color-reference-glow");
    const attColor = cssVar("--color-attempt");
    const attGlow = cssVar("--color-attempt-glow");

    if (latest.reference) {
      const pts = contourToPoints(latest.reference, plot, halfRange);
      drawSegmented(ctx, pts, refColor, refGlow);
    }

    if (latest.warped && latest.warped.length > 1) {
      const pts = latest.warped.map((w) => ({
        x: plot.left + w.t * (plot.right - plot.left),
        y: semitoneToY(w.attemptSemitone, plot, halfRange),
        confidence: 0.85,
      }));
      drawInkStroke(ctx, pts, attColor, attGlow);
    } else if (latest.attempt) {
      const pts = contourToPoints(latest.attempt, plot, halfRange);
      drawSegmented(ctx, pts, attColor, attGlow);
    }
  };

  let ctxRef: CanvasRenderingContext2D | null = null;
  let widthRef = 0;
  let heightRef = 0;
  const stop = observeCanvasSize(canvas, 260, (ctx, width, height) => {
    ctxRef = ctx;
    widthRef = width;
    heightRef = height;
    paint(ctx, width, height);
  });

  return {
    render(data: ContourStageData) {
      latest = data;
      if (ctxRef) paint(ctxRef, widthRef, heightRef);
    },
    destroy: stop,
  };
}
