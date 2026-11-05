import test from "node:test";
import assert from "node:assert/strict";
import { gateScreen, bannerText, money, totalLine, billingLines, chipLabel, formatDate } from "./billing.mjs";

const NOW = Date.UTC(2026, 10, 5, 12);
const at = (m, d, y = 2026) => Date.UTC(y, m - 1, d, 12);
const base = { enabled: true, status: "none", users: 1, trialEnd: null, testerUntil: null, periodEnd: null, cancelAtPeriodEnd: false, exempt: false };

test("gateScreen: open access shows no gate; each reason maps by role", () => {
  assert.equal(gateScreen({ ok: true }, "broker"), null);
  assert.equal(gateScreen(null, "broker"), null);
  assert.equal(gateScreen(undefined, "lo"), null);
  assert.equal(gateScreen({ ok: false, reason: "terms" }, "broker"), "terms");
  assert.equal(gateScreen({ ok: false, reason: "terms" }, "lo"), "terms");
  assert.equal(gateScreen({ ok: false, reason: "needs_card" }, "broker"), "start_trial");
  assert.equal(gateScreen({ ok: false, reason: "ended" }, "broker"), "ended");
  assert.equal(gateScreen({ ok: false, reason: "needs_card" }, "lo"), "lo_locked");
  assert.equal(gateScreen({ ok: false, reason: "ended" }, "lo"), "lo_locked");
  assert.equal(gateScreen({ ok: false, reason: "needs_card" }, undefined), "lo_locked");
});

test("money: no cents when whole", () => {
  assert.equal(money(9900), "$99");
  assert.equal(money(29500), "$295");
  assert.equal(money(9950), "$99.50");
});

test("formatDate: Nov 30, 2026", () => {
  assert.equal(formatDate(at(11, 30)), "Nov 30, 2026");
});

test("bannerText: the two lines", () => {
  assert.equal(bannerText("tester_ending", at(11, 30)), "Your free test month ends on Nov 30, 2026. Add a card to keep going.");
  assert.equal(bannerText("past_due", null), "Your last payment didn't go through. Update your card to keep Broker Radar running.");
  assert.equal(bannerText(null, null), null);
  assert.equal(bannerText("other", null), null);
});

test("totalLine: 1, 2 and 5 users", () => {
  assert.equal(totalLine(1), "Brokerage $99 a month");
  assert.equal(totalLine(2), "Brokerage $99 + 1 additional user × $49 = $148 a month");
  assert.equal(totalLine(5), "Brokerage $99 + 4 additional users × $49 = $295 a month");
  assert.equal(totalLine(0), "Brokerage $99 a month");
});

test("billingLines: every status", () => {
  assert.deepEqual(billingLines({ ...base, status: "trialing", trialEnd: at(11, 19) }, NOW),
    ["Brokerage $99 a month", "Free trial until Nov 19, 2026. First charge on Nov 19, 2026."]);
  assert.deepEqual(billingLines({ ...base, users: 5, testerUntil: at(11, 30) }, NOW),
    ["Brokerage $99 + 4 additional users × $49 = $295 a month", "Free test month until Nov 30, 2026."]);
  assert.deepEqual(billingLines({ ...base, status: "active", users: 2, periodEnd: at(12, 5) }, NOW),
    ["Brokerage $99 + 1 additional user × $49 = $148 a month", "Next charge on Dec 5, 2026."]);
  assert.deepEqual(billingLines({ ...base, status: "active", cancelAtPeriodEnd: true, periodEnd: at(12, 5) }, NOW),
    ["Brokerage $99 a month", "Cancelled. Broker Radar keeps working until Dec 5, 2026."]);
  assert.deepEqual(billingLines({ ...base, status: "past_due", periodEnd: at(12, 5) }, NOW),
    ["Brokerage $99 a month", "Your last payment didn't go through. Update your card to keep Broker Radar running."]);
});

test("billingLines: exempt shows no price", () => {
  assert.deepEqual(billingLines({ ...base, exempt: true, users: 5 }, NOW), ["No charge for this account."]);
});

test("billingLines: an expired tester month and a bare 'none' show only the price", () => {
  assert.deepEqual(billingLines({ ...base, testerUntil: at(10, 1) }, NOW), ["Brokerage $99 a month"]);
});

test("chipLabel: billing status words", () => {
  assert.equal(chipLabel("trialing", null), "Free trial");
  assert.equal(chipLabel("active", null), "Active");
  assert.equal(chipLabel("past_due", null), "Payment due");
  assert.equal(chipLabel("none", "2026-11-30T00:00:00.000Z"), "Test month");
  assert.equal(chipLabel("none", null), "Not started");
  assert.equal(chipLabel("canceled", null), "Ended");
  assert.equal(chipLabel("exempt", null), "No charge");
});
