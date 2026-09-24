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

const SEMITONE_RANGE = 12; // +-12 semitones shown, i.e. one octave each way

function semitoneToY(semitone: number, height: number, padding: number): number {
  const usable = height - padding * 2;
  const clamped = Math.max(-SEMITONE_RANGE, Math.min(SEMITONE_RANGE, semitone));
  return padding + usable * (1 - (clamped + SEMITONE_RANGE) / (2 * SEMITONE_RANGE));
}

function drawStaff(ctx: CanvasRenderingContext2D, width: number, height: number, padding: number): void {
  const lines = [-9, -6, -3, 0, 3, 6, 9];
  ctx.save();
  ctx.strokeStyle = cssVar("--color-border");
  ctx.lineWidth = 1;
  ctx.font = `11px ${cssVar("--font-mono")}`;
  ctx.fillStyle = cssVar("--color-text-muted");
  ctx.textBaseline = "middle";
  for (const semitone of lines) {
    const y = semitoneToY(semitone, height, padding);
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.globalAlpha = semitone === 0 ? 0.55 : 0.22;
    ctx.stroke();
    ctx.globalAlpha = 1;
    const label = semitone === 0 ? "0 st (median)" : `${semitone > 0 ? "+" : ""}${semitone} st`;
    ctx.fillText(label, 6, y);
  }
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
  width: number,
  height: number,
  padding: number,
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
    const x = padding + ((p.time - t0) / span) * (width - padding * 2);
    const y = semitoneToY(p.semitone!, height, padding);
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
  const padding = 28;

  const paint = (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
    ctx.clearRect(0, 0, width, height);
    drawStaff(ctx, width, height, padding);

    const refColor = cssVar("--color-reference");
    const refGlow = cssVar("--color-reference-glow");
    const attColor = cssVar("--color-attempt");
    const attGlow = cssVar("--color-attempt-glow");

    if (latest.reference) {
      const pts = contourToPoints(latest.reference, width, height, padding);
      drawSegmented(ctx, pts, refColor, refGlow);
    }

    if (latest.warped && latest.warped.length > 1) {
      const pts = latest.warped.map((w) => ({
        x: padding + w.t * (width - padding * 2),
        y: semitoneToY(w.attemptSemitone, height, padding),
        confidence: 0.85,
      }));
      drawInkStroke(ctx, pts, attColor, attGlow);
    } else if (latest.attempt) {
      const pts = contourToPoints(latest.attempt, width, height, padding);
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
