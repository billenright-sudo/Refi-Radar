// Refi pricing for the client list, the client page and the Overview. It mirrors server/lib/refi.js (the engine behind Sweeps,
// the morning briefing and Charlie) so every screen shows the same figures for the same loan; refiAnalysis.test.mjs checks the two agree.

export const calcPayment = (p, annualRate, years) => {
  const r = annualRate / 100 / 12, n = years * 12;
  if (r === 0) return p / n;
  return p * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
};

// Estimated loan-level pricing adjustments (rate-term refi, conventional).
// Price hits as % of loan amount by credit-score band × LTV band, simplified
// from the agency LLPA matrix. Converted to a rate adjustment at the customary
// 4:1 price-to-rate ratio and rounded to the nearest eighth — an estimate for
// prioritizing outreach, not a quote.
const LLPA_LTV_BREAKS = [30, 60, 70, 75, 80, 85, 90, 95];
const LLPA_GRID = [
  [780, [0,     0,     0,     0,     0.375, 0.375, 0.25,  0.25,  0.125]],
  [760, [0,     0,     0,     0.25,  0.625, 0.625, 0.5,   0.5,   0.25 ]],
  [740, [0,     0,     0.125, 0.375, 0.875, 1.0,   0.75,  0.625, 0.5  ]],
  [720, [0,     0,     0.25,  0.75,  1.25,  1.25,  1.0,   0.875, 0.75 ]],
  [700, [0,     0,     0.375, 0.875, 1.375, 1.5,   1.25,  1.125, 0.875]],
  [680, [0,     0,     0.625, 1.125, 1.75,  1.875, 1.5,   1.375, 1.125]],
  [660, [0,     0,     0.75,  1.375, 1.875, 2.125, 1.75,  1.625, 1.25 ]],
  [640, [0,     0,     1.125, 1.5,   2.25,  2.5,   2.0,   1.875, 1.5  ]],
  [0,   [0,     0.125, 1.5,   2.125, 2.75,  3.0,   2.5,   2.25,  1.75 ]],
];

export const llpaPrice = (creditScore, ltv) => {
  const score = creditScore || 700;
  const row = LLPA_GRID.find(([floor]) => score >= floor)[1];
  let col = LLPA_LTV_BREAKS.findIndex((b) => ltv <= b);
  if (col === -1) col = LLPA_LTV_BREAKS.length;
  return row[col];
};

export const roundEighth = (x) => Math.round(x / 0.125) * 0.125;

// The Optimal Blue top-tier index (LTV≤80, FICO≥740) is an observed lock rate
// whose cohort mix already embeds roughly this much LLPA price; adjustments
// for other borrowers are applied relative to it, not on top of it.
const LLPA_TOP_TIER_EMBEDDED = 0.25;

// Closing costs: fixed costs (title, appraisal, recording) plus 1% of balance
// (origination) — tracks typical refi costs better than a flat percentage.
export const estClosingCosts = (balance) => 2500 + balance * 0.01;

// A 5/1 ARM is priced as a move to a 30-year fixed, as the server's ARM-to-fixed lens does (the borrower locks a rate before
// the ARM adjusts), so its savings match Sweeps, the briefing and Charlie. `armToFixed` tells the page to say so.
export const analyze = (loan, rates) => {
  if (!rates || !loan) return null;
  const armToFixed = loan.loanType === "5_1_arm";
  const client = armToFixed ? { ...loan, loanType: "30yr_fixed" } : loan;
  const rMap = { "30yr_fixed": rates.rate_30yr_fixed, "15yr_fixed": rates.rate_15yr_fixed };
  const mktRate = rMap[client.loanType];
  if (!mktRate) return null;
  const years = client.loanType === "15yr_fixed" ? 15 : 30;
  const ltv = (client.loanBalance / client.propertyValue) * 100;
  const score = client.creditScore || 700;
  const priceHit = llpaPrice(score, ltv);

  // 30yr clients anchor to the observed top-tier lock rate when available:
  // top-tier borrowers get the real cohort rate (no estimate), others get it
  // plus pricing relative to what the index already embeds. 15yr/ARM have no
  // top-tier index, so they use the average rate + absolute pricing estimate.
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
  return { mktRate, base, baseLabel, effRate, rateAdj, rateDelta, curPmt, newPmt, monthlySavings, annualSavings, closingCosts, breakEven, ltv, good, priority: good ? (rateDelta >= 1.0 ? "high" : "medium") : "low", armToFixed };
};
