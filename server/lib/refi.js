"use strict";
/**
 * Deterministic refinance / opportunity engine — the brain behind "Sweeps".
 * No LLM, no network: pure math on a client record + a current-rates object.
 * Ported from client/src/App.jsx analyze() and extended with the Phase-1 lenses
 * (rate & term, cash-out, ARM→fixed, term swap) plus the 6-month check-in rule.
 *
 * A "rates" object looks like:
 *   { rate_30yr_fixed, rate_15yr_fixed, rate_5_1_arm, rate_30yr_top_tier? }
 * A "client" looks like a DB row: { id, name, loanType, currentRate, loanBalance,
 *   propertyValue, creditScore, close_date, last_contact, created_at }.
 */

// ── Config / thresholds ──────────────────────────────────────────────────────
const CASH_OUT_FLOOR = 40000;   // min tappable equity to flag a cash-out opportunity
const CHECK_IN_MONTHS = 6;      // relationship check-in cadence
const TERM30_RELIEF_MIN = 150;  // min $/mo drop to suggest 15→30 for cash flow

// ── Primitives (ported verbatim from App.jsx) ────────────────────────────────
const calcPayment = (p, annualRate, years) => {
  const r = annualRate / 100 / 12, n = years * 12;
  if (r === 0) return p / n;
  return p * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
};

const LLPA_LTV_BREAKS = [30, 60, 70, 75, 80, 85, 90, 95];
const LLPA_GRID = [
  [780, [0, 0, 0, 0, 0.375, 0.375, 0.25, 0.25, 0.125]],
  [760, [0, 0, 0, 0.25, 0.625, 0.625, 0.5, 0.5, 0.25]],
  [740, [0, 0, 0.125, 0.375, 0.875, 1.0, 0.75, 0.625, 0.5]],
  [720, [0, 0, 0.25, 0.75, 1.25, 1.25, 1.0, 0.875, 0.75]],
  [700, [0, 0, 0.375, 0.875, 1.375, 1.5, 1.25, 1.125, 0.875]],
  [680, [0, 0, 0.625, 1.125, 1.75, 1.875, 1.5, 1.375, 1.125]],
  [660, [0, 0, 0.75, 1.375, 1.875, 2.125, 1.75, 1.625, 1.25]],
  [640, [0, 0, 1.125, 1.5, 2.25, 2.5, 2.0, 1.875, 1.5]],
  [0, [0, 0.125, 1.5, 2.125, 2.75, 3.0, 2.5, 2.25, 1.75]],
];
const llpaPrice = (creditScore, ltv) => {
  const score = creditScore || 700;
  const row = LLPA_GRID.find(([floor]) => score >= floor)[1];
  let col = LLPA_LTV_BREAKS.findIndex((b) => ltv <= b);
  if (col === -1) col = LLPA_LTV_BREAKS.length;
  return row[col];
};
const roundEighth = (x) => Math.round(x / 0.125) * 0.125;
const LLPA_TOP_TIER_EMBEDDED = 0.25;
const estClosingCosts = (balance) => 2500 + balance * 0.01;

// Normalize a camelCase/ snake_case client record into the fields the math needs.
function norm(c) {
  return {
    id: c.id,
    name: c.name,
    loanType: c.loanType || c.loan_type,
    currentRate: Number(c.currentRate != null ? c.currentRate : c.current_rate),
    loanBalance: Number(c.loanBalance != null ? c.loanBalance : c.loan_balance),
    propertyValue: Number(c.propertyValue != null ? c.propertyValue : c.property_value),
    creditScore: c.creditScore != null ? c.creditScore : c.credit_score,
    closeDate: c.closeDate || c.close_date || "",
    lastContact: c.lastContact || c.last_contact || "",
    createdAt: c.createdAt || c.created_at || "",
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
const money = (n) => Math.round(n).toLocaleString("en-US");

// ── Core rate & term analysis (ported verbatim) ──────────────────────────────
function analyze(client, rates) {
  if (!rates) return null;
  const rMap = { "30yr_fixed": rates.rate_30yr_fixed, "15yr_fixed": rates.rate_15yr_fixed, "5_1_arm": rates.rate_5_1_arm };
  const mktRate = rMap[client.loanType];
  if (!mktRate) return null;
  const years = client.loanType === "15yr_fixed" ? 15 : 30;
  const ltv = (client.loanBalance / client.propertyValue) * 100;
  const score = client.creditScore || 700;
  const priceHit = llpaPrice(score, ltv);

  const topTier = client.loanType === "30yr_fixed" ? rates.rate_30yr_top_tier : null;
  let base, baseLabel, rateAdj;
  if (topTier) {
    const isTopTier = score >= 740 && ltv <= 80;
    base = topTier;
    baseLabel = "top-tier";
    rateAdj = isTopTier ? 0 : roundEighth(Math.max(0, priceHit - LLPA_TOP_TIER_EMBEDDED) / 4);
  } else {
    base = mktRate;
    baseLabel = "market";
    rateAdj = roundEighth(priceHit / 4);
  }
  const effRate = base + rateAdj;
  const rateDelta = client.currentRate - effRate;
  const curPmt = calcPayment(client.loanBalance, client.currentRate, years);
  const newPmt = calcPayment(client.loanBalance, effRate, years);
  const monthlySavings = curPmt - newPmt;
  const annualSavings = monthlySavings * 12;
  const closingCosts = estClosingCosts(client.loanBalance);
  const breakEven = monthlySavings > 0 ? Math.ceil(closingCosts / monthlySavings) : 9999;
  const good = rateDelta >= 0.5 && breakEven <= 36 && monthlySavings > 0 && ltv <= 95;
  return { mktRate, base, baseLabel, effRate, rateAdj, rateDelta, curPmt, newPmt, monthlySavings, annualSavings, closingCosts, breakEven, ltv, good, priority: good ? (rateDelta >= 1.0 ? "high" : "medium") : "low" };
}

// ── Lenses — each returns a normalized opportunity or null ───────────────────
function rateTerm(c, rates) {
  if (c.loanType === "5_1_arm") return null; // ARMs are routed to the ARM→fixed lens
  const a = analyze(c, rates);
  if (!a || !a.good) return null;
  return {
    lens: "rate_term", label: "Rate & Term", priority: a.priority,
    headline: Math.round(a.monthlySavings), unit: "$/mo",
    detail: `Drop ~${a.rateDelta.toFixed(2)}% to ${a.effRate.toFixed(2)}% → save ~$${money(a.monthlySavings)}/mo, break-even ${a.breakEven} mo`,
    monthlySavings: Math.round(a.monthlySavings), rateDelta: r2(a.rateDelta), breakEven: a.breakEven, effRate: r2(a.effRate),
  };
}

function cashOut(c) {
  const value = c.propertyValue, balance = c.loanBalance;
  if (!(value > 0) || !(balance > 0)) return null;
  const maxLoan = 0.80 * value;
  const gross = maxLoan - balance; // cash available to 80% LTV, before costs
  if (gross < CASH_OUT_FLOOR) return null;
  const ltv = (balance / value) * 100;
  return {
    lens: "cash_out", label: "Cash-Out", priority: gross >= 100000 ? "high" : "medium",
    headline: Math.round(gross), unit: "$",
    detail: `~$${money(gross)} tappable to 80% LTV (est. on origination value — verify)`,
    cashAvailable: Math.round(gross), currentLtv: r1(ltv),
  };
}

function armToFixed(c, rates) {
  if (c.loanType !== "5_1_arm") return null;
  const a = analyze({ ...c, loanType: "30yr_fixed" }, rates);
  if (!a) return null;
  const save = a.monthlySavings;
  const priority = a.rateDelta >= 0.5 ? "high" : "medium"; // ARMs carry reset risk → at least medium
  return {
    lens: "arm_to_fixed", label: "ARM → Fixed", priority,
    headline: Math.round(save), unit: "$/mo",
    detail: save > 0
      ? `Lock a fixed rate (~${a.effRate.toFixed(2)}%) before the ARM adjusts — ~$${money(save)}/mo`
      : `Lock a fixed rate (~${a.effRate.toFixed(2)}%) before the ARM adjusts — reset risk`,
    effRate: r2(a.effRate), monthlySavings: Math.round(save),
  };
}

function termSwap(c, rates) {
  const score = c.creditScore || 700;
  const ltv = (c.loanBalance / c.propertyValue) * 100;
  if (c.loanType === "30yr_fixed") {
    const eff15 = rates.rate_15yr_fixed + roundEighth(llpaPrice(score, ltv) / 4);
    if (eff15 > c.currentRate + 1e-9) return null; // only if they can get a 15yr at/under today's rate
    const cur = calcPayment(c.loanBalance, c.currentRate, 30);
    const new15 = calcPayment(c.loanBalance, eff15, 15);
    const pmtDelta = new15 - cur; // usually higher payment, shorter term
    return {
      lens: "term_swap", label: "Term Swap", priority: "medium",
      headline: r2(eff15), unit: "%",
      detail: `15-yr refi at ~${eff15.toFixed(2)}% — pay off ~15 yrs sooner${pmtDelta <= 50 ? " at about the same payment" : `, +$${money(pmtDelta)}/mo`}`,
      newRate: r2(eff15), paymentChange: Math.round(pmtDelta),
    };
  }
  if (c.loanType === "15yr_fixed") {
    const a = analyze({ ...c, loanType: "30yr_fixed" }, rates);
    if (!a) return null;
    const cur = calcPayment(c.loanBalance, c.currentRate, 15);
    const new30 = calcPayment(c.loanBalance, a.effRate, 30);
    const drop = cur - new30;
    if (drop < TERM30_RELIEF_MIN) return null;
    return {
      lens: "term_swap", label: "Term Swap", priority: "low",
      headline: Math.round(drop), unit: "$/mo",
      detail: `Cash-flow option: 30-yr refi cuts the payment ~$${money(drop)}/mo`,
      paymentChange: -Math.round(drop),
    };
  }
  return null;
}

// ── Check-in cadence ─────────────────────────────────────────────────────────
function checkInStatus(c, now = new Date()) {
  const last = c.lastContact || c.last_contact;
  const close = c.closeDate || c.close_date;
  const created = c.createdAt || c.created_at;
  const ref = last || close || created;
  if (!ref) return { due: false, monthsSince: null, basis: null };
  const d = new Date(ref);
  if (isNaN(d.getTime())) return { due: false, monthsSince: null, basis: null };
  const months = (now - d) / (1000 * 60 * 60 * 24 * 30.44);
  return { due: months >= CHECK_IN_MONTHS, monthsSince: Math.max(0, Math.floor(months)), basis: last ? "last_contact" : (close ? "close_date" : "created_at") };
}

// ── Sweep ────────────────────────────────────────────────────────────────────
const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };
const impact = (o) => o.monthlySavings || o.cashAvailable || o.headline || 0;

function sweepClient(raw, rates, now = new Date()) {
  const c = norm(raw);
  const lenses = [rateTerm(c, rates), cashOut(c), armToFixed(c, rates), termSwap(c, rates)].filter(Boolean);
  lenses.sort((x, y) => (PRIORITY_RANK[y.priority] - PRIORITY_RANK[x.priority]) || (impact(y) - impact(x)));
  return { clientId: c.id, name: c.name, best: lenses[0] || null, opportunities: lenses, checkIn: checkInStatus(c, now) };
}

function runSweep(clients, rates, now = new Date()) {
  const rows = (clients || []).map((c) => sweepClient(c, rates, now));
  const opportunities = rows.filter((r) => r.best);
  const checkIns = rows.filter((r) => r.checkIn.due);
  const byLens = {};
  for (const r of rows) for (const o of r.opportunities) byLens[o.lens] = (byLens[o.lens] || 0) + 1;
  return {
    opportunities, checkIns, byLens,
    counts: { total: rows.length, withOpportunity: opportunities.length, checkInsDue: checkIns.length },
    ranAt: now.toISOString(),
  };
}

module.exports = {
  CASH_OUT_FLOOR, CHECK_IN_MONTHS,
  calcPayment, llpaPrice, estClosingCosts, analyze,
  rateTerm, cashOut, armToFixed, termSwap, checkInStatus,
  sweepClient, runSweep,
};
