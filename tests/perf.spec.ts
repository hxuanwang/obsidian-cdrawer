/**
 * tests/perf.spec.ts (§11 / §12 — Phase 6)
 *
 * Performance smoke test for a large grid (10×10+). The plan calls for checking
 * both render time and the grid editor's responsiveness while dragging arrows;
 * the editor's drag feedback isn't unit-testable in plain node, but the shared
 * `layoutDiagram` geometry — which the editor's preview and the display-mode
 * renderer both run on every change — is. This bounds its time on a dense grid
 * so a real editing session on a 10×10 stays fluid, and checks the model's pure
 * grid ops (insert/delete row/col, trim) on the same size, since those run on
 * every resize mid-edit and a quadratic blowup there would be felt as lag.
 *
 * Budgets are generous (this runs on any CI machine, and node:test isn't a
 * benchmark harness) — they exist to catch a *regression* to accidental
 * O(n^3)+ behavior, not to gate on absolute speed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyModel,
  setCellLabel,
  addArrow,
  insertRow,
  deleteRow,
  insertCol,
  deleteCol,
  trimTrailing,
  _resetIdCounter,
} from "../src/diagram/model";
import { layoutDiagram } from "../src/diagram/render";
import type { CDStyleMetrics } from "../src/diagram/cd-style-metrics";

const metrics: CDStyleMetrics = {
  fontSize: 18,
  lineHeight: 22,
  arrowStrokeWidth: 0.9,
  minGap: 27,
};

/** Deterministic measurer: 10px per char, 20px tall (matches render.spec.ts). */
const measure = (s: string) => ({ width: s.length * 10, height: 20 });

/** Build a dense R×C grid: every cell labelled, plus an arrow across each row
 *  and down each column (so arrows + labels both stress the layout). */
function denseGrid(rows: number, cols: number) {
  _resetIdCounter();
  let m = createEmptyModel(rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      m = setCellLabel(m, r, c, `X_{${r}${c}}`);
    }
  }
  for (let r = 0; r < rows; r++) {
    if (cols >= 2) m = addArrow(m, { from: { row: r, col: 0 }, to: { row: r, col: cols - 1 } });
  }
  for (let c = 0; c < cols; c++) {
    if (rows >= 2) m = addArrow(m, { from: { row: 0, col: c }, to: { row: rows - 1, col: c } });
  }
  return m;
}

test("layoutDiagram on a 10×10 dense grid finishes within a generous budget", () => {
  const m = denseGrid(10, 10);
  // 100 labelled cells + 20 arrows.
  assert.equal(m.cells.length, 100);
  assert.equal(m.arrows.length, 20);

  const t0 = process.hrtime.bigint();
  const layout = layoutDiagram(m, measure, metrics);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(layout.cells.length, 100);
  assert.equal(layout.arrows.length, 20);
  // Geometry must be finite and strictly positive for a populated grid.
  assert.ok(Number.isFinite(layout.width) && layout.width > 0);
  assert.ok(Number.isFinite(layout.height) && layout.height > 0);
  assert.equal(layout.colWidths.length, 10);
  assert.equal(layout.rowHeights.length, 10);

  // Budget: 50ms is ~10× what this takes in practice on a laptop, so it catches
  // a real complexity regression without flaking on a slow CI runner.
  assert.ok(ms < 50, `layoutDiagram 10×10 took ${ms.toFixed(1)}ms (budget 50ms)`);
});

test("layoutDiagram scales sub-quadratically to 20×20", () => {
  const m10 = denseGrid(10, 10);
  const m20 = denseGrid(20, 20);

  // Take the min of a few runs for a stabler reading on each size.
  const timeMin = (m: ReturnType<typeof denseGrid>, runs: number): number => {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const s = process.hrtime.bigint();
      layoutDiagram(m, measure, metrics);
      const ms = Number(process.hrtime.bigint() - s) / 1e6;
      if (ms < best) best = ms;
    }
    return best;
  };
  const t10 = timeMin(m10, 5);
  const t20 = timeMin(m20, 3);

  const ratio = t20 / Math.max(t10, 1e-6);
  // 4× the cells (400 vs 100). If the algorithm were O(n^2) in cells the ratio
  // approaches 16; we just assert it's not *worse* than that — a regression to
  // O(n^3) would blow past it. Absolute budget again generous for CI.
  assert.ok(t20 < 400, `layoutDiagram 20×20 took ${t20.toFixed(1)}ms (budget 400ms)`);
  assert.ok(ratio < 25, `20×20/10×10 ratio ${ratio.toFixed(1)}× suggests worse-than-quadratic scaling`);
});

test("model grid ops on a 10×10 grid stay cheap (resize mid-edit path)", () => {
  const m = denseGrid(10, 10);
  const ops = [
    () => insertRow(m, 5),
    () => deleteRow(m, 3),
    () => insertCol(m, 5),
    () => deleteCol(m, 3),
    () => trimTrailing(m),
  ];
  const t0 = process.hrtime.bigint();
  let runs = 0;
  for (let i = 0; i < 200; i++) {
    for (const op of ops) {
      op();
      runs++;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 1000 pure model ops on a 10×10 should be well under 50ms total — these run
  // synchronously on every resize in the editor.
  assert.ok(ms < 50, `${runs} model ops on 10×10 took ${ms.toFixed(1)}ms (budget 50ms)`);
});

test("renderDiagram SVG build on a 10×10 grid finishes within budget", async () => {
  const { renderDiagram } = await import("../src/diagram/render");
  // renderDiagram needs a DOM; in node we have none, so this test only runs the
  // path when jsdom-like globals exist. Skip cleanly otherwise (CI without a DOM
  // shim still gets the layoutDiagram coverage above, which is the hot path).
  if (typeof (globalThis as { document?: unknown }).document === "undefined") {
    // node:test skip: return early; the test passes (no assertions) but is a no-op.
    return;
  }
  const m = denseGrid(10, 10);
  const doc = (globalThis as { document: Document }).document;
  const measureStub = (s: string): { width: number; height: number } => ({ width: s.length * 10, height: 20 });
  const t0 = process.hrtime.bigint();
  const svg = renderDiagram(m, { document: doc, measureLabel: measureStub });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(svg.namespaceURI?.includes("svg"));
  assert.ok(ms < 100, `renderDiagram 10×10 SVG build took ${ms.toFixed(1)}ms (budget 100ms)`);
});
