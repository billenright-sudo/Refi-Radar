import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { analyze } from "./refiAnalysis.mjs";

// The server engine (sweeps, the morning briefing, Charlie) is the reference: the client list and client page must show the
// same rate and savings for the same loan.
const serverRefi = createRequire(import.meta.url)("../../server/lib/refi.js");

const RATES = { rate_30yr_fixed: 7.09, rate_15yr_fixed: 6.41, rate_5_1_arm: 6.99, rate_30yr_top_tier: 6.98 };
const ARM = { loanType: "5_1_arm", currentRate: 8.25, loanBalance: 560000, propertyValue: 760000, creditScore: 735 };

test("a 5/1 ARM is priced as a move to a 30-year fixed", () => {
  const a = analyze(ARM, RATES);
  const asFixed = analyze({ ...ARM, loanType: "30yr_fixed" }, RATES);
  assert.equal(a.armToFixed, true);
  assert.equal(a.effRate, asFixed.effRate);
  assert.equal(a.monthlySavings, asFixed.monthlySavings);
  assert.equal(a.baseLabel, asFixed.baseLabel);
});

test("a fixed-rate loan is not marked as an ARM move", () => {
  assert.equal(analyze({ ...ARM, loanType: "30yr_fixed" }, RATES).armToFixed, false);
  assert.equal(analyze({ ...ARM, loanType: "15yr_fixed" }, RATES).armToFixed, false);
});

test("the client figures match the server engine for 30-year, 15-year and ARM loans", () => {
  const loans = [
    { loanType: "30yr_fixed", currentRate: 8.1, loanBalance: 425000, propertyValue: 580000, creditScore: 755 },
    { loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 600000, creditScore: 690 },
    { loanType: "15yr_fixed", currentRate: 7.4, loanBalance: 178000, propertyValue: 400000, creditScore: 780 },
    ARM,
  ];
  for (const loan of loans) {
    const mine = analyze(loan, RATES);
    const theirs = loan.loanType === "5_1_arm" ? serverRefi.armToFixed(loan, RATES) : serverRefi.analyze(loan, RATES);
    assert.equal(mine.effRate.toFixed(2), Number(theirs.effRate).toFixed(2), `${loan.loanType} rate`);
    assert.equal(Math.round(mine.monthlySavings), Math.round(theirs.monthlySavings), `${loan.loanType} savings`);
  }
});

test("no rates, or an unknown loan type, gives no analysis", () => {
  assert.equal(analyze(ARM, null), null);
  assert.equal(analyze({ ...ARM, loanType: "heloc" }, RATES), null);
});
