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

// Today's figures as lib/upgrades' today block gives them: the cash-out check reads today's balance and cautious value.
const C650 = { loanType: "30yr_fixed", currentRate: 6.0, loanBalance: 400000, propertyValue: 650000, creditScore: 760 };
const TODAY = (over = {}) => ({ balance: 400000, cautiousValue: 585000, valueBasis: "flat", ...over });

test("cashOut from today's figures: today's balance and cautious value, saying where the value came from", () => {
  const flat = refi.cashOut(C650, TODAY());
  assert.deepStrictEqual([flat.cashAvailable, flat.headline, flat.priority, flat.currentLtv], [68000, 68000, "medium", 68.4]); // 0.80*585k - 400k
  assert.strictEqual(flat.detail, "~$68,000 tappable to 80% LTV (on the value on file less 10% — verify)");
  const grown = refi.cashOut(C650, TODAY({ balance: 380000, cautiousValue: 702000, valueBasis: "grown" }));
  assert.deepStrictEqual([grown.cashAvailable, grown.priority], [181600, "high"]);
  assert.strictEqual(grown.detail, "~$181,600 tappable to 80% LTV (on today's estimated value less 10% — verify)");
  const typed = refi.cashOut(C650, TODAY({ cautiousValue: 650000, valueBasis: "typed" }));
  assert.strictEqual(typed.cashAvailable, 120000);
  assert.strictEqual(typed.detail, "~$120,000 tappable to 80% LTV (on the value you entered — verify)");
  assert.strictEqual(refi.cashOut(C650, TODAY({ valueBasis: undefined })).detail, "~$68,000 tappable to 80% LTV (est. on today's value — verify)");
  assert.strictEqual(refi.cashOut(C650, TODAY({ cautiousValue: 540000 })), null, "$32,000 is under the $40,000 floor");
  assert.strictEqual(refi.cashOut(C650, TODAY({ balance: 0 })), null, "no loan today: nothing to cash out, as with a stored 0");
});

test("cashOut without usable today's figures: the figures on file, as before", () => {
  const stored = refi.cashOut(C650);
  assert.strictEqual(stored.cashAvailable, 120000);
  assert.strictEqual(stored.detail, "~$120,000 tappable to 80% LTV (est. on origination value — verify)");
  for (const t of [undefined, null, {}, TODAY({ cautiousValue: null }), TODAY({ cautiousValue: 0 }), TODAY({ cautiousValue: Number.NaN }),
    TODAY({ balance: null }), TODAY({ balance: Number.NaN }), TODAY({ balance: -5 })]) {
    assert.deepStrictEqual(refi.cashOut(C650, t), stored, JSON.stringify(t));
  }
});

// The three rate lenses price the same today's figures as the cash-out check, and the figures on file without them.
const R650 = { loanType: "30yr_fixed", currentRate: 7.85, loanBalance: 485000, propertyValue: 650000, creditScore: 760 };
const ARM720 = { loanType: "5_1_arm", currentRate: 8.25, loanBalance: 560000, propertyValue: 720000, creditScore: 720 };
const T30 = { loanType: "30yr_fixed", currentRate: 7.0, loanBalance: 300000, propertyValue: 500000, creditScore: 760 };
const T15 = { loanType: "15yr_fixed", currentRate: 6.9, loanBalance: 215000, propertyValue: 380000, creditScore: 800 };
const UNUSABLE_TODAY = [undefined, null, {}, TODAY({ cautiousValue: null }), TODAY({ cautiousValue: 0 }), TODAY({ cautiousValue: Number.NaN }),
  TODAY({ balance: null }), TODAY({ balance: Number.NaN }), TODAY({ balance: -5 })];

test("pricedToday: today's balance and cautious value in place of the figures on file", () => {
  assert.deepStrictEqual(refi.pricedToday(R650, TODAY({ balance: 470000 })), { ...R650, loanBalance: 470000, propertyValue: 585000, miToday: 0 });
  for (const t of UNUSABLE_TODAY) assert.strictEqual(refi.pricedToday(R650, t), R650, JSON.stringify(t));
});

test("rateTerm from today's figures: the rate, savings and break-even on today's balance and cautious value", () => {
  // On file 485k / 650k = 74.6% LTV: the top-tier 6.461%. Today 470k / 585k = 80.3%: past top tier, +0.125 → 6.586%, and over 80%,
  // so the new loan's PMI (0.19% a year of 470k = $74/mo) comes off the $402/mo of principal and interest.
  assert.deepStrictEqual(refi.rateTerm(R650, RATES).effRate, 6.46);
  const hit = refi.rateTerm(R650, RATES, TODAY({ balance: 470000 }));
  assert.deepStrictEqual([hit.effRate, hit.rateDelta, hit.monthlySavings, hit.headline, hit.breakEven, hit.priority], [6.59, 1.26, 328, 328, 22, "high"]);
  assert.strictEqual(hit.newMiMonthly, 74);
  assert.strictEqual(hit.detail, "Drop ~1.26% to 6.59% → save ~$328/mo, break-even 22 mo — new-loan PMI ~$74/mo counted");
  assert.strictEqual(refi.rateTerm(R650, RATES, TODAY({ balance: 0 })), null, "paid off by today: no refi to offer");
  for (const t of UNUSABLE_TODAY) assert.deepStrictEqual(refi.rateTerm(R650, RATES, t), refi.rateTerm(R650, RATES), JSON.stringify(t));
});

test("armToFixed from today's figures", () => {
  // On file 560k / 720k = 77.8% LTV at 720: 6.711%. Today 540k / 800k = 67.5%: no adjustment → 6.461%.
  const hit = refi.armToFixed(ARM720, RATES, TODAY({ balance: 540000, cautiousValue: 800000 }));
  assert.deepStrictEqual([hit.effRate, hit.monthlySavings, hit.priority], [6.46, 658, "high"]);
  assert.strictEqual(hit.detail, "Lock a fixed rate (~6.46%) before the ARM adjusts — ~$658/mo");
  assert.strictEqual(refi.armToFixed(ARM720, RATES, TODAY({ balance: 0 })), null, "paid off by today");
  for (const t of UNUSABLE_TODAY) assert.deepStrictEqual(refi.armToFixed(ARM720, RATES, t), refi.armToFixed(ARM720, RATES), JSON.stringify(t));
});

test("termSwap from today's figures, both directions", () => {
  // 30 → 15. On file 300k / 500k = 60% LTV: 5.91%. Today 290k / 380k = 76.3%: +0.125 → 6.035%, on today's balance.
  const to15 = refi.termSwap(T30, RATES, TODAY({ balance: 290000, cautiousValue: 380000 }));
  assert.deepStrictEqual([to15.newRate, to15.paymentChange], [6.04, 523]);
  // 15 → 30: the payment drop on today's balance (200k at 6.9% over 15 years → the top-tier 6.461% over 30).
  const to30 = refi.termSwap(T15, RATES, TODAY({ balance: 200000, cautiousValue: 342000 }));
  assert.deepStrictEqual([to30.headline, to30.paymentChange], [527, -527]);
  for (const c of [T30, T15]) {
    assert.strictEqual(refi.termSwap(c, RATES, TODAY({ balance: 0 })), null, "paid off by today");
    for (const t of UNUSABLE_TODAY) assert.deepStrictEqual(refi.termSwap(c, RATES, t), refi.termSwap(c, RATES), JSON.stringify(t));
  }
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

test("no-program client: no upgrades; the rate lenses and cash-out from today's figures", () => {
  const now = new Date("2026-10-21T00:00:00Z");
  const cs = [
    { id: 1, name: "Rate", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760, last_contact: "2026-01-01" },
    { id: 2, name: "Arm", loan_type: "5_1_arm", current_rate: 8.25, loan_balance: 560000, property_value: 720000, credit_score: 720, last_contact: "2026-10-01" },
    { id: 3, name: "Fifteen", loan_type: "15yr_fixed", current_rate: 7.2, loan_balance: 300000, property_value: 500000, credit_score: 740, last_contact: "2026-10-10" },
  ];
  // No ZIP or value date on any of them, so each value is the one on file less 10%, and the balance the one on file.
  const want = [
    // 485k / 585k = 82.9% LTV: past top tier, 6.461 + 0.125 → 6.586% (on the $650,000 on file it was 74.6% → 6.46%, $455/mo).
    // Over 80%, so the new loan's PMI is counted: $415/mo of principal and interest less $77/mo. The ARM too: 560k / 648k = 86.4%,
    // $589/mo less $215/mo of PMI (0.46% a year at a 720 score).
    {"best":{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":338,"unit":"$/mo","detail":"Drop ~1.26% to 6.59% → save ~$338/mo, break-even 22 mo — new-loan PMI ~$77/mo counted","monthlySavings":338,"rateDelta":1.26,"breakEven":22,"effRate":6.59,"newMiMonthly":77},"opportunities":[{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":338,"unit":"$/mo","detail":"Drop ~1.26% to 6.59% → save ~$338/mo, break-even 22 mo — new-loan PMI ~$77/mo counted","monthlySavings":338,"rateDelta":1.26,"breakEven":22,"effRate":6.59,"newMiMonthly":77},{"lens":"term_swap","label":"Term Swap","priority":"medium","headline":6.04,"unit":"%","detail":"15-yr refi at ~6.04% — pay off ~15 yrs sooner, +$594/mo","newRate":6.04,"paymentChange":594}],"checkIn":{"due":true,"monthsSince":9,"basis":"last_contact"}},
    {"best":{"lens":"arm_to_fixed","label":"ARM → Fixed","priority":"high","headline":375,"unit":"$/mo","detail":"Lock a fixed rate (~6.71%) before the ARM adjusts — ~$375/mo","effRate":6.71,"monthlySavings":375},"opportunities":[{"lens":"arm_to_fixed","label":"ARM → Fixed","priority":"high","headline":375,"unit":"$/mo","detail":"Lock a fixed rate (~6.71%) before the ARM adjusts — ~$375/mo","effRate":6.71,"monthlySavings":375}],"checkIn":{"due":false,"monthsSince":0,"basis":"last_contact"}},
    // Cash-out from today's figures: no ZIP or value date, so the $500,000 on file less 10% → 0.80*450k - 300k = $60,000 (medium).
    {"best":{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":213,"unit":"$/mo","detail":"Drop ~1.29% to 5.91% → save ~$213/mo, break-even 26 mo","monthlySavings":213,"rateDelta":1.29,"breakEven":26,"effRate":5.91},"opportunities":[{"lens":"rate_term","label":"Rate & Term","priority":"high","headline":213,"unit":"$/mo","detail":"Drop ~1.29% to 5.91% → save ~$213/mo, break-even 26 mo","monthlySavings":213,"rateDelta":1.29,"breakEven":26,"effRate":5.91},{"lens":"cash_out","label":"Cash-Out","priority":"medium","headline":60000,"unit":"$","detail":"~$60,000 tappable to 80% LTV (on the value on file less 10% — verify)","cashAvailable":60000,"currentLtv":66.7},{"lens":"term_swap","label":"Term Swap","priority":"low","headline":842,"unit":"$/mo","detail":"Cash-flow option: 30-yr refi cuts the payment ~$842/mo","paymentChange":-842}],"checkIn":{"due":false,"monthsSince":0,"basis":"last_contact"}},
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

test("sweepClient: the cash-out check reads the same today's figures as the upgrade checks", () => {
  // ZIP3 850 goes 100 → 140 in UP_INDEX: $500,000 in 2021 → $700,000 today, less 10% → $630,000; the 2021 balance is rolled forward.
  const c = fhaClient({ propertyValue: 500000, currentRate: 7.9 });
  const t = require("../lib/upgrades").upgradesFor(refi.norm(c), UP_RATES, "2026-11-13", { index: UP_INDEX }).today;
  assert.deepStrictEqual([t.valueBasis, t.cautiousValue, t.balanceBasis], ["grown", 630000, "rolled"]);
  assert.ok(t.balance < 289500);
  const co = refi.sweepClient(c, UP_RATES, UP_NOW, { index: UP_INDEX }).opportunities.find((o) => o.lens === "cash_out");
  assert.strictEqual(co.cashAvailable, Math.round(0.8 * 630000 - t.balance));
  assert.match(co.detail, /on today's estimated value less 10% — verify\)$/);
  // runSweep passes the same figures through
  const run = refi.runSweep([c], UP_RATES, UP_NOW, { index: UP_INDEX });
  assert.strictEqual(run.opportunities[0].best.cashAvailable, co.cashAvailable);
});

test("sweepClient: the rate lenses read the same today's figures as the upgrade checks", () => {
  // The same loan as a conventional 30-year, a 15-year and an ARM: each rate lens prices the rolled-forward balance and $630,000.
  const base = fhaClient({ loanProgram: "conventional", propertyValue: 500000, currentRate: 7.9 });
  const lensOf = (c, lens) => refi.sweepClient(c, UP_RATES, UP_NOW, { index: UP_INDEX }).opportunities.find((o) => o.lens === lens);
  const todayOf = (c) => require("../lib/upgrades").upgradesFor(refi.norm(c), UP_RATES, "2026-11-13", { index: UP_INDEX }).today;
  const t = todayOf(base);
  assert.deepStrictEqual([t.cautiousValue, t.balanceBasis], [630000, "rolled"]);
  const rt = lensOf(base, "rate_term");
  assert.deepStrictEqual(rt, refi.rateTerm(refi.norm(base), UP_RATES, t));
  assert.ok(rt.monthlySavings < refi.rateTerm(refi.norm(base), UP_RATES).monthlySavings, "a smaller balance today saves less a month");
  assert.deepStrictEqual(lensOf(base, "term_swap"), refi.termSwap(refi.norm(base), UP_RATES, t));
  const arm = { ...base, loanType: "5_1_arm" };
  assert.deepStrictEqual(lensOf(arm, "arm_to_fixed"), refi.armToFixed(refi.norm(arm), UP_RATES, todayOf(arm)));
  assert.notDeepStrictEqual(lensOf(arm, "arm_to_fixed"), refi.armToFixed(refi.norm(arm), UP_RATES));
  // runSweep passes the same figures through
  assert.deepStrictEqual(refi.runSweep([base], UP_RATES, UP_NOW, { index: UP_INDEX }).opportunities[0].opportunities.find((o) => o.lens === "rate_term"), rt);
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

test("I5: opts.upgradeRates prices the upgrades (null: none but Drop PMI); the four rate lenses keep the rates given", () => {
  const c = fhaClient({ currentRate: 7.75, propertyZip: "" , closeDate: "2023-09-15", balanceAsOf: "2023-09-15", valueAsOf: "2023-09-15" });
  const { rate_30yr_fha, ...noFha } = UP_RATES;
  assert.deepStrictEqual(refi.sweepClient(c, noFha, UP_NOW, { index: UP_INDEX }).upgrades, [], "the given rates have no FHA rate");
  const s = refi.sweepClient(c, noFha, UP_NOW, { index: UP_INDEX, upgradeRates: UP_RATES });
  assert.deepStrictEqual(s.upgrades.map((l) => [l.lens, l.effRate]), [["fha_streamline", 5.9]]);
  assert.deepStrictEqual(refi.sweepClient(c, UP_RATES, UP_NOW, { index: UP_INDEX, upgradeRates: null }).upgrades, []);
  // a conventional client's rate lens prices from the given rates, not the upgrade rates
  const chen = { id: 1, name: "Chen", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760 };
  const cheap = { ...UP_RATES, rate_30yr_top_tier: 4.0 };
  assert.strictEqual(refi.sweepClient(chen, RATES, UP_NOW, { upgradeRates: cheap }).best.effRate, 6.59);   // 6.461 + 0.125 at 82.9% LTV today
  // runSweep passes it through
  const run = refi.runSweep([c], noFha, UP_NOW, { index: UP_INDEX, upgradeRates: UP_RATES });
  assert.deepStrictEqual(run.upgrades.map((r) => r.bestUpgrade.lens), ["fha_streamline"]);
});

test("M3: upgrade checks that throw leave the sweep row with no upgrades and no gaps, logging only the error name", () => {
  const U = require("../lib/upgrades");
  const real = U.upgradesFor;
  const realErr = console.error;
  const logged = [];
  U.upgradesFor = () => { throw new TypeError("secret client name"); };
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const s = refi.sweepClient(fhaClient({ propertyValue: 500000, currentRate: 7.9 }), UP_RATES, UP_NOW, { index: UP_INDEX });
    assert.deepStrictEqual([s.upgrades, s.bestUpgrade, s.upgradeGaps], [[], null, []]);
    assert.deepStrictEqual(s.opportunities.map((o) => o.lens), ["cash_out"], "the rate lenses still run");
    // no today's figures: cash-out from the figures on file (0.80*500k - 289,500)
    assert.strictEqual(s.best.cashAvailable, 110500);
    assert.match(s.best.detail, /est\. on origination value — verify\)$/);
  } finally { U.upgradesFor = real; console.error = realErr; }
  assert.deepStrictEqual(logged, ["upgrade checks skipped: TypeError"]);
});
