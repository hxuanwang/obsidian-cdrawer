/**
 * src/diagram/model.ts
 *
 * The DiagramModel data model, plus parse/serialize and the pure grid
 * insert/delete row/col functions (§4). These are written to be isolated and
 * unit-testable before any UI is wired to them, since off-by-one errors here
 * silently corrupt existing arrows.
 */

export type ArrowHead = "default" | "epi" | "hook" | "mapsto" | "none";
export type LineStyle = "solid" | "dashed" | "dotted";
export type LabelPosition = "left" | "right" | "above" | "below";

export interface CellPos {
  row: number;
  col: number;
}

export interface DiagramCell {
  row: number;
  col: number;
  /** LaTeX source; empty string = unoccupied cell (no object drawn). */
  label: string;
}

export interface DiagramArrow {
  id: string;
  from: CellPos;
  to: CellPos;
  /** LaTeX source for the arrow label. */
  label?: string;
  labelPosition?: LabelPosition;
  head?: ArrowHead;
  lineStyle?: LineStyle;
  /** Renders as <-> (isomorphism / equivalence). */
  bidirectional?: boolean;
  /**
   * Signed curve amount in [-1, 1]: 0 (default) = straight shaft; the magnitude
   * is how far the arc's apex deviates from the chord, as a fraction of the
   * chord length; the sign picks which side it bulges (positive = left of the
   * direction of travel, matching tikz-cd's "bend left"). Set by dragging the
   * arrow's curve handle in the grid editor or via the Curve slider in the
   * properties popover. Out-of-range values are clamped on parse.
   */
  curve?: number;
}

export interface DiagramModel {
  version: 1;
  rows: number;
  cols: number;
  /** Sparse: fully-empty cells are omitted after commit-time trim. */
  cells: DiagramCell[];
  arrows: DiagramArrow[];
}

/** Default arrow/cell option constants shared by editor + settings. */
export const DEFAULT_HEAD: ArrowHead = "default";
export const DEFAULT_LINE: LineStyle = "solid";

/** Curve bounds (DiagramArrow.curve is clamped to [-1, 1]). Shared by the
 *  editor's slider/handle and the tikz-cd bend mapping. */
export const CURVE_MIN = -1;
export const CURVE_MAX = 1;
/** Apex offset of a fully-curved arrow, as a fraction of the chord length. */
export const CURVE_APEX_FRAC = 0.28;

let _idCounter = 0;
/** Generate a locally-unique arrow id. Deterministic enough for tests to
 *  compare structures by replacing ids; ids only need to be unique within a
 *  single model. */
export function nextArrowId(): string {
  _idCounter += 1;
  return `a${_idCounter}`;
}

/** Reset the id counter (used by tests for deterministic ids). */
export function _resetIdCounter(): void {
  _idCounter = 0;
}

export function createEmptyModel(rows = 3, cols = 3): DiagramModel {
  return { version: 1, rows, cols, cells: [], arrows: [] };
}

export function cloneModel(m: DiagramModel): DiagramModel {
  return JSON.parse(JSON.stringify(m)) as DiagramModel;
}

/** Find the cell object at (row,col), or undefined if none (empty cell). */
export function getCell(model: DiagramModel, row: number, col: number): DiagramCell | undefined {
  return model.cells.find((c) => c.row === row && c.col === col);
}

/** Get a cell's label, or "" if the cell is unoccupied. */
export function getLabel(model: DiagramModel, row: number, col: number): string {
  return getCell(model, row, col)?.label ?? "";
}

/** Set a cell's label. Empty label removes the cell entry entirely (sparse). */
export function setCellLabel(model: DiagramModel, row: number, col: number, label: string): DiagramModel {
  const next = cloneModel(model);
  const trimmed = label.trim();
  const idx = next.cells.findIndex((c) => c.row === row && c.col === col);
  if (trimmed === "") {
    if (idx >= 0) next.cells.splice(idx, 1);
  } else {
    if (idx >= 0) next.cells[idx].label = label;
    else next.cells.push({ row, col, label });
  }
  return next;
}

/** Does any arrow reference (row,col) as an endpoint? */
function cellIsArrowEndpoint(model: DiagramModel, row: number, col: number): boolean {
  return model.arrows.some(
    (a) =>
      (a.from.row === row && a.from.col === col) ||
      (a.to.row === row && a.to.col === col),
  );
}

/** Is a cell "occupied" (has a label OR is an arrow endpoint)? */
function cellOccupied(model: DiagramModel, row: number, col: number): boolean {
  return getLabel(model, row, col) !== "" || cellIsArrowEndpoint(model, row, col);
}

/** Insert a row at `atIndex` (0..rows), shifting existing cells/arrows down. */
export function insertRow(model: DiagramModel, atIndex: number): DiagramModel {
  const next = cloneModel(model);
  const at = clamp(atIndex, 0, next.rows);
  next.rows += 1;
  for (const c of next.cells) if (c.row >= at) c.row += 1;
  for (const a of next.arrows) {
    if (a.from.row >= at) a.from.row += 1;
    if (a.to.row >= at) a.to.row += 1;
  }
  return next;
}

/** Insert a column at `atIndex` (0..cols), shifting existing cells/arrows right. */
export function insertCol(model: DiagramModel, atIndex: number): DiagramModel {
  const next = cloneModel(model);
  const at = clamp(atIndex, 0, next.cols);
  next.cols += 1;
  for (const c of next.cells) if (c.col >= at) c.col += 1;
  for (const a of next.arrows) {
    if (a.from.col >= at) a.from.col += 1;
    if (a.to.col >= at) a.to.col += 1;
  }
  return next;
}

/** Append a row at the end. */
export function appendRow(model: DiagramModel): DiagramModel {
  return insertRow(model, model.rows);
}

/** Append a column at the end. */
export function appendCol(model: DiagramModel): DiagramModel {
  return insertCol(model, model.cols);
}

/** Delete a row at `atIndex`. Returns the new model. Cells/arrows on that row
 *  are removed; rows below shift up. */
export function deleteRow(model: DiagramModel, atIndex: number): DiagramModel {
  const next = cloneModel(model);
  if (atIndex < 0 || atIndex >= next.rows) return next;
  next.rows -= 1;
  next.cells = next.cells
    .filter((c) => c.row !== atIndex)
    .map((c) => (c.row > atIndex ? { ...c, row: c.row - 1 } : c));
  next.arrows = next.arrows
    .filter((a) => a.from.row !== atIndex && a.to.row !== atIndex)
    .map((a) => ({
      ...a,
      from: a.from.row > atIndex ? { ...a.from, row: a.from.row - 1 } : a.from,
      to: a.to.row > atIndex ? { ...a.to, row: a.to.row - 1 } : a.to,
    }));
  return next;
}

/** Delete a column at `atIndex`. Analogous to deleteRow. */
export function deleteCol(model: DiagramModel, atIndex: number): DiagramModel {
  const next = cloneModel(model);
  if (atIndex < 0 || atIndex >= next.cols) return next;
  next.cols -= 1;
  next.cells = next.cells
    .filter((c) => c.col !== atIndex)
    .map((c) => (c.col > atIndex ? { ...c, col: c.col - 1 } : c));
  next.arrows = next.arrows
    .filter((a) => a.from.col !== atIndex && a.to.col !== atIndex)
    .map((a) => ({
      ...a,
      from: a.from.col > atIndex ? { ...a.from, col: a.from.col - 1 } : a.from,
      to: a.to.col > atIndex ? { ...a.to, col: a.to.col - 1 } : a.to,
    }));
  return next;
}

/** Would deleting this row destroy content (non-empty cells or arrow endpoints)? */
export function rowDeletionIsDestructive(model: DiagramModel, atIndex: number): boolean {
  for (let col = 0; col < model.cols; col++) {
    if (cellOccupied(model, atIndex, col)) return true;
  }
  return false;
}

export function colDeletionIsDestructive(model: DiagramModel, atIndex: number): boolean {
  for (let row = 0; row < model.rows; row++) {
    if (cellOccupied(model, row, atIndex)) return true;
  }
  return false;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Trim fully-empty trailing rows and columns (§4). A trailing row/col is
 *  empty if every cell in it is unoccupied (no label, no arrow endpoint). */
export function trimTrailing(model: DiagramModel): DiagramModel {
  let next = cloneModel(model);
  while (next.rows > 0) {
    let empty = true;
    for (let col = 0; col < next.cols; col++) {
      if (cellOccupied(next, next.rows - 1, col)) { empty = false; break; }
    }
    if (!empty) break;
    next = deleteRow(next, next.rows - 1);
  }
  while (next.cols > 0) {
    let empty = true;
    for (let row = 0; row < next.rows; row++) {
      if (cellOccupied(next, row, next.cols - 1)) { empty = false; break; }
    }
    if (!empty) break;
    next = deleteCol(next, next.cols - 1);
  }
  return next;
}

/** Is the model "entirely empty" — no labels and no arrows? (§7.4) */
export function isEmpty(model: DiagramModel): boolean {
  if (model.arrows.length > 0) return false;
  return model.cells.every((c) => c.label.trim() === "");
}

// ---------------------------------------------------------------------------
// parse / serialize
// ---------------------------------------------------------------------------

function normalizeModel(raw: unknown): DiagramModel {
  if (typeof raw !== "object" || raw === null) throw new Error("cd: invalid JSON (not an object)");
  const r = raw as Record<string, unknown>;
  const version = r.version === 1 ? 1 : 1;
  const rows = toNonNegInt(r.rows, "rows");
  const cols = toNonNegInt(r.cols, "cols");
  const cellsRaw = Array.isArray(r.cells) ? r.cells : [];
  const arrowsRaw = Array.isArray(r.arrows) ? r.arrows : [];

  const cells: DiagramCell[] = [];
  for (const c of cellsRaw) {
    if (typeof c !== "object" || c === null) continue;
    const co = c as Record<string, unknown>;
    const row = toNonNegInt(co.row, "cell.row");
    const col = toNonNegInt(co.col, "cell.col");
    const label = typeof co.label === "string" ? co.label : "";
    if (label.trim() === "") continue; // drop empty cells (sparse invariant)
    cells.push({ row, col, label });
  }

  const arrows: DiagramArrow[] = [];
  for (const a of arrowsRaw) {
    if (typeof a !== "object" || a === null) continue;
    const ao = a as Record<string, unknown>;
    const id = typeof ao.id === "string" && ao.id ? ao.id : nextArrowId();
    const from = toPos(ao.from, "arrow.from");
    const to = toPos(ao.to, "arrow.to");
    const arrow: DiagramArrow = { id, from, to };
    if (typeof ao.label === "string" && ao.label.trim() !== "") arrow.label = ao.label;
    if (ao.labelPosition !== undefined) {
      const lp = ao.labelPosition as LabelPosition;
      if (lp === "left" || lp === "right" || lp === "above" || lp === "below") {
        arrow.labelPosition = lp;
      }
    }
    const head = ao.head as ArrowHead;
    if (head === "default" || head === "epi" || head === "hook" || head === "mapsto" || head === "none") {
      arrow.head = head;
    }
    const line = ao.lineStyle as LineStyle;
    if (line === "solid" || line === "dashed" || line === "dotted") {
      arrow.lineStyle = line;
    }
    if (typeof ao.bidirectional === "boolean") arrow.bidirectional = ao.bidirectional;
    if (typeof ao.curve === "number") arrow.curve = ao.curve;
    arrows.push(normalizeArrowCurve(arrow));
  }

  return { version, rows, cols, cells, arrows };
}

function toPos(v: unknown, name: string): CellPos {
  if (typeof v !== "object" || v === null) throw new Error(`cd: invalid ${name}`);
  const o = v as Record<string, unknown>;
  return { row: toNonNegInt(o.row, `${name}.row`), col: toNonNegInt(o.col, `${name}.col`) };
}

function toNonNegInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || Math.floor(v) !== v) {
    throw new Error(`cd: invalid ${name} (expected non-negative integer)`);
  }
  return v;
}

/** Parse the fenced-block source string into a DiagramModel. Throws on invalid. */
export function parseDiagram(source: string): DiagramModel {
  const trimmed = source.trim();
  if (trimmed === "") return createEmptyModel(0, 0);
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`cd: invalid JSON (${(e as Error).message})`);
  }
  return normalizeModel(raw);
}

/** Serialize a DiagramModel to pretty-printed (2-space) JSON. */
export function serializeDiagram(model: DiagramModel): string {
  const sorted: DiagramModel = {
    version: 1,
    rows: model.rows,
    cols: model.cols,
    cells: [...model.cells].sort(byRowCol),
    arrows: [...model.arrows].sort(byArrow),
  };
  return JSON.stringify(sorted, null, 2);
}

function byRowCol(a: DiagramCell, b: DiagramCell): number {
  return a.row - b.row || a.col - b.col;
}
function byArrow(a: DiagramArrow, b: DiagramArrow): number {
  return (
    a.from.row - b.from.row ||
    a.from.col - b.from.col ||
    a.to.row - b.to.row ||
    a.to.col - b.to.col ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Add an arrow to a model (returns a new model). */
export function addArrow(model: DiagramModel, arrow: Omit<DiagramArrow, "id"> & { id?: string }): DiagramModel {
  const next = cloneModel(model);
  const id = arrow.id ?? nextArrowId();
  next.arrows.push(normalizeArrowCurve({ ...arrow, id }));
  return next;
}

/**
 * Clamp/drop an arrow's `curve` so the stored model stays sparse: a non-finite
 * or zero curve is removed (0 = straight = the default), a finite nonzero value
 * is clamped to [-1, 1]. Applied at every mutation entry point (addArrow,
 * updateArrow) so `"curve": 0` never litters the serialized JSON.
 */
function normalizeArrowCurve<T extends DiagramArrow>(a: T): T {
  if (a.curve === undefined || a.curve === null) {
    if ("curve" in a) delete (a as DiagramArrow).curve;
    return a;
  }
  if (!Number.isFinite(a.curve)) {
    delete a.curve;
    return a;
  }
  const c = Math.max(CURVE_MIN, Math.min(CURVE_MAX, a.curve));
  if (c === 0) delete a.curve;
  else a.curve = c;
  return a;
}

/** Remove an arrow by id. */
export function removeArrow(model: DiagramModel, id: string): DiagramModel {
  const next = cloneModel(model);
  next.arrows = next.arrows.filter((a) => a.id !== id);
  return next;
}

/** Update an arrow by id with a partial patch. */
export function updateArrow(model: DiagramModel, id: string, patch: Partial<DiagramArrow>): DiagramModel {
  const next = cloneModel(model);
  const idx = next.arrows.findIndex((a) => a.id === id);
  if (idx >= 0) {
    // normalizeArrowCurve drops a curve of 0 (straight = default) so the stored
    // model stays sparse — matches addArrow and the parse invariant.
    next.arrows[idx] = normalizeArrowCurve({ ...next.arrows[idx], ...patch, id });
  }
  return next;
}
