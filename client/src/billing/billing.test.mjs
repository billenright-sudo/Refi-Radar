import test from "node:test";
import assert from "node:assert/strict";
import {
  gateScreen, bannerText, money, totalLine, billingLines, chipLabel, formatDate, registerExtras, removeConfirmText,
  testerPriceLine, isGateResponse, createGateWatch, stillFinishing, overviewChip, publicFlags, FREE_ENDED_HEADING, RETURNING_LINE, legalPageFor,
} from "./billing.mjs";

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

// Round 2, item 4: a broker whose one free period is behind them (the server's billing.freeUsed) is told the charge starts today,
// not offered a free trial Checkout won't give. Only for needs_card; a loan officer still sees lo_locked.
test("gateScreen: needs_card with freeUsed is free_ended for a broker; anything else is as before", () => {
  const needsCard = { ok: false, reason: "needs_card" };
  assert.equal(gateScreen(needsCard, "broker", { enabled: true, freeUsed: true }), "free_ended");
  assert.equal(gateScreen(needsCard, "broker", { enabled: true, freeUsed: false }), "start_trial");
  assert.equal(gateScreen(needsCard, "broker", { enabled: true }), "start_trial");
  assert.equal(gateScreen(needsCard, "broker", null), "start_trial");
  assert.equal(gateScreen(needsCard, "broker", { freeUsed: "yes" }), "start_trial", "only a true counts");
  assert.equal(gateScreen(needsCard, "lo", { freeUsed: true }), "lo_locked");
  assert.equal(gateScreen({ ok: false, reason: "ended" }, "broker", { freeUsed: true }), "ended");
  assert.equal(gateScreen({ ok: false, reason: "terms" }, "broker", { freeUsed: true }), "terms");
  assert.equal(gateScreen({ ok: true }, "broker", { freeUsed: true }), null);
});

test("FREE_ENDED_HEADING and the returning line it shows", () => {
  assert.equal(FREE_ENDED_HEADING, "Your free month has ended");
  assert.equal(RETURNING_LINE, "$99 a month, plus $49 for each additional user, starting today, until you cancel.");
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

test("registerExtras: all on when billing is on, all off otherwise", () => {
  assert.deepEqual(registerExtras(true), { showPrice: true, showTerms: true, showTesterCode: true });
  assert.deepEqual(registerExtras(false), { showPrice: false, showTerms: false, showTesterCode: false });
  assert.deepEqual(registerExtras(undefined), { showPrice: false, showTerms: false, showTesterCode: false });
});

test("removeConfirmText: accepted with billing on and off, and pending", () => {
  const jane = { inviteAccepted: true, firstName: "Jane", lastName: "Smith", email: "j@x.com" };
  assert.equal(removeConfirmText(jane, { billingOn: true }),
    "Remove Jane Smith? They'll be signed out right away, their clients move to you, and you'll stop paying for them.");
  // billing off (the live site today): nothing about paying
  assert.equal(removeConfirmText(jane, { billingOn: false }),
    "Remove Jane Smith? They'll be signed out right away and their clients move to you.");
  assert.equal(removeConfirmText(jane), "Remove Jane Smith? They'll be signed out right away and their clients move to you.");
  assert.equal(removeConfirmText({ ...jane, inviteAccepted: false }, { billingOn: true }), "Cancel the invitation to j@x.com?");
  assert.equal(removeConfirmText({ inviteAccepted: false, firstName: "Jane", lastName: "Smith", email: "j@x.com" }),
    "Cancel the invitation to j@x.com?");
});

test("testerPriceLine: a tester month with no card says when the charge starts and how much (I4)", () => {
  const tester = { ...base, testerUntil: at(11, 30), monthlyTotalCents: 9900, hasCard: false };
  assert.equal(testerPriceLine(tester, NOW), "From Nov 30, 2026 we'll charge $99 a month until you cancel.");
  assert.equal(testerPriceLine({ ...tester, users: 5, monthlyTotalCents: 29500 }, NOW), "From Nov 30, 2026 we'll charge $295 a month until you cancel.");
  // a tester whose Stripe trial is running (no card yet) too
  assert.equal(testerPriceLine({ ...tester, status: "trialing", trialEnd: at(11, 30) }, NOW), "From Nov 30, 2026 we'll charge $99 a month until you cancel.");
  // the total from the user count when the server's own number is missing
  assert.equal(testerPriceLine({ ...tester, users: 3, monthlyTotalCents: undefined }, NOW), "From Nov 30, 2026 we'll charge $197 a month until you cancel.");
  // nothing otherwise: a card on file, an exempt account, the month over or never given, cancelled, billing off, no billing at all
  assert.equal(testerPriceLine({ ...tester, hasCard: true }, NOW), null);
  assert.equal(testerPriceLine({ ...tester, exempt: true }, NOW), null);
  assert.equal(testerPriceLine({ ...tester, testerUntil: at(11, 1) }, NOW), null);
  assert.equal(testerPriceLine({ ...tester, testerUntil: null }, NOW), null);
  assert.equal(testerPriceLine({ ...tester, cancelAtPeriodEnd: true }, NOW), null);
  assert.equal(testerPriceLine({ ...tester, enabled: false }, NOW), null);
  assert.equal(testerPriceLine(null, NOW), null);
  assert.equal(testerPriceLine({ enabled: false }), null);
});

test("isGateResponse: a 402 from our own /api/ only", () => {
  const ORIGIN = "https://app.test";
  assert.equal(isGateResponse("/api/clients", 402), true);
  assert.equal(isGateResponse("/api/org/stats?x=1", 402, ORIGIN), true);
  assert.equal(isGateResponse(`${ORIGIN}/api/clients`, 402, ORIGIN), true);
  assert.equal(isGateResponse(new URL(`${ORIGIN}/api/clients`), 402, ORIGIN), true);
  assert.equal(isGateResponse({ url: `${ORIGIN}/api/rates` }, 402, ORIGIN), true, "a Request");
  for (const status of [200, 401, 403, 404, 409, 500]) assert.equal(isGateResponse("/api/clients", status, ORIGIN), false, String(status));
  assert.equal(isGateResponse("/terms", 402, ORIGIN), false);
  assert.equal(isGateResponse("/apiary", 402, ORIGIN), false);
  assert.equal(isGateResponse("https://other.test/api/clients", 402, ORIGIN), false, "another site");
  assert.equal(isGateResponse("https://other.test/api/clients", 402), false);
  assert.equal(isGateResponse(undefined, 402, ORIGIN), false);
  assert.equal(isGateResponse("not a url", 402, ORIGIN), false);
});

test("createGateWatch: a burst of 402s reads the status once; a later one reads it again; stop cancels", async () => {
  const timers = [];
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const cleared = [];
  const clearTimer = (id) => { cleared.push(id); };
  let reads = 0;
  let finishRead;
  const watch = createGateWatch({ onGate: () => { reads++; return new Promise((r) => { finishRead = r; }); }, delayMs: 250, setTimer, clearTimer });
  watch.saw("/api/clients", 402);
  watch.saw("/api/org/stats", 402);
  watch.saw("/api/notifications", 402);
  watch.saw("/api/clients", 200);
  assert.equal(timers.length, 1, "one status read scheduled for the burst");
  assert.equal(timers[0].ms, 250);
  timers[0].fn();
  assert.equal(reads, 1);
  watch.saw("/api/clients", 402);
  assert.equal(timers.length, 1, "not while that read is still running");
  finishRead();
  await new Promise((r) => setTimeout(r, 0));
  watch.saw("/api/clients", 402);
  assert.equal(timers.length, 2, "a later 402 reads it again");
  watch.stop();
  assert.deepEqual(cleared, [2]);
  // a failed read never stops the watch
  const failing = createGateWatch({ onGate: () => Promise.reject(new Error("offline")), delayMs: 1, setTimer, clearTimer });
  failing.saw("/api/clients", 402);
  timers.at(-1).fn();
  await new Promise((r) => setTimeout(r, 0));
  failing.saw("/api/clients", 402);
  assert.equal(timers.length, 4);
});

test("stillFinishing: back from Stripe, the status is read again while access is not open (M5)", () => {
  assert.equal(stillFinishing({ access: { ok: false, reason: "needs_card" }, billing: { status: "none" } }), true);
  // a status that has moved on but still locks (an incomplete first payment, say) keeps waiting: the webhook may still land
  assert.equal(stillFinishing({ access: { ok: false, reason: "needs_card" }, billing: { status: "incomplete" } }), true);
  assert.equal(stillFinishing({ access: { ok: false, reason: "ended" }, billing: { status: "canceled" } }), true);
  assert.equal(stillFinishing({ access: { ok: true }, billing: { status: "trialing" } }), false);
  assert.equal(stillFinishing(null), false);
});

test("overviewChip: the plan chip only with billing on (I2)", () => {
  const stats = { loCount: 2, totalClients: 9, plan: "trial", trialEnds: "2026-11-30T12:00:00.000Z" };
  assert.equal(overviewChip(stats, false), null, "billing off: the live site shows no chip today");
  assert.equal(overviewChip({ ...stats, plan: "trialing" }, undefined), null);
  assert.deepEqual(overviewChip({ ...stats, plan: "trialing" }, true), { label: "Free trial", trialEnd: "Nov 30, 2026" });
  assert.deepEqual(overviewChip({ ...stats, plan: "active", trialEnds: null }, true), { label: "Active", trialEnd: null });
  assert.equal(overviewChip({ ...stats, plan: null }, true), null);
  assert.equal(overviewChip(null, true), null);
});

test("publicFlags: billing and feedback from /api/billing/public; anything else is off", () => {
  assert.deepEqual(publicFlags({ enabled: true, feedback: true }), { billing: true, feedback: true });
  assert.deepEqual(publicFlags({ enabled: false, feedback: true }), { billing: false, feedback: true });
  assert.deepEqual(publicFlags({ enabled: true }), { billing: true, feedback: false });
  assert.deepEqual(publicFlags(null), { billing: false, feedback: false });
  assert.deepEqual(publicFlags({ enabled: "yes", feedback: 1 }), { billing: false, feedback: false }, "only a true is on");
});

// Round 2, item 8: the Terms and Privacy drafts show only while billing is on; with billing off /terms and /privacy are the normal
// app, as before billing. Until GET /api/billing/public has answered (null), the page waits rather than flash either one.
test("legalPageFor: the draft only with billing on; the app with it off; wait until the public read is back", () => {
  assert.equal(legalPageFor("/terms", true), "terms");
  assert.equal(legalPageFor("/privacy", true), "privacy");
  assert.equal(legalPageFor("/terms", false), null);
  assert.equal(legalPageFor("/privacy", false), null);
  assert.equal(legalPageFor("/terms", null), "wait");
  assert.equal(legalPageFor("/privacy", undefined), "wait");
  for (const other of ["/", "/terms/", "/Terms", "/privacy.html", "/termsx", "", undefined]) {
    assert.equal(legalPageFor(other, true), null, String(other));
    assert.equal(legalPageFor(other, null), null, `${other}: other paths never wait`);
  }
});
