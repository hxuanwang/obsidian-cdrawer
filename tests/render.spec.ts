import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyModel, setCellLabel, addArrow, _resetIdCounter,
} from "../src/diagram/model";
import {
  layoutDiagram, deriveRenderConstants,
} from "../src/diagram/render";
import type { CDStyleMetrics } from "../src/diagram/cd-style-metrics";

/** Deterministic fake metrics (same values as the headless fallback). */
const metrics: CDStyleMetrics = {
  fontSize: 18,
  lineHeight: 22,
  arrowStrokeWidth: 0.9,
  minGap: 27,
};

/** Deterministic measurer: 10px per character, 20px tall. */
const measure = (s: string) => ({ width: s.length * 10, height: 20 });

const C = deriveRenderConstants(metrics); // cellPad 3.96, headLen 6.12, step 9, labelGap 5.04

function close(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function model1x2() {
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  return m;
}

test("empty model produces a minimal padded box", () => {
  const layout = layoutDiagram(createEmptyModel(0, 0), measure, metrics);
  assert.equal(layout.cells.length, 0);
  assert.equal(layout.arrows.length, 0);
  assert.ok(close(layout.width, 2 * C.svgPad));
  assert.ok(close(layout.height, 2 * C.svgPad));
  assert.ok(close(layout.originX, -C.svgPad));
  assert.ok(close(layout.originY, -C.svgPad));
});

test("single labelled cell is centered in its grid box", () => {
  const m = setCellLabel(createEmptyModel(1, 1), 0, 0, "A");
  const layout = layoutDiagram(m, measure, metrics);
  assert.deepEqual(layout.colWidths, [10]);
  assert.deepEqual(layout.rowHeights, [20]);
  assert.equal(layout.cells.length, 1);
  assert.ok(close(layout.cells[0].cx, 5));
  assert.ok(close(layout.cells[0].cy, 10));
  assert.ok(close(layout.width, 10 + 2 * C.svgPad));
});

test("column width is driven by the largest label; gap floors at minGap", () => {
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "AAAA");
  const layout = layoutDiagram(m, measure, metrics);
  assert.deepEqual(layout.colWidths, [10, 40]);
  assert.deepEqual(layout.colGaps, [27]);
  // second column center = col0 width + gap + half of col1
  assert.ok(close(layout.cellCenters[0][1].cx, 10 + 27 + 20));
});

test("row height is driven by the largest label", () => {
  const tallMeasure = (s: string) => ({ width: 10, height: s.length * 5 });
  let m = createEmptyModel(2, 1);
  m = setCellLabel(m, 0, 0, "AA");
  m = setCellLabel(m, 1, 0, "AAAA");
  const layout = layoutDiagram(m, tallMeasure, metrics);
  assert.deepEqual(layout.rowHeights, [10, 20]);
  assert.deepEqual(layout.rowGaps, [27]);
  assert.ok(close(layout.cellCenters[1][0].cy, 10 + 27 + 10));
});

test("horizontal arrow clips to label box edges, not centers", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  const layout = layoutDiagram(m, measure, metrics);
  assert.equal(layout.arrows.length, 1);
  const a = layout.arrows[0];
  // centers: (5,10) and (42,10); padded half extents: 5+3.96 = 8.96
  assert.ok(close(a.x1, 5 + 8.96));
  assert.ok(close(a.y1, 10));
  assert.ok(close(a.x2, 42 - 8.96));
  assert.ok(close(a.y2, 10));
  assert.ok(close(a.dirX, 1));
  assert.ok(close(a.dirY, 0));
});

test("vertical arrow clips to top/bottom edges", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 1);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 0, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 } });
  const layout = layoutDiagram(m, measure, metrics);
  const a = layout.arrows[0];
  // centers: (5,10) and (5,57); padded half height: 10+3.96 = 13.96
  assert.ok(close(a.x1, 5));
  assert.ok(close(a.y1, 10 + 13.96));
  assert.ok(close(a.x2, 5));
  assert.ok(close(a.y2, 57 - 13.96));
  assert.ok(close(a.dirX, 0));
  assert.ok(close(a.dirY, 1));
});

test("diagonal arrow exits through the box edge, not the center", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 } });
  const layout = layoutDiagram(m, measure, metrics);
  const a = layout.arrows[0];
  // c1=(5,10), c2=(42,57); dir=(37,47)/len. tx = 8.96/dirX < ty = 13.96/dirY,
  // so the shaft exits through the RIGHT edge of the source box.
  assert.ok(close(a.x1, 5 + 8.96, 1e-3));
  assert.ok(a.y1 > 10 && a.y1 < 10 + 13.96);
  // and enters through the LEFT edge of the target box
  assert.ok(close(a.x2, 42 - 8.96, 1e-3));
  assert.ok(a.y2 < 57 && a.y2 > 57 - 13.96);
});

test("parallel arrows on the same pair are offset symmetrically", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  const layout = layoutDiagram(m, measure, metrics);
  assert.equal(layout.arrows.length, 2);
  const [a, b] = layout.arrows;
  // symmetric around the centerline y=10, separated by multiArrowStep
  assert.ok(close(a.y1 + b.y1, 20));
  assert.ok(close(Math.abs(a.y1 - b.y1), C.multiArrowStep));
  assert.ok(close(a.x1, b.x1));
  assert.ok(close(a.y1, a.y2)); // shafts stay horizontal
});

test("opposite-direction arrows on the same pair do not overlap", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  m = addArrow(m, { from: { row: 0, col: 1 }, to: { row: 0, col: 0 } });
  const layout = layoutDiagram(m, measure, metrics);
  const [fwd, back] = layout.arrows;
  // canonical-direction offset puts them on opposite sides of the centerline
  assert.ok(close(Math.abs(fwd.y1 - back.y1), C.multiArrowStep));
  assert.ok(close(fwd.y1 + back.y1, 20));
  // each arrow keeps its own direction of travel
  assert.ok(close(fwd.dirX, 1));
  assert.ok(close(back.dirX, -1));
});

test("skip arrow is a straight line through intervening cells", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 3);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = setCellLabel(m, 0, 2, "C");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } });
  const layout = layoutDiagram(m, measure, metrics);
  const a = layout.arrows[0];
  assert.ok(close(a.y1, 10));
  assert.ok(close(a.y2, 10));
  assert.ok(close(a.x1, 5 + 8.96));
  // third column center: 10+27+10+27+5 = 79
  assert.ok(close(a.x2, 79 - 8.96));
});

test("arrow label defaults to the left of the direction of travel", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "f" });
  const layout = layoutDiagram(m, measure, metrics);
  const a = layout.arrows[0];
  assert.equal(a.label, "f");
  assert.equal(a.labelPosition, "left");
  const midX = (a.x1 + a.x2) / 2;
  // above the shaft: labelGap + half label height = 5.04 + 10
  assert.ok(close(a.labelX!, midX));
  assert.ok(close(a.labelY!, 10 - (C.labelGap + 10)));
  // viewBox grows to include the overflowing label
  assert.ok(layout.originY <= a.labelY! - 10 - C.svgPad + 1e-6);
});

test("labelPosition below places the label under the arrow", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, {
    from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, label: "g", labelPosition: "below",
  });
  const layout = layoutDiagram(m, measure, metrics);
  const a = layout.arrows[0];
  assert.ok(close(a.labelY!, 10 + (C.labelGap + 10)));
});

test("labelPosition above on a vertical arrow picks a side, not the shaft", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 1);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 0, "B");
  m = addArrow(m, {
    from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, label: "f", labelPosition: "above",
  });
  const layout = layoutDiagram(m, measure, metrics);
  const a = layout.arrows[0];
  // perpendicular to the vertical shaft: offset is purely horizontal
  assert.ok(close(a.labelY!, (a.y1 + a.y2) / 2));
  assert.ok(Math.abs(a.labelX! - a.x1) > C.labelGap);
});

test("head/lineStyle/bidirectional resolve with defaults", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  m = addArrow(m, {
    from: { row: 0, col: 1 }, to: { row: 0, col: 0 },
    head: "epi", lineStyle: "dashed", bidirectional: true,
  });
  const layout = layoutDiagram(m, measure, metrics);
  const [plain, fancy] = layout.arrows;
  assert.equal(plain.head, "default");
  assert.equal(plain.lineStyle, "solid");
  assert.equal(plain.bidirectional, false);
  assert.equal(fancy.head, "epi");
  assert.equal(fancy.lineStyle, "dashed");
  assert.equal(fancy.bidirectional, true);
});

test("degenerate self-arrows and out-of-grid arrows are dropped", () => {
  _resetIdCounter();
  let m = model1x2();
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 0 } });
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 5, col: 0 } });
  const layout = layoutDiagram(m, measure, metrics);
  assert.equal(layout.arrows.length, 0);
});

test("derived constants scale from the font size", () => {
  assert.ok(close(C.cellPad, 18 * 0.22));
  assert.ok(close(C.headLen, 18 * 0.34));
  assert.ok(close(C.multiArrowStep, 18 * 0.5));
  assert.ok(close(C.labelGap, 18 * 0.28));
  assert.match(C.dashedArray, /^\d+(\.\d+)? \d+(\.\d+)?$/);
  assert.match(C.dottedArray, /^0\.01 \d+(\.\d+)?$/);
});
