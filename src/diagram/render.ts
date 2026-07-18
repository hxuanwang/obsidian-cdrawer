/**
 * src/diagram/render.ts (§6)
 *
 * Pure SVG renderer for DiagramModel — one implementation, two call sites:
 * the floating grid editor's live draft preview and the static display-mode
 * renderer (Reading view post processor + Live Preview widget).
 *
 * Two layers:
 *   layoutDiagram(model, measure, metrics) — pure geometry, no DOM. Decides
 *     grid extents (§6.1: row heights / column widths driven by the largest
 *     rendered label, gaps floored at metrics.minGap = the AMS \arrowlength
 *     ratio, §6.4), clips arrow shafts to label-box edges, offsets parallel
 *     arrows (§6.2), and places arrow labels. Unit-testable in plain node.
 *   renderDiagram(model, opts) — thin DOM shell: renders + measures each
 *     label once (Obsidian's renderMath when present; injectable for tests
 *     or headless use), then builds the SVG. MathJax CHTML output embeds
 *     via <foreignObject>; arrows draw below labels.
 *
 * Arrow vocabulary (§6.3): head default/epi/hook/mapsto/none, lineStyle
 * solid/dashed/dotted, plus first-class bidirectional double-headed arrows
 * (§6.2). Skip (non-adjacent) arrows are straight lines through intervening
 * cells, matching the reference editor — no auto-routing.
 *
 * Styling (§6.4): all strokes use currentColor; styles.css sets
 * `color: var(--text-normal)` on .cd-diagram-svg so diagrams track the theme
 * exactly like native math. Sizes come from getCDStyleMetrics() rather than
 * hardcoded constants, so theme/zoom changes are picked up automatically.
 */

import type {
  ArrowHead,
  CellPos,
  DiagramArrow,
  DiagramModel,
  LabelPosition,
  LineStyle,
} from "./model";
import { DEFAULT_HEAD, DEFAULT_LINE, getLabel, CURVE_MIN, CURVE_MAX, CURVE_APEX_FRAC } from "./model";
import type { CDStyleMetrics } from "./cd-style-metrics";
import { getCDStyleMetrics } from "./cd-style-metrics";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MeasuredSize {
  width: number;
  height: number;
}

/** Measures a LaTeX label, returning its rendered pixel size. */
export type LabelMeasurer = (latex: string) => MeasuredSize;

/** Renders a LaTeX label into an HTML element (MathJax in the app). */
export type LabelRenderer = (latex: string) => HTMLElement;

/** Derived drawing constants, all scaled from the measured CD font size. */
export interface RenderConstants {
  /** Clearance between a label's bounding box and arrow anchor points. */
  cellPad: number;
  /** Arrowhead length along the shaft. */
  headLen: number;
  /** Arrowhead half-width (perpendicular). */
  headHalf: number;
  /** Half-length of the mapsto tail bar. */
  tailTickHalf: number;
  /** Size of the hook tail curve. */
  hookLen: number;
  /** Perpendicular spacing between parallel arrows on the same cell pair. */
  multiArrowStep: number;
  /** Gap between an arrow shaft and its label box. */
  labelGap: number;
  /** Outer padding baked into the viewBox so heads/ticks never clip. */
  svgPad: number;
  /** stroke-dasharray for lineStyle "dashed". */
  dashedArray: string;
  /** stroke-dasharray for lineStyle "dotted" (round caps make the dots). */
  dottedArray: string;
}

export interface CellLayout {
  row: number;
  col: number;
  label: string;
  /** Center of the cell's label box, diagram coordinates. */
  cx: number;
  cy: number;
  /** Measured label size. */
  width: number;
  height: number;
}

export interface ArrowLayout {
  id: string;
  from: CellPos;
  to: CellPos;
  /** Shaft endpoints after box clipping and parallel offset. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Unit direction of travel (from -> to). For a curved arrow this is the
   *  CHORD direction; head/tail decorations use the tangent at each end
   *  (startDir / endDir) instead. */
  dirX: number;
  dirY: number;
  /** Unit tangent at the start (tail) of the shaft. Equals (dirX,dirY) when
   *  straight; rotated toward the bulge when curved. */
  startDirX: number;
  startDirY: number;
  /** Unit tangent at the end (head) of the shaft. */
  endDirX: number;
  endDirY: number;
  /** Quadratic-Bézier control point for a curved shaft (undefined if straight). */
  ctrlX?: number;
  ctrlY?: number;
  /** Signed curve amount [-1,1]; 0 = straight. */
  curve: number;
  head: ArrowHead;
  lineStyle: LineStyle;
  bidirectional: boolean;
  /** Resolved (defaults applied). Only meaningful when label is set. */
  labelPosition: LabelPosition;
  label?: string;
  /** Label box center, diagram coordinates. */
  labelX?: number;
  labelY?: number;
  labelWidth?: number;
  labelHeight?: number;
}

export interface DiagramLayout {
  /** viewBox minimum corner (typically negative — see svgPad). */
  originX: number;
  originY: number;
  /** viewBox / pixel size of the produced SVG. */
  width: number;
  height: number;
  colWidths: number[];
  rowHeights: number[];
  colGaps: number[];
  rowGaps: number[];
  /** Center of every grid cell, [row][col], diagram coordinates. */
  cellCenters: { cx: number; cy: number }[][];
  /** Occupied cells only. */
  cells: CellLayout[];
  /** Renderable arrows (degenerate / out-of-grid arrows are dropped). */
  arrows: ArrowLayout[];
  metrics: CDStyleMetrics;
  constants: RenderConstants;
}

export interface RenderOptions {
  /** Style metrics; defaults to getCDStyleMetrics() (measured, cached). */
  metrics?: CDStyleMetrics;
  /** Label renderer; defaults to window.renderMath with a text fallback. */
  renderLabel?: LabelRenderer;
  /** Label measurer; defaults to measuring renderLabel output offscreen. */
  measureLabel?: LabelMeasurer;
  /** Target document (defaults to the global document). */
  document?: Document;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export function deriveRenderConstants(metrics: CDStyleMetrics): RenderConstants {
  const fs = metrics.fontSize;
  const headLen = fs * 0.34;
  const headHalf = headLen * 0.52;
  return {
    // Clearance between a label's bounding box and the arrow shaft anchor —
    // a larger value leaves more air between a character and its arrow.
    cellPad: fs * 0.34,
    headLen,
    headHalf,
    tailTickHalf: headHalf * 1.05,
    // Hook curl radius. Sized so the curl is clearly visible (longer than the
    // arrowhead) — the line from the curl's start to the tail is perpendicular
    // to the shaft, so a larger hookLen makes that perpendicular leg read as a
    // real hook rather than a stub (see appendHookTail).
    hookLen: fs * 0.42,
    multiArrowStep: fs * 0.5,
    // Gap between an arrow shaft and its label box.
    labelGap: fs * 0.4,
    svgPad: headLen + headHalf + metrics.arrowStrokeWidth + 2,
    dashedArray: `${r2(fs * 0.36)} ${r2(fs * 0.24)}`,
    dottedArray: `0.01 ${r2(fs * 0.26)}`,
  };
}

// ---------------------------------------------------------------------------
// layoutDiagram — pure geometry (no DOM)
// ---------------------------------------------------------------------------

export function layoutDiagram(
  model: DiagramModel,
  measure: LabelMeasurer,
  metrics: CDStyleMetrics,
): DiagramLayout {
  const constants = deriveRenderConstants(metrics);
  const { rows, cols } = model;

  // §6.1: measure every occupied cell; empty cells reserve no content size
  // (they still participate in grid extent via their row/column).
  const sizes: MeasuredSize[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: MeasuredSize[] = [];
    for (let c = 0; c < cols; c++) {
      const label = getLabel(model, r, c);
      row.push(label.trim() === "" ? { width: 0, height: 0 } : measure(label));
    }
    sizes.push(row);
  }

  // §6.1: a column's width / row's height is driven by its largest label.
  const colWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (let r = 0; r < rows; r++) w = Math.max(w, sizes[r][c].width);
    colWidths.push(w);
  }
  const rowHeights: number[] = [];
  for (let r = 0; r < rows; r++) {
    let h = 0;
    for (let c = 0; c < cols; c++) h = Math.max(h, sizes[r][c].height);
    rowHeights.push(h);
  }

  // §6.4: gaps floor at minGap (AMS \arrowlength, 3em = 3 × fontSize) so
  // short-label diagrams space — and arrows run — identically to a native
  // CD block. Grows further only as content forces it (§6.1).
  const colGaps = repeat(Math.max(0, cols - 1), metrics.minGap);
  const rowGaps = repeat(Math.max(0, rows - 1), metrics.minGap);

  // Cell centers in diagram coordinates, origin at the grid's top-left.
  const cxOf: number[] = [];
  const cyOf: number[] = [];
  {
    let x = 0;
    for (let c = 0; c < cols; c++) {
      cxOf.push(x + colWidths[c] / 2);
      x += colWidths[c] + (colGaps[c] ?? 0);
    }
    let y = 0;
    for (let r = 0; r < rows; r++) {
      cyOf.push(y + rowHeights[r] / 2);
      y += rowHeights[r] + (rowGaps[r] ?? 0);
    }
  }
  const cellCenters: { cx: number; cy: number }[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: { cx: number; cy: number }[] = [];
    for (let c = 0; c < cols; c++) row.push({ cx: cxOf[c], cy: cyOf[r] });
    cellCenters.push(row);
  }
  const gridW = cols === 0 ? 0 : cxOf[cols - 1] + colWidths[cols - 1] / 2;
  const gridH = rows === 0 ? 0 : cyOf[rows - 1] + rowHeights[rows - 1] / 2;

  const cells: CellLayout[] = [];
  for (const cell of model.cells) {
    if (cell.label.trim() === "") continue;
    if (!inGrid(cell, rows, cols)) continue;
    cells.push({
      row: cell.row,
      col: cell.col,
      label: cell.label,
      cx: cxOf[cell.col],
      cy: cyOf[cell.row],
      width: sizes[cell.row][cell.col].width,
      height: sizes[cell.row][cell.col].height,
    });
  }

  const layoutArrow = (a: DiagramArrow, shift: number): ArrowLayout | null => {
    const c1 = cellCenters[a.from.row][a.from.col];
    const c2 = cellCenters[a.to.row][a.to.col];
    let dx = c2.cx - c1.cx;
    let dy = c2.cy - c1.cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    dx /= len;
    dy /= len;

    // Parallel offset (§6.2): shift is the arrow's index within its pair
    // group, centered on 0. The offset uses the *canonical* pair direction
    // (lexicographically smaller endpoint -> larger) so opposite-direction
    // arrows on the same pair land on opposite sides instead of overlapping.
    const flip = comparePos(a.from, a.to) > 0;
    const cdx = flip ? -dx : dx;
    const cdy = flip ? -dy : dy;
    const off = shift * constants.multiArrowStep;
    const ox = cdy * off; // perpLeft(canon) = (cdy, -cdx)
    const oy = -cdx * off;

    // §6.2: anchor at the edge of each cell's (padded) label box, not its
    // center, so the shaft and arrowhead never run under a label.
    const hw1 = sizes[a.from.row][a.from.col].width / 2 + constants.cellPad;
    const hh1 = sizes[a.from.row][a.from.col].height / 2 + constants.cellPad;
    const hw2 = sizes[a.to.row][a.to.col].width / 2 + constants.cellPad;
    const hh2 = sizes[a.to.row][a.to.col].height / 2 + constants.cellPad;
    const s = clipToBox(c1.cx, c1.cy, dx, dy, hw1, hh1);
    const e = clipToBox(c2.cx, c2.cy, -dx, -dy, hw2, hh2);

    const x1 = s.x + ox;
    const y1 = s.y + oy;
    const x2 = e.x + ox;
    const y2 = e.y + oy;

    // Curve (§6.2 curves): a signed quadratic Bézier bulge. curve ∈ [-1,1],
    // 0 = straight. The bulge is to the LEFT of the arrow's direction of travel
    // for curve > 0 (matching tikz-cd's "bend left"); perpLeft(dx,dy)=(dy,-dx).
    // The apex (point at t=0.5) deviates from the chord midpoint by
    // curve * chordLen * CURVE_APEX_FRAC; the Bézier control point sits at
    // twice that offset (apex = (S+2C+E)/4). Heads/tails attach along the
    // tangent at each end (C-S and E-C), not the chord.
    const curve = typeof a.curve === "number" && Number.isFinite(a.curve)
      ? Math.max(CURVE_MIN, Math.min(CURVE_MAX, a.curve))
      : 0;
    const chordLen = Math.hypot(x2 - x1, y2 - y1);
    let ctrlX: number | undefined;
    let ctrlY: number | undefined;
    let startDirX = dx;
    let startDirY = dy;
    let endDirX = dx;
    let endDirY = dy;
    let apexX = (x1 + x2) / 2;
    let apexY = (y1 + y2) / 2;
    if (curve !== 0 && chordLen > 1e-9) {
      const perpX = dy; // perpLeft(dx,dy)
      const perpY = -dx;
      const apexOff = curve * chordLen * CURVE_APEX_FRAC;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      ctrlX = mx + perpX * (2 * apexOff);
      ctrlY = my + perpY * (2 * apexOff);
      apexX = mx + perpX * apexOff;
      apexY = my + perpY * apexOff;
      // Tangents at the endpoints of a quadratic Bézier.
      const sd = unitOrFallback(ctrlX - x1, ctrlY - y1, dx, dy);
      startDirX = sd.x;
      startDirY = sd.y;
      const ed = unitOrFallback(x2 - ctrlX, y2 - ctrlY, dx, dy);
      endDirX = ed.x;
      endDirY = ed.y;
    }

    const out: ArrowLayout = {
      id: a.id,
      from: { row: a.from.row, col: a.from.col },
      to: { row: a.to.row, col: a.to.col },
      x1,
      y1,
      x2,
      y2,
      dirX: dx,
      dirY: dy,
      startDirX,
      startDirY,
      endDirX,
      endDirY,
      ctrlX,
      ctrlY,
      curve,
      head: a.head ?? DEFAULT_HEAD,
      lineStyle: a.lineStyle ?? DEFAULT_LINE,
      bidirectional: a.bidirectional === true,
      labelPosition: a.labelPosition ?? "left",
    };

    if (a.label && a.label.trim() !== "") {
      const ls = measure(a.label);
      const nrm = labelNormal(out.labelPosition, dx, dy);
      // Place the label at the curve's apex (for a straight arrow the apex is
      // the chord midpoint, so this is unchanged), then push it out along the
      // offset normal by the label gap + half the label's perpendicular extent.
      const perpHalf =
        (Math.abs(nrm.x) * ls.width) / 2 + (Math.abs(nrm.y) * ls.height) / 2;
      const dist = constants.labelGap + perpHalf;
      out.label = a.label;
      out.labelX = apexX + nrm.x * dist;
      out.labelY = apexY + nrm.y * dist;
      out.labelWidth = ls.width;
      out.labelHeight = ls.height;
    }
    return out;
  };

  // Group arrows by unordered endpoint pair for the parallel offset.
  const groups = new Map<string, number[]>();
  model.arrows.forEach((a, i) => {
    if (!inGrid(a.from, rows, cols) || !inGrid(a.to, rows, cols)) return;
    if (a.from.row === a.to.row && a.from.col === a.to.col) return; // degenerate
    const key = pairKey(a.from, a.to);
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });

  const arrowSlots: (ArrowLayout | null)[] = model.arrows.map(() => null);
  groups.forEach((idxs) => {
    const n = idxs.length;
    idxs.forEach((modelIndex, k) => {
      arrowSlots[modelIndex] = layoutArrow(model.arrows[modelIndex], k - (n - 1) / 2);
    });
  });
  const arrows: ArrowLayout[] = [];
  for (const slot of arrowSlots) if (slot !== null) arrows.push(slot);

  // viewBox: grid content plus any overflowing arrow labels, padded so head
  // and tail decorations (which extend at most svgPad past the grid box)
  // are never clipped.
  let minX = 0;
  let minY = 0;
  let maxX = gridW;
  let maxY = gridH;
  for (const a of arrows) {
    // A curved shaft bulges past its chord; account for the apex so an unlabeled
    // curve isn't clipped. (The apex sits on the curve at t=0.5.)
    if (a.curve !== 0 && a.ctrlX !== undefined && a.ctrlY !== undefined) {
      const ax = (a.x1 + 2 * a.ctrlX + a.x2) / 4;
      const ay = (a.y1 + 2 * a.ctrlY + a.y2) / 4;
      minX = Math.min(minX, ax);
      maxX = Math.max(maxX, ax);
      minY = Math.min(minY, ay);
      maxY = Math.max(maxY, ay);
    }
    if (a.labelX === undefined || a.labelY === undefined) continue;
    const lw = (a.labelWidth ?? 0) / 2;
    const lh = (a.labelHeight ?? 0) / 2;
    minX = Math.min(minX, a.labelX - lw);
    maxX = Math.max(maxX, a.labelX + lw);
    minY = Math.min(minY, a.labelY - lh);
    maxY = Math.max(maxY, a.labelY + lh);
  }
  const pad = constants.svgPad;

  return {
    originX: minX - pad,
    originY: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
    colWidths,
    rowHeights,
    colGaps,
    rowGaps,
    cellCenters,
    cells,
    arrows,
    metrics,
    constants,
  };
}

// ---------------------------------------------------------------------------
// renderDiagram — DOM shell over layoutDiagram
// ---------------------------------------------------------------------------

export function renderDiagram(model: DiagramModel, opts: RenderOptions = {}): SVGElement {
  const doc = opts.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) {
    throw new Error("renderDiagram requires a DOM document (pass opts.document)");
  }
  const metrics = opts.metrics ?? getCDStyleMetrics(doc);
  const renderLabel = opts.renderLabel ?? defaultLabelRenderer(doc, metrics);

  const { layout, elementFor } = prepareLayout(model, opts, doc, metrics, renderLabel);
  return buildSvg(doc, layout, elementFor);
}

/**
 * Async variant: renders labels, awaits MathJax typesetting, then measures
 * and builds the SVG. Use this in Obsidian (where MathJax typesets
 * asynchronously) so \phi / X^{n} aren't captured as empty pre-typeset nodes.
 * Falls back to synchronous measurement when MathJax is absent.
 */
export async function renderDiagramAsync(
  model: DiagramModel,
  opts: RenderOptions = {},
): Promise<SVGElement> {
  const doc = opts.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) {
    throw new Error("renderDiagram requires a DOM document (pass opts.document)");
  }
  const metrics = opts.metrics ?? getCDStyleMetrics(doc);
  const renderLabel = opts.renderLabel ?? defaultLabelRenderer(doc, metrics);

  // Mount prototypes and wait for MathJax to fill them before measuring.
  const prototypes = new Map<string, HTMLElement>();
  const measured = new Map<string, MeasuredSize>();
  let measure: LabelMeasurer;
  if (opts.measureLabel) {
    measure = opts.measureLabel;
  } else {
    const unique = collectLabels(model);
    const host = mountLabelHost(doc, renderLabel, unique, prototypes, measured, metrics);
    if (host) {
      await awaitMathJaxTypeset(doc, host);
      measureMountedLabels(host, prototypes, measured, metrics);
    }
    measure = makeMeasure(measured, metrics);
  }
  const layout = layoutDiagram(model, measure, metrics);
  const elementFor = (latex: string): HTMLElement => {
    const proto = prototypes.get(latex);
    if (proto) return proto.cloneNode(true) as HTMLElement;
    return renderLabel(latex);
  };
  return buildSvg(doc, layout, elementFor);
}

/** Shared sync prep for renderDiagram (and a base for the async path). */
function prepareLayout(
  model: DiagramModel,
  opts: RenderOptions,
  doc: Document,
  metrics: CDStyleMetrics,
  renderLabel: LabelRenderer,
): { layout: DiagramLayout; elementFor: (latex: string) => HTMLElement } {
  const prototypes = new Map<string, HTMLElement>();
  const measured = new Map<string, MeasuredSize>();
  let measure: LabelMeasurer;
  if (opts.measureLabel) {
    measure = opts.measureLabel;
  } else {
    const unique = collectLabels(model);
    const host = mountLabelHost(doc, renderLabel, unique, prototypes, measured, metrics);
    if (host) measureMountedLabels(host, prototypes, measured, metrics);
    measure = makeMeasure(measured, metrics);
  }
  const layout = layoutDiagram(model, measure, metrics);
  const elementFor = (latex: string): HTMLElement => {
    const proto = prototypes.get(latex);
    if (proto) return proto.cloneNode(true) as HTMLElement;
    return renderLabel(latex);
  };
  return { layout, elementFor };
}

function collectLabels(model: DiagramModel): Set<string> {
  const unique = new Set<string>();
  for (const c of model.cells) if (c.label.trim() !== "") unique.add(c.label);
  for (const a of model.arrows) if (a.label && a.label.trim() !== "") unique.add(a.label);
  return unique;
}

function makeMeasure(measured: Map<string, MeasuredSize>, metrics: CDStyleMetrics): LabelMeasurer {
  return (latex: string): MeasuredSize => {
    const m = measured.get(latex);
    if (m) return m;
    const est = estimateSize(latex, metrics);
    measured.set(latex, est);
    return est;
  };
}

// ---------------------------------------------------------------------------
// SVG construction
// ---------------------------------------------------------------------------

function buildSvg(
  doc: Document,
  layout: DiagramLayout,
  elementFor: (latex: string) => HTMLElement,
): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "cd-diagram-svg");
  svg.setAttribute(
    "viewBox",
    `${r2(layout.originX)} ${r2(layout.originY)} ${r2(layout.width)} ${r2(layout.height)}`,
  );
  svg.setAttribute("width", String(Math.ceil(layout.width)));
  svg.setAttribute("height", String(Math.ceil(layout.height)));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "commutative diagram");
  svg.setAttribute("xmlns", SVG_NS);

  const gArrows = doc.createElementNS(SVG_NS, "g");
  gArrows.setAttribute("class", "cd-arrows");
  const gLabels = doc.createElementNS(SVG_NS, "g");
  gLabels.setAttribute("class", "cd-labels");
  // Labels must not swallow clicks meant for the diagram (click-to-edit, §8)
  // or for arrows in the editor preview.
  gLabels.setAttribute("pointer-events", "none");
  svg.appendChild(gArrows);
  svg.appendChild(gLabels);

  for (const a of layout.arrows) {
    gArrows.appendChild(buildArrow(doc, a, layout));
  }
  for (const cell of layout.cells) {
    gLabels.appendChild(
      buildLabelFo(doc, cell.cx, cell.cy, cell.width, cell.height, elementFor(cell.label), "cd-cell-label-box"),
    );
  }
  for (const a of layout.arrows) {
    if (!a.label || a.labelX === undefined || a.labelY === undefined) continue;
    const fo = buildLabelFo(
      doc,
      a.labelX,
      a.labelY,
      a.labelWidth ?? 1,
      a.labelHeight ?? 1,
      elementFor(a.label),
      "cd-arrow-label-box",
    );
    fo.setAttribute("data-arrow-id", a.id);
    gLabels.appendChild(fo);
  }
  return svg;
}

function buildArrow(doc: Document, a: ArrowLayout, layout: DiagramLayout): SVGGElement {
  const C = layout.constants;
  const sw = layout.metrics.arrowStrokeWidth;
  const g = doc.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "cd-arrow");
  g.setAttribute("data-arrow-id", a.id);

  // Shaft. A curved arrow (curve !== 0, with a control point) draws a quadratic
  // Bézier; otherwise a straight line. Heads/tails use the tangent directions
  // (startDir/endDir) so they meet the curve cleanly at each end.
  const shaft = doc.createElementNS(SVG_NS, "path");
  if (a.curve !== 0 && a.ctrlX !== undefined && a.ctrlY !== undefined) {
    shaft.setAttribute(
      "d",
      `M ${r2(a.x1)} ${r2(a.y1)} Q ${r2(a.ctrlX)} ${r2(a.ctrlY)} ${r2(a.x2)} ${r2(a.y2)}`,
    );
  } else {
    shaft.setAttribute("d", `M ${r2(a.x1)} ${r2(a.y1)} L ${r2(a.x2)} ${r2(a.y2)}`);
  }
  shaft.setAttribute("class", `cd-arrow-shaft cd-line-${a.lineStyle}`);
  styleStroke(shaft, sw);
  if (a.lineStyle === "dashed") shaft.setAttribute("stroke-dasharray", C.dashedArray);
  if (a.lineStyle === "dotted") shaft.setAttribute("stroke-dasharray", C.dottedArray);
  g.appendChild(shaft);

  // Head at the target end, along the end tangent. mapsto/hook end in a plain
  // arrowhead; their decoration lives at the tail (along the start tangent).
  appendHead(g, doc, headGlyph(a.head), a.x2, a.y2, a.endDirX, a.endDirY, C, sw);

  if (a.bidirectional) {
    // §6.2: double-headed arrow (isomorphisms/equivalences). A "none" head
    // makes no sense double-ended, so upgrade it to a plain head.
    appendHead(g, doc, headGlyph(a.head === "none" ? "default" : a.head), a.x1, a.y1, -a.startDirX, -a.startDirY, C, sw);
  } else if (a.head === "mapsto") {
    appendMapstoBar(g, doc, a.x1, a.y1, a.startDirX, a.startDirY, C, sw);
  } else if (a.head === "hook") {
    appendHookTail(g, doc, a.x1, a.y1, a.startDirX, a.startDirY, C, sw);
  }
  return g;
}

/** The glyph drawn at the target end for a given head style. */
function headGlyph(head: ArrowHead): "default" | "epi" | "none" {
  if (head === "epi") return "epi";
  if (head === "none") return "none";
  return "default"; // default, mapsto, hook all terminate in a plain head
}

function appendHead(
  g: SVGGElement,
  doc: Document,
  glyph: "default" | "epi" | "none",
  tipX: number,
  tipY: number,
  dirX: number,
  dirY: number,
  C: RenderConstants,
  sw: number,
): void {
  if (glyph === "none") return;
  g.appendChild(headPath(doc, chevronD(tipX, tipY, dirX, dirY, C.headLen, C.headHalf), sw));
  if (glyph === "epi") {
    // Twin arrowhead (↠): a second chevron trailing the first.
    const back = C.headLen * 0.9;
    g.appendChild(
      headPath(doc, chevronD(tipX - dirX * back, tipY - dirY * back, dirX, dirY, C.headLen, C.headHalf), sw),
    );
  }
}

/** Open chevron: two segments meeting at the tip (thin, single-stroke, §6.4). */
function chevronD(
  tipX: number,
  tipY: number,
  dirX: number,
  dirY: number,
  len: number,
  half: number,
): string {
  const bx = tipX - dirX * len;
  const by = tipY - dirY * len;
  const px = dirY; // perpLeft(dir)
  const py = -dirX;
  return (
    `M ${r2(bx + px * half)} ${r2(by + py * half)}` +
    ` L ${r2(tipX)} ${r2(tipY)}` +
    ` L ${r2(bx - px * half)} ${r2(by - py * half)}`
  );
}

/** mapsto (↦): a full perpendicular bar at the tail. */
function appendMapstoBar(
  g: SVGGElement,
  doc: Document,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  C: RenderConstants,
  sw: number,
): void {
  const px = dirY;
  const py = -dirX;
  const d =
    `M ${r2(x + px * C.tailTickHalf)} ${r2(y + py * C.tailTickHalf)}` +
    ` L ${r2(x - px * C.tailTickHalf)} ${r2(y - py * C.tailTickHalf)}`;
  g.appendChild(headPath(doc, d, sw));
}

/** hook (↪ / \hookrightarrow): a J-shaped curl at the tail, on the
 *  left-of-travel side (up for a rightward arrow, matching the AMS glyph).
 *
 *  Two constraints make it read as a proper hook:
 *   1. The curl ENDS exactly at the tail with end-tangent == shaft direction,
 *      so it joins the shaft smoothly (no kink).
 *   2. The curl's START lies directly perpendicular to the tail — the line from
 *      start to tail is perpendicular to the shaft — so the hook is a clean
 *      quarter-arc, not a stubby diagonal.
 *  Construction (quadratic Bézier, h = hookLen):
 *    end     = tail (x, y)
 *    start   = tail + h·perp         (perpendicular to the tail — constraint 2)
 *    control = tail − h·dir          (behind the tail, on the shaft line)
 *  For a rightward arrow: start (x, y−h), control (x−h, y), end (x, y) — the
 *  curl sweeps from straight-up, around, into the shaft pointing right; the
 *  end-tangent (end−control) = (h, 0) = shaft dir (constraint 1). */
function appendHookTail(
  g: SVGGElement,
  doc: Document,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  C: RenderConstants,
  sw: number,
): void {
  const px = dirY; // perpLeft(dir) = (dirY, -dirX)
  const py = -dirX;
  const h = C.hookLen;
  // start: perpendicular to the tail — so the start→tail line is perpendicular
  // to the shaft (the hook reads as a quarter-arc, not a diagonal stub).
  const sx = x + px * h;
  const sy = y + py * h;
  // control: behind the tail on the shaft line → end-tangent == shaft dir, so
  // the curl joins the shaft with no kink.
  const cx = x - dirX * h;
  const cy = y - dirY * h;
  g.appendChild(headPath(doc, `M ${r2(sx)} ${r2(sy)} Q ${r2(cx)} ${r2(cy)} ${r2(x)} ${r2(y)}`, sw));
}

function headPath(doc: Document, d: string, sw: number): SVGPathElement {
  const p = doc.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("class", "cd-arrow-head");
  styleStroke(p, sw);
  p.setAttribute("stroke-linejoin", "round");
  return p;
}

function styleStroke(el: SVGPathElement, sw: number): void {
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", String(sw));
  el.setAttribute("stroke-linecap", "round");
}

function buildLabelFo(
  doc: Document,
  cx: number,
  cy: number,
  w: number,
  h: number,
  el: HTMLElement,
  className: string,
): SVGForeignObjectElement {
  const fo = doc.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", String(r2(cx - w / 2)));
  fo.setAttribute("y", String(r2(cy - h / 2)));
  fo.setAttribute("width", String(r2(Math.max(w, 1))));
  fo.setAttribute("height", String(r2(Math.max(h, 1))));
  fo.setAttribute("class", className);
  // Don't clip descenders / tall scripts that slightly exceed the measure.
  fo.style.overflow = "visible";
  if (!el.getAttribute("xmlns")) el.setAttribute("xmlns", XHTML_NS);
  fo.appendChild(el);
  return fo;
}

// ---------------------------------------------------------------------------
// Label rendering / measurement helpers
// ---------------------------------------------------------------------------

/**
 * Default label renderer: Obsidian's renderMath (MathJax) when available,
 * falling back to plain text so the renderer never hard-fails on a bad
 * snippet or a headless environment.
 */
function defaultLabelRenderer(doc: Document, metrics: CDStyleMetrics): LabelRenderer {
  return (latex: string): HTMLElement => {
    const host = doc.createElement("div");
    host.setAttribute("xmlns", XHTML_NS);
    host.className = "cd-rendered-label";
    host.style.fontSize = `${metrics.fontSize}px`;
    const w = (typeof window !== "undefined" ? window : undefined) as
      | { renderMath?: (tex: string, display: boolean) => HTMLElement }
      | undefined;
    if (w && typeof w.renderMath === "function") {
      try {
        host.appendChild(w.renderMath(latex, false));
        return host;
      } catch {
        // fall through to the text fallback
      }
    }
    const span = doc.createElement("span");
    span.textContent = latex;
    host.appendChild(span);
    return host;
  };
}

/**
 * Render each unique label once into a hidden host. The host stays mounted
 * (returned to the caller) so MathJax can typeset it asynchronously; call
 * `measureMountedLabels` after typesetting to read real offsets. Prototypes
 * are stored so the SVG builder can clone the now-filled nodes.
 *
 * Returns null (and fills `measured` with estimates) when there's no document
 * body to mount into.
 */
function mountLabelHost(
  doc: Document,
  renderLabel: LabelRenderer,
  labels: Set<string>,
  prototypes: Map<string, HTMLElement>,
  measured: Map<string, MeasuredSize>,
  metrics: CDStyleMetrics,
): HTMLElement | null {
  if (labels.size === 0) return null;
  if (!doc.body) {
    for (const latex of labels) measured.set(latex, estimateSize(latex, metrics));
    return null;
  }
  const host = doc.createElement("div");
  host.style.position = "absolute";
  host.style.visibility = "hidden";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.pointerEvents = "none";
  doc.body.appendChild(host);
  for (const latex of labels) {
    const el = renderLabel(latex);
    prototypes.set(latex, el);
    host.appendChild(el);
  }
  return host;
}

/** Read real offsets from a mounted, typeset label host into `measured`. */
function measureMountedLabels(
  host: HTMLElement,
  prototypes: Map<string, HTMLElement>,
  measured: Map<string, MeasuredSize>,
  metrics: CDStyleMetrics,
): void {
  for (const [latex, el] of prototypes) {
    const est = estimateSize(latex, metrics);
    measured.set(latex, {
      width: el.offsetWidth > 0 ? el.offsetWidth : est.width,
      height: el.offsetHeight > 0 ? el.offsetHeight : est.height,
    });
  }
  host.remove();
}

/** Rough size estimate used only when real measurement is impossible. */
function estimateSize(latex: string, metrics: CDStyleMetrics): MeasuredSize {
  return {
    width: Math.max(1, latex.length) * metrics.fontSize * 0.5,
    height: metrics.fontSize * 1.25,
  };
}

/**
 * Wait for MathJax to finish typesetting the given host's descendants.
 * Obsidian ships MathJax (CHTML output) which typesets asynchronously:
 * renderMath() returns an element whose content is filled in on a later
 * microtask. Measuring or cloning it immediately captures an empty node, so
 * \phi / X^{n} render as blank boxes and single characters only work by luck.
 *
 * Resolves immediately when MathJax isn't present (tests, text fallback) so
 * callers stay synchronous in those environments.
 */
function awaitMathJaxTypeset(doc: Document, host: HTMLElement): Promise<void> {
  const w = typeof window !== "undefined" ? (window as unknown as {
    MathJax?: {
      typesetPromise?: (els: (HTMLElement | Element)[]) => Promise<unknown>;
      startup?: { promise?: Promise<unknown> };
    };
  }) : undefined;
  const mj = w?.MathJax;
  if (!mj) return Promise.resolve();
  // Ensure the loader/startup finished, then typeset just our host.
  const startup = mj.startup?.promise ?? Promise.resolve();
  const typeset =
    typeof mj.typesetPromise === "function"
      ? mj.typesetPromise([host])
      : Promise.resolve();
  return Promise.all([startup, typeset]).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function repeat(n: number, v: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(v);
  return out;
}

function inGrid(p: CellPos, rows: number, cols: number): boolean {
  return p.row >= 0 && p.row < rows && p.col >= 0 && p.col < cols;
}

function comparePos(a: CellPos, b: CellPos): number {
  return a.row - b.row || a.col - b.col;
}

function pairKey(a: CellPos, b: CellPos): string {
  return comparePos(a, b) <= 0
    ? `${a.row},${a.col}|${b.row},${b.col}`
    : `${b.row},${b.col}|${a.row},${a.col}`;
}

/** Intersection of the ray (cx,cy)+t*(dx,dy) with the rectangle of half
 *  extents (hw,hh) centered at (cx,cy). A zero-size box anchors at center. */
function clipToBox(
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  hw: number,
  hh: number,
): { x: number; y: number } {
  const tx = Math.abs(dx) < 1e-9 ? Infinity : hw / Math.abs(dx);
  const ty = Math.abs(dy) < 1e-9 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Unit vector along (x,y), falling back to (fx,fy) when (x,y) is ~zero (e.g.
 *  a degenerate Bézier tangent when the control point coincides with an
 *  endpoint — shouldn't happen for a real curve, but guards the math). */
function unitOrFallback(x: number, y: number, fx: number, fy: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return { x: fx, y: fy };
  return { x: x / len, y: y / len };
}

/**
 * Unit normal for an arrow label. "left"/"right" are relative to the
 * direction of travel (left = tikz-cd's default auto side). "above"/"below"
 * pick whichever perpendicular side points more screen-up / screen-down, so
 * labels never land on top of the shaft for vertical arrows.
 */
function labelNormal(pos: LabelPosition, dx: number, dy: number): { x: number; y: number } {
  const left = { x: dy, y: -dx };
  const right = { x: -dy, y: dx };
  switch (pos) {
    case "left":
      return left;
    case "right":
      return right;
    case "above":
      return left.y <= right.y ? left : right;
    case "below":
      return left.y >= right.y ? left : right;
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
