import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyScale,
  clampLabelScale,
  getCDStyleMetrics,
  resetCDStyleMetricsCache,
  type CDStyleMetrics,
} from "../src/diagram/cd-style-metrics";
import { createEmptyModel, setCellLabel } from "../src/diagram/model";
import { layoutDiagram } from "../src/diagram/render";

const baseMetrics: CDStyleMetrics = {
  fontSize: 18,
  lineHeight: 22,
  arrowStrokeWidth: 0.9,
  minGap: 54,
};

test("applyScale multiplies every size field and is non-mutating", () => {
  const before = { ...baseMetrics };
  const scaled = applyScale(baseMetrics, 1.5);
  assert.equal(scaled.fontSize, 27);
  assert.equal(scaled.lineHeight, 33);
  assert.equal(scaled.arrowStrokeWidth, 1.35);
  assert.equal(scaled.minGap, 81);
  // input untouched
  assert.deepEqual(baseMetrics, before);
});

test("applyScale clamps out-of-range scale (NaN, 0, huge)", () => {
  assert.equal(applyScale(baseMetrics, NaN).fontSize, 18 * 0.95); // NaN -> 0.95 default
  assert.equal(applyScale(baseMetrics, 0).fontSize, 18 * 0.4); // clamps to 0.4
  assert.equal(applyScale(baseMetrics, 10).fontSize, 18 * 1.5); // clamps to 1.5
});

test("clampLabelScale bounds to [0.4, 1.5] and defaults NaN to 0.95", () => {
  assert.equal(clampLabelScale(0.2), 0.4);
  assert.equal(clampLabelScale(5), 1.5);
  assert.equal(clampLabelScale(1.0), 1.0);
  assert.equal(clampLabelScale(0.95), 0.95);
  assert.equal(clampLabelScale(NaN), 0.95);
  assert.equal(clampLabelScale(Infinity), 0.95);
});

test("getCDStyleMetrics with scale returns rescaled fallback in a headless env", () => {
  resetCDStyleMetricsCache();
  // A bare object as `doc`: detectTheme yields "" (no body), and measureWithMathJax
  // throws (no `window`) inside its try/catch, so we hit the fallback (fontSize 18,
  // minGap 54) then applyScale. labelScale 1.5 grows both by 1.5×.
  const doc = {} as Document;
  const m = getCDStyleMetrics(doc, { labelScale: 1.5 });
  assert.equal(m.fontSize, 27);
  assert.equal(m.minGap, 81);
  resetCDStyleMetricsCache();
});

test("getCDStyleMetrics caches per scale (changing scale yields different metrics)", () => {
  resetCDStyleMetricsCache();
  const doc = {} as Document;
  const a = getCDStyleMetrics(doc, { labelScale: 0.95 });
  const b = getCDStyleMetrics(doc, { labelScale: 1.5 });
  assert.equal(a.fontSize, 18 * 0.95);
  assert.equal(b.fontSize, 27);
  // Same scale as `a` again returns the cached (0.95×) value, not the 1.5× one.
  const a2 = getCDStyleMetrics(doc, { labelScale: 0.95 });
  assert.equal(a2.fontSize, 18 * 0.95);
  resetCDStyleMetricsCache();
});

test("layoutDiagram spacing scales with the supplied metrics (label size -> bigger gap)", () => {
  // The label-size setting ultimately changes minGap (AMS \arrowlength),
  // so a larger scale grows the column gap for short-label diagrams.
  const measure = (s: string) => ({ width: s.length * 10, height: 20 });
  let m = createEmptyModel(1, 2);
  m = setCellLabel(m, 0, 0, "A");
  m = setCellLabel(m, 0, 1, "B");

  const small = layoutDiagram(m, measure, applyScale(baseMetrics, 0.95));
  const big = layoutDiagram(m, measure, applyScale(baseMetrics, 1.5));
  assert.equal(small.colGaps[0], 54 * 0.95);
  assert.equal(big.colGaps[0], 54 * 1.5);
  // A bigger scale yields a wider overall diagram.
  assert.ok(big.width > small.width);
});
