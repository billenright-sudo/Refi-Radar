"use strict";
// The loan math behind the client import and the ARIVE feed (lib/intake/loan.js): when payments start, how many have come
// due, today's balance (given, estimated from the schedule, or the original amount), and which of the three priced loan
// types a loan maps to. All pure, so there is no DB here.
const test = require("node:test");
const assert = require("node:assert");

const { firstPaymentFromClosing, paymentsMade, estimateBalance, termOf, mapLoanType } = require("../lib/intake/loan");

test("firstPaymentFromClosing: 3/14 → 5/1, across a year end", () => {
  assert.equal(firstPaymentFromClosing("2024-03-14"), "2024-05-01");
  assert.equal(firstPaymentFromClosing("2024-11-30"), "2025-01-01");
  assert.equal(firstPaymentFromClosing("2024-12-05"), "2025-02-01");
  assert.equal(firstPaymentFromClosing(""), null);
});
test("firstPaymentFromClosing: anything that is not a real YYYY-MM-DD is null", () => {
  for (const v of [null, undefined, 20240314, "3/14/2024", "2024-02-30", "2024-13-01", {}]) assert.equal(firstPaymentFromClosing(v), null);
});
test("paymentsMade counts the first payment once it is due", () => {
  assert.equal(paymentsMade("2024-05-01", "2026-11-01"), 31);
  assert.equal(paymentsMade("2024-05-01", "2026-10-31"), 30);
  assert.equal(paymentsMade("2024-05-01", "2024-04-30"), 0);
  assert.equal(paymentsMade("2024-05-15", "2024-06-14"), 1);
});
test("paymentsMade: a payment due on the 31st falls on the last day of a shorter month; bad dates count none", () => {
  assert.equal(paymentsMade("2024-01-31", "2024-02-28"), 1);
  assert.equal(paymentsMade("2024-01-31", "2024-02-29"), 2);
  assert.equal(paymentsMade("2025-01-31", "2025-02-28"), 2);
  assert.equal(paymentsMade("2024-01-31", "2024-03-30"), 2);
  assert.equal(paymentsMade("2024-01-31", "2024-03-31"), 3);
  assert.equal(paymentsMade("", "2026-11-01"), 0);
  assert.equal(paymentsMade("2024-05-01", undefined), 0);
});
test("estimateBalance: current wins, then the schedule, then the original amount", () => {
  const base = { loanAmount: 400000, rate: 6.5, termMonths: 360, today: "2026-11-01" };
  assert.deepStrictEqual(estimateBalance({ ...base, currentBalance: 391002.5 }), { balance: 391002.5, basis: "current" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "2024-05-01" }), { balance: 387830, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "2024-05-01", today: "2026-10-31" }), { balance: 388255, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, closeDate: "2024-03-14" }), { balance: 387830, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "2026-12-01" }), { balance: 400000, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "1990-01-01" }), { balance: 0, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ loanAmount: 300000, rate: 5.875, termMonths: 180, firstPaymentDate: "2025-11-01", today: "2026-10-01" }), { balance: 287146, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ loanAmount: 400000, rate: 6.5, today: "2026-11-01" }), { balance: 400000, basis: "original" });
  assert.equal(estimateBalance({ rate: 6.5, today: "2026-11-01" }), null);
});
test("estimateBalance: a first-payment date wins over the closing date, and a bad one falls back to it", () => {
  const base = { loanAmount: 400000, rate: 6.5, termMonths: 360, today: "2026-11-01" };
  assert.equal(estimateBalance({ ...base, firstPaymentDate: "2024-05-01", closeDate: "2020-01-01" }).balance, 387830);
  assert.equal(estimateBalance({ ...base, firstPaymentDate: "soon", closeDate: "2024-03-14" }).balance, 387830);
});
test("estimateBalance: a figure it cannot trust is never a schedule; zero, negative and junk inputs fall through", () => {
  const base = { loanAmount: 400000, rate: 6.5, termMonths: 360, firstPaymentDate: "2024-05-01", today: "2026-11-01" };
  assert.equal(estimateBalance({ ...base, currentBalance: 0 }).basis, "estimated");
  assert.equal(estimateBalance({ ...base, currentBalance: -5 }).basis, "estimated");
  assert.equal(estimateBalance({ ...base, currentBalance: "391000" }).basis, "estimated");
  assert.deepStrictEqual(estimateBalance({ ...base, rate: 0 }), { balance: 400000, basis: "original" });
  assert.deepStrictEqual(estimateBalance({ ...base, rate: null }), { balance: 400000, basis: "original" });
  assert.deepStrictEqual(estimateBalance({ ...base, termMonths: 0 }), { balance: 400000, basis: "original" });
  assert.deepStrictEqual(estimateBalance({ ...base, today: undefined }), { balance: 400000, basis: "original" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: undefined }), { balance: 400000, basis: "original" });
  assert.equal(estimateBalance({ ...base, loanAmount: 0 }), null);
  assert.equal(estimateBalance(), null);
});
test("mapLoanType maps term + amortization to the three priced types and flags what it rounds", () => {
  const t = (x) => mapLoanType(x);
  assert.deepStrictEqual(t({ amortization: "5/1 ARM" }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "ARM" }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "7/1 ARM" }), { loanType: "5_1_arm", given: true, flag: "7/1 ARM priced as a 5/1" });
  assert.deepStrictEqual(t({ amortization: "Adjustable", termMonths: 360 }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ termMonths: 180, amortization: "Fixed" }), { loanType: "15yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ termMonths: 120 }), { loanType: "15yr_fixed", given: true, flag: "10-year fixed priced as a 15-year" });
  assert.deepStrictEqual(t({ termMonths: 240 }), { loanType: "30yr_fixed", given: true, flag: "20-year fixed priced as a 30-year" });
  assert.deepStrictEqual(t({ termMonths: 300 }), { loanType: "30yr_fixed", given: true, flag: "25-year fixed priced as a 30-year" });
  assert.deepStrictEqual(t({ amortization: "30 Yr Fixed" }), { loanType: "30yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "15 Year Fixed" }), { loanType: "15yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "Conventional" }), { loanType: "30yr_fixed", given: false, flag: null });
  assert.deepStrictEqual(t({}), { loanType: "30yr_fixed", given: false, flag: null });
});
test("mapLoanType: an ARM's x/y is never read as a term; the term column beats the text; text with the term in the middle works", () => {
  const t = (x) => mapLoanType(x);
  assert.deepStrictEqual(t({ amortization: "10/1 ARM", termMonths: 360 }), { loanType: "5_1_arm", given: true, flag: "10/1 ARM priced as a 5/1" });
  assert.deepStrictEqual(t({ amortization: "5 / 1 Adjustable" }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "Variable Rate" }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ termMonths: 360, amortization: "15 Year Fixed" }), { loanType: "30yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "Fixed 15 Year" }), { loanType: "15yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "FHA 30-Year Fixed Rate" }), { loanType: "30yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "20 Yr Fixed" }), { loanType: "30yr_fixed", given: true, flag: "20-year fixed priced as a 30-year" });
  assert.deepStrictEqual(t({ termMonths: 0, amortization: "" }), { loanType: "30yr_fixed", given: false, flag: null });
  assert.deepStrictEqual(t({ termMonths: null, amortization: null }), { loanType: "30yr_fixed", given: false, flag: null });
});
test("mapLoanType: 'given' means the row names the priced type (an ARM or a term); a bare 'Fixed' is only the default", () => {
  // An update writes loan_type only when given (R5), so "Fixed" with no term must never turn a stored 15-year into a 30-year.
  for (const amortization of ["Fixed", "Fixed Rate", "Conventional Fixed", "fixed"]) {
    assert.deepStrictEqual(mapLoanType({ amortization }), { loanType: "30yr_fixed", given: false, flag: null });
  }
  assert.deepStrictEqual(mapLoanType({ termMonths: 180, amortization: "Fixed" }), { loanType: "15yr_fixed", given: true, flag: null });
});
test("mapLoanType: a term outside 12-600 months is no term at all (not given, no flag)", () => {
  const none = { loanType: "30yr_fixed", given: false, flag: null };
  assert.deepStrictEqual(mapLoanType({ termMonths: 5 }), none);
  assert.deepStrictEqual(mapLoanType({ termMonths: 601 }), none);
  assert.deepStrictEqual(mapLoanType({ amortization: "2024" }), none);
  assert.deepStrictEqual(mapLoanType({ amortization: "Fixed 2024 months" }), none);
  assert.deepStrictEqual(mapLoanType({ amortization: "3 Yr Fixed" }), { loanType: "15yr_fixed", given: true, flag: "3-year fixed priced as a 15-year" });
  // The edges are in: 12 and 600 months are terms.
  assert.deepStrictEqual(mapLoanType({ termMonths: 12 }), { loanType: "15yr_fixed", given: true, flag: "1-year fixed priced as a 15-year" });
  assert.deepStrictEqual(mapLoanType({ termMonths: 600 }), { loanType: "30yr_fixed", given: true, flag: "50-year fixed priced as a 30-year" });
  // A term column that is out of range doesn't hide a good term in the text.
  assert.deepStrictEqual(mapLoanType({ termMonths: 5, amortization: "15 Year Fixed" }), { loanType: "15yr_fixed", given: true, flag: null });
});
test("mapLoanType: long runs of spaces in the text are read quickly and give no term", () => {
  const spaces = " ".repeat(30000);
  const none = { loanType: "30yr_fixed", given: false, flag: null };
  const timed = (amortization) => {
    const start = process.hrtime.bigint();
    const got = mapLoanType({ amortization });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 50, `took ${ms} ms`);
    return got;
  };
  assert.deepStrictEqual(timed(spaces), none);
  assert.deepStrictEqual(timed(`Fixed${spaces}`), none);
  assert.deepStrictEqual(timed(`${"x ".repeat(15000)}`), none);
  // A number followed by a long gap: this used to take 0.4 to 1 second. Only the speed is asserted; the text is cut to its
  // first 200 characters, so what it reads as is not the point.
  for (const amortization of [`5${spaces}!`, `30${spaces}`, `15${spaces}year`, `${"1 ".repeat(15000)}x`]) timed(amortization);
});
test("termOf: the term column when it is believable, else a term read from the product text, else null", () => {
  assert.equal(termOf({ termMonths: 360, amortization: "15 Yr Fixed" }), 360);
  assert.equal(termOf({ termMonths: null, amortization: "30 Yr Fixed" }), 360);
  assert.equal(termOf({ termMonths: 6, amortization: "15 Year" }), 180);
  assert.equal(termOf({ termMonths: 360, amortization: "5/1 ARM" }), 360);
  for (const v of [{}, { amortization: "Fixed" }, { termMonths: null, amortization: "5/1 ARM" }, { termMonths: 2024 }, undefined]) assert.equal(termOf(v), null);
});
