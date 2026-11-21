"use strict";
// Mortgage insurance in the rate-refi savings: a new conventional loan over 80% LTV carries PMI, so the savings count it
// (an estimate from a published rate card, leaning high), with the insurance on file for the current loan beside it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze, pricedToday, rateTerm, calcPayment, estClosingCosts, norm } = require("../lib/refi");
const { pmiAnnualRate, pmiMonthly } = require("../lib/pmi");
const { upgradesFor } = require("../lib/upgrades");

const RATES = { rate_30yr_fixed: 6.25, rate_15yr_fixed: 5.6, rate_5_1_arm: 6.1 };   // no top-tier index: market + pricing
const cents = (n) => Math.round(n * 100) / 100;

test("pmiAnnualRate: the rate card's standard-coverage row for the LTV band and the score column", () => {
  const rows = [
    // score, ltv, years, percent a year
    [760, 82, 30, 0.19], [700, 82.4, 30, 0.25], [700, 85, 30, 0.25],
    [700, 85.01, 30, 0.55], [700, 90, 30, 0.55],
    [700, 90.01, 30, 0.78], [700, 95, 30, 0.78],
    [700, 95.01, 30, 0.99], [700, 99, 30, 0.99],
    [619, 88, 30, 1.32], [640, 93, 30, 1.33], [739, 93, 30, 0.66], [740, 93, 30, 0.53],
    [700, 82, 15, 0.23], [760, 93, 15, 0.32], [660, 96, 15, 1.34],
  ];
  for (const [score, ltv, years, want] of rows) assert.equal(pmiAnnualRate(score, ltv, years), want, `${score} / ${ltv}% / ${years}yr`);
});

test("pmiAnnualRate: nothing at or under 80% LTV; an unknown score is priced as 700, as the rate is", () => {
  for (const ltv of [80, 79.99, 60, 0]) assert.equal(pmiAnnualRate(700, ltv, 30), 0, String(ltv));
  for (const score of [null, undefined, 0, ""]) assert.equal(pmiAnnualRate(score, 82, 30), 0.25, String(score));
  assert.equal(pmiAnnualRate(700, NaN, 30), 0);
});

test("pmiMonthly: the yearly rate over 12 on the loan balance, to the cent", () => {
  assert.equal(pmiMonthly(700, 82.4, 30, 412000), 85.83);   // 0.25% of 412,000 / 12
  assert.equal(pmiMonthly(700, 80, 30, 400000), 0);
  assert.equal(pmiMonthly(700, 90, 30, 0), 0);
});

const AT_80 = { loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 400000, propertyValue: 500000, creditScore: 700 };
const OVER_80 = { ...AT_80, loanBalance: 412000 };   // 82.4% LTV

test("analyze: at or under 80% LTV nothing changes, whatever insurance is on file", () => {
  for (const loan of [AT_80, { ...AT_80, miToday: 150 }]) {
    const a = analyze(loan, RATES);
    assert.equal(a.newMi, 0);
    assert.equal(a.curMi, 0);
    assert.equal(a.monthlySavings, a.curPmt - a.newPmt);
    assert.equal(a.breakEven, Math.ceil(estClosingCosts(400000) / (a.curPmt - a.newPmt)));
  }
});

test("analyze: over 80% LTV the new loan's PMI comes off the savings, and the break-even follows", () => {
  const a = analyze(OVER_80, RATES);
  assert.equal(a.newMi, 85.83);
  assert.equal(a.newMiRate, 0.25);
  assert.equal(a.curMi, 0);
  const pAndI = calcPayment(412000, 7.5, 30) - calcPayment(412000, a.effRate, 30);
  assert.equal(cents(a.monthlySavings), cents(pAndI - 85.83));
  assert.equal(a.annualSavings, a.monthlySavings * 12);
  assert.equal(a.breakEven, Math.ceil(estClosingCosts(412000) / a.monthlySavings));
});

test("analyze: over 80% LTV the insurance on file for the current loan is counted beside the new loan's", () => {
  const a = analyze({ ...OVER_80, miToday: 120 }, RATES);
  assert.equal(a.curMi, 120);
  const pAndI = calcPayment(412000, 7.5, 30) - calcPayment(412000, a.effRate, 30);
  assert.equal(cents(a.monthlySavings), cents(pAndI + 120 - 85.83));
  for (const junk of [null, undefined, "", -5, NaN, "abc"]) assert.equal(analyze({ ...OVER_80, miToday: junk }, RATES).curMi, 0, String(junk));
});

test("analyze: a loan that only looks refi-ready on principal and interest is not, once PMI is counted", () => {
  const loan = { loanType: "30yr_fixed", currentRate: 7.75, loanBalance: 360000, propertyValue: 400000, creditScore: 665 };   // 90% LTV
  const a = analyze(loan, RATES);
  assert.ok(a.rateDelta >= 0.5, "the rate drop alone would pass");
  assert.ok(Math.ceil(estClosingCosts(360000) / (a.curPmt - a.newPmt)) <= 36, "so would the break-even on principal and interest");
  assert.equal(a.newMi, 270);   // 0.90% of 360,000 / 12
  assert.equal(a.good, false);
  assert.equal(a.priority, "low");
});

test("pricedToday: the insurance on file rides with today's figures", () => {
  const c = norm({ loan_type: "30yr_fixed", current_rate: 7.5, loan_balance: 420000, property_value: 500000, credit_score: 700 });
  assert.equal(pricedToday(c, { balance: 412000, cautiousValue: 500000, miOnFile: 120 }).miToday, 120);
  for (const mi of [undefined, null, 0, -1, NaN]) assert.equal(pricedToday(c, { balance: 412000, cautiousValue: 500000, miOnFile: mi }).miToday, 0, String(mi));
  assert.equal(pricedToday(c, null).miToday, undefined, "no today block: the loan as it is on file");
});

test("rateTerm: the reason line says the PMI was counted, and carries the figure as a number", () => {
  const c = norm({ loan_type: "30yr_fixed", current_rate: 8.25, loan_balance: 412000, property_value: 500000, credit_score: 700 });
  const lens = rateTerm(c, RATES, { balance: 412000, cautiousValue: 500000, miOnFile: 0 });
  assert.ok(lens, "still worth a call at this rate drop");
  assert.equal(lens.newMiMonthly, 86);
  assert.match(lens.detail, /break-even \d+ mo — new-loan PMI ~\$86\/mo counted$/);
  const a = analyze({ ...c, loanBalance: 412000, propertyValue: 500000, miToday: 0 }, RATES);
  assert.equal(lens.monthlySavings, Math.round(a.monthlySavings));

  const withMi = rateTerm(c, RATES, { balance: 412000, cautiousValue: 500000, miOnFile: 120 });
  assert.match(withMi.detail, /— PMI counted: ~\$86\/mo new, \$120\/mo now$/);
  assert.equal(withMi.monthlySavings, lens.monthlySavings + 120);

  const under = rateTerm(c, RATES, { balance: 400000, cautiousValue: 500000, miOnFile: 120 });
  assert.equal(under.newMiMonthly, undefined);
  assert.doesNotMatch(under.detail, /PMI/);
});

test("upgradesFor: today's figures carry the typed insurance still in force, and 0 otherwise", () => {
  const base = { loan_type: "30yr_fixed", loan_program: "conventional", current_rate: 7.5, loan_balance: 412000, property_value: 500000,
    credit_score: 700, credit_score_known: 1, close_date: "2024-06-14", original_amount: 420000, original_value: 500000, property_zip: "85254" };
  const today = "2026-11-21";
  assert.equal(upgradesFor(norm({ ...base, monthly_mi: 120 }), RATES, today).today.miOnFile, 120);
  assert.equal(upgradesFor(norm(base), RATES, today).today.miOnFile, 0, "none typed");
  assert.equal(upgradesFor(norm({ ...base, monthly_mi: 120, close_date: "" }), RATES, today).today.miOnFile, 120, "no close date: the amount on file");
  // paid down past 78% of the original value: the insurance has ended on its own
  const ended = { ...base, monthly_mi: 120, close_date: "2010-06-14", original_amount: 400000, original_value: 500000 };
  assert.equal(upgradesFor(norm(ended), RATES, today).today.miOnFile, 0, "ended at 78%");
});
