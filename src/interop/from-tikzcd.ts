/**
 * src/interop/from-tikzcd.ts (§9 — Phase 5)
 *
 * Parse a tikz-cd `\begin{tikzcd}…\end{tikzcd}` block into a DiagramModel.
 *
 * Scope (§9): a dedicated parser for the tikz-cd *subset* — the matrix grid
 * plus basic `\arrow[…]` options — not general TikZ. We handle:
 *   - the `\begin{tikzcd}[…]` / `\end{tikzcd}` wrapper (optional env options
 *     are ignored — they're layout hints, not data);
 *   - rows split on `\\` and cells split on `&`;
 *   - a cell's label = the text before its first `\arrow`/`\ar` (trimmed; an
 *     empty cell contributes no cell entry);
 *   - `\arrow[opts]` / `\ar[opts]` (modern bracket form) and the legacy
 *     `\arrow{dir}{label}` / `\ar{dir}{label}` form;
 *   - direction letters r/l/u/d (multi-step, e.g. `rr` or `dr`);
 *   - quoted labels `"f"` with optional `swap`, plus a `description` anchor we
 *     treat as the default side;
 *   - head/tail options: two heads → epi, hook → hook, mapsto → mapsto,
 *     no head → none, leftrightarrow → bidirectional;
 *   - line options: dashed, dotted.
 *
 * Unknown options are ignored (a tikz-cd diagram with options we don't model —
 * curved arrows, `phantom`, bend, color — still parses; the parts we don't
 * understand are dropped rather than throwing). A block with no recognizable
 * matrix throws.
 */

import {
  addArrow,
  createEmptyModel,
  setCellLabel,
  type ArrowHead,
  type DiagramModel,
  type LabelPosition,
  type LineStyle,
} from "../diagram/model";

/** Parse a tikz-cd source string into a DiagramModel. Throws on bad input. */
export function fromTikzcd(source: string): DiagramModel {
  const inner = extractTikzcdBody(source);
  const rows = splitMatrixRows(inner);
  if (rows.length === 0) throw new Error("tikz-cd: empty matrix");

  const cells: { row: number; col: number; label: string }[] = [];
  const arrows: ParsedTikzArrow[] = [];

  for (let r = 0; r < rows.length; r++) {
    const rawCells = splitCells(rows[r]);
    for (let c = 0; c < rawCells.length; c++) {
      const { label, arrowSpecs } = parseCell(rawCells[c]);
      if (label !== "") cells.push({ row: r, col: c, label });
      for (const spec of arrowSpecs) {
        const d = resolveDirection(spec.dir, r, c);
        if (!d) continue;
        arrows.push({
          from: { row: r, col: c },
          to: d,
          label: spec.label,
          labelPosition: spec.labelPosition,
          head: spec.head,
          lineStyle: spec.lineStyle,
          bidirectional: spec.bidirectional,
        });
      }
    }
  }

  const cols = rows.reduce((mx, row) => Math.max(mx, splitCells(row).length), 0);
  const model = createEmptyModel(rows.length, Math.max(cols, 1));
  let m = model;
  for (const c of cells) {
    if (c.col < m.cols) m = setCellLabel(m, c.row, c.col, c.label);
  }
  for (const a of arrows) {
    if (a.to.row < 0 || a.to.col < 0 || a.to.row >= m.rows || a.to.col >= m.cols) continue;
    if (a.from.row === a.to.row && a.from.col === a.to.col) continue;
    m = addArrow(m, {
      from: a.from,
      to: a.to,
      label: a.label,
      labelPosition: a.labelPosition,
      head: a.head,
      lineStyle: a.lineStyle,
      bidirectional: a.bidirectional,
    });
  }
  return m;
}

interface ParsedTikzArrow {
  from: { row: number; col: number };
  to: { row: number; col: number };
  label?: string;
  labelPosition?: LabelPosition;
  head?: ArrowHead;
  lineStyle?: LineStyle;
  bidirectional?: boolean;
}

/** Strip the `\begin{tikzcd}[…]` … `\end{tikzcd}` wrapper. */
function extractTikzcdBody(source: string): string {
  let s = source.trim();
  const beginIdx = s.search(/\\begin\{tikzcd\}/);
  if (beginIdx !== -1) {
    const after = s.slice(beginIdx + "\\begin{tikzcd}".length);
    // Skip an optional `[options]` block immediately after \begin{tikzcd}.
    const optMatch = /^\s*\[([^\]]*)\]/.exec(after);
    s = optMatch ? after.slice(optMatch[0].length) : after;
    const endIdx = s.search(/\\end\{tikzcd\}/);
    if (endIdx !== -1) s = s.slice(0, endIdx);
  }
  return s.trim();
}

/** Split the matrix body into rows on `\\` (with optional trailing `[align]`). */
function splitMatrixRows(body: string): string[] {
  return body
    .split(/\\\\(?:\s*\[[^\]]*\])?/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** Split a row into cells on unescaped `&`. */
function splitCells(row: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "&" && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0 || out.length > 0) out.push(cur);
  return out;
}

interface ArrowSpec {
  dir: string;
  label?: string;
  labelPosition?: LabelPosition;
  head?: ArrowHead;
  lineStyle?: LineStyle;
  bidirectional?: boolean;
}

interface ParsedCell {
  label: string;
  arrowSpecs: ArrowSpec[];
}

/** Parse a single cell into its label and any `\arrow[…]` specs. */
function parseCell(cell: string): ParsedCell {
  const arrowSpecs: ArrowSpec[] = [];
  // Find the first `\arrow` / `\ar` token; the label is whatever precedes it.
  const first = searchArrow(cell, 0);
  if (first === -1) {
    return { label: cell.trim(), arrowSpecs };
  }
  const label = cell.slice(0, first).trim();
  let i = first;
  while (i !== -1 && i < cell.length) {
    // Advance past the `\arrow` / `\ar` command itself.
    const cmdLen = cell.startsWith("\\arrow", i) ? 6 : 3;
    let j = i + cmdLen;
    while (j < cell.length && /\s/.test(cell[j])) j++;
    if (j >= cell.length) break;
    const parsed = parseArrowTail(cell, j);
    if (!parsed) break;
    arrowSpecs.push(parsed.spec);
    i = searchArrow(cell, parsed.next);
  }
  return { label, arrowSpecs };
}

/** Index of the next `\arrow` or `\ar` token at or after `from`, else -1. */
function searchArrow(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\" && s.startsWith("\\arrow", i)) return i;
    if (s[i] === "\\" && s.startsWith("\\ar", i) && !/^[a-z]/.test(s[i + 3] ?? "")) {
      return i;
    }
  }
  return -1;
}

/** Parse what follows `\arrow` — either `[opts]` (modern) or `{dir}{label}`
 *  (legacy) — returning the spec and the index past it. */
function parseArrowTail(
  cell: string,
  i: number,
): { spec: ArrowSpec; next: number } | null {
  if (cell[i] === "[") {
    return parseBracketOpts(cell, i);
  }
  if (cell[i] === "{") {
    return parseLegacyForm(cell, i);
  }
  return null;
}

/** Parse `\arrow[r, "f", two heads, dashed]` — the modern bracket form. */
function parseBracketOpts(
  cell: string,
  i: number,
): { spec: ArrowSpec; next: number } | null {
  const close = findMatching(cell, i, "[", "]");
  if (close === -1) return null;
  const inside = cell.slice(i + 1, close);
  const spec = parseOptionList(inside);
  return { spec, next: close + 1 };
}

/** Parse `\arrow{r}{f}` — the legacy two-brace form. */
function parseLegacyForm(
  cell: string,
  i: number,
): { spec: ArrowSpec; next: number } | null {
  const dirClose = findMatching(cell, i, "{", "}");
  if (dirClose === -1) return null;
  const dir = cell.slice(i + 1, dirClose).trim();
  let next = dirClose + 1;
  let label: string | undefined;
  while (next < cell.length && /\s/.test(cell[next])) next++;
  if (cell[next] === "{") {
    const lblClose = findMatching(cell, next, "{", "}");
    if (lblClose !== -1) {
      label = stripQuotes(cell.slice(next + 1, lblClose).trim());
      next = lblClose + 1;
    }
  }
  return { spec: { dir, label }, next };
}

/**
 * Parse the comma-separated option list inside `[…]`. Recognizes a leading
 * direction run (r/l/u/d letters), a quoted label (with optional `swap`), and
 * the head/line/bidirectional keywords. Everything else is ignored.
 */
function parseOptionList(inside: string): ArrowSpec {
  const tokens = splitTopLevelCommas(inside);
  const spec: ArrowSpec = { dir: "" };
  for (let t of tokens) {
    t = t.trim();
    if (t === "") continue;
    // Direction run: only r/l/u/d letters.
    if (/^[rlud]+$/i.test(t)) {
      spec.dir = t.toLowerCase();
      continue;
    }
    // Quoted label, possibly with a trailing anchor keyword.
    const labelMatch = /^"([^"]*)"\s*(.*)$/.exec(t);
    if (labelMatch) {
      spec.label = labelMatch[1];
      const anchor = labelMatch[2].trim();
      // tikz-cd's swap marker is the keyword `swap` or, more commonly, a bare
      // trailing `'` after the quoted label (e.g. `"g"'`).
      if (anchor === "swap" || anchor === "swap'" || anchor === "'") {
        spec.labelPosition = "right";
      } else if (anchor === "description") {
        spec.labelPosition = "left"; // on the shaft — closest to our "left"
      } else if (anchor) {
        // Explicit positional anchor like 'above'/'below'/'left'/'right'.
        spec.labelPosition = anchorToPosition(anchor) ?? spec.labelPosition;
      }
      continue;
    }
    // Head / line / relationship keywords.
    switch (t) {
      case "two heads":
        spec.head = "epi";
        break;
      case "hook":
      case "hook'":
        spec.head = "hook";
        break;
      case "mapsto":
        spec.head = "mapsto";
        break;
      case "no head":
        spec.head = "none";
        break;
      case "leftrightarrow":
        spec.bidirectional = true;
        break;
      case "dashed":
        spec.lineStyle = "dashed";
        break;
      case "dotted":
        spec.lineStyle = "dotted";
        break;
      default:
        // Unknown option (bend, color, phantom, …) — ignored per §9 scope.
        break;
    }
  }
  // A label with no explicit position keyword is left as `undefined` — the
  // renderer defaults to the left-of-travel side, and leaving it unset keeps
  // a model → tex → model round-trip lossless (no spurious "left" introduced).
  return spec;
}

/** Split on commas that aren't inside braces or quotes. */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/** Map a tikz-cd positional anchor keyword to our LabelPosition. */
function anchorToPosition(anchor: string): LabelPosition | undefined {
  switch (anchor) {
    case "above":
    case "above left":
    case "above right":
      return "above";
    case "below":
    case "below left":
    case "below right":
      return "below";
    case "left":
      return "left";
    case "right":
      return "right";
    default:
      return undefined;
  }
}

/** Resolve a direction run like `rr`, `dr`, `ull` to absolute (row,col). */
function resolveDirection(
  dir: string,
  row: number,
  col: number,
): { row: number; col: number } | null {
  if (dir === "") return null;
  let r = row;
  let c = col;
  for (const ch of dir) {
    if (ch === "r") c += 1;
    else if (ch === "l") c -= 1;
    else if (ch === "u") r -= 1;
    else if (ch === "d") r += 1;
    else return null;
  }
  return { row: r, col: c };
}

/** Find the index of the closer matching `closeCh` for the `openCh` at `i`. */
function findMatching(s: string, i: number, openCh: string, closeCh: string): number {
  if (s[i] !== openCh) return -1;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === openCh) depth++;
    else if (s[j] === closeCh) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Strip surrounding `{…}` grouping and surrounding quotes from a label. */
function stripQuotes(s: string): string {
  let t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  if (t.startsWith("{") && t.endsWith("}") && balanced(t)) t = t.slice(1, -1).trim();
  return t;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}
