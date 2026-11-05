"use strict";
// The work a Stripe event leaves for after the webhook has answered (lib/billing/events.js says which): cancel a second subscription
// (H1), put the user count back (H2), send the confirmation email (H6). Each runs on its own: a failure is logged by its message
// only (never an id, an address or a Stripe object) and the rest still run.
const { seatCount, syncSeats } = require("./seats");
const { BASE_CENTS, ADDITIONAL_CENTS, monthlyTotalCents } = require("./config");

const money = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// The price for this many users, worded as the Billing page words it (spec §6.5).
function totalLine(users) {
  const extra = Math.max(0, users - 1);
  if (extra === 0) return `Brokerage ${money(BASE_CENTS)} a month`;
  return `Brokerage ${money(BASE_CENTS)} + ${extra} additional user${extra === 1 ? "" : "s"} × ${money(ADDITIONAL_CENTS)} = `
    + `${money(monthlyTotalCents(users))} a month`;
}

// "Nov 19, 2026", the client's date style. UTC, like every other billing date here (the tester code's expiry day is a UTC day too).
const formatEndDate = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const CONFIRMABLE = new Set(["trialing", "active"]);
// Organizations whose confirmation is being sent right now: two events landing together must not send two emails (one instance).
const confirming = new Set();

// The confirmation email (spec §6.1.5), to the broker only, once per brokerage: the flag is set only after a send that really went,
// so a failure is tried again on the next event. A tester month with no card yet gets the test-month wording; everyone else the
// trial wording. Nothing is sent without a trial or test-month end to name.
async function sendConfirmation(db, send, orgId) {
  if (confirming.has(orgId)) return;
  confirming.add(orgId);
  try {
    const org = db.prepare(`
      SELECT name, billing_status, billing_trial_end, billing_confirmation_sent, billing_via_tester_code, billing_has_card
      FROM organizations WHERE id = ?
    `).get(orgId);
    if (!org || org.billing_confirmation_sent || !CONFIRMABLE.has(org.billing_status) || !org.billing_trial_end) return;
    const broker = db.prepare(
      "SELECT email, first_name FROM users WHERE org_id = ? AND role = 'broker' AND removed_at IS NULL ORDER BY id LIMIT 1"
    ).get(orgId);
    if (!broker) return;
    const ok = await send({
      to: broker.email,
      firstName: broker.first_name,
      orgName: org.name,
      kind: org.billing_via_tester_code && !org.billing_has_card ? "tester" : "trial",
      endDate: formatEndDate(org.billing_trial_end),
      totalLine: totalLine(seatCount(db, orgId)),
    });
    if (ok === true) db.prepare("UPDATE organizations SET billing_confirmation_sent = 1 WHERE id = ?").run(orgId);
    else console.error("[billing] confirmation email not sent");
  } finally {
    confirming.delete(orgId);
  }
}

// `config` is part of the call so later follow-ups can read settings; none of today's need it.
async function runFollowUps({ db, gateway, send }, followUps) {
  for (const followUp of followUps || []) {
    try {
      if (followUp.type === "cancel_duplicate") {
        const result = await gateway.cancelAndRefund(followUp.subscriptionId);
        console.log(`[billing] second subscription cancelled: ${result?.cancelled ? "yes" : "no (already ended)"}, refunded: ${result?.refunded ? "yes" : "no"}`);
      } else if (followUp.type === "sync_seats") {
        await syncSeats(db, gateway, followUp.orgId);
      } else if (followUp.type === "confirm") {
        await sendConfirmation(db, send, followUp.orgId);
      }
    } catch (err) {
      console.error(`[billing] ${followUp.type} failed:`, err?.message);
    }
  }
}

module.exports = { runFollowUps, totalLine, formatEndDate };
