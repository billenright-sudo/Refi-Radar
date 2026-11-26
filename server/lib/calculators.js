"use strict";
// Shared calculator math for Charlie. The text between the markers is identical in client/src/calculators.mjs
// (server/test/calculators.test.js holds the two equal); edit both or neither.
const { calcPayment, estClosingCosts } = require("./refi");
const { pmiMonthly } = require("./pmi");

// ---- calculators: shared math begin ----
// The four calculators (payment, refi break-even, blended rate, buydown). This text is kept
// identical in server/lib/calculators.js and client/src/calculators.mjs; edit both or neither.
// Plain functions and constants only. Callers parse; a blank is null, never a string.
const CALC_LIMITS = { amountMax: 50000000, rateMax: 20, termMin: 1, termMax: 40, monthsMax: 480, scoreMin: 300, scoreMax: 850, pointsMax: 20 };

const CALC_LINES = {
  estimate: "Estimate for your own use only. This is not a Loan Estimate, a rate quote or an offer of credit.",
  estimateTag: "estimate",
  notEntered: "not entered",
  currentPaymentLabel: "worked out from the balance, rate and months left",
  costsInLoan: "Costs are in the new loan, so the new payment already includes them. Break-even is the cautious figure.",
  longRun: (x) => `Lower payment, higher total: restarting the clock costs ${x} more over the life of the loan than keeping the current loan.`,
  noSavings: "The new payment isn't lower, so the costs are never earned back.",
  tooLate: "Break-even comes after the current loan would have been paid off.",
  noCosts: "No costs entered",
  moreAMonth: (x) => `${x} more a month`,
  cashNeeded: "Enter the cash needed.",
  helocNote: "Worked as a fixed rate paid off over the term. A HELOC's rate can change, and an interest-only draw period changes the payment.",
  helocInterestOnly: (x) => `Interest-only payment on the second: ${x} a month`,
  termTooShort: "The term must be at least as long as the buydown.",
  noteTooLow: "The note rate is too low for this buydown.",
  pointsNotLower: "The rate with points must be lower than the rate without.",
  noCost: "No cost entered",
  pointsNever: "The savings don't cover the cost of the points within the term.",
  amount: "Enter an amount above $0, up to $50,000,000.",
  optionalAmount: "Enter an amount from $0 to $50,000,000.",
  rate: "Enter a rate from 0% to 20%.",
  term: "Enter a term from 1 to 40 years.",
  compareYears: "Enter from 1 to 40 years.",
  monthsLeft: "Enter months left from 1 to 480.",
  score: "Enter a credit score from 300 to 850.",
  points: "Enter points from 0 to 20.",
};

const roundCents = (n) => Math.round(n * 100) / 100;
const roundDollars = (n) => Math.round(n);
const roundRate = (r) => Math.round(r * 1000) / 1000;

// Balance still owed after `paid` payments, unrounded; 0 once `paid` reaches the term.
const remainingBalance = (p, rate, years, paid) => {
  const n = years * 12;
  if (paid >= n) return 0;
  if (rate === 0) return p - (p / n) * paid;
  const r = rate / 1200, pay = calcPayment(p, rate, years), g = Math.pow(1 + r, paid);
  return p * g - (pay * (g - 1)) / r;
};

const fmtCents = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDollars = (n) => "$" + Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtAmount = (n) => (Number.isInteger(n) ? fmtDollars(n) : fmtCents(n));
const fmtRate = (r) => `${Number(r.toFixed(3))}%`;
const fmtBlended = (r) => `${r.toFixed(3)}%`;
const possessive = (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

// Is `v` a good value of this kind? Only real numbers pass; strings and NaN never do.
const calcValueOk = (v, kind) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const L = CALC_LIMITS;
  switch (kind) {
    case "amount": case "cash": return v > 0 && v <= L.amountMax;
    case "optionalAmount": return v >= 0 && v <= L.amountMax;
    case "rate": return v >= 0 && v <= L.rateMax;
    case "term": case "compareYears": return Number.isInteger(v) && v >= L.termMin && v <= L.termMax;
    case "months": return Number.isInteger(v) && v >= 1 && v <= L.monthsMax;
    case "score": return v >= L.scoreMin && v <= L.scoreMax;
    case "points": return v >= 0 && v <= L.pointsMax;
    default: return false;
  }
};
const CALC_KIND_LINE = { amount: "amount", optionalAmount: "optionalAmount", rate: "rate", term: "term", months: "monthsLeft",
  score: "score", points: "points", compareYears: "compareYears" };
const calcLineFor = (v, kind) => (kind === "cash" ? (v > CALC_LIMITS.amountMax ? CALC_LINES.amount : CALC_LINES.cashNeeded) : CALC_LINES[CALC_KIND_LINE[kind]]);

// specs: [field, kind, required][] in input order. Returns a refusal ({ ok:false, errors, missing }) or null.
const checkFields = (input, specs) => {
  const errors = {}, missing = [];
  for (const [field, kind, required] of specs) {
    const v = input[field];
    if (v === null || v === undefined) { if (required) missing.push(field); continue; }
    if (!calcValueOk(v, kind)) errors[field] = calcLineFor(v, kind);
  }
  return Object.keys(errors).length || missing.length ? { ok: false, errors, missing } : null;
};
const calcOk = (inputs, parts) => ({ ok: true, inputs, defaulted: [], estimated: {}, warnings: [], notes: [], notEntered: [], ...parts });
const orDefault = (v, d) => (v === null || v === undefined ? d : v);

const paymentCalc = (input) => {
  const bad = checkFields(input, [
    ["loanAmount", "amount", true], ["rate", "rate", true], ["termYears", "term", false],
    ["taxesYearly", "optionalAmount", false], ["insuranceYearly", "optionalAmount", false],
    ["miMonthly", "optionalAmount", false], ["hoaMonthly", "optionalAmount", false],
    ["homeValue", "amount", false], ["creditScore", "score", false],
  ]);
  if (bad) return bad;
  const defaulted = [], estimated = {}, notEntered = [];
  const termYears = orDefault(input.termYears, 30);
  if (input.termYears == null) defaulted.push("termYears");
  const taxesYearly = orDefault(input.taxesYearly, 0), insuranceYearly = orDefault(input.insuranceYearly, 0);
  const hoaMonthly = orDefault(input.hoaMonthly, 0);
  if (input.taxesYearly == null) notEntered.push("taxes");
  if (input.insuranceYearly == null) notEntered.push("insurance");
  let mi = orDefault(input.miMonthly, 0);
  if (input.miMonthly == null) {
    const ltv = input.homeValue != null ? input.loanAmount / input.homeValue * 100 : null;
    if (ltv !== null && input.creditScore != null && ltv > 80) {
      mi = pmiMonthly(input.creditScore, ltv, termYears, input.loanAmount);
      estimated.mi = true;
    } else notEntered.push("mi");
  }
  if (input.hoaMonthly == null) notEntered.push("hoa");
  const pi = roundCents(calcPayment(input.loanAmount, input.rate, termYears));
  const taxes = roundCents(taxesYearly / 12), insurance = roundCents(insuranceYearly / 12);
  const out = { pi, taxes, insurance, mi, hoa: hoaMonthly, total: roundCents(pi + taxes + insurance + mi + hoaMonthly) };
  return calcOk({ ...input, termYears, taxesYearly, insuranceYearly, miMonthly: mi, hoaMonthly }, { defaulted, estimated, notEntered, out });
};
// ---- calculators: shared math end ----

module.exports = {
  CALC_LIMITS, CALC_LINES, roundCents, roundDollars, roundRate, remainingBalance, fmtCents, fmtDollars, fmtAmount, fmtRate, fmtBlended, possessive, paymentCalc,
};
