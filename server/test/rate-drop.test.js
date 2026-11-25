"use strict";
// The one drop rule the briefing and the rate-drop ping share (lib/rateDrop.js). Pure: no database, no network.
const test = require("node:test");
const assert = require("node:assert");
const D = require("../lib/rateDrop");

const mv = { current: { rate_30yr_fixed: 6.402, date: "2026-11-24" }, deltas: { rate_30yr_fixed: -0.1531 }, hasHistory: true, sinceDate: "2026-11-21" };

test("the sizes", () => {
  assert.equal(D.DEFAULT_THRESHOLD, 0.125);
  assert.deepEqual(D.THRESHOLDS, [0.125, 0.25, 0.375, 0.5]);
});

test("marketMove rounds as the briefing's market tool does", () => {
  assert.deepEqual(D.marketMove(mv), { rate30: 6.4, move30: -0.15, obsDate: "2026-11-24", sinceDate: "2026-11-21" });
  assert.equal(D.marketMove({ ...mv, deltas: { rate_30yr_fixed: -0.125 } }).move30, -0.13);
  assert.equal(D.marketMove({ ...mv, hasHistory: false, deltas: null }), null);
  assert.equal(D.marketMove({ ...mv, current: { ...mv.current, date: "2026-02-30" } }), null);
});

test("marketMove is null without a finite 30-year delta, a finite 30-year, or a real since date", () => {
  assert.equal(D.marketMove(null), null);
  assert.equal(D.marketMove({ ...mv, deltas: { rate_15yr_fixed: -0.2 } }), null);
  assert.equal(D.marketMove({ ...mv, deltas: { rate_30yr_fixed: NaN } }), null);
  assert.equal(D.marketMove({ ...mv, current: { date: "2026-11-24" } }), null);
  assert.equal(D.marketMove({ ...mv, sinceDate: "2026-13-01" }), null);
  assert.equal(D.marketMove({ ...mv, sinceDate: null }), null);
  assert.equal(D.marketMove({ ...mv, current: { ...mv.current, date: "Nov 24" } }), null);
});

test("isDrop: at or past the size, never a rise", () => {
  for (const [m, t, want] of [[-0.13, 0.125, true], [-0.12, 0.125, false], [-0.25, 0.25, true], [-0.37, 0.375, false],
    [-0.38, 0.375, true], [-0.5, 0.5, true], [0.2, 0.125, false], [null, 0.125, false], [undefined, 0.125, false], [NaN, 0.125, false]]) {
    assert.equal(D.isDrop(m, t), want, `${m} vs ${t}`);
  }
});

test("isDrop agrees with 'fell by the size or more' on every two-decimal move for all four sizes", () => {
  for (const t of D.THRESHOLDS) {
    for (let cents = -80; cents <= 80; cents += 1) {
      // a two-decimal move is a drop of size t when it is at least ceil(t * 100) cents down (0.125 -> 13, 0.375 -> 38)
      assert.equal(D.isDrop(cents / 100, t), cents <= -Math.ceil(t * 100 - 1e-9), `${cents} cents vs ${t}`);
    }
  }
});
