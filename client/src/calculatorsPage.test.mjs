import test from "node:test";
import assert from "node:assert/strict";
import { readNumber, fredLink, CARDS, freshInputs, inputFor } from "./calculatorsPage.mjs";
import { paymentCalc, breakEvenCalc, blendedRateCalc, buydownCalc } from "./calculators.mjs";

test("Review Focus 1: readNumber reads typed and pasted money", () => {
  assert.equal(readNumber("$400,000"), 400000); assert.equal(readNumber(" 400,000.00 "), 400000);
  assert.equal(readNumber(""), null); assert.ok(Number.isNaN(readNumber("4oo")));
});
test("fredLink: today's FRED average for a 30- or 15-year term only", () => {
  const R = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-11-24", source: "Optimal Blue lock data (2026-11-24) · ARM estimated" };
  assert.deepEqual(fredLink(R, 30), { rate: 6.52, text: "Use today's 30-year average, 6.52%, from November 24, 2026" });
  assert.equal(fredLink(R, 15).text, "Use today's 15-year average, 5.91%, from November 24, 2026");
  assert.equal(fredLink(R, 20), null);
  assert.equal(fredLink({ ...R, source: "Estimated — server error" }, 30), null);
  assert.equal(fredLink({ ...R, date: "2026-02-30" }, 30), null); assert.equal(fredLink(null, 30), null);
});
test("the four cards, in order", () => {
  assert.deepEqual(CARDS, [["payment", "Payment"], ["breakEven", "Refi break-even"], ["blended", "Blended rate"], ["buydown", "Buydown"]]);
});
test("inputFor: the Payment card's spec example comes to $3,254.94", () => {
  const s = freshInputs().payment;
  assert.equal(s.termYears, "30");
  Object.assign(s, { loanAmount: "$400,000", rate: "6.5", taxesYearly: "4,800", insuranceYearly: "1,800", hoaMonthly: "50", homeValue: "450000", creditScore: "740" });
  const r = paymentCalc(inputFor("payment", s));
  assert.equal(r.ok, true); assert.equal(r.out.total, 3254.94); assert.equal(r.estimated.mi, true);
});
test("inputFor: untouched cards read as blank, never as a guess", () => {
  const f = freshInputs();
  assert.equal(paymentCalc(inputFor("payment", f.payment)).ok, false);
  assert.equal(breakEvenCalc(inputFor("breakEven", f.breakEven)).ok, false);
  assert.equal(blendedRateCalc(inputFor("blended", f.blended)).ok, false);
  assert.equal(buydownCalc(inputFor("buydown", f.buydown)).ok, false);
  assert.equal(inputFor("breakEven", f.breakEven).costsInLoan, false);
  assert.equal(inputFor("blended", f.blended).compareYears, 5);
});
test("inputFor: the break-even card's spec example (costs in cash, then added to the loan)", () => {
  const s = { ...freshInputs().breakEven, currentBalance: "350000", currentRate: "7.25", monthsLeft: "324", newRate: "6.25" };
  const cash = breakEvenCalc(inputFor("breakEven", s));
  assert.equal(cash.out.monthlySavings, 309.67); assert.equal(cash.out.breakEvenMonth, 20);
  const inLoan = breakEvenCalc(inputFor("breakEven", { ...s, costsPaid: "loan" }));
  assert.equal(inLoan.out.breakEvenMonth, 22);
});
