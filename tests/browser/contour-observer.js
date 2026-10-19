/* global CanvasRenderingContext2D, getComputedStyle, innerWidth */

export function observeContourDrawing() {
  window.gapStudy = { contours: [], alignment: null, pcm: [], violations: [] };
  document.addEventListener('securitypolicyviolation', e => window.gapStudy.violations.push(e.violatedDirective));
  const NativeWorker = Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', e => {
        if (e.data.type === 'analyzed') window.gapStudy.contours.push(e.data.contour);
        if (e.data.type === 'compared') window.gapStudy.alignment = e.data.alignment;
      });
    }
    postMessage(message, ...args) {
      if (message.type === 'analyze') window.gapStudy.pcm.push({ sampleRate: message.sampleRate, samples: Array.from(message.pcm) });
      return super.postMessage(message, ...args);
    }
  };
  // Observe the native path calls without changing geometry, styles,
  // transforms or the draw operation. Clear the trace on each repaint.
  const p = CanvasRenderingContext2D.prototype;
  const clear = p.clearRect, move = p.moveTo, line = p.lineTo;
  p.clearRect = function (...args) { this.canvas.gapSegments = []; return clear.apply(this, args); };
  p.moveTo = function (x, y) { this.gapPoint = { x, y }; return move.call(this, x, y); };
  p.lineTo = function (x, y) {
    if (this.gapPoint) (this.canvas.gapSegments ??= []).push({ a: this.gapPoint, b: { x, y }, color: this.strokeStyle });
    this.gapPoint = { x, y };
    return line.call(this, x, y);
  };
}

export function readContourDrawing() {
  const { contours, alignment, pcm, violations } = window.gapStudy;
  const reference = contours[0], voice = reference.points.filter(p => p.voiced && p.semitone !== null);
  const from = voice[0].time, span = voice.at(-1).time - from;
  const canvas = document.querySelector('canvas'), width = canvas.clientWidth;
  const color = token => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return ctx.strokeStyle;
  };
  const refColor = color('--color-reference'), attColor = color('--color-attempt');
  const segments = (canvas.gapSegments ?? []).filter(s => s.color === refColor || s.color === attColor);
  const gaps = [];
  let previous = null, previousIndex = -1;
  // Derive missing intervals from native frame identities, not the
  // product's DTW samples or its new drawing metadata.
  for (let i = 0; i < reference.points.length; i++) {
    const point = reference.points[i];
    if (!point.voiced || point.semitone === null) continue;
    if (previous && i !== previousIndex + 1) {
      const x1 = 74 + (previous.time - from) / span * (width - 90);
      const x2 = 74 + (point.time - from) / span * (width - 90);
      const count = c => segments.filter(s => s.color === c && s.a.x <= x1 + 1e-6 && s.b.x >= x2 - 1e-6).length;
      gaps.push({ lastVoicedTime: previous.time, nextVoicedTime: point.time, omittedFrames: i - previousIndex - 1, referenceConnections: count(refColor), alignedAttemptConnections: count(attColor) });
    }
    previous = point; previousIndex = i;
  }
  const { path, totalCost, meanCostPerStep, score, feedback, sampling } = alignment;
  return { gaps, segments, contours, pcm, alignment: { path, totalCost, meanCostPerStep, score, feedback, sampling }, violations, overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), visibleScore: document.querySelector('.tm-score').textContent };
}
