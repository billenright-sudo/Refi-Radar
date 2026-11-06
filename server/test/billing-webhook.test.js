"use strict";
// The Stripe webhook (routes/billingWebhook.js), the event rules (lib/billing/events.js), the follow-ups (lib/billing/followUps.js,
// syncSeats in lib/billing/seats.js) and the confirmation email (email.js). Throwaway DB. Nothing here reaches Stripe or sends mail:
// the gateway is a fake that records its calls, the sender comes in through the app seam, and the signed bodies are made offline
// with the real stripe package's test helper.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-billing-webhook-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const Stripe = require("stripe");

const db = require("../db");
const webhookRoutes = require("../routes/billingWebhook");
const { applyStripeEvent, storeSubscription } = require("../lib/billing/events");
const { runFollowUps, retryPendingDuplicate, totalLine, formatEndDate } = require("../lib/billing/followUps");
const { syncSeats } = require("../lib/billing/seats");
const { accessFor } = require("../lib/billing/access");
const { checkoutPlan } = require("../lib/billing/plan");
const { billingConfirmationMessage } = require("../email");

const SECRET = "whsec_test";
const CONFIG = Object.freeze({
  enabled: true, stripeConfigured: true, secretKey: "sk_test_must_never_be_logged", webhookSecret: SECRET, priceId: "price_test",
});
const DAY = 86_400;
const T0 = Math.floor(Date.now() / 1000);   // Stripe's times are whole seconds
const NOW = T0 * 1000;
const TRIAL_END = T0 + 14 * DAY;

// The fake gateway: the signature check is the real stripe package's (offline HMAC); everything that would reach Stripe is recorded.
// retrieveImpl answers a subscription read (Stripe's own view of one); by default Stripe has none, as for an id it doesn't know.
let calls, cancelImpl, quantityImpl, retrieveImpl;
const gateway = {
  constructEvent: (raw, sig, secret) => Stripe.webhooks.constructEvent(raw, sig, secret),
  cancelAndRefund: async (id, opts) => { calls.push(["cancelAndRefund", id, opts]); return cancelImpl(id, opts); },
  setQuantity: async (args) => { calls.push(["setQuantity", args]); return quantityImpl(args); },
  retrieveSubscription: async (id) => { calls.push(["retrieveSubscription", id]); return retrieveImpl(id); },
};
let sent, sendImpl;
const send = async (args) => { sent.push(args); return sendImpl(args); };

let server, app, base;
before(async () => {
  app = express();
  app.use("/api/billing/webhook", webhookRoutes);
  app.use(express.json());   // after the webhook, as in index.js
  app.set("sendBillingConfirmation", send);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  calls = []; sent = [];
  cancelImpl = async () => ({ cancelled: true, refunded: false });
  quantityImpl = async () => {};
  retrieveImpl = async () => { throw new Error("No such subscription"); };
  sendImpl = async () => true;
  app.set("billingConfig", { ...CONFIG });
  app.set("billingGateway", gateway);
});

// An organization with its broker; `seats` counts the broker. Pending invites and removed loan officers are never seats.
let orgSeq = 0;
function addOrg({ seats = 1, pending = 0, removed = 0, ...cols } = {}) {
  const n = ++orgSeq;
  const orgId = Number(db.prepare("INSERT INTO organizations (name, billing_status) VALUES (?, 'none')").run(`Org ${n}`).lastInsertRowid);
  const user = db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted, removed_at) VALUES (?, ?, ?, 'Smith', ?, 'h', ?, ?)"
  );
  user.run(orgId, "broker", "Bea", `broker${n}@x.test`, 1, null);
  for (let i = 1; i < seats; i++) user.run(orgId, "lo", "Lou", `lo${n}-${i}@x.test`, 1, null);
  for (let i = 0; i < pending; i++) user.run(orgId, "lo", "Pat", `pending${n}-${i}@x.test`, 0, null);
  for (let i = 0; i < removed; i++) user.run(orgId, "lo", "Rem", `removed${n}-${i}@x.test`, 1, NOW);
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE organizations SET ${k} = ? WHERE id = ?`).run(v, orgId);
  return orgId;
}
const orgRow = (id) => db.prepare("SELECT * FROM organizations WHERE id = ?").get(id);
const eventCount = () => db.prepare("SELECT COUNT(*) AS n FROM stripe_events").get().n;

// A Stripe subscription as a recent API version sends it: the period end sits on the item, not the subscription.
function subscription(orgId, over = {}) {
  const { item = {}, ...rest } = over;
  return {
    id: `sub_${orgId}`, object: "subscription", customer: `cus_${orgId}`, status: "trialing",
    trial_end: TRIAL_END, cancel_at_period_end: false, default_payment_method: `pm_${orgId}`,
    metadata: { org_id: String(orgId) },
    items: { object: "list", data: [{ id: `si_${orgId}`, object: "subscription_item", quantity: 1, current_period_end: TRIAL_END, ...item }] },
    ...rest,
  };
}
const checkoutSession = (orgId, over = {}) => ({
  id: `cs_${orgId}`, object: "checkout.session", mode: "subscription", status: "complete", client_reference_id: String(orgId),
  customer: `cus_${orgId}`, subscription: `sub_${orgId}`, metadata: {}, ...over,
});
let evSeq = 0;
const event = (type, object, created = T0) => ({ id: `evt_${++evSeq}`, object: "event", type, created, livemode: false, data: { object } });

// One webhook call, signed with `secret` (or with the given `signature`; null sends none). `body` replaces the signed payload.
async function post(ev, { secret = SECRET, signature, body } = {}) {
  const payload = JSON.stringify(ev);
  const headers = { "content-type": "application/json" };
  const sig = signature !== undefined ? signature : Stripe.webhooks.generateTestHeaderString({ payload, secret });
  if (sig !== null) headers["stripe-signature"] = sig;
  const res = await fetch(base + "/api/billing/webhook", { method: "POST", headers, body: body ?? payload });
  let data = null;
  try { data = await res.json(); } catch { /* no JSON body */ }
  return { status: res.status, data };
}

// The follow-ups run after the answer, so a test that looks at what they did waits for it.
async function until(check, ms = 1000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40));   // room for a wrong follow-up to show up

test("a bad or missing signature is 400 and changes nothing; billing off is 404", async () => {
  const orgId = addOrg();
  const ev = event("customer.subscription.created", subscription(orgId));
  for (const opts of [{ secret: "whsec_wrong" }, { signature: null }, { signature: "" }, { signature: "t=1,v1=00" }]) {
    const r = await post(ev, opts);
    assert.strictEqual(r.status, 400, JSON.stringify(opts));
    assert.deepStrictEqual(r.data, { success: false });
  }
  // a body changed after it was signed, and a signed body that isn't JSON
  const payload = JSON.stringify(ev);
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  assert.strictEqual((await post(ev, { signature: sig, body: payload.replace('"trialing"', '"active"') })).status, 400);
  const notJson = "not json";
  assert.strictEqual((await post(ev, { signature: Stripe.webhooks.generateTestHeaderString({ payload: notJson, secret: SECRET }), body: notJson })).status, 400);
  // over 1 MB is refused before anything is read into an event
  const big = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
  const tooBig = await post(ev, { signature: Stripe.webhooks.generateTestHeaderString({ payload: big, secret: SECRET }), body: big });
  assert.strictEqual(tooBig.status, 413);
  assert.deepStrictEqual(tooBig.data, { success: false });

  // billing off (no config, enabled false, or no gateway): the route isn't there
  for (const [config, gw] of [[undefined, gateway], [{ ...CONFIG, enabled: false }, gateway], [{ ...CONFIG }, undefined]]) {
    app.set("billingConfig", config);
    app.set("billingGateway", gw);
    const r = await post(ev);
    assert.strictEqual(r.status, 404);
  }
  await settle();
  const o = orgRow(orgId);
  assert.strictEqual(o.billing_status, "none");
  assert.strictEqual(o.stripe_subscription_id, null);
  assert.strictEqual(eventCount(), 0);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(sent, []);

  // switched on again, the same signed event is taken
  app.set("billingConfig", { ...CONFIG });
  app.set("billingGateway", gateway);
  const ok = await post(ev);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.data, { received: true });
  assert.strictEqual(orgRow(orgId).billing_status, "trialing");
});

test("checkout completed stores customer, subscription and has_card; subscription events store status, dates, item, quantity", async () => {
  const orgId = addOrg({ billing_pending_checkout: "cs_open" });
  let r = await post(event("checkout.session.completed", checkoutSession(orgId, { id: "cs_open", customer: "cus_new", subscription: "sub_new" })));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, { received: true });
  let o = orgRow(orgId);
  assert.strictEqual(o.stripe_customer_id, "cus_new");
  assert.strictEqual(o.stripe_subscription_id, "sub_new");
  assert.strictEqual(o.billing_has_card, 1);
  // the subscription's own state isn't in this event: the status stays, and so does the pending Checkout, so the status call can
  // still re-read it from Stripe if the subscription event is late (H4)
  assert.strictEqual(o.billing_status, "none");
  assert.strictEqual(o.billing_pending_checkout, "cs_open");

  const created = T0 + 5;
  const before = Date.now();
  r = await post(event("customer.subscription.created",
    subscription(orgId, { id: "sub_new", customer: "cus_new", item: { id: "si_new", quantity: 1 } }), created));
  assert.strictEqual(r.status, 200);
  o = orgRow(orgId);
  const pick = (row) => Object.fromEntries([
    "stripe_customer_id", "stripe_subscription_id", "stripe_item_id", "billing_status", "billing_quantity", "billing_trial_end",
    "billing_period_end", "billing_cancel_at_period_end", "billing_has_card", "billing_ever_subscribed", "billing_event_at",
    "billing_pending_checkout",
  ].map((k) => [k, row[k]]));
  assert.deepStrictEqual(pick(o), {
    stripe_customer_id: "cus_new", stripe_subscription_id: "sub_new", stripe_item_id: "si_new", billing_status: "trialing",
    billing_quantity: 1, billing_trial_end: TRIAL_END * 1000, billing_period_end: TRIAL_END * 1000,   // from the item
    billing_cancel_at_period_end: 0, billing_has_card: 1, billing_ever_subscribed: 1, billing_event_at: created * 1000,
    billing_pending_checkout: null,   // a live subscription: the card step is done
  });
  assert.ok(o.billing_synced_at >= before && o.billing_synced_at <= Date.now());

  // an older API version: the period end on the subscription itself; the trial over; found by the stored id without metadata
  const periodEnd = T0 + 44 * DAY;
  r = await post(event("customer.subscription.updated", subscription(orgId, {
    id: "sub_new", customer: "cus_new", status: "active", trial_end: null, metadata: {}, current_period_end: periodEnd,
    item: { id: "si_new", current_period_end: undefined },
  }), created + 10));
  o = orgRow(orgId);
  assert.strictEqual(o.billing_status, "active");
  assert.strictEqual(o.billing_trial_end, null);
  assert.strictEqual(o.billing_period_end, periodEnd * 1000);
  assert.strictEqual(o.billing_event_at, (created + 10) * 1000);

  // invoice events are acknowledged and ignored; so is an event for an organization nobody knows
  const snapshot = orgRow(orgId);
  r = await post(event("invoice.paid", { id: "in_1", object: "invoice", customer: "cus_new", subscription: "sub_new" }, created + 20));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  r = await post(event("customer.subscription.created", subscription(999_999, { id: "sub_stranger", customer: "cus_stranger" }), created + 20));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  assert.deepStrictEqual(orgRow(orgId), snapshot);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE stripe_subscription_id = 'sub_stranger'").get().n, 0);

  // customer.updated: a default card on the customer (a tester adding one in the portal) counts; one without doesn't clear it,
  // because a Checkout card sits on the subscription rather than the customer
  const tester = addOrg({ stripe_customer_id: "cus_tester" });
  const customer = (pm) => ({ id: "cus_tester", object: "customer", metadata: {}, invoice_settings: { default_payment_method: pm } });
  await post(event("customer.updated", customer(null)));
  assert.strictEqual(orgRow(tester).billing_has_card, 0);
  await post(event("customer.updated", customer("pm_tester")));
  assert.strictEqual(orgRow(tester).billing_has_card, 1);
  await post(event("customer.updated", customer(null)));
  assert.strictEqual(orgRow(tester).billing_has_card, 1);
});

test("the same event twice applies once; an older event after a newer one is ignored", async () => {
  const orgId = addOrg({ seats: 2 });
  sendImpl = async () => false;   // keeps the confirmation owed, so a second apply would show as a second send too
  const first = event("customer.subscription.created", subscription(orgId, { item: { quantity: 1 } }), T0 + 100);
  assert.deepStrictEqual((await post(first)).data, { received: true });
  await until(() => calls.length === 1 && sent.length === 1);
  // Stripe sends it again: acknowledged, and nothing is done twice
  assert.deepStrictEqual((await post(first)).data, { received: true });
  await settle();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(applyStripeEvent(db, first), { outcome: "duplicate", followUps: [], orgId });
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM stripe_events WHERE id = ?").get(first.id).n, 1);

  const newer = event("customer.subscription.updated", subscription(orgId, { status: "past_due", item: { quantity: 2 } }), T0 + 200);
  const older = event("customer.subscription.updated", subscription(orgId, { status: "active", item: { quantity: 2 } }), T0 + 150);
  assert.strictEqual(applyStripeEvent(db, newer).outcome, "applied");
  assert.deepStrictEqual(applyStripeEvent(db, older), { outcome: "ignored", followUps: [], orgId });
  assert.strictEqual(orgRow(orgId).billing_status, "past_due");
  assert.strictEqual(orgRow(orgId).billing_event_at, (T0 + 200) * 1000);
  // the ignored event is recorded too, so Stripe's retry of it is a duplicate
  assert.strictEqual(applyStripeEvent(db, older).outcome, "duplicate");
  // Stripe's times are whole seconds: another event from the same second still applies
  const sameSecond = event("customer.subscription.updated", subscription(orgId, { status: "active", item: { quantity: 2 } }), T0 + 200);
  assert.strictEqual(applyStripeEvent(db, sameSecond).outcome, "applied");
  assert.strictEqual(orgRow(orgId).billing_status, "active");
  // a late checkout event doesn't overwrite what a newer subscription event stored
  const lateCheckout = event("checkout.session.completed", checkoutSession(orgId, { customer: "cus_old" }), T0 + 50);
  assert.strictEqual(applyStripeEvent(db, lateCheckout).outcome, "ignored");
  assert.strictEqual(orgRow(orgId).stripe_customer_id, `cus_${orgId}`);

  // storeSubscription (the status call's re-read) follows the same rule and answers its follow-ups
  assert.deepStrictEqual(storeSubscription(db, orgId, subscription(orgId, { status: "canceled" }), (T0 + 199) * 1000), []);
  assert.strictEqual(orgRow(orgId).billing_status, "active");
  assert.deepStrictEqual(storeSubscription(db, orgId, subscription(orgId, { item: { quantity: 1 } }), (T0 + 300) * 1000),
    [{ type: "sync_seats", orgId }, { type: "confirm", orgId }]);
});

test("a second live subscription for one org is cancelled and refunded through the gateway (H1)", async () => {
  const orgId = addOrg();
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_A", item: { id: "si_A" } }), T0 + 10));
  assert.strictEqual(orgRow(orgId).stripe_subscription_id, "sub_A");

  // a second card page finished in another tab: its subscription is cancelled (and refunded) at once; the first one stays
  const r = await post(event("customer.subscription.created", subscription(orgId, { id: "sub_B", item: { id: "si_B" } }), T0 + 20));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  // recorded first, and worked on as a recorded duplicate; cleared once that went through
  assert.deepStrictEqual(calls, [["cancelAndRefund", "sub_B", { recorded: true }]]);
  let o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.stripe_item_id, o.billing_status], ["sub_A", "si_A", "trialing"]);
  assert.strictEqual(o.billing_duplicate_pending, null);

  // a checkout for yet another one says the same, even delivered late (older than what was applied): two tabs a second apart
  await post(event("checkout.session.completed", checkoutSession(orgId, { id: "cs_C", subscription: "sub_C" }), T0 + 5));
  assert.deepStrictEqual(calls[1], ["cancelAndRefund", "sub_C", { recorded: true }]);
  assert.strictEqual(orgRow(orgId).stripe_subscription_id, "sub_A");
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, null);

  // the cancelled one's own "deleted" event doesn't touch the organization, and cancels nothing more
  await post(event("customer.subscription.deleted", subscription(orgId, { id: "sub_B", status: "canceled", item: { id: "si_B" } }), T0 + 30));
  await settle();
  assert.strictEqual(calls.length, 2);
  o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.billing_status], ["sub_A", "trialing"]);

  // once the first has really ended, a new one (coming back) takes its place and nothing is cancelled
  await post(event("customer.subscription.deleted", subscription(orgId, { id: "sub_A", status: "canceled", item: { id: "si_A" } }), T0 + 40));
  assert.strictEqual(orgRow(orgId).billing_status, "canceled");
  await post(event("customer.subscription.created",
    subscription(orgId, { id: "sub_D", status: "active", trial_end: null, item: { id: "si_D" } }), T0 + 50));
  await settle();
  o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.stripe_item_id, o.billing_status], ["sub_D", "si_D", "active"]);
  assert.strictEqual(calls.length, 2);
});

test("a second subscription whose cancel or refund fails stays recorded and is tried again on the org's next event (H1)", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...a) => { errors.push(a.map(String).join(" ")); });
  const orgId = addOrg();
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_keep" }), T0 + 10));

  // the refund fails after the cancel went through (the gateway throws): the id stays recorded, and the answer is still 200
  cancelImpl = async () => { throw new Error("refund failed"); };
  const r = await post(event("customer.subscription.created", subscription(orgId, { id: "sub_extra" }), T0 + 20));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, "sub_extra");
  assert.deepStrictEqual(calls, [["cancelAndRefund", "sub_extra", { recorded: true }]], "tried once for this event, not twice");
  assert.ok(errors.includes(`[billing] cancel_duplicate failed for org ${orgId}: refund failed`), errors.join("\n"));

  // the next event for the organization, of any kind, tries again; this time it goes through and the record is cleared
  cancelImpl = async () => ({ cancelled: false, refunded: true });
  await post(event("invoice.paid", { id: "in_retry", object: "invoice", customer: `cus_${orgId}` }, T0 + 30));
  assert.deepStrictEqual(calls[1], ["cancelAndRefund", "sub_extra", { recorded: true }]);
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, null);
  await post(event("invoice.paid", { id: "in_after", object: "invoice", customer: `cus_${orgId}` }, T0 + 40));
  assert.strictEqual(calls.length, 2, "nothing more once it is done");

  // the cancel itself fails: the same
  cancelImpl = async () => { throw new Error("cancel failed"); };
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_third" }), T0 + 50));
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, "sub_third");
  cancelImpl = async () => ({ cancelled: true, refunded: true });
  await post(event("customer.updated", { id: `cus_${orgId}`, object: "customer", metadata: {}, invoice_settings: { default_payment_method: null } }, T0 + 60));
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, null);
  assert.deepStrictEqual(calls.slice(2).map((c) => c[1]), ["sub_third", "sub_third"]);

  // two found before either is dealt with: both kept; the one that fails stays, the other is cleared
  cancelImpl = async (id) => { if (id === "sub_bad") throw new Error("still down"); return { cancelled: true, refunded: false }; };
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_bad" }), T0 + 70));
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_ok" }), T0 + 80));
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, "sub_bad");
  assert.ok(calls.some((c) => c[1] === "sub_ok"));
  // the billing status call (Task 3) drives the same retry
  cancelImpl = async () => ({ cancelled: true, refunded: false });
  await retryPendingDuplicate(db, gateway, orgId);
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, null);
  const n = calls.length;
  await retryPendingDuplicate(db, gateway, orgId);
  assert.strictEqual(calls.length, n, "nothing recorded: no call");
  assert.strictEqual(orgRow(orgId).stripe_subscription_id, "sub_keep", "the organization's own subscription is never touched");
});

test("a recorded second subscription that becomes the organization's only one is kept: never cancelled or refunded (H1)", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const cancels = () => calls.filter((c) => c[0] === "cancelAndRefund");
  const orgId = addOrg();
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_A", item: { id: "si_A" } }), T0 + 10));

  // sub_B is recorded as a second subscription, and its cancel fails
  cancelImpl = async () => { throw new Error("cancel failed"); };
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_B", item: { id: "si_B" } }), T0 + 20));
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, "sub_B");
  // sub_A then ends (its event tries sub_B again, which fails again)
  await post(event("customer.subscription.deleted", subscription(orgId, { id: "sub_A", status: "canceled", item: { id: "si_A" } }), T0 + 30));
  assert.deepStrictEqual([orgRow(orgId).billing_status, orgRow(orgId).billing_duplicate_pending], ["canceled", "sub_B"]);

  // sub_B is now the brokerage's only subscription: adopted and taken off the record, so nothing cancels or refunds it, even with
  // a gateway that would now succeed
  cancelImpl = async () => ({ cancelled: true, refunded: true });
  calls = [];
  await post(event("customer.subscription.updated",
    subscription(orgId, { id: "sub_B", status: "active", trial_end: null, item: { id: "si_B" } }), T0 + 40));
  await settle();
  const o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.stripe_item_id, o.billing_status, o.billing_duplicate_pending], ["sub_B", "si_B", "active", null]);
  assert.deepStrictEqual(cancels(), []);
  await post(event("invoice.paid", { id: "in_after_adopt", object: "invoice", customer: `cus_${orgId}` }, T0 + 50));
  assert.deepStrictEqual(cancels(), []);

  // the retry's own guard: a record that names the organization's live subscription is skipped and cleared
  db.prepare("UPDATE organizations SET billing_duplicate_pending = 'sub_B' WHERE id = ?").run(orgId);
  await retryPendingDuplicate(db, gateway, orgId);
  assert.deepStrictEqual(cancels(), []);
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, null);

  // but one stored as the organization's after it has ended (we cancelled it as a second subscription and its refund failed, then
  // the first ended) stays recorded, so the refund owed for it is still made
  const other = addOrg();
  await post(event("customer.subscription.created", subscription(other, { id: "sub_P" }), T0 + 10));
  cancelImpl = async () => { throw new Error("refund failed"); };
  await post(event("customer.subscription.created", subscription(other, { id: "sub_Q" }), T0 + 20));
  // Stripe's own view from now on: our cancel went through (only its refund failed)
  retrieveImpl = async (id) => subscription(other, { id, status: "canceled" });
  await post(event("customer.subscription.deleted", subscription(other, { id: "sub_P", status: "canceled" }), T0 + 30));
  storeSubscription(db, other, subscription(other, { id: "sub_Q", status: "canceled" }), (T0 + 40) * 1000);
  assert.deepStrictEqual([orgRow(other).stripe_subscription_id, orgRow(other).billing_duplicate_pending], ["sub_Q", "sub_Q"]);
  cancelImpl = async () => ({ cancelled: false, refunded: true });
  calls = [];
  await retryPendingDuplicate(db, gateway, other);
  assert.deepStrictEqual(cancels(), [["cancelAndRefund", "sub_Q", { recorded: true }]]);
  assert.strictEqual(orgRow(other).billing_duplicate_pending, null);
});

test("M1: the retry on the first subscription's deleted event adopts a recorded second one Stripe still has live; never cancels it", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const cancels = () => calls.filter((c) => c[0] === "cancelAndRefund");
  // times in the past, as Stripe's always are: the retry's own read of Stripe is newer than every event applied
  const orgId = addOrg({ seats: 2 });
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_S1", item: { id: "si_S1", quantity: 2 } }), T0 - 300));

  // S2 is recorded as a second subscription and its cancel keeps failing
  cancelImpl = async () => { throw new Error("cancel failed"); };
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_S2", item: { id: "si_S2", quantity: 2 } }), T0 - 200));
  await post(event("invoice.paid", { id: "in_m1", object: "invoice", customer: `cus_${orgId}` }, T0 - 150));
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, "sub_S2");
  assert.strictEqual(cancels().length, 2, "while S1 is live, S2 is a second subscription and is cancelled (here: tried)");

  // S1 ends. The retry that its deleted event drives must not cancel S2, even with a gateway that would now succeed: Stripe still
  // has S2 live, so it is the brokerage's only subscription and is adopted
  cancelImpl = async () => ({ cancelled: true, refunded: true });
  retrieveImpl = async (id) => (id === "sub_S2"
    ? subscription(orgId, { id: "sub_S2", status: "active", trial_end: null, item: { id: "si_S2", quantity: 2 } })
    : assert.fail(`no read of ${id}`));
  calls = [];
  const r = await post(event("customer.subscription.deleted", subscription(orgId, { id: "sub_S1", status: "canceled", item: { id: "si_S1" } }), T0 - 100));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  assert.deepStrictEqual(cancels(), [], "S2 is neither cancelled nor refunded");
  assert.deepStrictEqual(calls, [["retrieveSubscription", "sub_S2"]]);
  const o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.stripe_item_id, o.billing_status, o.billing_duplicate_pending], ["sub_S2", "si_S2", "active", null]);
  assert.deepStrictEqual(accessFor({ config: CONFIG, org: o, termsOk: true, nowMs: NOW }), { ok: true }, "the brokerage keeps working");
  // later events change nothing about that
  await post(event("invoice.paid", { id: "in_m1_after", object: "invoice", customer: `cus_${orgId}` }, T0 - 50));
  assert.deepStrictEqual(cancels(), []);

  // the same sequence where our cancel of S2 went through but its refund failed: Stripe has it ended, so the retry still owes (and
  // makes) the refund, the gateway refunding only one carrying our cancel's mark (ruling 16)
  const two = addOrg();
  await post(event("customer.subscription.created", subscription(two, { id: "sub_T1" }), T0 - 300));
  cancelImpl = async () => { throw new Error("refund failed"); };
  await post(event("customer.subscription.created", subscription(two, { id: "sub_T2" }), T0 - 200));
  retrieveImpl = async (id) => subscription(two, { id, status: "canceled" });
  cancelImpl = async () => ({ cancelled: false, refunded: true });
  calls = [];
  await post(event("customer.subscription.deleted", subscription(two, { id: "sub_T1", status: "canceled" }), T0 - 100));
  assert.deepStrictEqual(calls, [["retrieveSubscription", "sub_T2"], ["cancelAndRefund", "sub_T2", { recorded: true }]]);
  assert.deepStrictEqual([orgRow(two).stripe_subscription_id, orgRow(two).billing_status, orgRow(two).billing_duplicate_pending], ["sub_T1", "canceled", null]);

  // a read that fails keeps the record and cancels nothing; the next event tries again
  const three = addOrg();
  await post(event("customer.subscription.created", subscription(three, { id: "sub_U1" }), T0 - 300));
  cancelImpl = async () => { throw new Error("cancel failed"); };
  await post(event("customer.subscription.created", subscription(three, { id: "sub_U2" }), T0 - 200));
  retrieveImpl = async () => { throw new Error("stripe down"); };
  cancelImpl = async () => ({ cancelled: true, refunded: true });
  calls = [];
  await post(event("customer.subscription.deleted", subscription(three, { id: "sub_U1", status: "canceled" }), T0 - 100));
  assert.deepStrictEqual(cancels(), []);
  assert.strictEqual(orgRow(three).billing_duplicate_pending, "sub_U2");
  retrieveImpl = async (id) => subscription(three, { id, status: "trialing" });
  await post(event("invoice.paid", { id: "in_u", object: "invoice", customer: `cus_${three}` }, T0 - 50));
  assert.deepStrictEqual(cancels(), []);
  assert.deepStrictEqual([orgRow(three).stripe_subscription_id, orgRow(three).billing_status, orgRow(three).billing_duplicate_pending], ["sub_U2", "trialing", null]);
});

test("M1: a late Checkout for a recorded second subscription never makes it the organization's while the stored status is stale", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const cancels = () => calls.filter((c) => c[0] === "cancelAndRefund");
  const orgId = addOrg();
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_C1" }), T0 - 300));
  cancelImpl = async () => { throw new Error("cancel failed"); };
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_C2" }), T0 - 250));
  assert.strictEqual(orgRow(orgId).billing_duplicate_pending, "sub_C2");
  // C1 ends while Stripe can't be read, so the retry can't tell what C2 is yet
  retrieveImpl = async () => { throw new Error("stripe down"); };
  await post(event("customer.subscription.deleted", subscription(orgId, { id: "sub_C1", status: "canceled" }), T0 - 200));
  // C2's Checkout arrives late: the stored status ("canceled", C1's) says nothing about C2, so C2 is not taken on from it
  cancelImpl = async () => ({ cancelled: true, refunded: true });
  calls = [];
  const r = await post(event("checkout.session.completed", checkoutSession(orgId, { id: "cs_C2", subscription: "sub_C2" }), T0 - 150));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  let o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.billing_status, o.billing_duplicate_pending], ["sub_C1", "canceled", "sub_C2"]);
  assert.deepStrictEqual(cancels(), [], "nothing cancelled on a stale status");
  // once Stripe answers, the re-read adopts it
  retrieveImpl = async (id) => subscription(orgId, { id, status: "active", trial_end: null });
  await post(event("invoice.paid", { id: "in_c2", object: "invoice", customer: `cus_${orgId}` }, T0 - 100));
  o = orgRow(orgId);
  assert.deepStrictEqual([o.stripe_subscription_id, o.billing_status, o.billing_duplicate_pending], ["sub_C2", "active", null]);
  assert.deepStrictEqual(cancels(), []);
});

test("the webhook answers once its follow-ups have run, and still 200 when one fails (ruling 9)", async (t) => {
  t.mock.method(console, "error", () => {});
  const orgId = addOrg({ seats: 2 });
  sendImpl = () => new Promise((r) => setTimeout(() => r(true), 50));
  quantityImpl = async () => { throw new Error("quantity refused"); };
  const r = await post(event("customer.subscription.created", subscription(orgId, { item: { quantity: 1 } }), T0 + 10));
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  // no waiting needed: by the answer the email went and the failed push was tried
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(orgRow(orgId).billing_confirmation_sent, 1);
  assert.deepStrictEqual(calls, [["setQuantity", { subscriptionId: `sub_${orgId}`, itemId: `si_${orgId}`, quantity: 2 }]]);
  assert.strictEqual(orgRow(orgId).billing_quantity, 1, "kept, so the next event pushes it again");
});

test("the confirmation goes only during the trial: an active event still carrying trial_end, or a paid start, owes none (ruling 6)", async () => {
  // the trial already converted (Stripe keeps trial_end on the subscription afterwards) and no confirmation ever went out
  const converted = addOrg();
  const sub = subscription(converted, { status: "active", trial_end: T0 - DAY, item: { current_period_end: T0 + 29 * DAY } });
  assert.deepStrictEqual(storeSubscription(db, converted, sub, NOW), []);
  await post(event("customer.subscription.updated", sub, T0 + 10));
  assert.strictEqual(orgRow(converted).billing_trial_end, (T0 - DAY) * 1000);
  // coming back: active at once, no trial
  const returning = addOrg({ billing_ever_subscribed: 1 });
  await post(event("customer.subscription.created", subscription(returning, { status: "active", trial_end: null }), T0 + 10));
  // and the follow-up itself refuses too, should a confirm reach it for an active subscription
  await runFollowUps({ db, gateway, send, config: CONFIG }, [{ type: "confirm", orgId: converted }]);
  await settle();
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(orgRow(converted).billing_confirmation_sent, 0);
  assert.strictEqual(orgRow(returning).billing_confirmation_sent, 0);
});

test("a quantity that differs from the user count is pushed back (H2)", async () => {
  const orgId = addOrg({ seats: 3, pending: 1, removed: 1 });   // 3 users: the pending invite and the removed loan officer don't count
  await post(event("customer.subscription.created", subscription(orgId, { item: { quantity: 1 } }), T0 + 10));
  await until(() => calls.length === 1);
  assert.deepStrictEqual(calls[0], ["setQuantity", { subscriptionId: `sub_${orgId}`, itemId: `si_${orgId}`, quantity: 3 }]);
  await until(() => orgRow(orgId).billing_quantity === 3);

  // the quantity lowered somewhere else (the portal, the dashboard): it goes straight back
  await post(event("customer.subscription.updated", subscription(orgId, { item: { quantity: 2 } }), T0 + 20));
  await until(() => calls.length === 2);
  assert.strictEqual(calls[1][1].quantity, 3);
  await until(() => orgRow(orgId).billing_quantity === 3);

  // the right count: nothing to do; an ended subscription is never touched
  await post(event("customer.subscription.updated", subscription(orgId, { item: { quantity: 3 } }), T0 + 30));
  await post(event("customer.subscription.deleted", subscription(orgId, { status: "canceled", item: { quantity: 1 } }), T0 + 40));
  await settle();
  assert.strictEqual(calls.length, 2);
  await syncSeats(db, gateway, orgId);
  assert.strictEqual(calls.length, 2);

  // syncSeats on its own: nothing without a subscription item, nothing when in step, and a failed push leaves the stored count, so it
  // is tried again next time
  await syncSeats(db, gateway, addOrg({ seats: 2 }));
  const inStep = addOrg({ seats: 2, stripe_subscription_id: "sub_s", stripe_item_id: "si_s", billing_quantity: 2, billing_status: "active" });
  await syncSeats(db, gateway, inStep);
  assert.strictEqual(calls.length, 2);
  db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', 'New', 'Lo', 'joined@x.test', 'h', 1)").run(inStep);
  quantityImpl = async () => { throw new Error("stripe down"); };
  await assert.rejects(syncSeats(db, gateway, inStep), /stripe down/);
  assert.strictEqual(orgRow(inStep).billing_quantity, 2);
  quantityImpl = async () => {};
  await syncSeats(db, gateway, inStep);
  assert.deepStrictEqual(calls.at(-1), ["setQuantity", { subscriptionId: "sub_s", itemId: "si_s", quantity: 3 }]);
  assert.strictEqual(orgRow(inStep).billing_quantity, 3);
});

test("the first subscription sends one confirmation email with the end date and price; never twice; a failed send retries next event (H6)", async (t) => {
  const orgId = addOrg({ seats: 2 });
  const broker = db.prepare("SELECT * FROM users WHERE org_id = ? AND role = 'broker'").get(orgId);
  sendImpl = async () => false;   // the first send fails
  await post(event("customer.subscription.created", subscription(orgId, { item: { quantity: 2 } }), T0 + 10));
  await until(() => sent.length === 1);
  assert.deepStrictEqual(sent[0], {
    to: broker.email, firstName: "Bea", orgName: orgRow(orgId).name, kind: "trial", endDate: formatEndDate(TRIAL_END * 1000),
    totalLine: "Brokerage $99 + 1 additional user × $49 = $148 a month",
  });
  await settle();
  assert.strictEqual(orgRow(orgId).billing_confirmation_sent, 0);

  // the next event tries again; this time it goes, and the flag is set
  sendImpl = async () => true;
  await post(event("customer.subscription.updated", subscription(orgId, { item: { quantity: 2 } }), T0 + 20));
  await until(() => orgRow(orgId).billing_confirmation_sent === 1);
  assert.strictEqual(sent.length, 2);
  // never again, whatever comes next
  await post(event("customer.subscription.updated", subscription(orgId, { status: "active", trial_end: null, item: { quantity: 2 } }), T0 + 30));
  await settle();
  assert.strictEqual(sent.length, 2);

  // a send that throws counts as not sent
  const thrower = addOrg();
  sendImpl = async () => { throw new Error("smtp down"); };
  t.mock.method(console, "error", () => {});
  await runFollowUps({ db, gateway, send, config: CONFIG }, storeSubscription(db, thrower, subscription(thrower), NOW));
  assert.strictEqual(orgRow(thrower).billing_confirmation_sent, 0);

  // two events at the same moment send one email
  const twin = addOrg();
  const held = [];   // each send waits here until released, so the second run starts while the first is still sending
  sendImpl = () => new Promise((r) => { held.push(() => r(true)); });
  const followUps = storeSubscription(db, twin, subscription(twin), NOW);
  assert.deepStrictEqual(followUps, [{ type: "confirm", orgId: twin }]);
  const first = runFollowUps({ db, gateway, send, config: CONFIG }, followUps);
  await until(() => held.length === 1);
  const second = runFollowUps({ db, gateway, send, config: CONFIG }, followUps);
  await settle();
  for (const release of held) release();
  await Promise.all([first, second]);
  assert.strictEqual(sent.filter((s) => s.to === `broker${orgSeq}@x.test`).length, 1);
  assert.strictEqual(orgRow(twin).billing_confirmation_sent, 1);

  // a tester month without a card gets the test-month email; nothing is owed while there is no trial or test month
  const tester = addOrg({ billing_via_tester_code: 1, billing_tester_until: (T0 + 30 * DAY) * 1000 });
  sendImpl = async () => true;
  const testerSub = subscription(tester, { trial_end: T0 + 30 * DAY, default_payment_method: null, item: { current_period_end: T0 + 30 * DAY } });
  await runFollowUps({ db, gateway, send, config: CONFIG }, storeSubscription(db, tester, testerSub, NOW));
  assert.deepStrictEqual(sent.at(-1), {
    to: `broker${orgSeq}@x.test`, firstName: "Bea", orgName: orgRow(tester).name, kind: "tester",
    endDate: formatEndDate((T0 + 30 * DAY) * 1000), totalLine: "Brokerage $99 a month",
  });
  assert.strictEqual(orgRow(tester).billing_confirmation_sent, 1);
  const unpaid = addOrg();
  assert.deepStrictEqual(storeSubscription(db, unpaid, subscription(unpaid, { status: "incomplete", trial_end: null }), NOW), []);

  // the email's words (a DRAFT for Bill), every value escaped
  const trial = billingConfirmationMessage({
    firstName: "<b>Bea</b>", orgName: "O'Neil & <i>Co</i>", kind: "trial", endDate: "Nov 19, 2026",
    totalLine: "Brokerage $99 + 2 additional users × $49 = $197 a month",
  });
  assert.strictEqual(trial.subject, "Your Broker Radar trial has started");
  for (const line of [
    "Hi &lt;b&gt;Bea&lt;/b&gt;,",
    "O&#39;Neil &amp; &lt;i&gt;Co&lt;/i&gt;'s free trial runs until Nov 19, 2026.",
    "After that, Broker Radar is $99 a month, plus $49 for each additional user, charged to the card you added until you cancel.",
    "Brokerage $99 + 2 additional users × $49 = $197 a month",
    "You can cancel any time in Broker Radar under Billing → Manage billing.",
  ]) assert.ok(trial.html.includes(line), line);
  assert.ok(!/<b>Bea|<i>Co|test month|Before it ends/.test(trial.html));
  const testMonth = billingConfirmationMessage({ firstName: "Bea", orgName: "Acme", kind: "tester", endDate: "<Dec 5>", totalLine: "Brokerage $99 a month" });
  assert.strictEqual(testMonth.subject, "Your Broker Radar test month has started");
  for (const line of [
    "Hi Bea,", "Acme's free test month runs until &lt;Dec 5&gt;.",
    "Before it ends we'll ask you for a card; without one, Broker Radar pauses and your data is kept.",
    "Brokerage $99 a month", "You can cancel any time in Broker Radar under Billing → Manage billing.",
  ]) assert.ok(testMonth.html.includes(line), line);
  assert.ok(!/free trial|charged to the card|<Dec/.test(testMonth.html));
  assert.ok(!/RefiRadar/.test(trial.html + trial.subject + testMonth.html + testMonth.subject));

  assert.strictEqual(formatEndDate(Date.UTC(2026, 10, 19, 15)), "Nov 19, 2026");
  assert.strictEqual(totalLine(1), "Brokerage $99 a month");
  assert.strictEqual(totalLine(2), "Brokerage $99 + 1 additional user × $49 = $148 a month");
  assert.strictEqual(totalLine(5), "Brokerage $99 + 4 additional users × $49 = $295 a month");
  assert.strictEqual(totalLine(10), "Brokerage $99 + 9 additional users × $49 = $540 a month");

  // the real sender sends nothing, and answers false, when mail isn't set up
  const saved = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  t.after(() => {
    for (const [k, v] of [["EMAIL_USER", saved.u], ["EMAIL_PASS", saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const warn = t.mock.method(console, "warn", () => {});
  const { sendBillingConfirmation } = require("../email");
  assert.strictEqual(await sendBillingConfirmation({ to: "a@x.test", firstName: "A", orgName: "O", kind: "trial", endDate: "Nov 19, 2026", totalLine: "x" }), false);
  assert.strictEqual(warn.mock.callCount(), 1);
});

test("cancel during the trial: allowed until the deleted event, then ended, and no second trial", async () => {
  const orgId = addOrg();
  const access = () => accessFor({ config: CONFIG, org: orgRow(orgId), termsOk: true, nowMs: NOW });
  assert.deepStrictEqual(checkoutPlan(orgRow(orgId), NOW), { trial: "days", days: 14 });

  await post(event("customer.subscription.created", subscription(orgId), T0 + 10));
  assert.deepStrictEqual(access(), { ok: true });
  // cancelled in the portal: it keeps working to the end of the trial
  await post(event("customer.subscription.updated", subscription(orgId, { cancel_at_period_end: true }), T0 + 20));
  assert.strictEqual(orgRow(orgId).billing_cancel_at_period_end, 1);
  assert.strictEqual(orgRow(orgId).billing_trial_end, TRIAL_END * 1000);
  assert.deepStrictEqual(access(), { ok: true });
  // the trial ends with no charge: Stripe deletes the subscription
  await post(event("customer.subscription.deleted", subscription(orgId, { status: "canceled", cancel_at_period_end: true }), T0 + 14 * DAY));
  assert.strictEqual(orgRow(orgId).billing_status, "canceled");
  assert.deepStrictEqual(access(), { ok: false, reason: "ended" });
  // coming back is a paid start, not a second free trial
  assert.strictEqual(orgRow(orgId).billing_ever_subscribed, 1);
  assert.deepStrictEqual(checkoutPlan(orgRow(orgId), NOW + 15 * DAY * 1000), { trial: "none" });
});

test("no log line holds a secret or a whole Stripe object", async (t) => {
  const lines = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, m, (...args) => { lines.push(args.map(String).join(" ")); });
  }
  const orgId = addOrg({ seats: 2 });
  const broker = db.prepare("SELECT email FROM users WHERE org_id = ? AND role = 'broker'").get(orgId);
  cancelImpl = async () => { throw new Error("cancel refused"); };
  quantityImpl = async () => { throw new Error("quantity refused"); };
  sendImpl = async () => { throw new Error("mail refused"); };

  const ev = event("customer.subscription.created", subscription(orgId, { item: { quantity: 1 } }), T0 + 10);
  await post(ev, { secret: "whsec_wrong" });                      // refused signature
  await post(ev);                                                 // sync_seats and confirm, both failing
  await post(event("customer.subscription.created", subscription(orgId, { id: "sub_dup" }), T0 + 20));   // cancel_duplicate, failing
  await post(event("invoice.payment_failed", { id: "in_9", object: "invoice", customer: `cus_${orgId}`, customer_email: broker.email }));
  await post(event("checkout.session.completed", checkoutSession(orgId, { customer_details: { email: broker.email } }), T0 + 30));
  await until(() => ["cancel refused", "quantity refused", "mail refused"].every((m) => lines.some((l) => l.includes(m))));
  await settle();

  const banned = [SECRET, "whsec_wrong", CONFIG.secretKey, broker.email, `pm_${orgId}`, `cus_${orgId}`, `sub_${orgId}`, "sub_dup",
    '"object"', "[object Object]", "trial_end", "v1="];
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /^\[billing\] /, line);
    for (const b of banned) assert.ok(!line.includes(b), `a log line holds ${b}: ${line}`);
  }
  // every failure names our own organization number (ruling 10), so a log line can be traced without a Stripe id
  for (const [type, message] of [["sync_seats", "quantity refused"], ["confirm", "mail refused"], ["cancel_duplicate", "cancel refused"]]) {
    assert.ok(lines.includes(`[billing] ${type} failed for org ${orgId}: ${message}`), `${type}: ${lines.join("\n")}`);
  }
});

// The gateway's own behaviour is tested over a fake Stripe client in billing-gateway.test.js.
test("index.js mounts the webhook before the JSON parser, and the stripe package is pinned", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const mount = src.indexOf('app.use("/api/billing/webhook"');
  assert.ok(mount > 0, "the webhook is mounted");
  assert.ok(mount < src.indexOf("app.use(express.json("), "before the JSON parser, which would take the raw body first");
  assert.match(require("../package.json").dependencies.stripe, /^\d+\.\d+\.\d+$/, "stripe is pinned to an exact version");
});
