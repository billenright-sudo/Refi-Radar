"use strict";
// Tests for the server-side Sweeps engine (server/lib/refi.js) — proper import,
// no eval. Known-answer cases for each lens, the check-in rule, and runSweep().
const test = require("node:test");
const assert = require("node:assert");
const refi = require("../lib/refi");

const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const approx = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b} (±${tol})`);

test("analyze() matches the shipped known answers", () => {
  const chen = refi.analyze({ loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 }, RATES);
  assert.equal(chen.effRate, 6.461);
  assert.equal(chen.good, true);
  assert.equal(chen.priority, "high");
});

test("rateTerm lens flags a strong refi, ignores a tiny gap", () => {
  const hit = refi.rateTerm({ loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 }, RATES);
  assert.equal(hit.lens, "rate_term");
  assert.equal(hit.priority, "high");
  assert.ok(hit.monthlySavings > 400);
  const none = refi.rateTerm({ loanType: "30yr_fixed", currentRate: 6.50, loanBalance: 142000, propertyValue: 195000, creditScore: 790 }, RATES);
  assert.equal(none, null);
});

test("cashOut lens: tappable equity over the floor, nothing when underwater", () => {
  const hit = refi.cashOut({ loanType: "30yr_fixed", currentRate: 6.0, loanBalance: 400000, propertyValue: 650000, creditScore: 760 });
  assert.equal(hit.lens, "cash_out");
  assert.equal(hit.cashAvailable, 120000); // 0.80*650k - 400k
  assert.equal(hit.priority, "high");       // >= 100k
  const small = refi.cashOut({ loanType: "30yr_fixed", currentRate: 6.0, loanBalance: 485000, propertyValue: 650000, creditScore: 760 });
  assert.equal(small, null, "only $35k tappable < $40k floor");
  const none = refi.cashOut({ loanType: "30yr_fixed", currentRate: 6.0, loanBalance: 280000, propertyValue: 300000, creditScore: 760 });
  assert.equal(none, null, "no room — already above 80% LTV");
});

test("armToFixed lens: ARMs only", () => {
  const hit = refi.armToFixed({ loanType: "5_1_arm", currentRate: 8.25, loanBalance: 560000, propertyValue: 720000, creditScore: 720 }, RATES);
  assert.equal(hit.lens, "arm_to_fixed");
  assert.equal(hit.priority, "high");
  assert.equal(hit.effRate, 6.71); // prices a 30yr FIXED (6.461 top-tier + 0.25 LLPA)
  assert.ok(hit.monthlySavings > 0);
  assert.equal(refi.armToFixed({ loanType: "30yr_fixed", currentRate: 8.0, loanBalance: 300000, propertyValue: 400000, creditScore: 740 }, RATES), null);
});

test("termSwap lens: 30->15 when 15yr beats their rate; 15->30 for payment relief", () => {
  const to15 = refi.termSwap({ loanType: "30yr_fixed", currentRate: 7.0, loanBalance: 300000, propertyValue: 500000, creditScore: 760 }, RATES);
  assert.equal(to15.lens, "term_swap");
  assert.equal(to15.newRate, 5.91);
  const to30 = refi.termSwap({ loanType: "15yr_fixed", currentRate: 6.9, loanBalance: 215000, propertyValue: 380000, creditScore: 800 }, RATES);
  assert.equal(to30.lens, "term_swap");
  assert.equal(to30.priority, "low");
  assert.ok(to30.headline > 300, "meaningful payment drop");
  const none = refi.termSwap({ loanType: "30yr_fixed", currentRate: 5.5, loanBalance: 300000, propertyValue: 500000, creditScore: 760 }, RATES);
  assert.equal(none, null, "already below the 15yr rate");
});

test("checkInStatus: 6-month cadence off last_contact / close_date", () => {
  const now = new Date("2026-10-21T00:00:00Z");
  const overdue = refi.checkInStatus({ last_contact: "2026-01-01" }, now);
  assert.equal(overdue.due, true);
  assert.ok(overdue.monthsSince >= 9);
  assert.equal(overdue.basis, "last_contact");
  const recent = refi.checkInStatus({ last_contact: "2026-09-15" }, now);
  assert.equal(recent.due, false);
  const fromClose = refi.checkInStatus({ close_date: "2023-06-10" }, now);
  assert.equal(fromClose.due, true);
  assert.equal(fromClose.basis, "close_date");
});

test("runSweep aggregates opportunities, lens counts, and check-ins", () => {
  const now = new Date("2026-10-21T00:00:00Z");
  const clients = [
    { id: 1, name: "Chen", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760, last_contact: "2026-01-01" },
    { id: 2, name: "Lopez", loan_type: "5_1_arm", current_rate: 8.25, loan_balance: 560000, property_value: 720000, credit_score: 720, last_contact: "2026-10-01" },
    { id: 3, name: "Nguyen", loan_type: "30yr_fixed", current_rate: 6.50, loan_balance: 142000, property_value: 195000, credit_score: 790, last_contact: "2026-10-10" },
  ];
  const s = refi.runSweep(clients, RATES, now);
  assert.equal(s.counts.total, 3);
  assert.ok(s.counts.withOpportunity >= 2, "Chen + Lopez have opportunities");
  assert.equal(s.counts.checkInsDue, 1, "only Chen is overdue");
  assert.ok(s.byLens.rate_term >= 1);
  assert.ok(s.byLens.arm_to_fixed >= 1);
  // Lopez's best should be the high-priority ARM->fixed
  const lopez = s.opportunities.find((o) => o.name === "Lopez");
  assert.equal(lopez.best.lens, "arm_to_fixed");
});

// ── Upgrades in the sweep ────────────────────────────────────────────────────
const { createIndex } = require("../lib/hpi");
// ZIP3 "850": flat at 100 from 2005Q1, 140 in 2026Q3.
const UP_INDEX = (() => {
  const n = (2026 * 4 + 2) - 2005 * 4 + 1;
  const s = Array(n).fill(100);
  s[n - 1] = 140;
  return createIndex({ source: "test", start: "2005Q1", end: "2026Q3", zip3: { "850": s } });
})();
const UP_RATES = { ...RATES, rate_30yr_fha: 5.9, rate_30yr_va: 5.8 };
const UP_NOW = new Date("2026-11-13T00:00:00Z");
const fhaClient = (over = {}) => ({
  id: 10, name: "Fha", loanProgram: "fha", occupancy: "primary", loanType: "30yr_fixed", currentRate: 6.9,
  loanBalance: 289500, balanceAsOf: "2021-06-15", closeDate: "2021-06-15",
  originalAmount: 289500, originalValue: 300000, propertyValue: 300000, valueAsOf: "2021-06-15", propertyZip: "85016",
  creditScore: 720, creditScoreKnown: true, monthlyMi: null, editedByHand: "", ...over,
});

test("no-program client: identical to before", () => {
  const now = new Date("2026-10-21T00:00:00Z");
  const cs = [
    { id: 1, name: "Rate", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760, last_contact: "2026-01-01" },
    { id: 2, name: "Arm", loan_type: "5_1_arm", current_rate: 8.25, loan_balance: 560000, property_value: 720000, credit_score: 720, last_contact: "2026-10-01" },
    { id: 3, name: "Fifteen", loan_type: "15yr_fixed", current_rate: 7.2, loan_balance: 300000, property_value: 500000, credit_score: 740, last_contact: "2026-10-10" },
  ];
  const want = [
    {"best":{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":455,"unit":"$/mo","detail":"Drop ~1.39% to 6.46% → save ~$455/mo, break-even 17 mo","monthlySavings":455,"rateDelta":1.39,"breakEven":17,"effRate":6.46},"opportunities":[{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":455,"unit":"$/mo","detail":"Drop ~1.39% to 6.46% → save ~$455/mo, break-even 17 mo","monthlySavings":455,"rateDelta":1.39,"breakEven":17,"effRate":6.46},{"lens":"term_swap","label":"Term Swap","priority":"medium","headline":6.04,"unit":"%","detail":"15-yr refi at ~6.04% — pay off ~15 yrs sooner, +$594/mo","newRate":6.04,"paymentChange":594}],"checkIn":{"due":true,"monthsSince":9,"basis":"last_contact"}},
    {"best":{"lens":"arm_to_fixed","label":"ARM → Fixed","priority":"high","headline":589,"unit":"$/mo","detail":"Lock a fixed rate (~6.71%) before the ARM adjusts — ~$589/mo","effRate":6.71,"monthlySavings":589},"opportunities":[{"lens":"arm_to_fixed","label":"ARM → Fixed","priority":"high","headline":589,"unit":"$/mo","detail":"Lock a fixed rate (~6.71%) before the ARM adjusts — ~$589/mo","effRate":6.71,"monthlySavings":589}],"checkIn":{"due":false,"monthsSince":0,"basis":"last_contact"}},
    {"best":{"lens":"cash_out","label":"Cash-Out","priority":"high","headline":100000,"unit":"$","detail":"~$100,000 tappable to 80% LTV (est. on origination value — verify)","cashAvailable":100000,"currentLtv":60},"opportunities":[{"lens":"cash_out","label":"Cash-Out","priority":"high","headline":100000,"unit":"$","detail":"~$100,000 tappable to 80% LTV (est. on origination value — verify)","cashAvailable":100000,"currentLtv":60},{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":213,"unit":"$/mo","detail":"Drop ~1.29% to 5.91% → save ~$213/mo, break-even 26 mo","monthlySavings":213,"rateDelta":1.29,"breakEven":26,"effRate":5.91},{"lens":"term_swap","label":"Term Swap","priority":"low","headline":842,"unit":"$/mo","detail":"Cash-flow option: 30-yr refi cuts the payment ~$842/mo","paymentChange":-842}],"checkIn":{"due":false,"monthsSince":0,"basis":"last_contact"}},
  ];
  cs.forEach((c, i) => {
    const s = refi.sweepClient(c, RATES, now, { index: UP_INDEX });
    assert.deepStrictEqual({ best: s.best, opportunities: s.opportunities, checkIn: s.checkIn }, want[i], c.name);
    assert.deepStrictEqual(s.upgrades, []);
    assert.strictEqual(s.bestUpgrade, null);
    assert.ok(Array.isArray(s.upgradeGaps));
  });
});

test("an FHA client gets cash-out only from the old lenses plus its upgrades", () => {
  // Equity-rich FHA at 6.9%: rate_term would flag a conventional client; the FHA client keeps only cash-out.
  const c = fhaClient({ propertyValue: 500000, currentRate: 7.9 });
  const s = refi.sweepClient(c, UP_RATES, UP_NOW, { index: UP_INDEX });
  assert.deepStrictEqual(s.opportunities.map((o) => o.lens), ["cash_out"]);
  assert.strictEqual(s.best.lens, "cash_out");
  assert.ok(s.upgrades.some((l) => l.lens === "fha_to_conv"), JSON.stringify(s.upgrades));
  assert.strictEqual(s.bestUpgrade, s.upgrades[0]);
  const conv = refi.sweepClient({ ...c, loanProgram: "conventional" }, UP_RATES, UP_NOW, { index: UP_INDEX });
  assert.ok(conv.opportunities.some((o) => o.lens === "rate_term"), "same client as conventional gets rate_term");
});

test("runSweep lists upgrades separately and counts them", () => {
  const clients = [
    fhaClient({ id: 10, name: "Zed" }),
    fhaClient({ id: 11, name: "Abe" }),
    { id: 1, name: "Chen", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760 },
  ];
  const s = refi.runSweep(clients, UP_RATES, UP_NOW, { index: UP_INDEX });
  assert.strictEqual(s.upgrades.length, 2);
  assert.strictEqual(s.counts.withUpgrade, 2);
  assert.deepStrictEqual(s.upgrades.map((r) => r.name), ["Abe", "Zed"], "equal rows: the name breaks the tie");
  assert.ok(s.byLens.fha_to_conv >= 2);
  const chen = s.opportunities.find((o) => o.name === "Chen");
  assert.strictEqual(chen.best.lens, "rate_term");
  assert.ok(!s.upgrades.some((r) => r.name === "Chen"));
});

test("norm keeps null monthly MI as null", () => {
  for (const mi of [null, "", undefined]) {
    const n = refi.norm({ id: 1, monthlyMi: mi, originalAmount: mi, originalValue: mi });
    assert.strictEqual(n.monthlyMi, null);
    assert.strictEqual(n.originalAmount, null);
    assert.strictEqual(n.originalValue, null);
  }
  const snake = refi.norm({ monthly_mi: 95, original_amount: "285000", original_value: 300000, loan_program: "fha", property_zip: "85016",
    occupancy: "primary", balance_as_of: "2026-01-01", value_as_of: "2026-02-01", credit_score_known: 1, edited_by_hand: "loan_balance,property_value" });
  assert.deepStrictEqual(
    [snake.monthlyMi, snake.originalAmount, snake.originalValue, snake.loanProgram, snake.propertyZip, snake.occupancy, snake.balanceAsOf, snake.valueAsOf, snake.creditScoreKnown, snake.editedByHand],
    [95, 285000, 300000, "fha", "85016", "primary", "2026-01-01", "2026-02-01", true, "loan_balance,property_value"]);
  assert.strictEqual(refi.norm({ credit_score_known: 0 }).creditScoreKnown, false);
  assert.strictEqual(refi.norm({ creditScoreKnown: true }).creditScoreKnown, true);
});
