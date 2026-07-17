/**
 * tests/interop.spec.ts (§9 — Phase 5)
 *
 * Fixture-based tests for the four interop modules. Fixtures are drawn from
 * real commutative-diagram examples (the tikz-cd package documentation, a
 * pullback square, a short exact sequence, a naturality square) rather than
 * only self-generated ones, so the parsers are tested against what a real user
 * will actually paste (CLAUDE.md §11, Phase 5).
 *
 * What's checked:
 *   - to-tikzcd emits valid-looking tikz-cd and round-trips through
 *     from-tikzcd (model → tex → model, comparing cells/arrow geometry/style,
 *     ignoring ids).
 *   - to-cd gates correctly (non-adjacent / styled arrows block export) and
 *     round-trips for the CD-expressible subset.
 *   - from-cd / from-tikzcd parse the documented arrow syntax, including label
 *     placement (above/below/left/right) and the head/line vocabulary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyModel,
  setCellLabel,
  addArrow,
  _resetIdCounter,
  type DiagramModel,
} from "../src/diagram/model";
import { toTikzcd } from "../src/interop/to-tikzcd";
import { fromTikzcd } from "../src/interop/from-tikzcd";
import { toCD, canExportToCD } from "../src/interop/to-cd";
import { fromCD } from "../src/interop/from-cd";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A label/geometry/style view of a model, ignoring arrow ids (which are
 *  generated and don't survive a tex round-trip deterministically). */
function shape(m: DiagramModel) {
  return {
    rows: m.rows,
    cols: m.cols,
    cells: m.cells.map((c) => ({ row: c.row, col: c.col, label: c.label })),
    arrows: m.arrows
      .map((a) => ({
        from: a.from,
        to: a.to,
        label: a.label ?? null,
        labelPosition: a.labelPosition ?? null,
        head: a.head ?? "default",
        lineStyle: a.lineStyle ?? "solid",
        bidirectional: a.bidirectional === true,
      }))
      .sort(compareArrow),
  };
}

function compareArrow(
  a: { from: { row: number; col: number }; to: { row: number; col: number }; label: string | null },
  b: typeof a,
): number {
  return (
    a.from.row - b.from.row ||
    a.from.col - b.from.col ||
    a.to.row - b.to.row ||
    a.to.col - b.to.col ||
    (a.label ?? "").localeCompare(b.label ?? "")
  );
}

function assertShapeEqual(a: DiagramModel, b: DiagramModel, msg?: string): void {
  assert.deepEqual(shape(a), shape(b), msg);
}

// ---------------------------------------------------------------------------
// to-tikzcd: structure
// ---------------------------------------------------------------------------

test("to-tikzcd wraps in begin/end and indents the body", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" });
  const tex = toTikzcd(m);
  assert.match(tex, /^\\begin\{tikzcd\}/);
  assert.match(tex, /\\end\{tikzcd\}$/);
  assert.match(tex, /\\arrow\[r, "f"\]/);
  // arrow is attached to the source cell, so A precedes \arrow and B follows &
  assert.match(tex, /A \\arrow\[r, "f"\] & B/);
});

test("to-tikzcd emits head/line/bidirectional options", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 4);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 0, 2, "C");
  m = setCellLabel(m, 0, 3, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, head: "epi" });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 0, col: 2 }, head: "hook", label: "i" });
  m = addArrow(m, { from: { row: 0, col: 2 }, to: { row: 0, col: 3 }, head: "mapsto", lineStyle: "dotted", bidirectional: false });
  const tex = toTikzcd(m);
  assert.match(tex, /\\arrow\[r, two heads\]/);
  assert.match(tex, /\\arrow\[r, hook, "i"\]/);
  assert.match(tex, /\\arrow\[r, mapsto, dotted\]/);
});

test("to-tikzcd bidirectional emits leftrightarrow (no head option)", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, bidirectional: true, label: "\\cong" });
  const tex = toTikzcd(m);
  assert.match(tex, /\\arrow\[r, leftrightarrow, "\\cong"\]/);
  // backslash in the LaTeX command must survive unescaped
  assert.doesNotMatch(tex, /\\\\cong/);
});

test("to-tikzcd diagonal/skip arrows produce multi-letter directions", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 3);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 2, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 2 } }); // dr
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } }); // rr skip
  const tex = toTikzcd(m);
  // (0,0)->(1,2) is +2 cols, +1 row: the emitter writes horizontal-then-
  // vertical letters, so `rrd` (a valid tikz-cd direction summing to the same
  // cell as `drr`/`rdr`). (0,0)->(0,2) is `rr`.
  assert.match(tex, /\\arrow\[rrd\]/);
  assert.match(tex, /\\arrow\[rr\]/);
});

test("to-tikzcd swap for right-side label on a horizontal arrow", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f", labelPosition: "right" });
  const tex = toTikzcd(m);
  assert.match(tex, /\\arrow\[r, "f" swap\]/);
});

// ---------------------------------------------------------------------------
// to-tikzcd <-> from-tikzcd round-trip
// ---------------------------------------------------------------------------

test("tikz-cd round-trip: pullback square", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "P");
  m = setCellLabel(m, 0, 1, "X");
  m = setCellLabel(m, 1, 0, "Y");
  m = setCellLabel(m, 1, 1, "Z");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "p_X" });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "p_Y" });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, label: "f" });
  m = addArrow(m, { from: { row: 1, col: 0 }, to: { row: 1, col: 1 }, label: "g" });
  const back = fromTikzcd(toTikzcd(m));
  assertShapeEqual(back, m, "pullback square round-trip");
});

test("tikz-cd round-trip: short exact sequence with style", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 3);
  m = setCellLabel(m, 0, 0, "0");
  m = setCellLabel(m, 0, 1, "A");
  m = setCellLabel(m, 0, 2, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 0, col: 2 }, head: "hook", label: "f" });
  const back = fromTikzcd(toTikzcd(m));
  assertShapeEqual(back, m, "SES round-trip");
});

test("tikz-cd round-trip: naturality square with diagonal", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 1, 0, "C");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "g" });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, label: "h" });
  m = addArrow(m, { from: { row: 1, col: 0 }, to: { row: 1, col: 1 }, label: "k" });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 }, label: "\\eta", lineStyle: "dashed" });
  const back = fromTikzcd(toTikzcd(m));
  assertShapeEqual(back, m, "naturality square with diagonal round-trip");
});

// ---------------------------------------------------------------------------
// from-tikzcd: real fixtures a user would paste
// ---------------------------------------------------------------------------

test("from-tikzcd parses a hand-written tikz-cd block (modern bracket form)", () => {
  const tex = `\\begin{tikzcd}
  A \\arrow[r, "f"] & B \\arrow[d, "g"'] \\\\
  C \\arrow[r, "h"'] & D
\\end{tikzcd}`;
  const m = fromTikzcd(tex);
  assert.equal(m.rows, 2);
  assert.equal(m.cols, 2);
  assert.equal(m.cells.length, 4);
  assert.equal(m.arrows.length, 3);
  // "g" has the swap marker (trailing '), so it lands on the right side.
  const g = m.arrows.find((a) => a.label === "g");
  assert.equal(g?.labelPosition, "right");
  const f = m.arrows.find((a) => a.label === "f");
  assert.equal(f?.labelPosition, undefined); // default side (no explicit keyword)
});

test("from-tikzcd parses legacy \\arrow{r}{f} form", () => {
  const tex = `\\begin{tikzcd} A \\arrow{r}{f} & B \\end{tikzcd}`;
  const m = fromTikzcd(tex);
  assert.equal(m.cells.length, 2);
  assert.equal(m.arrows.length, 1);
  assert.equal(m.arrows[0].label, "f");
  assert.deepEqual(m.arrows[0].from, { row: 0, col: 0 });
  assert.deepEqual(m.arrows[0].to, { row: 0, col: 1 });
});

test("from-tikzcd parses head/line vocabulary", () => {
  const tex = `\\begin{tikzcd}
  A \\arrow[r, two heads] & B \\arrow[r, hook, "i"'] & C \\arrow[r, mapsto, dashed] & D \\arrow[r, no head] & E \\arrow[r, leftrightarrow, "\\cong"] & F
\\end{tikzcd}`;
  const m = fromTikzcd(tex);
  const heads = m.arrows.map((a) => ({ head: a.head ?? "default", bidir: a.bidirectional === true, line: a.lineStyle ?? "solid" }));
  assert.deepEqual(heads, [
    { head: "epi", bidir: false, line: "solid" },
    { head: "hook", bidir: false, line: "solid" },
    { head: "mapsto", bidir: false, line: "dashed" },
    { head: "none", bidir: false, line: "solid" },
    { head: "default", bidir: true, line: "solid" },
  ]);
});

test("from-tikzcd ignores options it doesn't model (bend, color) without throwing", () => {
  const tex = `\\begin{tikzcd}
  A \\arrow[r, bend left=30, "f", red] & B
\\end{tikzcd}`;
  const m = fromTikzcd(tex);
  assert.equal(m.arrows.length, 1);
  assert.equal(m.arrows[0].label, "f");
});

test("from-tikzcd resolves multi-step and diagonal directions", () => {
  const tex = `\\begin{tikzcd}
  A \\arrow[r] & B \\arrow[d] \\\\
  C \\arrow[rr] & & D \\arrow[ul]
\\end{tikzcd}`;
  const m = fromTikzcd(tex);
  assert.equal(m.arrows.length, 4);
  const skip = m.arrows.find((a) => a.from.row === 1 && a.from.col === 0);
  assert.deepEqual(skip?.to, { row: 1, col: 2 }); // rr
  // `ul` from (1,2): up-left lands on (0,1). Disambiguate from the (0,0)->(0,1)
  // right-arrow by also matching the source cell.
  const ul = m.arrows.find((a) => a.from.row === 1 && a.from.col === 2);
  assert.deepEqual(ul?.to, { row: 0, col: 1 }); // ul from (1,2)
});

// ---------------------------------------------------------------------------
// to-cd: gating
// ---------------------------------------------------------------------------

test("canExportToCD accepts a plain adjacent-arrow square", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 1, 0, "C");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "g" });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, label: "h" });
  m = addArrow(m, { from: { row: 1, col: 0 }, to: { row: 1, col: 1 }, label: "k" });
  assert.equal(canExportToCD(m), null);
});

test("canExportToCD rejects a diagonal arrow", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 } });
  assert.match(canExportToCD(m)!, /diagonal or skipped/);
});

test("canExportToCD rejects styled/bidirectional arrows", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, head: "epi" });
  assert.match(canExportToCD(m)!, /epi/);
  let m2 = createEmptyModel(1, 2);
  m2 = setCellLabel(m2, 0, 0, "A");
  m2 = setCellLabel(m2, 0, 1, "B");
  m2 = addArrow(m2, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, bidirectional: true });
  assert.match(canExportToCD(m2)!, /bidirectional/);
});

test("toCD throws when the model isn't CD-expressible", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 } });
  assert.throws(() => toCD(m));
});

// ---------------------------------------------------------------------------
// to-cd: emission + round-trip
// ---------------------------------------------------------------------------

test("toCD emits @>>> / @VVV and label slots", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 1, 0, "C");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" }); // above
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "g", labelPosition: "right" });
  const cd = toCD(m);
  assert.match(cd, /\\begin\{CD\}/);
  assert.match(cd, /@>f>>/); // label above a right arrow
  assert.match(cd, /@VVgV/); // label right of a down arrow
  assert.match(cd, /@\. /); // empty arrow slot
});

test("toCD round-trips through fromCD for an adjacent square", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 1, 0, "C");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "g" });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, label: "h" });
  m = addArrow(m, { from: { row: 1, col: 0 }, to: { row: 1, col: 1 }, label: "k" });
  const back = fromCD(toCD(m));
  assertShapeEqual(back, m, "CD adjacent square round-trip");
});

// ---------------------------------------------------------------------------
// from-cd: real amscd fixtures
// ---------------------------------------------------------------------------

test("from-cd parses a classic CD block", () => {
  const cd = `\\begin{CD}
  A @>f>> B \\\\
  @VgVV @VVhV \\\\
  C @>>k> D
\\end{CD}`;
  const m = fromCD(cd);
  assert.equal(m.rows, 2);
  assert.equal(m.cells.length, 4);
  assert.equal(m.arrows.length, 4);
  const f = m.arrows.find((a) => a.label === "f");
  assert.deepEqual(f?.from, { row: 0, col: 0 });
  assert.deepEqual(f?.to, { row: 0, col: 1 });
  const g = m.arrows.find((a) => a.label === "g");
  assert.deepEqual(g?.from, { row: 0, col: 0 });
  assert.deepEqual(g?.to, { row: 1, col: 0 });
  assert.equal(g?.labelPosition, undefined); // first slot = amscd default side
});

test("from-cd parses second-slot (right-side) label placement", () => {
  const cd = `\\begin{CD}
  A @>>f> B \\\\
  @VVgV @. \\\\
  C @. D
\\end{CD}`;
  const m = fromCD(cd);
  const f = m.arrows.find((a) => a.label === "f");
  assert.equal(f?.labelPosition, "right"); // @>>f> → second slot → right of travel
  const g = m.arrows.find((a) => a.label === "g");
  assert.deepEqual(g?.from, { row: 0, col: 0 });
  assert.deepEqual(g?.to, { row: 1, col: 0 });
  assert.equal(g?.labelPosition, "right"); // @VVgV → second slot → right of travel
});

test("from-cd handles left and up arrows", () => {
  const cd = `\\begin{CD}
  A @<<f< B \\\\
  @AAgA @. \\\\
  C @. D
\\end{CD}`;
  const m = fromCD(cd);
  const f = m.arrows.find((a) => a.label === "f");
  assert.deepEqual(f?.from, { row: 0, col: 1 });
  assert.deepEqual(f?.to, { row: 0, col: 0 }); // leftward
  const g = m.arrows.find((a) => a.label === "g");
  assert.deepEqual(g?.from, { row: 1, col: 0 });
  assert.deepEqual(g?.to, { row: 0, col: 0 }); // upward
});

test("from-cd strips one layer of {…} grouping from labels", () => {
  const cd = `\\begin{CD} A @>{f(x)}>> B \\end{CD}`;
  const m = fromCD(cd);
  assert.equal(m.arrows[0].label, "f(x)");
});

test("from-cd with no wrapper (raw body) still parses", () => {
  const m = fromCD("A @>f>> B");
  assert.equal(m.cells.length, 2);
  assert.equal(m.arrows.length, 1);
});

// ---------------------------------------------------------------------------
// cross-conversion: CD → model → tikz-cd (the §9 upgrade path)
// ---------------------------------------------------------------------------

test("CD-expressible model converts to tikz-cd and back losslessly", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 1, 0, "C");
  m = setCellLabel(m, 1, 1, "D");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "g" });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 1, col: 1 }, label: "h" });
  m = addArrow(m, { from: { row: 1, col: 0 }, to: { row: 1, col: 1 }, label: "k" });
  const back = fromTikzcd(toTikzcd(m));
  assertShapeEqual(back, m, "CD-style model survives a tikz-cd round-trip");
});
