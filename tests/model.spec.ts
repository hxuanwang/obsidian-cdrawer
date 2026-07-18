import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyModel, cloneModel, setCellLabel, getLabel, getCell,
  insertRow, insertCol, appendRow, appendCol, deleteRow, deleteCol,
  trimTrailing, isEmpty, parseDiagram, serializeDiagram, addArrow,
  removeArrow, updateArrow, rowDeletionIsDestructive, colDeletionIsDestructive,
  _resetIdCounter, nextArrowId,
} from "../src/diagram/model";

function roundTrip(m: ReturnType<typeof createEmptyModel> & object) {
  return parseDiagram(serializeDiagram(m));
}

test("round-trip: empty model", () => {
  _resetIdCounter();
  const m = createEmptyModel(0, 0);
  assert.deepEqual(roundTrip(m), { version: 1, rows: 0, cols: 0, cells: [], arrows: [] });
});

test("round-trip: cells and arrows preserve all fields", () => {
  _resetIdCounter();
  let m = createEmptyModel(3, 3);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 1, "B_{n}");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 }, label: "f", labelPosition: "above", head: "hook", lineStyle: "dashed", bidirectional: true, curve: 0.35 });
  const back = roundTrip(m);
  assert.equal(back.rows, 3);
  assert.equal(back.cols, 3);
  assert.equal(back.cells.length, 2);
  assert.equal(getLabel(back, 0, 0), "A");
  assert.equal(getLabel(back, 1, 1), "B_{n}");
  assert.equal(back.arrows.length, 1);
  const a = back.arrows[0];
  assert.equal(a.label, "f");
  assert.equal(a.labelPosition, "above");
  assert.equal(a.head, "hook");
  assert.equal(a.lineStyle, "dashed");
  assert.equal(a.bidirectional, true);
  assert.equal(a.curve, 0.35);
});

test("curve round-trips and a curve of 0 is dropped (sparse invariant)", () => {
  _resetIdCounter();
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, curve: -0.7 });
  // A curve of exactly 0 isn't stored — updateArrow drops it.
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, curve: 0 });
  const straight = m.arrows.find((a) => a.curve === undefined);
  assert.ok(straight, "curve:0 arrow has no curve field in the live model");
  const back = roundTrip(m);
  const curved = back.arrows.find((a) => a.curve !== undefined);
  assert.equal(curved?.curve, -0.7);
  // serialize must not emit "curve": 0 for the straight arrow
  const ser = serializeDiagram(m);
  assert.doesNotMatch(ser, /"curve": 0/);
});

test("parseDiagram clamps an out-of-range curve", () => {
  _resetIdCounter();
  const src = `{
    "version": 1, "rows": 1, "cols": 2,
    "cells": [{ "row": 0, "col": 0, "label": "A" }, { "row": 0, "col": 1, "label": "B" }],
    "arrows": [{ "id": "a1", "from": { "row": 0, "col": 0 }, "to": { "row": 0, "col": 1 }, "curve": 2.5 }]
  }`;
  const m = parseDiagram(src);
  assert.equal(m.arrows[0].curve, 1);
});

test("serialize pretty-prints with 2-space indent", () => {
  _resetIdCounter();
  const m = createEmptyModel(1, 1);
  const s = serializeDiagram(m);
  assert.match(s, /\n  "version": 1,/);
});

test("setCellLabel removes cell when label emptied (sparse invariant)", () => {
  let m = setCellLabel(createEmptyModel(2, 2), 0, 0, "X");
  assert.equal(m.cells.length, 1);
  m = setCellLabel(m, 0, 0, "   ");
  assert.equal(m.cells.length, 0);
  assert.equal(getLabel(m, 0, 0), "");
});

test("insertRow shifts cells and arrows below", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 0, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 } });
  m = insertRow(m, 1); // new empty row at index 1
  assert.equal(m.rows, 3);
  assert.equal(getLabel(m, 0, 0), "A");
  assert.equal(getLabel(m, 1, 0), ""); // new empty row
  assert.equal(getLabel(m, 2, 0), "B"); // shifted down
  assert.deepEqual(m.arrows[0].from, { row: 0, col: 0 });
  assert.deepEqual(m.arrows[0].to, { row: 2, col: 0 });
});

test("insertCol shifts cells and arrows right", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "C");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  m = insertCol(m, 1);
  assert.equal(m.cols, 3);
  assert.equal(getLabel(m, 0, 0), "A");
  assert.equal(getLabel(m, 0, 1), "");
  assert.equal(getLabel(m, 0, 2), "C");
  assert.deepEqual(m.arrows[0].from, { row: 0, col: 0 });
  assert.deepEqual(m.arrows[0].to, { row: 0, col: 2 });
});

test("appendRow/appendCol extend grid at the end", () => {
  let m = createEmptyModel(1, 1);
  m = appendRow(m);
  m = appendCol(m);
  assert.equal(m.rows, 2);
  assert.equal(m.cols, 2);
});

test("deleteRow removes cells/arrows on it and shifts up", () => {
  _resetIdCounter();
  let m = createEmptyModel(3, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 0, "B");
  m = setCellLabel(m, 2, 0, "C");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 0 } });
  m = addArrow(m, { from: { row: 1, col: 0 }, to: { row: 2, col: 0 } });
  m = deleteRow(m, 1); // delete the B row
  assert.equal(m.rows, 2);
  assert.equal(getLabel(m, 0, 0), "A");
  assert.equal(getLabel(m, 1, 0), "C"); // shifted up
  // arrow ending/starting on deleted row is removed
  assert.equal(m.arrows.length, 0);
});

test("deleteCol removes arrows that touch it", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 3);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 2, "C");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } });
  m = deleteCol(m, 1); // delete middle col (arrow passes through but endpoints on 0 and 2)
  assert.equal(m.cols, 2);
  assert.equal(getLabel(m, 0, 0), "A");
  assert.equal(getLabel(m, 0, 1), "C"); // shifted left
  assert.deepEqual(m.arrows[0].from, { row: 0, col: 0 });
  assert.deepEqual(m.arrows[0].to, { row: 0, col: 1 });
});

test("deleteRow/Col with out-of-range index is a no-op", () => {
  const m = createEmptyModel(2, 2);
  assert.deepEqual(deleteRow(m, 5), m);
  assert.deepEqual(deleteCol(m, -1), m);
});

test("trimTrailing removes empty trailing rows then cols", () => {
  _resetIdCounter();
  let m = createEmptyModel(5, 5);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 1, 1, "B");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 } });
  const t = trimTrailing(m);
  // occupied extent is rows 0-1, cols 0-1
  assert.equal(t.rows, 2);
  assert.equal(t.cols, 2);
});

test("trimTrailing keeps a column that an arrow endpoint occupies", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 4);
  m = setCellLabel(m, 0, 0, "A");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 3 } });
  const t = trimTrailing(m);
  assert.equal(t.cols, 4); // arrow endpoint at col 3 keeps it
});

test("isEmpty true for blank model, false with label or arrow", () => {
  assert.equal(isEmpty(createEmptyModel(3, 3)), true);
  let m = setCellLabel(createEmptyModel(3, 3), 0, 0, "A");
  assert.equal(isEmpty(m), false);
  _resetIdCounter();
  const a = addArrow(createEmptyModel(2, 2), { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  assert.equal(isEmpty(a), false);
});

test("rowDeletionIsDestructive / colDeletionIsDestructive", () => {
  _resetIdCounter();
  let m = createEmptyModel(3, 3);
  m = setCellLabel(m, 0, 0, "A");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 2, col: 2 } });
  assert.equal(rowDeletionIsDestructive(m, 0), true);  // has label + arrow endpoint
  assert.equal(rowDeletionIsDestructive(m, 1), false); // empty row
  assert.equal(rowDeletionIsDestructive(m, 2), true);  // arrow endpoint
  assert.equal(colDeletionIsDestructive(m, 1), false);
});

test("removeArrow / updateArrow", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 0, col: 1 } });
  const id = m.arrows[0].id;
  m = updateArrow(m, id, { label: "g", head: "epi" });
  assert.equal(m.arrows[0].label, "g");
  assert.equal(m.arrows[0].head, "epi");
  m = removeArrow(m, id);
  assert.equal(m.arrows.length, 0);
});

test("parseDiagram throws on invalid JSON", () => {
  assert.throws(() => parseDiagram("not json"));
  assert.throws(() => parseDiagram('{ "rows": -1 }'));
});

test("parseDiagram drops empty-label cells and normalizes", () => {
  const src = '{"version":1,"rows":1,"cols":1,"cells":[{"row":0,"col":0,"label":"   "}],"arrows":[]}';
  const m = parseDiagram(src);
  assert.equal(m.cells.length, 0);
});

test("parseDiagram assigns id to arrows missing one", () => {
  _resetIdCounter();
  const src = '{"version":1,"rows":2,"cols":2,"cells":[],"arrows":[{"from":{"row":0,"col":0},"to":{"row":0,"col":1}}]}';
  const m = parseDiagram(src);
  assert.equal(m.arrows.length, 1);
  assert.ok(m.arrows[0].id.length > 0);
});

test("nextArrowId produces distinct ids", () => {
  _resetIdCounter();
  assert.notEqual(nextArrowId(), nextArrowId());
});

test("deep round-trip equality for a complex model", () => {
  _resetIdCounter();
  let m = createEmptyModel(2, 2);
  m = setCellLabel(m, 0, 0, "X");
  m = setCellLabel(m, 1, 1, "Y");
  m = addArrow(m, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 }, label: "f", head: "mapsto", lineStyle: "dotted", bidirectional: false });
  const back = roundTrip(m);
  // compare structurally ignoring id assignment stability: ids preserved through serialize
  assert.deepEqual(back, m);
});

test("cloneModel does not share references", () => {
  const m = createEmptyModel(2, 2);
  const c = cloneModel(m);
  c.cells.push({ row: 0, col: 0, label: "Z" });
  assert.equal(m.cells.length, 0);
});
