/**
 * src/interop/from-cd.ts (§9 — Phase 5)
 *
 * Parse a plain AMS `\begin{CD}…\end{CD}` block into a DiagramModel.
 *
 * amscd's CD layout alternates two kinds of rows:
 *   - cell rows:    `cell @arrow cell @arrow … cell`  (tokens separated by
 *     spaces; horizontal arrow tokens sit BETWEEN cells, never as a cell);
 *   - arrow rows:   `@VVV & @AAA & @. & …`  (one vertical-arrow token per
 *     column, joined by `&`), which sit BETWEEN cell rows and carry the
 *     up/down arrows.
 * Rows are separated by `\\`.
 *
 * Arrow token grammar (each is `@` + three slots):
 *   @>>>  right   @<<<  left   @VVV  down   @AAA  up   @.  empty
 * A label occupies the MIDDLE slot; the first/third slots are runs of the
 * shaft glyph. So `@>f>>` = label above a right arrow, `@>>f>` = label below;
 * `@VfVV` = label left of a down arrow, `@VVfV` = label right. `@AfAA` /
 * `@AAfA` are the up-arrow analogues.
 *
 * Labels are raw LaTeX (we strip one outer layer of `{…}` grouping if present,
 * so a user who writes `@>{f(x)}>>` gets `f(x)`, matching how a CD reader
 * thinks of the label). The grid is sized to the bounding box of all cells and
 * arrows actually present. Non-arrow, non-cell tokens we don't recognize are
 * skipped rather than throwing, so lightly malformed input still yields a
 * partial model — but a genuinely unparseable block throws.
 */

import {
  addArrow,
  createEmptyModel,
  setCellLabel,
  type DiagramModel,
  type LabelPosition,
} from "../diagram/model";

/** Parse an AMS CD source string into a DiagramModel. Throws on bad input. */
export function fromCD(source: string): DiagramModel {
  const inner = extractCDBody(source);
  const rows = splitCDRows(inner);
  if (rows.length === 0) return createEmptyModel(0, 0);

  // Track cells and arrows on a sparse grid first; resolve grid extent after.
  const cells: { row: number; col: number; label: string }[] = [];
  const arrows: {
    from: { row: number; col: number };
    to: { row: number; col: number };
    label?: string;
    labelPosition?: LabelPosition;
  }[] = [];

  let cellRow = 0;
  let maxCol = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (isArrowRow(row)) {
      const tokens = splitArrowRow(row);
      for (let c = 0; c < tokens.length; c++) {
        const v = parseVerticalArrow(tokens[c]);
        if (!v) continue;
        if (v.dir === "down") {
          arrows.push({
            from: { row: cellRow - 1, col: c },
            to: { row: cellRow, col: c },
            label: v.label,
            labelPosition: v.labelPosition,
          });
        } else {
          arrows.push({
            from: { row: cellRow, col: c },
            to: { row: cellRow - 1, col: c },
            label: v.label,
            labelPosition: v.labelPosition,
          });
        }
      }
    } else {
      // A CD cell row alternates: cell, arrow-token, cell, arrow-token, …
      // Cells sit at column indices 0,1,2,…; each arrow-token sits BETWEEN two
      // cells and connects col-1 ↔ col.
      const tokens = splitCellRow(row);
      let col = 0;
      let expectCell = true; // the first token of a row is always a cell
      for (const tok of tokens) {
        if (expectCell) {
          if (tok !== "@.") {
            const label = stripBraces(tok);
            if (label !== "") cells.push({ row: cellRow, col, label });
          }
          col++;
          if (col > maxCol) maxCol = col;
          expectCell = false;
        } else {
          const h = parseHorizontalArrow(tok);
          if (h) {
            arrows.push({
              from: { row: cellRow, col: h.dir === "right" ? col - 1 : col },
              to: { row: cellRow, col: h.dir === "right" ? col : col - 1 },
              label: h.label,
              labelPosition: h.labelPosition,
            });
          } else if (tok === "@.") {
            // empty arrow slot — no arrow between these two cells
          } else {
            // Unexpected token where an arrow was expected: treat it as a cell
            // (lenient) so a missing arrow token doesn't desync the whole row.
            const label = stripBraces(tok);
            if (label !== "") cells.push({ row: cellRow, col, label });
            col++;
            if (col > maxCol) maxCol = col;
          }
          expectCell = true;
        }
      }
      cellRow++;
    }
  }

  // Grid extent: number of cell rows × number of columns. maxCol is the count
  // of columns seen (cell rows alternate cells and arrow tokens, so the column
  // count is derived from the widest cell row).
  const cols = Math.max(maxCol, 1);
  const model = createEmptyModel(Math.max(cellRow, 1), cols);
  let m = model;
  for (const c of cells) {
    if (c.row >= 0 && c.col >= 0 && c.col < cols) {
      m = setCellLabel(m, c.row, c.col, c.label);
    }
  }
  // Reset id counter so imported arrows get clean ids; then add.
  for (const a of arrows) {
    if (a.from.row < 0 || a.to.row < 0 || a.from.col < 0 || a.to.col < 0) continue;
    if (a.from.row >= m.rows || a.to.row >= m.rows) continue;
    if (a.from.col >= m.cols || a.to.col >= m.cols) continue;
    m = addArrow(m, {
      from: a.from,
      to: a.to,
      label: a.label,
      labelPosition: a.labelPosition,
    });
  }
  return m;
}

/** Strip an optional `\begin{CD}` / `\end{CD}` wrapper and surrounding math. */
function extractCDBody(source: string): string {
  let s = source.trim();
  const begin = s.indexOf("\\begin{CD}");
  const end = s.indexOf("\\end{CD}");
  if (begin !== -1 && end !== -1 && end > begin) {
    s = s.slice(begin + "\\begin{CD}".length, end);
  }
  // Strip surrounding $$ … $$ or $ … $ if the user pasted a math block.
  s = s.replace(/^\$+/, "").replace(/\$+$/, "");
  return s.trim();
}

/** Split the CD body into rows on `\\` (allowing optional trailing spaces/&). */
function splitCDRows(body: string): string[] {
  return body
    .split(/\\\\/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * A row is an "arrow row" (the inter-row line of up/down arrows) if EVERY
 * non-empty token is a vertical-arrow token — `@VVV`/`@AAA` (optionally
 * labeled) or the empty `@.` — separated by `&` or whitespace. amscd writes
 * these rows either as `@VgVV & @VVhV` or `@VgVV @VVhV`, so we detect by token
 * content rather than requiring `&`. A cell row's first token is a label (not
 * an `@`-token), so this cleanly distinguishes the two.
 */
function isArrowRow(row: string): boolean {
  const tokens = row.split(/[&\s]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((t) => isArrowToken(t));
}

/** Is `tok` a CD arrow token (`@>>>`, `@VVV`, `@AAA`, `@<<<`, `@.`, labeled)? */
function isArrowToken(tok: string): boolean {
  if (tok === "@.") return true;
  // A CD arrow token is `@` immediately followed by a shaft glyph (`> < V A`);
  // the label (if any) sits in the middle slot, so the char right after `@` is
  // always a glyph. A cell label like `A` or `f(x)` never starts with one.
  return /^@[<>VA]/.test(tok);
}

/** Split a cell row into tokens: cells and the arrow tokens between them. */
function splitCellRow(row: string): string[] {
  // Tokens are either an arrow (@>>> … possibly with a label) or a cell. Arrow
  // tokens match @ followed by >,<,V,A or `.` and may contain a label in the
  // middle. We tokenize by scanning: an `@` starts an arrow token that runs
  // until the next whitespace; anything else up to the next whitespace/`@` is a
  // cell token.
  const tokens: string[] = [];
  let i = 0;
  const n = row.length;
  while (i < n) {
    while (i < n && /\s/.test(row[i])) i++;
    if (i >= n) break;
    if (row[i] === "@") {
      let j = i + 1;
      // An arrow token is `@` + (label-or-glyphs) with no internal spaces.
      while (j < n && !/\s/.test(row[j])) j++;
      tokens.push(row.slice(i, j));
      i = j;
    } else {
      let j = i;
      // A cell runs until whitespace or the start of an arrow token.
      while (j < n && !/\s/.test(row[j])) j++;
      tokens.push(row.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/** Split an arrow row on `&` or whitespace, trimming each token. amscd
 *  separates vertical-arrow tokens with either `&` or plain spaces. */
function splitArrowRow(row: string): string[] {
  return row.split(/[&\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
}

interface ParsedArrow {
  label?: string;
  labelPosition?: LabelPosition;
  dir: "right" | "left" | "down" | "up";
}

/** Parse a horizontal arrow token (`@>>>`, `@<<<`, or labeled variants). */
function parseHorizontalArrow(tok: string): ParsedArrow | null {
  if (!tok.startsWith("@")) return null;
  const body = tok.slice(1);
  if (/^>+$/.test(body)) return { dir: "right" };
  if (/^<+$/.test(body)) return { dir: "left" };
  // Labeled: shaft glyphs in the first/third slots, label in the middle. The
  // first slot is amscd's DEFAULT side, so it maps to `undefined` (our default,
  // rendered left-of-travel); the second slot is the swapped side → "right".
  const r = matchLabeled(body, ">");
  if (r) return { dir: "right", label: r.label, labelPosition: r.first ? undefined : "right" };
  const l = matchLabeled(body, "<");
  if (l) return { dir: "left", label: l.label, labelPosition: l.first ? undefined : "right" };
  return null;
}

/** Parse a vertical arrow token (`@VVV`, `@AAA`, or labeled variants). */
function parseVerticalArrow(tok: string): ParsedArrow | null {
  if (!tok.startsWith("@")) return null;
  const body = tok.slice(1);
  if (/^V+$/.test(body)) return { dir: "down" };
  if (/^A+$/.test(body)) return { dir: "up" };
  const d = matchLabeled(body, "V");
  if (d) return { dir: "down", label: d.label, labelPosition: d.first ? undefined : "right" };
  const u = matchLabeled(body, "A");
  if (u) return { dir: "up", label: u.label, labelPosition: u.first ? undefined : "right" };
  return null;
}

interface LabeledMatch {
  label: string;
  /** True if the label is in the first slot (above/left), false if second. */
  first: boolean;
}

/**
 * Match a labeled arrow body against the grammar: a run of `glyph`, then
 * optional label text (the middle slot), then a run of `glyph`. We find the
 * boundary between the leading glyph-run and the label by locating where the
 * glyph characters stop and restart. Concretely: split the body into maximal
 * runs; if there are exactly two glyph runs with text between, that text is the
 * label in the FIRST slot (above/left). If there's a leading glyph run, then
 * label, then trailing glyph run — first slot. If the label is sandwiched such
 * that the FIRST run is longer... we instead use the canonical rule:
 *   @>f>>  → leading `>`, label `f`, trailing `>>`  → first slot
 *   @>>f>  → leading `>>`, label `f`, trailing `>`  → second slot
 * i.e. first slot ⇔ the trailing glyph run is LONGER than the leading run.
 */
function matchLabeled(body: string, glyph: string): LabeledMatch | null {
  // Find leading run of glyph.
  let lead = 0;
  while (lead < body.length && body[lead] === glyph) lead++;
  if (lead === 0) return null;
  // Find trailing run of glyph.
  let trail = 0;
  while (trail < body.length && body[body.length - 1 - trail] === glyph) trail++;
  if (trail === 0) return null;
  if (lead + trail >= body.length) return null; // no label text between
  const label = body.slice(lead, body.length - trail);
  if (label.length === 0) return null;
  // Reject if the label itself still contains the glyph char (malformed).
  if (label.includes(glyph)) return null;
  return { label: stripBraces(label), first: trail > lead };
}

/** Remove a single layer of surrounding `{…}` if present. */
function stripBraces(s: string): string {
  let t = s.trim();
  if (t.startsWith("{") && t.endsWith("}") && balanced(t)) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Are the braces in `s` balanced, with the first `{` matching the last `}`? */
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
