"use strict";
// Today's balance and value for a client (spec 4.3). Pure: `today` is always a "YYYY-MM-DD" parameter.
const { firstPaymentFromClosing } = require("./intake/loan");
const { calcPayment } = require("./refi");
const hpi = require("./hpi");

const CAUTION_CUT = 0.10;
const TYPED_FRESH_MONTHS = 12;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parts(d) {
  const m = DATE_RE.exec(String(d || ""));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
// Whole months from a to b (negative when b is before a); null if either date is unreadable.
function monthsBetween(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return null;
  let n = (y.y - x.y) * 12 + (y.m - x.m);
  if (n > 0 && y.d < x.d) n -= 1;
  else if (n < 0 && y.d > x.d) n += 1;
  return n;
}

function balanceToday(c, today) {
  const stored = { balance: c.loanBalance, asOf: c.balanceAsOf || null, basis: "stored" };
  const bal = Number(c.loanBalance), rate = Number(c.currentRate);
  if (!(bal > 0) || !(rate > 0) || !parts(c.balanceAsOf) || !parts(today)) return stored;
  const first = firstPaymentFromClosing(c.closeDate);
  if (!first) return stored;
  const term = c.loanType === "15yr_fixed" ? 180 : 360;
  const elapsed = Math.max(0, monthsBetween(first, c.balanceAsOf) || 0);
  const remaining = Math.max(1, term - elapsed);
  const k = monthsBetween(c.balanceAsOf, today);
  if (k === null || k <= 0) return stored;
  const pmt = calcPayment(bal, rate, remaining / 12);
  const r = rate / 100 / 12;
  const g = Math.pow(1 + r, k);
  const rolled = bal * g - pmt * ((g - 1) / r);
  return { balance: Math.max(0, Math.round(rolled)), asOf: today, basis: "rolled" };
}

function valueToday(c, today, index = hpi.defaultIndex) {
  const value = Number(c.propertyValue);
  const asOf = c.valueAsOf || null;
  const typed = String(c.editedByHand || "").split(/[\s,]+/).includes("property_value");
  const age = monthsBetween(asOf, today);
  if (typed && age !== null && age <= TYPED_FRESH_MONTHS) {
    return { value, cautious: value, asOf, basis: "typed", growthPct: null, area: null };
  }
  const g = asOf ? index.growth(c.propertyZip, asOf, today) : null;
  if (!g) {
    return { value, cautious: Math.round(value * (1 - CAUTION_CUT)), asOf, basis: "flat", growthPct: null, area: null };
  }
  const grown = Math.round(value * g.factor);
  return {
    value: grown,
    cautious: Math.round(grown * (1 - CAUTION_CUT)),
    asOf,
    basis: "grown",
    growthPct: Math.round((g.factor - 1) * 100),
    area: g.area,
  };
}

module.exports = { balanceToday, valueToday, CAUTION_CUT, TYPED_FRESH_MONTHS };
