"use strict";
// What mortgage insurance a loan carries today and when it ends. Pure: no DB, no network, `today` is a parameter.
// A typed monthly amount is used as is. Otherwise FHA and USDA are estimated from the closing date (a stand-in for the case
// number date), leaning low; conventional, jumbo and VA are never estimated. See spec section 4.4.

const { calcPayment } = require("./refi");
const { firstPaymentFromClosing } = require("./intake/loan");

const DAY_MS = 86400000;
const BOUNDARY_GRACE_DAYS = 90;
const FHA_ESTIMATE_FROM = "2013-09-01";
const FHA_END_MAX_LTV = 90;
const FHA_END_YEARS = 11;
const CONV_END_FRACTION = 0.78;

// Annual rate in percent, in effect from `from`. FHA uses the lower LTV tier (LTV is unknown for an estimate).
const FHA_LONG = [["2013-06-03", 1.3], ["2015-01-26", 0.8], ["2023-03-20", 0.5]];
const FHA_SHORT = [["2013-06-03", 0.45], ["2015-01-26", 0.45], ["2023-03-20", 0.15]];
const USDA = [["2011-10-01", 0.3], ["2012-10-01", 0.4], ["2013-10-01", 0.5], ["2016-10-01", 0.35]];

const num = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => num(v) && v > 0;
const cents = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const day = (s) => Date.parse(s + "T00:00:00Z");

function addMonths(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

// The rate for a closing date; within 90 days after a boundary, the lower of the band before and the band after.
// `before` is the rate of the band that precedes the first one (null: none, so the first band has no lowering).
function bandRate(bands, closeDate, before) {
  const t = day(closeDate);
  let i = -1;
  for (let k = 0; k < bands.length; k++) if (t >= day(bands[k][0])) i = k;
  if (i < 0) return null;
  const rate = bands[i][1];
  const prev = i > 0 ? bands[i - 1][1] : before;
  if (prev != null && t - day(bands[i][0]) < (BOUNDARY_GRACE_DAYS + 1) * DAY_MS) return Math.min(rate, prev);
  return rate;
}

// The first payment date on which the scheduled balance is at or under 78% of the original value, or null.
function seventyEightDate(c) {
  const years = c.loanType === "15yr_fixed" ? 15 : 30;
  const first = firstPaymentFromClosing(c.closeDate);
  if (!first || !pos(c.currentRate) || !pos(c.originalAmount) || !pos(c.originalValue)) return null;
  const pmt = calcPayment(c.originalAmount, c.currentRate, years);
  let bal = c.originalAmount;
  for (let n = 1; n <= years * 12; n++) {
    bal = bal * (1 + c.currentRate / 1200) - pmt;
    if (bal <= CONV_END_FRACTION * c.originalValue) return addMonths(first, n - 1);
  }
  return null;
}

function currentMi(c, balance, today) {
  const program = c.loanProgram || "";
  const originalLtv = pos(c.originalAmount) && pos(c.originalValue) ? round4((c.originalAmount / c.originalValue) * 100) : null;
  const out = { monthly: null, annualRate: null, basis: "unknown", endsOn: null, endsReason: null, originalLtv };

  if (program === "fha" && c.closeDate && originalLtv != null && originalLtv <= FHA_END_MAX_LTV) {
    out.endsOn = addMonths(c.closeDate, FHA_END_YEARS * 12);
    out.endsReason = "11_years";
  } else if ((program === "conventional" || program === "jumbo") && num(c.monthlyMi) && c.monthlyMi > 0) {
    const d = seventyEightDate(c);
    if (d) { out.endsOn = d; out.endsReason = "78_percent"; }
  }

  if (num(c.monthlyMi)) {
    out.monthly = cents(c.monthlyMi);
    out.basis = "typed";
    out.annualRate = pos(balance) ? round4((c.monthlyMi * 12 / balance) * 100) : null;
    return out;
  }
  if (program === "va") return { ...out, monthly: 0, annualRate: 0, basis: "none" };
  if (program === "conventional" || program === "jumbo") return { ...out, basis: "none" };

  let rate = null;
  if (program === "fha" && c.closeDate && day(c.closeDate) >= day(FHA_ESTIMATE_FROM)) {
    rate = bandRate(c.loanType === "15yr_fixed" ? FHA_SHORT : FHA_LONG, c.closeDate, null);
  } else if (program === "usda" && c.closeDate) {
    rate = bandRate(USDA, c.closeDate, 0) ?? 0;
  }
  if (rate == null || !pos(balance)) return out;
  return { ...out, monthly: cents((balance * rate) / 1200), annualRate: rate, basis: rate === 0 ? "none" : "estimated" };
}

// True when the insurance ends on or before `months` months from today (an end date already past counts).
function endsWithinMonths(mi, today, months) {
  if (!mi || !mi.endsOn) return false;
  return day(mi.endsOn) <= day(addMonths(today, months));
}

module.exports = { currentMi, endsWithinMonths };
