import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { analyze } from "./refiAnalysis.mjs";
import { pricedToday } from "./equity.mjs";

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

// Today's figures as the server sends them on each client (upgrades.today): the page prices those, as Sweeps does.
const LOAN = { loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 };
const withToday = (loan, today) => ({ ...loan, upgrades: { lenses: [], gaps: [], today } });
const UNUSABLE_TODAY = [undefined, null, {}, { balance: 470000, cautiousValue: null }, { balance: 470000, cautiousValue: 0 },
  { balance: null, cautiousValue: 585000 }, { balance: Number.NaN, cautiousValue: 585000 }, { balance: -5, cautiousValue: 585000 }];

test("pricedToday: today's balance and cautious value in place of the figures on file", () => {
  const c = withToday(LOAN, { balance: 470000, cautiousValue: 585000 });
  assert.deepEqual(pricedToday(c), { ...c, loanBalance: 470000, propertyValue: 585000 });
  for (const today of UNUSABLE_TODAY) {
    const p = pricedToday(withToday(LOAN, today));
    assert.deepEqual([p.loanBalance, p.propertyValue], [485000, 650000], JSON.stringify(today));
  }
  assert.deepEqual([pricedToday(LOAN).loanBalance, pricedToday(LOAN).propertyValue], [485000, 650000], "a client with no upgrades block");
});

test("the page prices today's figures as the server's rate lenses do", () => {
  const today = { balance: 470000, cautiousValue: 585000 };
  const mine = analyze(pricedToday(withToday(LOAN, today)), RATES);
  const theirs = serverRefi.rateTerm(LOAN, RATES, today);
  assert.equal(mine.ltv.toFixed(1), "80.3");   // 470k / 585k, not the 74.6% on file
  assert.equal(mine.effRate.toFixed(2), theirs.effRate.toFixed(2));
  assert.equal(Math.round(mine.monthlySavings), theirs.monthlySavings);
  assert.equal(mine.breakEven, theirs.breakEven);
  assert.notEqual(Math.round(mine.monthlySavings), Math.round(analyze(LOAN, RATES).monthlySavings));

  const armToday = { balance: 540000, cautiousValue: 800000 };
  const arm = analyze(pricedToday(withToday(ARM, armToday)), RATES);
  const armTheirs = serverRefi.armToFixed(ARM, RATES, armToday);
  assert.equal(arm.effRate.toFixed(2), armTheirs.effRate.toFixed(2));
  assert.equal(Math.round(arm.monthlySavings), armTheirs.monthlySavings);

  // Without usable figures both sides price the figures on file.
  for (const t of UNUSABLE_TODAY) {
    const m = analyze(pricedToday(withToday(LOAN, t)), RATES);
    assert.equal(Math.round(m.monthlySavings), serverRefi.rateTerm(LOAN, RATES, t).monthlySavings, JSON.stringify(t));
  }
});

test("no rates, or an unknown loan type, gives no analysis", () => {
  assert.equal(analyze(ARM, null), null);
  assert.equal(analyze({ ...ARM, loanType: "heloc" }, RATES), null);
});
