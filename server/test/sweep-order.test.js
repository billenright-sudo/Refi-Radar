"use strict";
// The Sweeps page lists runSweep's opportunities in the order the server returns them, so that order must be the ranking the
// call list and Charlie use (priority, then dollar impact), never the book's alphabetical order. Ties fall back to the name.
const test = require("node:test");
const assert = require("node:assert/strict");
const refi = require("../lib/refi");

const RATES = { rate_30yr_fixed: 7.09, rate_15yr_fixed: 6.41, rate_5_1_arm: 6.99, rate_30yr_top_tier: 6.98 };
const NOW = new Date("2026-11-06T12:00:00Z");
const client = (id, name, fields) => ({ id, name, loanType: "30yr_fixed", creditScore: 760, closeDate: "2024-01-15", ...fields });

test("runSweep lists opportunities by priority, then dollar impact, not by name", () => {
  const clients = [
    client(1, "Aaron Able", { currentRate: 7.2, loanBalance: 200000, propertyValue: 310000 }),   // cash-out ~$48,000, medium
    client(2, "Mia Middle", { currentRate: 7.2, loanBalance: 200000, propertyValue: 325000 }),   // cash-out ~$60,000, medium
    client(3, "Zed Zulu", { currentRate: 8.5, loanBalance: 400000, propertyValue: 600000 }),     // rate-and-term, high
  ];
  const { opportunities } = refi.runSweep(clients, RATES, NOW);
  assert.deepEqual(opportunities.map((r) => [r.name, r.best.priority]), [
    ["Zed Zulu", "high"],
    ["Mia Middle", "medium"],
    ["Aaron Able", "medium"],
  ]);
});

test("runSweep breaks a full tie by name", () => {
  const same = { currentRate: 7.2, loanBalance: 200000, propertyValue: 325000 };
  const { opportunities } = refi.runSweep([client(1, "Pat Second", same), client(2, "Kim First", same)], RATES, NOW);
  assert.deepEqual(opportunities.map((r) => r.name), ["Kim First", "Pat Second"]);
});

test("runSweep marks do-not-email clients, so Charlie's sweep never offers them an email", () => {
  const rows = [
    client(1, "Flagged Fran", { currentRate: 8.5, loanBalance: 400000, propertyValue: 600000, do_not_email: 1 }),
    client(2, "Open Owen", { currentRate: 8.5, loanBalance: 400000, propertyValue: 600000 }),
  ];
  const flags = Object.fromEntries(refi.runSweep(rows, RATES, NOW).opportunities.map((r) => [r.name, r.doNotEmail]));
  assert.deepEqual(flags, { "Flagged Fran": true, "Open Owen": false });
});
