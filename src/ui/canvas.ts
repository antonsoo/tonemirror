/** Sizes a canvas for crisp rendering at the current devicePixelRatio and
 * keeps it in sync with its CSS box size via ResizeObserver. */
export function observeCanvasSize(
  canvas: HTMLCanvasElement,
  cssHeight: number,
  onResize: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
): () => void {
  canvas.style.height = `${cssHeight}px`;

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 300;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    onResize(ctx, cssWidth, cssHeight);
  };

  resize();
  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);
  return () => observer.disconnect();
}
