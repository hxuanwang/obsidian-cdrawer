/**
 * src/editor/positioning.ts (§7.2)
 *
 * Clamp / flip a popover's desired top-left so it stays inside the visible
 * viewport. Standard popover problem — no heavy dependency, just arithmetic.
 *
 * Strategy: first try the requested (x, y). If it overflows the right/bottom
 * edge, flip to place the popover's far edge against the viewport edge; if it
 * still overflows (popover taller/wider than the viewport), clamp to 0 and let
 * the overlay's own max-height/max-width (styles.css) handle scrolling.
 */

export interface Placement {
  /** Top-left of the overlay, in viewport (fixed) coordinates. */
  left: number;
  top: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MARGIN = 8; // px of breathing room from the viewport edge

/**
 * Position an overlay of size (w, h) so it fits in `vp`, anchored near (x, y).
 * `x`/`y` are the preferred top-left (e.g. just below/right of the cursor).
 */
export function placeInViewport(x: number, y: number, w: number, h: number, vp: ViewportRect): Placement {
  const maxX = vp.left + vp.width - w - MARGIN;
  const maxY = vp.top + vp.height - h - MARGIN;
  const minX = vp.left + MARGIN;
  const minY = vp.top + MARGIN;

  // Horizontal: prefer x; flip (right-align) if it would overflow the right
  // edge and there's more room to the left; otherwise clamp.
  let left = x;
  if (left > maxX) {
    const flipped = x - w; // place the overlay's right edge near x
    left = flipped >= minX ? flipped : Math.max(minX, Math.min(x, maxX));
  }
  if (left < minX) left = minX;

  // Vertical: prefer y; flip (bottom-align) if it overflows the bottom edge.
  let top = y;
  if (top > maxY) {
    const flipped = y - h; // place the overlay's bottom edge near y
    top = flipped >= minY ? flipped : Math.max(minY, Math.min(y, maxY));
  }
  if (top < minY) top = minY;

  return { left, top };
}

/** The visible viewport, in fixed coordinates. */
export function viewportRect(): ViewportRect {
  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}
