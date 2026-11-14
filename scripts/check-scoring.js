/**
 * Sanity-check the scoring logic (analyze() in server/lib/refi.js) and the loan-upgrade checks (server/lib/upgrades.js)
 * against known clients.
 * Usage: node scripts/check-scoring.js
 */
const { analyze } = require("../server/lib/refi.js");
const { upgradesFor } = require("../server/lib/upgrades.js");
const { createIndex } = require("../server/lib/hpi.js");

// OBMMI-shaped payload (incl. top-tier anchor)
const rates = { rate_30yr_fixed: 6.526, rate_15yr_fixed: 5.922, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
// Fallback payload (Claude web search / estimates — no top-tier series)
const ratesNoTT = { rate_30yr_fixed: 6.526, rate_15yr_fixed: 5.922, rate_5_1_arm: 5.81 };

const cases = [
  { name: "Chen (760cs, 74.6 LTV, 7.85%) — top-tier box → observed rate", rates,
    c: { loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 },
    expect: { effRate: 6.461, rateAdj: 0, baseLabel: "top-tier", priority: "high" } },
  { name: "Nguyen (790cs, 72.8 LTV, 6.50%) — top-tier, tiny delta", rates,
    c: { loanType: "30yr_fixed", currentRate: 6.50, loanBalance: 142000, propertyValue: 195000, creditScore: 790 },
    expect: { effRate: 6.461, priority: "low" } },
  { name: "No credit score (defaults 700), 93.75 LTV — relative adj on top-tier", rates,
    c: { loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 300000, propertyValue: 320000, creditScore: null },
    expect: { rateAdj: 0.25, baseLabel: "top-tier" } },   // (1.125 - 0.25)/4 = 0.21875 → rounds to 0.25; eff 6.711
  { name: "Lopez (720cs, 77.8 LTV, ARM 8.25%) — no ARM top-tier index", rates,
    c: { loanType: "5_1_arm", currentRate: 8.25, loanBalance: 560000, propertyValue: 720000, creditScore: 720 },
    expect: { rateAdj: 0.375, baseLabel: "market", priority: "high" } },  // absolute model: 1.25/4 → 0.375
  { name: "Patel (800cs, 56.6 LTV, 15yr 6.90%) — 15yr keeps market model", rates,
    c: { loanType: "15yr_fixed", currentRate: 6.90, loanBalance: 215000, propertyValue: 380000, creditScore: 800 },
    expect: { rateAdj: 0, baseLabel: "market", priority: "low" } },       // thin savings → 40mo break-even
  { name: "Fallback payload (no top-tier series) — absolute model", rates: ratesNoTT,
    c: { loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 },
    expect: { rateAdj: 0.125, baseLabel: "market" } },    // 0.25 price /4 = 0.0625 → rounds to 0.125
  { name: "Underwater (740cs, LTV 105) — never good", rates,
    c: { loanType: "30yr_fixed", currentRate: 8.0, loanBalance: 400000, propertyValue: 380000, creditScore: 740 },
    expect: { good: false } },
];

let fail = 0;
for (const t of cases) {
  const a = analyze(t.c, t.rates);
  const lines = [];
  for (const [k, want] of Object.entries(t.expect)) {
    const got = a[k];
    const ok = got === want;
    if (!ok) fail++;
    lines.push(`${ok ? "  ok " : "  FAIL"} ${k}: got ${got}, want ${want}`);
  }
  console.log(`${t.name}\n  → base ${a.baseLabel} ${a.base}  effRate ${a.effRate.toFixed(3)}  adj ${a.rateAdj}  delta ${a.rateDelta.toFixed(2)}  save $${a.monthlySavings.toFixed(0)}/mo  BE ${a.breakEven}mo  good=${a.good} prio=${a.priority}`);
  console.log(lines.join("\n"));
}

// Invariants across a sweep (with the top-tier anchor in play)
let inv = 0;
for (let score = 600; score <= 820; score += 20) {
  for (let ltv = 40; ltv <= 99; ltv += 5) {
    const a = analyze({ loanType: "30yr_fixed", currentRate: 7.5, loanBalance: ltv * 1000, propertyValue: 100000, creditScore: score }, rates);
    if (a.rateAdj < 0) { console.log(`INVARIANT FAIL: negative adj at ${score}/${ltv}`); inv++; }
    if (a.effRate < rates.rate_30yr_top_tier - 1e-9) { console.log(`INVARIANT FAIL: effRate below top-tier at ${score}/${ltv}`); inv++; }
    if (a.rateAdj > 0.875) { console.log(`INVARIANT FAIL: adj implausibly large (${a.rateAdj}) at ${score}/${ltv}`); inv++; }
    // Top-tier box must map exactly to the observed rate
    if (score >= 740 && ltv <= 80 && a.effRate !== rates.rate_30yr_top_tier) { console.log(`INVARIANT FAIL: top-tier box not anchored at ${score}/${ltv}`); inv++; }
  }
}
console.log(`\nInvariant sweep: ${inv === 0 ? "all passed" : inv + " FAILURES"}`);
console.log(fail === 0 ? "ALL CASE CHECKS PASSED" : `${fail} CASE CHECKS FAILED`);

// ── Upgrades: one flagging and one must-not-flag client per lens ─────────────
const TODAY = "2026-11-13";
const upRates = { rate_30yr_fixed: 6.25, rate_15yr_fixed: 5.6, rate_5_1_arm: 6.1, rate_30yr_top_tier: 6.1, rate_30yr_fha: 5.9, rate_30yr_va: 5.8 };
// ZIP3 "850": flat at 100 from 2005Q1, 140 in the latest quarter (2026Q3).
const nQ = (2026 * 4 + 2) - 2005 * 4 + 1;
const series = Array(nQ).fill(100);
series[nQ - 1] = 140;
const index = createIndex({ source: "check", start: "2005Q1", end: "2026Q3", zip3: { "850": series } });

const fha = (over = {}) => ({
  loanProgram: "fha", occupancy: "primary", loanType: "30yr_fixed", currentRate: 6.9,
  loanBalance: 289500, balanceAsOf: "2021-06-15", closeDate: "2021-06-15",
  originalAmount: 289500, originalValue: 300000, propertyValue: 300000, valueAsOf: "2021-06-15", propertyZip: "85016",
  creditScore: 720, creditScoreKnown: true, monthlyMi: null, editedByHand: "", ...over,
});
const closedOn = (d, over = {}) => fha({ closeDate: d, balanceAsOf: d, valueAsOf: d, ...over });
const conv = (over = {}) => ({
  loanProgram: "conventional", occupancy: "primary", loanType: "30yr_fixed", currentRate: 6.5,
  loanBalance: 238000, balanceAsOf: TODAY, closeDate: "2022-03-15",
  originalAmount: 285000, originalValue: 300000, propertyValue: 300000, valueAsOf: "2022-03-15", propertyZip: "",
  creditScore: 700, creditScoreKnown: false, monthlyMi: 95, editedByHand: "", ...over,
});
const va = (d, over = {}) => closedOn(d, { loanProgram: "va", currentRate: 7.25, originalAmount: 300000, loanBalance: 300000, propertyZip: "", ...over });
const usda = (d, over = {}) => closedOn(d, { loanProgram: "usda", originalAmount: 300000, loanBalance: 300000, ...over });

const upCases = [
  { name: "fha_to_conv flags: FHA 3.5% down 2021, prices up 40%", lens: "fha_to_conv", flag: true, c: fha() },
  { name: "fha_to_conv quiet: known score 600", lens: "fha_to_conv", flag: false, c: fha({ creditScore: 600 }) },
  { name: "drop_pmi flags: conventional, PMI typed, balance under 80% of original value", lens: "drop_pmi", flag: true, c: conv() },
  { name: "drop_pmi quiet: FHA is not a PMI loan", lens: "drop_pmi", flag: false, c: fha({ monthlyMi: 95, loanBalance: 200000, balanceAsOf: TODAY }) },
  { name: "fha_streamline flags: 7.75% FHA closed 2023", lens: "fha_streamline", flag: true, c: closedOn("2023-09-15", { currentRate: 7.75, propertyZip: "" }) },
  { name: "fha_streamline quiet: closed 150 days ago (inside the waiting period)", lens: "fha_streamline", flag: false, c: closedOn("2026-06-16", { currentRate: 7.75, propertyZip: "" }) },
  { name: "va_irrrl flags: 7.25% VA closed 2023", lens: "va_irrrl", flag: true, c: va("2023-09-15") },
  { name: "va_irrrl quiet: 15-year loan is not a 30-year IRRRL", lens: "va_irrrl", flag: false, c: va("2023-09-15", { loanType: "15yr_fixed" }) },
  { name: "usda_to_conv flags: USDA closed 2019 with the annual fee", lens: "usda_to_conv", flag: true, c: usda("2019-05-15") },
  { name: "usda_to_conv quiet: USDA closed 2010 (no annual fee then)", lens: "usda_to_conv", flag: false, c: usda("2010-06-01", { currentRate: 7.75 }) },
];

console.log("\nUpgrades");
let upFail = 0;
for (const t of upCases) {
  const r = upgradesFor(t.c, upRates, TODAY, { index });
  const l = r.lenses.find((x) => x.lens === t.lens) || null;
  const ok = t.flag ? !!l : !l;
  if (!ok) upFail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${t.name}${l ? ` → ${l.detail}` : ""}`);
}
console.log(upFail === 0 ? "ALL UPGRADE CHECKS PASSED" : `${upFail} UPGRADE CHECKS FAILED`);
process.exit(fail + inv + upFail === 0 ? 0 : 1);
