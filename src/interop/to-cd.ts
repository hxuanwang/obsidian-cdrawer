/**
 * src/interop/to-cd.ts (§9 — Phase 5)
 *
 * Export a DiagramModel to a plain AMS `\begin{CD}…\end{CD}` block, but ONLY
 * when the model is expressible in the amscd vocabulary:
 *   - every arrow connects orthogonally-adjacent cells (a single r/l/u/d step);
 *   - every arrow has at most one label;
 *   - arrow style is limited to what CD can say: plain, dashed/dotted line,
 *     and (via the `amscd` extensions) head/tail decorations are NOT supported
 *     by the core CD environment — so epi/hook/mapsto/bidirectional arrows
 *     make a diagram non-exportable to CD (export as tikz-cd instead).
 *
 * amscd's CD arrows (and their label slots):
 *   @>>>       → right            @<f<< or @>f>> label above/below
 *   @<<<       → left
 *   @VVV       → down             @VfVV label left/right
 *   @AAA       → up
 *   @.         → no arrow (empty cell separator)
 *   |=|        → vertical equal   not used here
 * Line style is not part of core amscd; we therefore treat dashed/dotted as a
 * gating condition too (exporting a plain solid line where the user asked for
 * dashed would be lossy). The §9 brief explicitly says: gate, and if not
 * expressible, "disable with an explanatory tooltip" — implemented here as
 * `canExportToCD(model)` returning a reason string when not.
 *
 * CD has no concept of grid rows/cols beyond what the `&` / `\\` layout
 * expresses, and no way to place an arrow that skips a cell — hence the
 * adjacency requirement.
 */

import { getLabel, type DiagramModel } from "../diagram/model";

export interface ToCDOptions {
  /** Wrap output in `\begin{CD}…\end{CD}` (default true). */
  wrap?: boolean;
}

/**
 * Can this model be exported to plain AMS CD? Returns null if yes, or a
 * human-readable reason string if not (for the UI's "export as tikz-cd instead"
 * tooltip, §9).
 */
export function canExportToCD(model: DiagramModel): string | null {
  if (model.arrows.length === 0 && model.cells.length === 0) {
    return "diagram is empty";
  }
  for (const a of model.arrows) {
    const dCol = Math.abs(a.to.col - a.from.col);
    const dRow = Math.abs(a.to.row - a.from.row);
    if (dCol + dRow !== 1) {
      return "contains a diagonal or skipped arrow — export as tikz-cd instead";
    }
    // Multiple labels per arrow aren't representable, but our model only ever
    // has one `label` field, so this is always fine — keep the check for clarity.
    if (a.head && a.head !== "default") {
      return `arrow head "${a.head}" is not expressible in AMS CD — export as tikz-cd instead`;
    }
    if (a.bidirectional) {
      return "bidirectional arrows are not expressible in AMS CD — export as tikz-cd instead";
    }
    if (a.lineStyle && a.lineStyle !== "solid") {
      return `${a.lineStyle} arrows are not expressible in AMS CD — export as tikz-cd instead`;
    }
  }
  return null;
}

/** Serialize a model to a CD block. Throws if the model isn't CD-expressible. */
export function toCD(model: DiagramModel, opts: ToCDOptions = {}): string {
  const reason = canExportToCD(model);
  if (reason) throw new Error(`cannot export to CD: ${reason}`);
  const body = renderBody(model);
  if (opts.wrap === false) return body;
  return `\\begin{CD}\n${indent(body)}\n\\end{CD}`;
}

function renderBody(model: DiagramModel): string {
  const { rows, cols } = model;
  const horizByRow = horizontalArrowsByRow(model);
  const vertByCol = verticalArrowsByCol(model);

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      parts.push(getLabel(model, r, c));
      if (c < cols - 1) {
        const arr = horizByRow.get(`${r},${c}`); // arrow starting at (r,c) going right
        parts.push(arr ? cdRightArrow(arr) : "@.");
      }
    }
    lines.push(parts.join(" "));
    // Down-arrow row: one CD arrow token per column (or @. ), between this row
    // and the next.
    if (r < rows - 1) {
      const downParts: string[] = [];
      for (let c = 0; c < cols; c++) {
        const arr = vertByCol.get(`${r},${c}`); // arrow starting at (r,c) going down
        downParts.push(arr ? cdDownArrow(arr) : "@.");
      }
      lines.push(downParts.join(" & "));
    }
  }
  return lines.join(" \\\\\n");
}

type HDir = "right" | "left";
type VDir = "down" | "up";
interface HArrow {
  arrow: DiagramModel["arrows"][number];
  dir: HDir;
}
interface VArrow {
  arrow: DiagramModel["arrows"][number];
  dir: VDir;
}

/**
 * Horizontal arrows (single step left/right), keyed by "row,col" of their LEFT
 * cell (the lower column index) — that's where the token sits in the CD row,
 * regardless of which way the arrow points.
 */
function horizontalArrowsByRow(model: DiagramModel): Map<string, HArrow> {
  const m = new Map<string, HArrow>();
  for (const a of model.arrows) {
    if (a.to.row !== a.from.row) continue;
    if (a.to.col === a.from.col + 1) {
      m.set(`${a.from.row},${a.from.col}`, { arrow: a, dir: "right" });
    } else if (a.to.col === a.from.col - 1) {
      m.set(`${a.to.row},${a.to.col}`, { arrow: a, dir: "left" });
    }
  }
  return m;
}

/**
 * Vertical arrows (single step up/down), keyed by "row,col" of their TOP cell
 * (the lower row index) — that's where the token sits in the CD down-arrow row.
 */
function verticalArrowsByCol(model: DiagramModel): Map<string, VArrow> {
  const m = new Map<string, VArrow>();
  for (const a of model.arrows) {
    if (a.to.col !== a.from.col) continue;
    if (a.to.row === a.from.row + 1) {
      m.set(`${a.from.row},${a.from.col}`, { arrow: a, dir: "down" });
    } else if (a.to.row === a.from.row - 1) {
      m.set(`${a.to.row},${a.to.col}`, { arrow: a, dir: "up" });
    }
  }
  return m;
}

/**
 * Horizontal CD arrow token. The token is `@` + three shaft glyphs with the
 * optional label in the first slot (1 leading glyph, 2 trailing) or the second
 * slot (2 leading, 1 trailing):
 *   right (@>>>):  unlabeled @>>>   above @>f>>   below @>>f>
 *   left  (@<<<):  unlabeled @<<<   above @<f<<   below @<<f<
 * "Above" (first slot) corresponds to our labelPosition left/above; "below"
 * (second slot) to right/below.
 */
function cdRightArrow(h: HArrow): string {
  const lbl = h.arrow.label ?? "";
  const g = h.dir === "right" ? ">" : "<";
  const two = g + g;
  if (lbl.trim() === "") return `@${two}${g}`;
  return labelAbove(h.arrow) ? `@${g}${lbl}${two}` : `@${two}${lbl}${g}`;
}

/**
 * Vertical CD arrow token, analogous to the horizontal one:
 *   down (@VVV):  unlabeled @VVV   left @VfVV   right @VVfV
 *   up   (@AAA):  unlabeled @AAA   left @AfAA   right @AAfA
 */
function cdDownArrow(v: VArrow): string {
  const lbl = v.arrow.label ?? "";
  const g = v.dir === "down" ? "V" : "A";
  const two = g + g;
  if (lbl.trim() === "") return `@${two}${g}`;
  return labelLeft(v.arrow) ? `@${g}${lbl}${two}` : `@${two}${lbl}${g}`;
}

/** Should this horizontal arrow's label render above (CD's first slot)? */
function labelAbove(a: DiagramModel["arrows"][number]): boolean {
  const pos = a.labelPosition ?? "left";
  return pos === "left" || pos === "above";
}

/** Should this vertical arrow's label render on the left (CD's first slot)? */
function labelLeft(a: DiagramModel["arrows"][number]): boolean {
  const pos = a.labelPosition ?? "left";
  return pos === "left" || pos === "above";
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((line) => (line.length === 0 ? "" : "  " + line))
    .join("\n");
}
