"use strict";
// The work a Stripe event leaves (lib/billing/events.js says which), run before the webhook answers (Cloud Run throttles the CPU once
// a response has gone): cancel and refund a second subscription (H1), put the user count back (H2), send the confirmation email
// (H6). Each runs on its own and a failure never stops the rest. A failure is logged as "<type> failed for org <our org id>: " plus
// the error's own message; we never add a Stripe id, an address, an object or a secret to a log line, but Stripe's own message can
// name one of its ids.
const { seatCount, syncSeats } = require("./seats");
const { CONFIRMABLE, LIVE, duplicateIds, storeSubscription } = require("./events");
const { BASE_CENTS, ADDITIONAL_CENTS, monthlyTotalCents } = require("./config");
const { formatDateIn } = require("../timeZone");

const money = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// The price for this many users, worded as the Billing page words it (spec §6.5).
function totalLine(users) {
  const extra = Math.max(0, users - 1);
  if (extra === 0) return `Brokerage ${money(BASE_CENTS)} a month`;
  return `Brokerage ${money(BASE_CENTS)} + ${extra} additional user${extra === 1 ? "" : "s"} × ${money(ADDITIONAL_CENTS)} = `
    + `${money(monthlyTotalCents(users))} a month`;
}

// "Nov 19, 2026", the client's date style, on the broker's own day (round 2, item 5): `timeZone` is users.time_zone, from the sign-up
// form; none, or one that is not a real zone, is America/New_York. (The app shows the same instant in the browser's own zone.)
const formatEndDate = (ms, timeZone) => formatDateIn(ms, timeZone);

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
      "SELECT email, first_name, time_zone FROM users WHERE org_id = ? AND role = 'broker' AND removed_at IS NULL ORDER BY id LIMIT 1"
    ).get(orgId);
    if (!broker) return;
    const ok = await send({
      to: broker.email,
      firstName: broker.first_name,
      orgName: org.name,
      kind: org.billing_via_tester_code && !org.billing_has_card ? "tester" : "trial",
      endDate: formatEndDate(org.billing_trial_end, broker.time_zone),
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

// Stripe's own end states: a subscription in one of them never charges or starts again (the gateway's rule too).
const OVER_AT_STRIPE = new Set(["canceled", "incomplete_expired"]);

// Works on the second subscriptions recorded for the organization (H1, billing_duplicate_pending) and nothing else. For each, the
// organization's stored row is read again (an event may have changed it since the list was read), and then:
//   - it is the organization's own live subscription now (adopted after its first ended): only taken off the record;
//   - the organization holds a different live subscription: it really is a second one, so it is cancelled if still live and its
//     latest paid invoice refunded unless already refunded (the gateway's recorded-duplicate rules), then taken off the record;
//   - otherwise (the first has ended, or the stored status is stale) Stripe's own view decides (M1), so a retry never cancels the
//     only subscription a brokerage has: one Stripe still has going is adopted, stored by the webhook's own rules as of this read
//     (taken off the record, and its follow-ups run: the user count, and the confirmation when `send` is given); one that has ended
//     at Stripe goes to cancelAndRefund, which refunds it only if it carries our cancel's mark (ruling 16).
// A failure (a read included) keeps the record and is logged, so the next webhook event for the organization (or the billing status
// call) tries again. Never throws.
async function retryPendingDuplicate(db, gateway, orgId, send) {
  if (orgId == null || retrying.has(orgId)) return;
  const row = db.prepare("SELECT billing_duplicate_pending FROM organizations WHERE id = ?").get(orgId);
  const ids = duplicateIds(row?.billing_duplicate_pending);
  if (!ids.length) return;
  retrying.add(orgId);
  try {
    for (const subscriptionId of ids) {
      try {
        const own = db.prepare("SELECT stripe_subscription_id, billing_status, billing_event_at FROM organizations WHERE id = ?").get(orgId);
        const ownLive = Boolean(own?.stripe_subscription_id) && LIVE.has(own.billing_status);
        if (ownLive && own.stripe_subscription_id === subscriptionId) {
          dropDuplicate(db, orgId, subscriptionId);
          console.log(`[billing] second subscription for org ${orgId} is now its only one: kept, not cancelled`);
          continue;
        }
        if (!ownLive) {
          const subscription = await gateway.retrieveSubscription(subscriptionId);
          if (!subscription || typeof subscription.status !== "string") throw new Error("the subscription couldn't be read");
          if (!OVER_AT_STRIPE.has(subscription.status)) {
            // A fresh read is newer than every event applied before it, even one stamped by a Stripe clock a little ahead of ours.
            const readMs = Math.max(Math.floor(Date.now() / 1000) * 1000, own?.billing_event_at ?? 0);
            const followUps = storeSubscription(db, orgId, subscription, readMs);
            const now = db.prepare("SELECT stripe_subscription_id FROM organizations WHERE id = ?").get(orgId);
            if (now?.stripe_subscription_id !== subscriptionId) throw new Error("the subscription couldn't be stored yet");
            // A live one came off the record in that write; one still unpaid or paused does too: we never ended it, so no refund is owed.
            dropDuplicate(db, orgId, subscriptionId);
            console.log(`[billing] second subscription for org ${orgId} is its only one now: adopted, not cancelled`);
            await runFollowUps({ db, gateway, send }, followUps.filter((f) => f.type !== "cancel_duplicate" && (send || f.type !== "confirm")));
            continue;
          }
        }
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
        await retryPendingDuplicate(db, gateway, followUp.orgId, send);
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
