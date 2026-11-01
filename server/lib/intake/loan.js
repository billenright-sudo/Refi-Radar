"use strict";
// Loan math for imported loans. A spreadsheet or an ARIVE feed rarely says what the loan owes today, and rarely says which of
// the three loan types the pricing engine knows (30-year fixed, 15-year fixed, 5/1 ARM) the loan is. This turns the loan's
// terms into both: today's balance, and a loan type. Nothing here touches the DB or the network, so every function is pure.
//
// The callers pass values already read by lib/intake/normalize.js (numbers, "YYYY-MM-DD" dates). The one thing read here is a
// term out of free text like "30 Yr Fixed", which uses normalize's parseTermMonths.
//
// A balance is never made up. When it is not given, it is worked out from the payment schedule (basis "estimated"), and when
// even that cannot be done the original loan amount stands in (basis "original") so the caller can flag it. With no loan
// amount either there is no figure, and the answer is null.

const { parseTermMonths } = require("./normalize");

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A 5/1 ARM is the only ARM the pricing engine has. Any ARM, adjustable or variable rate (or a "7/1" style ratio) maps to it.
const ARM_RE = /\barm\b|adjustable|variable|\b\d{1,2}\s*\/\s*\d{1,2}\b/i;
const ARM_RATIO_RE = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/;
const FIXED_RE = /fixed/i;
// A term written inside other words ("Fixed 15 Year", "FHA 30-Year Fixed Rate", "20 Yr"). The unit has to be there, so a bare
// number in the text is never taken for a term and an ARM's "5/1" cannot be (and an ARM never gets this far anyway).
const TERM_IN_TEXT_RE = /\b\d+(?:\.\d+)?\s*-?\s*(?:years?|yrs?|y|months?|mos?|mo)\b/i;
// Priced as a 15-year at 180 months or fewer, as a 30-year for anything longer.
const FIFTEEN_YEAR_MONTHS = 180;
const THIRTY_YEAR_MONTHS = 360;

const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

// "YYYY-MM-DD" as { y, m, d }, or null if it is not a real day. The date is read back from a UTC date, so Feb 30 (which the
// Date constructor would roll into March) and a year under 100 (which it would move to 19xx) are refused.
function readDate(s) {
  const m = typeof s === "string" ? ISO_DATE_RE.exec(s) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The first mortgage payment is due on the 1st of the second month after closing: close 3/14 -> pay from 5/1, close 11/30 ->
// pay from 1/1 of the next year. Null if the closing date is missing or not a real day.
function firstPaymentFromClosing(closeDate) {
  const c = readDate(closeDate);
  if (!c) return null;
  return new Date(Date.UTC(c.y, c.m - 1 + 2, 1)).toISOString().slice(0, 10);
}

// How many payments have come due by today. Payments fall on firstPayment + 0, 1, 2... months, and one counts on its due date
// itself (due 5/1 -> counted on 5/1, not on 4/30). A payment due on the 29th-31st falls on the last day of a shorter month.
// A missing or unreadable date counts none.
function paymentsMade(firstPayment, today) {
  const f = readDate(firstPayment);
  const t = readDate(today);
  if (!f || !t) return 0;
  const monthsApart = (t.y - f.y) * 12 + (t.m - f.m);
  if (monthsApart < 0) return 0;
  const dueThisMonth = Math.min(f.d, daysInMonth(t.y, t.m));
  return Math.max(0, t.d >= dueThisMonth ? monthsApart + 1 : monthsApart);
}

// What is still owed after n payments of a standard fully-amortizing loan: P(1+r)^n - pmt((1+r)^n - 1)/r, where r is the
// monthly rate and pmt = P*r / (1 - (1+r)^-N).
function amortizedBalance(principal, ratePercent, termMonths, n) {
  const r = ratePercent / 1200;
  const growth = Math.pow(1 + r, n);
  const payment = (principal * r) / (1 - Math.pow(1 + r, -termMonths));
  return principal * growth - (payment * (growth - 1)) / r;
}

// Today's balance and where it came from:
//   "current"   - the balance the row gave (> 0), used as given.
//   "estimated" - worked out from the schedule: needs a loan amount, a rate, a term and a start date (the first-payment date,
//                 else the one derived from the closing date) plus today's date. Payments are capped at the term, the answer
//                 is rounded to the dollar and never goes below 0.
//   "original"  - the loan amount, when the schedule cannot be worked out. The caller flags it.
// Anything else is null.
function estimateBalance({ currentBalance, loanAmount, rate, termMonths, firstPaymentDate, closeDate, today } = {}) {
  if (pos(currentBalance)) return { balance: currentBalance, basis: "current" };
  if (!pos(loanAmount)) return null;
  const start = readDate(firstPaymentDate) ? firstPaymentDate : firstPaymentFromClosing(closeDate);
  if (pos(rate) && pos(termMonths) && start && readDate(today)) {
    const n = Math.min(paymentsMade(start, today), termMonths);
    const balance = Math.max(0, Math.round(amortizedBalance(loanAmount, rate, termMonths, n)));
    return { balance, basis: "estimated" };
  }
  return { balance: loanAmount, basis: "original" };
}

// A term in months from text like "30 Yr Fixed": the unit-bearing words wherever they sit, else the whole text (a bare "30").
function termFromText(v) {
  if (typeof v === "string") {
    const m = TERM_IN_TEXT_RE.exec(v);
    if (m) return parseTermMonths(m[0]);
  }
  return parseTermMonths(v);
}

// Which priced loan type a loan is, whether the row actually said, and what had to be rounded to get there.
//   loanType - "5_1_arm" for any ARM; else "15yr_fixed" for a term of 180 months or fewer; else "30yr_fixed" (also when no
//              term is known).
//   given    - true when an ARM or a term was found, or the text says "fixed". False means this is only the default, so an
//              update must not overwrite a loan type already on file with it.
//   flag     - a plain-English note when the loan is priced as something it is not ("20-year fixed priced as a 30-year",
//              "7/1 ARM priced as a 5/1"), else null.
// The term column wins over a term in the text. An ARM's term is ignored: it is priced as a 5/1 whatever the term is.
function mapLoanType({ termMonths, amortization } = {}) {
  const text = typeof amortization === "string" ? amortization : "";
  if (ARM_RE.test(text)) {
    const ratio = ARM_RATIO_RE.exec(text);
    const flag = ratio && Number(ratio[1]) !== 5 ? `${Number(ratio[1])}/${Number(ratio[2])} ARM priced as a 5/1` : null;
    return { loanType: "5_1_arm", given: true, flag };
  }
  const term = pos(termMonths) ? termMonths : termFromText(amortization);
  const loanType = term !== null && term <= FIFTEEN_YEAR_MONTHS ? "15yr_fixed" : "30yr_fixed";
  const given = term !== null || FIXED_RE.test(text);
  let flag = null;
  if (term !== null && term !== FIFTEEN_YEAR_MONTHS && term !== THIRTY_YEAR_MONTHS) {
    flag = `${Math.round(term / 12)}-year fixed priced as a ${loanType === "15yr_fixed" ? "15" : "30"}-year`;
  }
  return { loanType, given, flag };
}

module.exports = { firstPaymentFromClosing, paymentsMade, estimateBalance, mapLoanType };
