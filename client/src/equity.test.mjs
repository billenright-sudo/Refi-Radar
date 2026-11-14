import test from "node:test";
import assert from "node:assert/strict";
import { APPRECIATION_RATE, equityStart, equityAt, monthsToSubEightyLTV } from "./equity.mjs";

// Sample client: bought for $250,000 in 2021; the server's today block grew it to $338,986 and took 10% off → $305,087.
const withToday = (today, over = {}) => ({
  propertyValue: 250000, loanBalance: 214000, currentRate: 7.25, loanType: "30yr_fixed",
  upgrades: { today: { balance: 214000, value: 338986, cautiousValue: 305087, ...today } },
  ...over,
});
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("appreciation stays 3.5% a year", () => {
  assert.equal(APPRECIATION_RATE, 0.035);
});

test("starts from today's balance and today's cautious value", () => {
  assert.deepEqual(equityStart(withToday({})), { value: 305087, balance: 214000 });
});

test("a rolled-forward balance is used, not the stored one", () => {
  assert.deepEqual(equityStart(withToday({ balance: 198500 })), { value: 305087, balance: 198500 });
});

test("a paid-off balance of 0 still counts as today's balance", () => {
  assert.deepEqual(equityStart(withToday({ balance: 0 })), { value: 305087, balance: 0 });
});

test("no today figures: falls back to what's on file", () => {
  const stored = { value: 250000, balance: 214000 };
  assert.deepEqual(equityStart(withToday({}, { upgrades: undefined })), stored);
  assert.deepEqual(equityStart(withToday({}, { upgrades: {} })), stored);
  assert.deepEqual(equityStart(withToday({ cautiousValue: null })), stored);
  assert.deepEqual(equityStart(withToday({ cautiousValue: 0 })), stored);
  assert.deepEqual(equityStart(withToday({ balance: null })), stored);
  assert.deepEqual(equityStart(withToday({ balance: Number.NaN })), stored);
});

test("Today row: value, balance, equity, LTV and cash-out from today's figures", () => {
  const e = equityAt(withToday({}), 0);
  assert.equal(e.futVal, 305087);
  near(e.futBal, 214000);
  near(e.equity, 91087);
  near(e.ltvPct, (214000 / 305087) * 100);
  near(e.cashOut, 305087 * 0.8 - 214000);
});

test("later rows grow 3.5% a year from today's value", () => {
  near(equityAt(withToday({}), 5).futVal, 305087 * Math.pow(1.035, 5));
});

test("PMI timing starts from today's figures", () => {
  // Stored: 214,000 / 250,000 = 85.6% (above 80%). Today: 214,000 / 305,087 ≈ 70.1% → already below 80%.
  assert.equal(monthsToSubEightyLTV(withToday({})), 0);
  assert.ok(monthsToSubEightyLTV(withToday({}, { upgrades: undefined })) > 0);
});
