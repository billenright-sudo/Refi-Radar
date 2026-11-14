"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { balanceToday, valueToday, CAUTION_CUT, TYPED_FRESH_MONTHS } = require("../lib/equity");
const { createIndex } = require("../lib/hpi");

function series(last) {
  const a = [];
  for (let i = 0; i < 22; i++) a.push(100);
  a[21] = last;
  return a;
}
const idx = (last = 129) => createIndex({ source: "t", start: "2021Q1", end: "2026Q2", zip3: { "850": series(last) } });
const base = { loanType: "30yr_fixed", currentRate: 6, loanBalance: 300000, closeDate: "2024-01-15", balanceAsOf: "2024-03-01" };

test("constants", () => {
  assert.strictEqual(CAUTION_CUT, 0.1);
  assert.strictEqual(TYPED_FRESH_MONTHS, 12);
});

test("rolls the balance forward", () => {
  const r = balanceToday(base, "2025-03-01");
  assert.strictEqual(r.basis, "rolled");
  assert.ok(Math.abs(r.balance - 296316) <= 1, String(r.balance));
});

test("no close date keeps the stored balance", () => {
  const r = balanceToday({ ...base, closeDate: "" }, "2025-03-01");
  assert.strictEqual(r.basis, "stored");
  assert.strictEqual(r.balance, 300000);
});

test("as-of today keeps the stored balance", () => {
  const r = balanceToday(base, "2024-03-01");
  assert.strictEqual(r.balance, 300000);
});

const v = { propertyValue: 355000, valueAsOf: "2021-06-30", propertyZip: "85016" };

test("grows an untyped value and cuts 10%", () => {
  const r = valueToday(v, "2026-11-13", idx());
  assert.strictEqual(r.basis, "grown");
  assert.strictEqual(r.value, 457950);
  assert.strictEqual(r.cautious, 412155);
  assert.strictEqual(r.growthPct, 29);
  assert.strictEqual(r.area, "850");
});

test("typed within 12 months is used as is", () => {
  const r = valueToday({ ...v, editedByHand: "property_value", valueAsOf: "2026-08-13" }, "2026-11-13", idx());
  assert.strictEqual(r.basis, "typed");
  assert.strictEqual(r.value, 355000);
  assert.strictEqual(r.cautious, 355000);
});

test("typed 13 months ago is grown and cut", () => {
  const r = valueToday({ ...v, editedByHand: "property_value", valueAsOf: "2025-10-13" }, "2026-11-13", idx());
  assert.strictEqual(r.basis, "grown");
});

test("no ZIP: flat, still cut 10%", () => {
  const r = valueToday({ ...v, propertyZip: "" }, "2026-11-13", idx());
  assert.strictEqual(r.basis, "flat");
  assert.strictEqual(r.value, 355000);
  assert.strictEqual(r.cautious, 319500);
  assert.strictEqual(r.growthPct, null);
});

test("a falling index lowers the value", () => {
  const r = valueToday(v, "2026-11-13", idx(90));
  assert.strictEqual(r.value, 319500);
  assert.strictEqual(r.cautious, 287550);
});
