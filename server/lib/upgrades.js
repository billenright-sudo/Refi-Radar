"use strict";
// The five upgrade checks (spec 4.6): FHA → Conventional, Drop PMI, FHA Streamline, VA IRRRL, USDA → Conventional. Pure: no DB, no
// network, `today` is a "YYYY-MM-DD" parameter. Bill's anti-goal is flagging a client who doesn't qualify, so whenever a condition
// can't be confirmed the check doesn't flag (spec 3.3). Every lens carries its reason line (`detail`), and every figure in it is
// also a number field on the lens.

const { analyze, calcPayment, estClosingCosts, PRIORITY_RANK, impact } = require("./refi");
const { balanceToday, valueToday } = require("./equity");
const { currentMi, endsWithinMonths } = require("./mortgageInsurance");
const { firstPaymentFromClosing } = require("./intake/loan");
const hpi = require("./hpi");

const CONV_MIN_SCORE = 620;         // known score for a conventional refi
const STREAMLINE_MIN_SCORE = 580;   // known score for an FHA or VA streamline
const MAX_BREAK_EVEN = 36;          // months to recover the new loan's costs
const HIGH_SAVINGS = 200;           // $/mo for a "high" refi upgrade
const NTB_MIN_DROP = 0.5;           // points: HUD's net tangible benefit, and the VA rate drop
const FHA_UFMIP = 0.0175;           // upfront FHA insurance on a streamline (no refund credit: leans high)
const FHA_NEW_ANNUAL_MIP = 0.55;    // % a year: today's FHA annual insurance at its top tier
const VA_FUNDING_FEE = 0.005;       // IRRRL funding fee, counted as a cost
const MI_ENDING_SOON_MONTHS = 12;   // insurance ending on its own this soon: no refi upgrade
const CONV_MAX_LTV = 80;            // today's LTV for a conventional refi; and for Drop PMI after 5 years
const WAITING_DAYS = 210;           // streamline seasoning
const FHA_SEASON_MONTHS = 6;        // FHA: 6 full months since the first payment
const VA_SEASON_MONTHS = 5;         // VA: 6 payments made = the first payment + 5 months
const PMI_ORIGINAL_FRACTION = 0.8;  // Drop PMI on the original value
const PMI_SEASONED_LTV = 75;        // Drop PMI on today's value, 2 to 5 years after closing
const PMI_SEASONED_MONTHS = 24;
const PMI_LONG_MONTHS = 60;

const GAPS = {
  program: "Add the loan program to check upgrades.",
  credit: "Add a credit score to check upgrades.",
  zip: "Add the property ZIP to check home value growth.",
  mi: "Add the monthly mortgage insurance to check whether PMI can be dropped.",
  close: "Add the original close date to check upgrades.",
  investment: "Investment property: upgrades aren't checked.",
};

const PROGRAMS = new Set(["conventional", "fha", "va", "usda", "jumbo"]);
const REFI_PROGRAMS = new Set(["fha", "va", "usda"]);
const PMI_PROGRAMS = new Set(["conventional", "jumbo"]);

const DAY_MS = 86400000;
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => fin(v) && v > 0;
const orNull = (v) => (fin(v) ? v : null);
const numOrNull = (v) => (v == null || v === "" ? null : orNull(Number(v)));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) => Math.round(n).toLocaleString("en-US");
const rate2 = (n) => r2(n).toFixed(2);
const day = (s) => Date.parse(s + "T00:00:00Z");
const addDays = (iso, n) => new Date(day(iso) + n * DAY_MS).toISOString().slice(0, 10);
function addMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}
// Whole months from a to b (both real "YYYY-MM-DD" days).
function monthsBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  let n = (by - ay) * 12 + (bm - am);
  if (n > 0 && bd < ad) n -= 1;
  return n;
}
const later = (a, b) => (a > b ? a : b);
// The HUD and VA rate tests compare to 0.5 points; float noise (7.4 - 6.9 = 0.4999…) must not decide them.
const points = (n) => Math.round(n * 1e6) / 1e6;

// Today's balance and value (spec 4.3), with the stored figures they started from. `ltv` is 1 decimal for display; the checks
// use `rawLtv`.
function todayBlock(c, today, index) {
  const b = balanceToday(c, today);
  const v = valueToday(c, today, index);
  const balance = orNull(Number(b.balance));
  const cautiousValue = orNull(v.cautious);
  const rawLtv = pos(balance) && pos(cautiousValue) ? (balance / cautiousValue) * 100 : null;
  return {
    t: {
      balance, balanceFrom: numOrNull(c.loanBalance), balanceAsOf: c.balanceAsOf || null, balanceBasis: b.basis,
      value: orNull(v.value), valueFrom: numOrNull(c.propertyValue), cautiousValue, valueAsOf: c.valueAsOf || null,
      valueBasis: v.basis, growthPct: v.growthPct, ltv: rawLtv == null ? null : r1(rawLtv),
    },
    rawLtv,
  };
}

const refiPriority = (savings) => (savings >= HIGH_SAVINGS ? "high" : "medium");
// Months to recover `costs`, or null when there's no saving or it takes longer than the bar.
function breakEvenWithin(costs, savings) {
  if (!(savings > 0)) return null;
  const be = Math.ceil(costs / savings);
  return be <= MAX_BREAK_EVEN ? be : null;
}

// 1 and 5: FHA or USDA to a conventional loan, leaving the insurance (or the USDA annual fee) behind.
function govToConv(x, rates) {
  const { c, program, score, scoreKnown, rate, t, rawLtv, mi, today } = x;
  if (!scoreKnown || !(score >= CONV_MIN_SCORE)) return null;
  if (!(mi && mi.monthly > 0) || endsWithinMonths(mi, today, MI_ENDING_SOON_MONTHS)) return null;
  if (!(rawLtv <= CONV_MAX_LTV)) return null;
  const a = analyze({
    loanType: c.loanType === "15yr_fixed" ? "15yr_fixed" : "30yr_fixed",
    currentRate: rate, loanBalance: t.balance, propertyValue: t.cautiousValue, creditScore: score,
  }, rates);
  if (!a) return null;
  const savings = a.curPmt + mi.monthly - a.newPmt;
  const be = breakEvenWithin(estClosingCosts(t.balance), savings);
  if (be == null) return null;
  const fha = program === "fha";
  const ltv = t.ltv, miMonthly = Math.round(mi.monthly), monthlySavings = Math.round(savings), effRate = r2(a.effRate);
  return {
    lens: fha ? "fha_to_conv" : "usda_to_conv", label: fha ? "FHA → Conventional" : "USDA → Conventional",
    priority: refiPriority(savings), headline: monthlySavings, unit: "$/mo",
    detail: `${fha ? "FHA" : "USDA"}, about ${Math.round(ltv)}% of value, ${fha ? "insurance" : "fee"} about $${money(miMonthly)}/mo; ` +
      `conventional at ${rate2(effRate)}% saves about $${money(monthlySavings)}/mo, break-even ${be} mo`,
    monthlySavings, breakEven: be, effRate, ltv, miMonthly,
  };
}

// 3: FHA streamline. Old insurance leans low (unknown counts as none); the new loan pays today's top-tier annual insurance and the
// upfront insurance as a cost.
function fhaStreamline(x, rates) {
  const { c, score, scoreKnown, rate, t, mi, first, today } = x;
  if (c.loanType !== "30yr_fixed" || !scoreKnown || !(score >= STREAMLINE_MIN_SCORE)) return null;
  const fhaRate = rates && rates.rate_30yr_fha;
  if (!pos(fhaRate)) return null;
  if (today < later(addDays(c.closeDate, WAITING_DAYS), addMonths(first, FHA_SEASON_MONTHS))) return null;
  const oldMiRate = (mi && mi.annualRate) ?? 0;
  if (points(rate + oldMiRate - (fhaRate + FHA_NEW_ANNUAL_MIP)) < NTB_MIN_DROP) return null;
  const oldPmt = calcPayment(t.balance, rate, 30) + ((mi && mi.monthly) ?? 0);
  const newPmt = calcPayment(t.balance, fhaRate, 30) + (t.balance * (FHA_NEW_ANNUAL_MIP / 100)) / 12;
  const savings = oldPmt - newPmt;
  const be = breakEvenWithin(estClosingCosts(t.balance) + FHA_UFMIP * t.balance, savings);
  if (be == null) return null;
  const monthlySavings = Math.round(savings);
  return {
    lens: "fha_streamline", label: "FHA Streamline", priority: refiPriority(savings), headline: monthlySavings, unit: "$/mo",
    detail: `FHA ${rate2(rate)}% → about ${rate2(fhaRate)}% FHA, saves about $${money(monthlySavings)}/mo, break-even ${be} mo (upfront FHA insurance counted)`,
    monthlySavings, breakEven: be, effRate: r2(fhaRate), currentRate: r2(rate), ltv: t.ltv,
  };
}

// 4: VA IRRRL, with the funding fee counted as a cost.
function vaIrrrl(x, rates) {
  const { c, score, scoreKnown, rate, t, first, today } = x;
  if (c.loanType !== "30yr_fixed" || !scoreKnown || !(score >= STREAMLINE_MIN_SCORE)) return null;
  const vaRate = rates && rates.rate_30yr_va;
  if (!pos(vaRate)) return null;
  if (today < later(addDays(first, WAITING_DAYS), addMonths(first, VA_SEASON_MONTHS))) return null;
  if (points(rate - vaRate) < NTB_MIN_DROP) return null;
  const savings = calcPayment(t.balance, rate, 30) - calcPayment(t.balance, vaRate, 30);
  const be = breakEvenWithin(estClosingCosts(t.balance) + VA_FUNDING_FEE * t.balance, savings);
  if (be == null) return null;
  const monthlySavings = Math.round(savings);
  return {
    lens: "va_irrrl", label: "VA IRRRL", priority: refiPriority(savings), headline: monthlySavings, unit: "$/mo",
    detail: `VA ${rate2(rate)}% → about ${rate2(vaRate)}% VA, saves about $${money(monthlySavings)}/mo, break-even ${be} mo`,
    monthlySavings, breakEven: be, effRate: r2(vaRate), currentRate: r2(rate), ltv: t.ltv,
  };
}

// 2: Drop PMI, only with a typed or imported monthly figure (an estimate can't tell lender-paid or single-premium MI). Path
// "original" carries the share of the original value it used as `originalLtv`.
function dropPmi(x) {
  const { c, t, rawLtv, mi, today } = x;
  if (!(fin(c.monthlyMi) && c.monthlyMi > 0)) return null;
  if (mi && mi.endsOn && mi.endsOn <= today) return null; // the scheduled balance reached 78%: it ended on its own
  const originalValue = numOrNull(c.originalValue);
  let path = null, originalLtv = null;
  if (pos(originalValue) && t.balance <= PMI_ORIGINAL_FRACTION * originalValue) {
    path = "original";
    originalLtv = r1((t.balance / originalValue) * 100);
  } else {
    const months = monthsBetween(c.closeDate, today);
    if ((months >= PMI_SEASONED_MONTHS && months < PMI_LONG_MONTHS && rawLtv <= PMI_SEASONED_LTV) ||
        (months >= PMI_LONG_MONTHS && rawLtv <= CONV_MAX_LTV)) path = "current";
  }
  if (!path) return null;
  const miMonthly = Math.round(c.monthlyMi);
  const share = path === "original" ? `${Math.round(originalLtv)}% of the original value` : `${Math.round(t.ltv)}% of value`;
  return {
    lens: "drop_pmi", label: "Drop PMI", priority: "low", headline: miMonthly, unit: "$/mo",
    detail: `Conventional, about ${share}, PMI $${money(miMonthly)}/mo: they can ask their lender to remove it`,
    ltv: t.ltv, miMonthly, path, ...(path === "original" ? { originalLtv } : {}),
  };
}

function upgradesFor(c, rates, today, { index } = {}) {
  const { t, rawLtv } = todayBlock(c, today, index || hpi.defaultIndex);
  const first = firstPaymentFromClosing(c.closeDate); // null for a missing or malformed close date
  const mi = first ? currentMi(c, t.balance, today) : null;
  const done = (gaps, lenses = []) => ({ lenses, gaps, today: t, mi });

  if (c.occupancy === "investment") return done([GAPS.investment]);
  const program = PROGRAMS.has(c.loanProgram) ? c.loanProgram : "";
  if (!program) return done([GAPS.program]);

  const scoreKnown = c.creditScoreKnown === true || c.creditScoreKnown === 1;
  const originalLtv = pos(numOrNull(c.originalAmount)) && pos(numOrNull(c.originalValue))
    ? (Number(c.originalAmount) / Number(c.originalValue)) * 100 : null;
  const gaps = [];
  if (REFI_PROGRAMS.has(program) && !scoreKnown) gaps.push(GAPS.credit);
  if (!/^\d{5}(-\d{4})?$/.test(String(c.propertyZip == null ? "" : c.propertyZip).trim())) gaps.push(GAPS.zip);
  if (PMI_PROGRAMS.has(program) && !fin(c.monthlyMi) && !(originalLtv != null && originalLtv <= CONV_MAX_LTV)) gaps.push(GAPS.mi);
  if (!first) gaps.push(GAPS.close);

  const rate = Number(c.currentRate);
  if (!first || !pos(rate) || !pos(t.balance) || !pos(t.cautiousValue)) return done(gaps);

  const x = { c, program, score: Number(c.creditScore), scoreKnown, rate, t, rawLtv, mi, first, today };
  const found = program === "fha" ? [govToConv(x, rates), fhaStreamline(x, rates)]
    : program === "usda" ? [govToConv(x, rates)]
    : program === "va" ? [vaIrrrl(x, rates)]
    : [dropPmi(x)];
  const lenses = found.filter(Boolean);
  lenses.sort((p, q) => (PRIORITY_RANK[q.priority] - PRIORITY_RANK[p.priority]) || (impact(q) - impact(p)));
  return done(gaps, lenses);
}

module.exports = {
  upgradesFor, GAPS,
  CONV_MIN_SCORE, STREAMLINE_MIN_SCORE, MAX_BREAK_EVEN, HIGH_SAVINGS, NTB_MIN_DROP, FHA_UFMIP, FHA_NEW_ANNUAL_MIP,
  VA_FUNDING_FEE, MI_ENDING_SOON_MONTHS, CONV_MAX_LTV, WAITING_DAYS,
};
