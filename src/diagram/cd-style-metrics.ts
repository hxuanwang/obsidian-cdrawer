/**
 * src/diagram/cd-style-metrics.ts (§6.4)
 *
 * Measure the visual style of Obsidian's native `\begin{CD}\end{CD}` rendering
 * at runtime so our SVG renderer matches it (font size, arrow weight, spacing),
 * rather than hardcoding numbers that would drift with the user's theme / zoom.
 *
 * Strategy: lazily render a hidden reference `$$\begin{CD}A \to B\end{CD}$$`
 * via Obsidian's renderMath (MathJax), read its computed font-size + the
 * rendered arrow's stroke-width, cache per-document, then discard the node.
 */

export interface CDStyleMetrics {
  /** Base font size (px) for cell labels, from native CD rendering. */
  fontSize: number;
  /** Approximate line height (px) of one CD row. */
  lineHeight: number;
  /** Arrow stroke width (px), measured from a native CD arrow glyph. */
  arrowStrokeWidth: number;
  /** Minimum row/column gap (px) — AMS \arrowlength, which defaults to 3em
   *  (= 3 × fontSize). Drives the visible arrow length for short-label
   *  diagrams so they space identically to a native CD block (§6.4). */
  minGap: number;
}

/**
 * A user-facing label-size multiplier (the "label size" setting, §8.3 feature
 * request). 1.0 = match native CD exactly (the §6.4 default); larger = bigger
 * labels, smaller = smaller. Applied uniformly to fontSize and minGap so a
 * scaled diagram keeps its proportions and just grows/shrinks as a whole.
 */
export interface CDStyleScale {
  /** Multiplier on the base font size; clamped to a sane range on input. */
  labelScale: number;
}

/**
 * Clamp a raw label-scale value to the allowed range [0.4, 1.5]. This safely
 * contains the slider's 50%–150% range (0.475–1.425 render-scale). The default
 * fallback for NaN/Infinity is 0.95 (the "100%" default), not 1.
 */
export function clampLabelScale(raw: number): number {
  if (!Number.isFinite(raw)) return 0.95;
  return Math.max(0.4, Math.min(1.5, raw));
}

// The cache key includes the theme AND the scale, so changing the label-size
// setting produces fresh metrics without waiting for a theme-change reset.
let cached: CDStyleMetrics | null = null;
let cachedTheme: string | null = null;
let cachedScale = 1;

/**
 * Lazily compute (and cache) CD style metrics from the live document.
 * Falls back to sensible defaults if MathJax / measurement is unavailable
 * (e.g. in a headless test environment).
 *
 * `scale.labelScale` (default 1) multiplies the base font size and min gap so
 * the user can grow/shrink labels from settings (the label-size knob, §8.3);
 * 1.0 reproduces a native CD block exactly (§6.4).
 */
export function getCDStyleMetrics(
  doc: Document = document,
  scale: CDStyleScale = { labelScale: 1 },
): CDStyleMetrics {
  const theme = detectTheme(doc);
  const labelScale = clampLabelScale(scale.labelScale);
  if (cached && cachedTheme === theme && cachedScale === labelScale) return cached;

  const fallback: CDStyleMetrics = {
    fontSize: 18,
    lineHeight: 22,
    arrowStrokeWidth: 0.9,
    minGap: 54, // 3 × fontSize (AMS \arrowlength default)
  };

  try {
    const measured = measureWithMathJax(doc);
    if (measured) {
      const scaled = applyScale(measured, labelScale);
      cached = scaled;
      cachedTheme = theme;
      cachedScale = labelScale;
      return scaled;
    }
  } catch {
    // fall through to fallback
  }
  const scaledFallback = applyScale(fallback, labelScale);
  cached = scaledFallback;
  cachedTheme = theme;
  cachedScale = labelScale;
  return scaledFallback;
}

/**
 * Multiply a metrics object's size-driven fields by `labelScale`. Arrow stroke
 * width scales too so a bigger diagram isn't left with hairline arrows (and a
 * smaller one isn't over-weight); line height follows font size. Returns a new
 * object — the input is not mutated.
 */
export function applyScale(m: CDStyleMetrics, labelScale: number): CDStyleMetrics {
  const s = clampLabelScale(labelScale);
  return {
    fontSize: m.fontSize * s,
    lineHeight: m.lineHeight * s,
    arrowStrokeWidth: m.arrowStrokeWidth * s,
    minGap: m.minGap * s,
  };
}

/** Reset the cache (tests, theme change). */
export function resetCDStyleMetricsCache(): void {
  cached = null;
  cachedTheme = null;
  cachedScale = 1;
}

function detectTheme(doc: Document): string {
  return doc.body?.getAttribute("class") ?? "";
}

function measureWithMathJax(doc: Document): CDStyleMetrics | null {
  // Use Obsidian's renderMath when available (injected onto window by the app).
  const w = window as unknown as {
    renderMath?: (tex: string, display: boolean) => HTMLElement;
  };
  if (!w.renderMath) return null;

  // Off-screen, non-interactive host for measuring the reference CD render.
  // `setCssStyles` is Obsidian's preferred helper for applying a batch of
  // styles rather than assigning each property on .style directly.
  const host = doc.createElement("div");
  host.setCssStyles({
    position: "absolute",
    visibility: "hidden",
    left: "-9999px",
    top: "0",
    pointerEvents: "none",
    opacity: "0",
  });
  doc.body.appendChild(host);

  try {
    const mathEl = w.renderMath("\\begin{CD} A \\to B \\end{CD}", true);
    host.appendChild(mathEl);
    // Let the browser lay it out.
    const fontSize = parseFloat(getComputedStyle(mathEl).fontSize) || 18;
    const lineHeight =
      parseFloat(getComputedStyle(mathEl).lineHeight) || fontSize * 1.2;

    // Find an SVG path inside the rendered math to read stroke-width.
    let arrowStrokeWidth = 0.9;
    const svg = mathEl.querySelector("svg");
    if (svg) {
      const paths = svg.querySelectorAll("path, line, polyline");
      for (const p of Array.from(paths)) {
        const sw = parseFloat(getComputedStyle(p).strokeWidth);
        if (Number.isFinite(sw) && sw > 0) {
          arrowStrokeWidth = sw;
          break;
        }
      }
    }

    // AMS \arrowlength defaults to 3em = 3 × font size (the source of truth
    // for native CD arrow length; the §6.4 "~1.25× line height" note in the
    // plan was incorrect). Floor the gap here so short-label diagrams space
    // identically to a native CD block.
    const minGap = Math.round(fontSize * 3);
    return { fontSize, lineHeight, arrowStrokeWidth, minGap };
  } finally {
    host.remove();
  }
}
