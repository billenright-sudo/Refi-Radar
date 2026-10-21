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
