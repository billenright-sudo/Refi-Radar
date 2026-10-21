"use strict";
// Refi-math tests. The scoring logic lives in client/src/App.jsx (analyze + helpers).
// We evaluate the real helper section out of that file so the tests track the shipped
// code, and assert against hand-computed known answers. Run with: cd server && npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "client", "src", "App.jsx"), "utf8");
const start = SRC.indexOf("const calcPayment");
const end = SRC.indexOf("const $c");
assert.ok(start !== -1 && end > start, "could not locate the helper section in App.jsx");
const helpers = SRC.slice(start, end);
// The helper consts live only inside the eval scope; return the two we test.
const { analyze, calcPayment } = eval(helpers + "\n; ({ analyze, calcPayment });");

const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

// OBMMI-shaped payload (includes the observed top-tier anchor)
const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
// Fallback payload (Claude web search / estimates — no top-tier series)
const RATES_NO_TT = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81 };

test("calcPayment: amortization matches a known value", () => {
  // $100,000 at 6% over 30 years = $599.55/mo (standard amortization).
  approx(calcPayment(100000, 6, 30), 599.55, 0.5, "P&I");
  // 0% guard: principal spread evenly.
  approx(calcPayment(120000, 0, 30), 120000 / 360, 0.01, "zero-rate");
});

test("30yr top-tier borrower gets the observed rate with no add-on (high priority)", () => {
  const a = analyze({ loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 }, RATES);
  assert.equal(a.baseLabel, "top-tier");
  assert.equal(a.effRate, 6.461, "FICO>=740 & LTV<=80 maps exactly to the top-tier rate");
  assert.equal(a.rateAdj, 0);
  approx(a.rateDelta, 1.389, 0.01, "rate delta");
  assert.equal(a.good, true);
  assert.equal(a.priority, "high", "delta >= 1.0 is high priority");
  assert.ok(a.monthlySavings > 400 && a.monthlySavings < 520, "monthly savings sane");
  assert.ok(a.breakEven <= 24, "strong break-even");
});

test("tiny rate gap is NOT an opportunity", () => {
  const a = analyze({ loanType: "30yr_fixed", currentRate: 6.50, loanBalance: 142000, propertyValue: 195000, creditScore: 790 }, RATES);
  assert.equal(a.good, false, "0.04% delta below the 0.5% threshold");
  assert.equal(a.priority, "low");
});

test("lower credit / higher LTV gets a relative LLPA add-on over top-tier", () => {
  const a = analyze({ loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 300000, propertyValue: 320000, creditScore: null }, RATES);
  assert.equal(a.baseLabel, "top-tier");
  assert.equal(a.rateAdj, 0.25, "700 FICO @ ~94% LTV -> +0.25 relative");
  assert.equal(a.effRate, 6.711);
});

test("5/1 ARM uses the ARM rate with absolute LLPA (no top-tier series)", () => {
  const a = analyze({ loanType: "5_1_arm", currentRate: 8.25, loanBalance: 560000, propertyValue: 720000, creditScore: 720 }, RATES);
  assert.equal(a.baseLabel, "market");
  assert.equal(a.rateAdj, 0.375);
  assert.equal(a.effRate, 6.185);
  assert.equal(a.priority, "high");
});

test("thin savings fail the break-even gate even with a 0.99% delta", () => {
  const a = analyze({ loanType: "15yr_fixed", currentRate: 6.90, loanBalance: 215000, propertyValue: 380000, creditScore: 800 }, RATES);
  assert.equal(a.baseLabel, "market");
  assert.equal(a.good, false, "break-even > 36 months");
});

test("fallback payload (no top-tier) prices off the market average", () => {
  const a = analyze({ loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 }, RATES_NO_TT);
  assert.equal(a.baseLabel, "market");
  assert.equal(a.rateAdj, 0.125);
});

test("underwater loan (LTV > 95) is never flagged, however big the rate gap", () => {
  const a = analyze({ loanType: "30yr_fixed", currentRate: 8.0, loanBalance: 400000, propertyValue: 380000, creditScore: 740 }, RATES);
  assert.ok(a.ltv > 100);
  assert.equal(a.good, false);
});

test("invariants hold across a credit x LTV sweep", () => {
  for (let score = 600; score <= 820; score += 20) {
    for (let ltv = 40; ltv <= 99; ltv += 5) {
      const a = analyze({ loanType: "30yr_fixed", currentRate: 7.5, loanBalance: ltv * 1000, propertyValue: 100000, creditScore: score }, RATES);
      assert.ok(a.rateAdj >= 0, `adj never negative (${score}/${ltv})`);
      assert.ok(a.effRate >= RATES.rate_30yr_top_tier - 1e-9, `effRate never below top-tier (${score}/${ltv})`);
      if (score >= 740 && ltv <= 80) assert.equal(a.effRate, RATES.rate_30yr_top_tier, `top-tier box anchored (${score}/${ltv})`);
    }
  }
});
