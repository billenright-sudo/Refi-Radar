"use strict";
// The work a Stripe event leaves (lib/billing/events.js says which), run before the webhook answers (Cloud Run throttles the CPU once
// a response has gone): cancel and refund a second subscription (H1), put the user count back (H2), send the confirmation email
// (H6). Each runs on its own and a failure never stops the rest. A failure is logged as "<type> failed for org <our org id>: " plus
// the error's own message; we never add a Stripe id, an address, an object or a secret to a log line, but Stripe's own message can
// name one of its ids.
const { seatCount, syncSeats } = require("./seats");
const { CONFIRMABLE, duplicateIds } = require("./events");
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

// Organizations whose confirmation is being sent right now: two events landing together must not send two emails (one instance).
const confirming = new Set();

// The confirmation email (spec §6.1.5), to the broker only, once per brokerage: the flag is set only after a send that really went,
// so a failure is tried again on the next event, but only while the trial or tester month runs (CONFIRMABLE: never once active).
// A tester month with no card yet gets the test-month wording; everyone else the trial wording. Nothing is sent without an end date.
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
    else console.error(`[billing] confirmation email not sent for org ${orgId}`);
  } finally {
    confirming.delete(orgId);
  }
}

// Organizations whose recorded duplicates are being worked on right now, so two events landing together don't both work them.
const retrying = new Set();

function dropDuplicate(db, orgId, subscriptionId) {
  const row = db.prepare("SELECT billing_duplicate_pending FROM organizations WHERE id = ?").get(orgId);
  const rest = duplicateIds(row?.billing_duplicate_pending).filter((id) => id !== subscriptionId);
  db.prepare("UPDATE organizations SET billing_duplicate_pending = ? WHERE id = ?").run(rest.length ? rest.join(" ") : null, orgId);
}

// Works on the second subscriptions recorded for the organization (H1, billing_duplicate_pending) and nothing else: each is cancelled
// if still live and its latest paid invoice refunded unless already refunded (the gateway's recorded-duplicate rules), then its
// record is cleared. A failure keeps the record and is logged, so the next webhook event for the organization (or the billing status
// call) tries again. Never throws.
async function retryPendingDuplicate(db, gateway, orgId) {
  if (orgId == null || retrying.has(orgId)) return;
  const row = db.prepare("SELECT billing_duplicate_pending FROM organizations WHERE id = ?").get(orgId);
  const ids = duplicateIds(row?.billing_duplicate_pending);
  if (!ids.length) return;
  retrying.add(orgId);
  try {
    for (const subscriptionId of ids) {
      try {
        const result = await gateway.cancelAndRefund(subscriptionId, { recorded: true });
        dropDuplicate(db, orgId, subscriptionId);
        console.log(`[billing] second subscription for org ${orgId}: cancelled ${result?.cancelled ? "now" : "already"}, refunded ${result?.refunded ? "yes" : "no"}`);
      } catch (err) {
        console.error(`[billing] cancel_duplicate failed for org ${orgId}:`, err?.message);
      }
    }
  } finally {
    retrying.delete(orgId);
  }
}

// `config` is part of the call so later follow-ups can read settings; none of today's need it.
async function runFollowUps({ db, gateway, send }, followUps) {
  for (const followUp of followUps || []) {
    try {
      if (followUp.type === "cancel_duplicate") {
        await retryPendingDuplicate(db, gateway, followUp.orgId);
      } else if (followUp.type === "sync_seats") {
        await syncSeats(db, gateway, followUp.orgId);
      } else if (followUp.type === "confirm") {
        await sendConfirmation(db, send, followUp.orgId);
      }
    } catch (err) {
      console.error(`[billing] ${followUp.type} failed for org ${followUp.orgId}:`, err?.message);
    }
  }
}

module.exports = { runFollowUps, retryPendingDuplicate, totalLine, formatEndDate };
