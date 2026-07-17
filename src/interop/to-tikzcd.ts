/**
 * src/interop/to-tikzcd.ts (§9 — Phase 5)
 *
 * Export a DiagramModel to a tikz-cd `\begin{tikzcd}…\end{tikzcd}` block.
 *
 * Our model is already grid-shaped like tikz-cd's own matrix, so the mapping is
 * direct: every occupied cell (label, or an arrow endpoint that needs an
 * anchor) becomes a matrix entry; every arrow becomes an `\arrow[…]` on its
 * source cell. Arrow options map 1:1 from head/lineStyle/bidirectional/
 * labelPosition:
 *   head=default   → (no option)
 *   head=epi       → two heads
 *   head=hook      → hook
 *   head=mapsto    → mapsto
 *   head=none      → no head
 *   lineStyle=dashed/dotted → dashed/dotted
 *   bidirectional  → leftrightarrow  (note: this is a head option in tikz-cd;
 *                    it replaces the plain head, so it is emitted instead of
 *                    any head= option — a CD-style <-> arrow has neither two
 *                    heads nor a hook tail in our model, so there's no clash)
 *   labelPosition  → default (left of travel = tikz-cd's auto side) or swap
 *
 * Direction letters are derived from the (dRow, dCol) offset between source and
 * target: r/l per ±col, u/d per ∓row (up decreases the row index). tikz-cd
 * expects the horizontal letter first, then vertical, matching `\arrow[dr]`.
 *
 * The emitted LaTeX is intended to compile unmodified in a real document — the
 * gate for §14 ("compiles unmodified for every fixture").
 */

import {
  getLabel,
  type ArrowHead,
  type DiagramArrow,
  type DiagramModel,
  type LineStyle,
} from "../diagram/model";

export interface ToTikzcdOptions {
  /** Wrap output in `\begin{tikzcd}…\end{tikzcd}` (default true). When false,
   *  emit only the matrix body — useful for embedding inside an existing env. */
  wrap?: boolean;
}

/** Serialize a model to a tikz-cd block. */
export function toTikzcd(model: DiagramModel, opts: ToTikzcdOptions = {}): string {
  const { rows, cols } = model;
  const body = renderBody(model, rows, cols);
  if (opts.wrap === false) return body;
  return `\\begin{tikzcd}\n${indent(body)}\n\\end{tikzcd}`;
}

function renderBody(model: DiagramModel, rows: number, cols: number): string {
  const cellArrows = arrowsBySource(model);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const label = getLabel(model, r, c);
      const arrows = cellArrows.get(r * cols + c) ?? [];
      const cell = renderCell(label, arrows);
      parts.push(cell);
    }
    lines.push(parts.join(" & "));
  }
  return lines.join(" \\\\\n");
}

/** Group arrows by their source cell so each cell emits its own `\arrow`s. */
function arrowsBySource(model: DiagramModel): Map<number, DiagramArrow[]> {
  const m = new Map<number, DiagramArrow[]>();
  for (const a of model.arrows) {
    const key = a.from.row * model.cols + a.from.col;
    const list = m.get(key);
    if (list) list.push(a);
    else m.set(key, [a]);
  }
  return m;
}

/** Render one matrix entry: its label (or a blank) plus trailing `\arrow[…]`. */
function renderCell(label: string, arrows: DiagramArrow[]): string {
  const cellLabel = label.trim() === "" ? "" : label;
  const arrowStrs = arrows.map(renderArrow);
  const tail = arrowStrs.length > 0 ? " " + arrowStrs.join(" ") : "";
  if (cellLabel === "" && arrowStrs.length === 0) return "";
  return `${cellLabel}${tail}`;
}

function renderArrow(a: DiagramArrow): string {
  const dir = directionLetters(a);
  const opts: string[] = [dir];
  const headOpt = headOption(a.head, a.bidirectional);
  if (headOpt) opts.push(headOpt);
  const lineOpt = lineOption(a.lineStyle);
  if (lineOpt) opts.push(lineOpt);
  const labelPart = labelPartFor(a);
  if (labelPart) opts.push(labelPart);
  return `\\arrow[${opts.join(", ")}]`;
}

/** tikz-cd direction letters for an arrow's (dRow, dCol) offset. */
function directionLetters(a: DiagramArrow): string {
  const dCol = a.to.col - a.from.col;
  const dRow = a.to.row - a.from.row;
  let s = "";
  if (dCol > 0) s += repeat("r", dCol);
  else if (dCol < 0) s += repeat("l", -dCol);
  if (dRow > 0) s += repeat("d", dRow);
  else if (dRow < 0) s += repeat("u", -dRow);
  return s;
}

/** tikz-cd head/relationship option string, or null for the plain default. */
function headOption(head: ArrowHead | undefined, bidirectional: boolean | undefined): string | null {
  if (bidirectional) return "leftrightarrow";
  switch (head) {
    case "epi":
      return "two heads";
    case "hook":
      return "hook";
    case "mapsto":
      return "mapsto";
    case "none":
      return "no head";
    default:
      return null; // default → no option
  }
}

function lineOption(line: LineStyle | undefined): string | null {
  switch (line) {
    case "dashed":
      return "dashed";
    case "dotted":
      return "dotted";
    default:
      return null;
  }
}

/**
 * tikz-cd label clause: `"label"` on the default side (left of the direction of
 * travel — tikz-cd's auto side) or `"label" swap` for the opposite side. Our
 * labelPosition "left" = default side, "right" = swapped; "above"/"below"
 * collapse to whichever side that is for the arrow's orientation, so we map
 * them to left/right by the same rule the renderer uses (§6, labelNormal).
 * No label → empty string.
 */
function labelPartFor(a: DiagramArrow): string {
  if (!a.label || a.label.trim() === "") return "";
  const swap = shouldSwap(a);
  const lbl = quoteLabel(a.label);
  return swap ? `"${lbl}" swap` : `"${lbl}"`;
}

/**
 * Decide whether the arrow's labelPosition maps to tikz-cd's swapped side. For
 * horizontal arrows, "left" (above) is the default side and "right" (below)
 * swaps; for vertical arrows, "left" is the default side and "right" swaps;
 * "above"/"below" pick a side by orientation the same way the renderer does.
 */
function shouldSwap(a: DiagramArrow): boolean {
  const pos = a.labelPosition ?? "left";
  const dCol = a.to.col - a.from.col;
  const dRow = a.to.row - a.from.row;
  const horizontal = Math.abs(dCol) >= Math.abs(dRow);
  // tikz-cd's auto/default side is "above" for a rightward arrow and "left"
  // for a downward arrow — i.e. the left-of-travel side in both cases, which
  // is exactly our "left". So "right" always swaps. "above"/"below" only make
  // sense for the dominant axis; resolve them to a left/right side.
  switch (pos) {
    case "left":
      return false;
    case "right":
      return true;
    case "above":
      // "above" = the side pointing more screen-up. For a horizontal arrow
      // that's the default (left-of-travel) side; for a vertical arrow the
      // perpendicular sides are left/right, so "above" has no natural meaning
      // and we keep it on the default side.
      return false;
    case "below":
      return horizontal ? true : false;
    default:
      return false;
  }
}

/** Quote a label for tikz-cd. Labels are raw LaTeX (e.g. `\cong`, `f'`), so
 *  backslashes must be preserved verbatim — only a literal `"` would break the
 *  surrounding quotes and needs escaping. */
function quoteLabel(label: string): string {
  return label.replace(/"/g, '\\"');
}

function repeat(s: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += s;
  return out;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((line) => (line.length === 0 ? "" : "  " + line))
    .join("\n");
}
