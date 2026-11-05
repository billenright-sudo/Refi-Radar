"use strict";
// What a Stripe webhook event does to an organization's billing columns (spec §6.4). Synchronous, and in one transaction with the
// record of the event's id, so a replay changes nothing and a failure records nothing (Stripe then sends it again). Whatever has to
// reach Stripe or send mail comes back as a follow-up, for lib/billing/followUps.js to run once the webhook has answered:
//   { type: "cancel_duplicate", subscriptionId }  a second live subscription for an organization that already has one (H1)
//   { type: "sync_seats", orgId }                 Stripe's quantity isn't the organization's user count (H2)
//   { type: "confirm", orgId }                    the confirmation email is still owed (H6)
// The organization is the one named in the object's metadata (org_id, which our Checkout and tester subscriptions carry), else the
// one holding the object's subscription or customer id. Times are epoch ms; Stripe's are whole seconds.
const { seatCount } = require("./seats");

const LIVE = new Set(["trialing", "active", "past_due"]);
// Statuses only a subscription that really started can reach: once seen, the organization never gets a free trial again.
const STARTED = new Set([...LIVE, "unpaid", "paused"]);
// The confirmation is owed while it hasn't gone out and the subscription is running, so a failed send is tried again on the next
// event (ruling 2 of the build ledger).
const CONFIRMABLE = new Set(["trialing", "active"]);

const idOf = (v) => (typeof v === "string" ? v : v && typeof v.id === "string" ? v.id : null);
const msOf = (seconds) => (Number.isFinite(seconds) ? seconds * 1000 : null);
const ignored = () => ({ outcome: "ignored", followUps: [] });
const orgById = (db, id) => db.prepare("SELECT * FROM organizations WHERE id = ?").get(id);

function findOrg(db, { orgIds = [], subscriptionId = null, customerId = null }) {
  for (const raw of orgIds) {
    if (!/^\d+$/.test(String(raw ?? ""))) continue;
    const row = orgById(db, Number(raw));
    if (row) return row;
  }
  if (subscriptionId) {
    const row = db.prepare("SELECT * FROM organizations WHERE stripe_subscription_id = ?").get(subscriptionId);
    if (row) return row;
  }
  if (customerId) {
    const row = db.prepare("SELECT * FROM organizations WHERE stripe_customer_id = ?").get(customerId);
    if (row) return row;
  }
  return null;
}

// H1: the organization already holds a different subscription that is live. This check comes before the age check on purpose: two
// card pages finished a second apart can be delivered in either order, and the second subscription must be cancelled either way.
// (A late event for an old subscription that has really ended is harmless: the gateway looks at it again before cancelling or
// refunding anything.)
const holdsAnotherLive = (org, subscriptionId) =>
  Boolean(org.stripe_subscription_id && subscriptionId && org.stripe_subscription_id !== subscriptionId && LIVE.has(org.billing_status));
const olderThanApplied = (org, eventMs) => org.billing_event_at != null && eventMs < org.billing_event_at;

function applySubscription(db, org, sub, eventMs, nowMs) {
  if (holdsAnotherLive(org, sub.id)) {
    // A live newcomer is a second subscription: cancel it and leave the organization's state alone. One that isn't live (the
    // duplicate's own "deleted" event, say) says nothing about the organization's subscription.
    if (LIVE.has(sub.status)) return { outcome: "applied", followUps: [{ type: "cancel_duplicate", subscriptionId: sub.id }] };
    return ignored();
  }
  // Stripe's times are whole seconds, so only a strictly older event is stale: one from the same second still applies.
  if (olderThanApplied(org, eventMs)) return ignored();

  const item = sub.items?.data?.[0] ?? {};
  // Recent API versions keep the period end on the item rather than on the subscription.
  const periodEnd = msOf(sub.current_period_end ?? item.current_period_end);
  const live = LIVE.has(sub.status);
  db.prepare(`
    UPDATE organizations SET
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = ?,
      stripe_item_id = COALESCE(?, stripe_item_id),
      billing_status = COALESCE(?, billing_status),
      billing_quantity = COALESCE(?, billing_quantity),
      billing_trial_end = ?,
      billing_period_end = ?,
      billing_cancel_at_period_end = ?,
      billing_has_card = MAX(billing_has_card, ?),
      billing_ever_subscribed = MAX(billing_ever_subscribed, ?),
      billing_pending_checkout = CASE WHEN ? THEN NULL ELSE billing_pending_checkout END,
      billing_event_at = MAX(COALESCE(billing_event_at, 0), ?),
      billing_synced_at = ?
    WHERE id = ?
  `).run(
    idOf(sub.customer), sub.id, typeof item.id === "string" ? item.id : null, typeof sub.status === "string" ? sub.status : null,
    Number.isInteger(item.quantity) ? item.quantity : null, msOf(sub.trial_end), periodEnd, sub.cancel_at_period_end ? 1 : 0,
    // A card is only ever added here: a Checkout card sits on the subscription, a portal card on the customer, and neither event
    // shows the other, so one without a card can't tell us there is none.
    sub.default_payment_method ? 1 : 0, STARTED.has(sub.status) ? 1 : 0,
    // a live subscription means the card step is done, so no Checkout is pending any more
    live ? 1 : 0, eventMs, nowMs, org.id,
  );

  const followUps = [];
  if (live && typeof item.id === "string" && Number.isInteger(item.quantity) && item.quantity !== seatCount(db, org.id)) {
    followUps.push({ type: "sync_seats", orgId: org.id });
  }
  if (!org.billing_confirmation_sent && CONFIRMABLE.has(sub.status)) followUps.push({ type: "confirm", orgId: org.id });
  return { outcome: "applied", followUps };
}

// A finished Checkout: the customer, the subscription it made, and a card (Checkout always collects one). It doesn't carry the
// subscription's own state, so the status and the pending Checkout are left for the subscription event (or the status call's re-read
// through that pending Checkout, H4); it doesn't move billing_event_at for the same reason.
function applyCheckout(db, session, eventMs) {
  if (session.mode !== "subscription") return ignored();
  const subscriptionId = idOf(session.subscription);
  const customerId = idOf(session.customer);
  const org = findOrg(db, { orgIds: [session.client_reference_id, session.metadata?.org_id], customerId });
  if (!org) return ignored();
  if (holdsAnotherLive(org, subscriptionId)) {
    return { outcome: "applied", followUps: [{ type: "cancel_duplicate", subscriptionId }] };
  }
  if (olderThanApplied(org, eventMs)) return ignored();
  // A new subscription replacing an ended one: the old item and quantity are not its own, so they go until its event arrives.
  const replaced = subscriptionId && subscriptionId !== org.stripe_subscription_id ? 1 : 0;
  db.prepare(`
    UPDATE organizations SET
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id),
      stripe_item_id = CASE WHEN ? THEN NULL ELSE stripe_item_id END,
      billing_quantity = CASE WHEN ? THEN NULL ELSE billing_quantity END,
      billing_has_card = 1
    WHERE id = ?
  `).run(customerId, subscriptionId, replaced, replaced, org.id);
  return { outcome: "applied", followUps: [] };
}

// The customer changed: a default card on it (a tester adding one in the portal) means there is a card. Only ever adds one (see
// applySubscription), so its order against other events doesn't matter and it is applied whatever its age.
function applyCustomer(db, customer) {
  const org = findOrg(db, { orgIds: [customer.metadata?.org_id], customerId: customer.id });
  if (!org || (org.stripe_customer_id && org.stripe_customer_id !== customer.id)) return ignored();
  if (customer.invoice_settings?.default_payment_method) {
    db.prepare("UPDATE organizations SET billing_has_card = 1 WHERE id = ?").run(org.id);
  }
  return { outcome: "applied", followUps: [] };
}

function handle(db, event, nowMs) {
  const object = event.data?.object;
  if (!object || typeof object !== "object") return ignored();
  const eventMs = msOf(event.created) ?? nowMs;
  switch (event.type) {
    case "checkout.session.completed":
      return applyCheckout(db, object, eventMs);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (typeof object.id !== "string") return ignored();
      const org = findOrg(db, { orgIds: [object.metadata?.org_id], subscriptionId: object.id, customerId: idOf(object.customer) });
      return org ? applySubscription(db, org, object, eventMs, nowMs) : ignored();
    }
    case "customer.updated":
      return typeof object.id === "string" ? applyCustomer(db, object) : ignored();
    default:
      // invoice events and the rest: acknowledged and ignored (the subscription events carry the status)
      return ignored();
  }
}

function applyStripeEvent(db, event, nowMs = Date.now()) {
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") return ignored();
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM stripe_events WHERE id = ?").get(event.id)) return { outcome: "duplicate", followUps: [] };
    const result = handle(db, event, nowMs);
    db.prepare("INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").run(event.id, event.type, nowMs);
    return result;
  })();
}

// The same rules for a subscription read from Stripe outside a webhook (the status call's re-read, the tester month's new
// subscription): eventCreatedMs is when it was read.
function storeSubscription(db, orgId, subscription, eventCreatedMs, nowMs = Date.now()) {
  const org = orgById(db, orgId);
  if (!org || !subscription || typeof subscription.id !== "string") return [];
  return applySubscription(db, org, subscription, eventCreatedMs, nowMs).followUps;
}

module.exports = { applyStripeEvent, storeSubscription };
