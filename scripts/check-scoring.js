/**
 * Sanity-check the analyze() scoring logic by evaluating the real helper
 * section out of client/src/App.jsx (pure JS, no JSX) against known clients.
 * Usage: node scripts/check-scoring.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../client/src/App.jsx"), "utf8");

// Extract from calcPayment up to (not including) the $c formatter
const start = src.indexOf("const calcPayment");
const end = src.indexOf("const $c");
if (start === -1 || end === -1 || end <= start) throw new Error("Could not locate helper section in App.jsx");
const helpers = src.slice(start, end);

// eslint-disable-next-line no-eval
const analyze = eval(`${helpers}; analyze`);

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
process.exit(fail + inv === 0 ? 0 : 1);
