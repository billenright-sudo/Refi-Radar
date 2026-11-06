"use strict";
// The real Stripe gateway (lib/billing/stripeGateway.js) over an injected fake Stripe client that records every call and never
// reaches the network: the parameters that decide what a broker is charged, and the cancel-and-refund rules for a second
// subscription (H1), end to end through the webhook. Throwaway DB; no mail (the sender seam answers true).
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-billing-gateway-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const Stripe = require("stripe");

const db = require("../db");
const { createStripeGateway } = require("../lib/billing/stripeGateway");
const { storeSubscription } = require("../lib/billing/events");
const webhookRoutes = require("../routes/billingWebhook");

const SECRET = "whsec_gateway_test";
const DAY = 86_400;
const T0 = Math.floor(Date.now() / 1000);

// A fake Stripe client: the same method names the gateway uses, answering from `state`, recording [name, ...args] in `calls`.
// `failCancel` / `failRefund` make the next N such calls throw, as a Stripe outage would.
function fakeStripe(state = {}) {
  const s = { subs: {}, payments: {}, refunds: [], failCancel: 0, failRefund: 0, price: null, ...state };
  const calls = [];
  const rec = (name, ...args) => calls.push([name, ...args]);
  const client = {
    prices: { retrieve: async (id, opts) => { rec("prices.retrieve", id, opts); return structuredClone(s.price); } },
    checkout: {
      sessions: {
        create: async (p) => { rec("checkout.sessions.create", p); return { id: "cs_new", url: "https://checkout.stripe.test/cs_new" }; },
        retrieve: async (id) => {
          rec("checkout.sessions.retrieve", id);
          return { id, status: "complete", url: null, customer: { id: "cus_x", object: "customer" }, subscription: "sub_x" };
        },
      },
    },
    billingPortal: { sessions: { create: async (p) => { rec("billingPortal.sessions.create", p); return { url: "https://billing.stripe.test/p" }; } } },
    customers: {
      create: async (p) => { rec("customers.create", p); return { id: "cus_tester", object: "customer" }; },
      update: async (id, p) => { rec("customers.update", id, p); return { id }; },
    },
    subscriptions: {
      retrieve: async (id) => {
        rec("subscriptions.retrieve", id);
        if (!s.subs[id]) throw new Error("No such subscription");
        return structuredClone(s.subs[id]);
      },
      create: async (p) => {
        rec("subscriptions.create", p);
        return { id: "sub_tester", object: "subscription", status: "trialing", trial_end: p.trial_end, items: { data: [{ id: "si_tester", quantity: p.items[0].quantity }] } };
      },
      update: async (id, p) => { rec("subscriptions.update", id, p); return { id }; },
      cancel: async (id, p) => {
        rec("subscriptions.cancel", id, p);
        if (s.failCancel > 0) { s.failCancel--; throw new Error("cancel failed"); }
        Object.assign(s.subs[id], { status: "canceled", cancellation_details: { comment: p?.cancellation_details?.comment ?? null, reason: "cancellation_requested" } });
        return structuredClone(s.subs[id]);
      },
    },
    // deliberately not filtered by status here: the gateway must pick the paid ones itself too
    invoicePayments: { list: async (p) => { rec("invoicePayments.list", p); return { data: structuredClone(s.payments[p.invoice] || []) }; } },
    refunds: {
      list: async (p) => {
        rec("refunds.list", p);
        return { data: s.refunds.filter((r) => (p.payment_intent && r.payment_intent === p.payment_intent) || (p.charge && r.charge === p.charge)) };
      },
      create: async (p, opts) => {
        rec("refunds.create", p, opts);
        if (s.failRefund > 0) { s.failRefund--; throw new Error("refund failed"); }
        const refund = { id: `re_${s.refunds.length + 1}`, status: "succeeded", ...p };
        s.refunds.push(refund);
        return refund;
      },
    },
    webhooks: { constructEvent: (raw, sig, secret) => Stripe.webhooks.constructEvent(raw, sig, secret) },
  };
  return { client, calls, state: s, names: () => calls.map((c) => c[0]) };
}
const paidPayment = (paymentIntent, amount) => ({ id: `inpay_${paymentIntent}`, status: "paid", amount_paid: amount, payment: { type: "payment_intent", payment_intent: paymentIntent } });

test("the gateway exposes the whole interface, over an injected client", () => {
  const gw = createStripeGateway({ secretKey: "sk_test_unused", client: fakeStripe().client });
  assert.deepStrictEqual(Object.keys(gw).sort(), [
    "cancelAndRefund", "constructEvent", "createCheckout", "createPortal", "createTesterSubscription", "retrieveCheckout",
    "retrievePrice", "retrieveSubscription", "setQuantity", "updateCustomerEmail",
  ]);
});

test("retrievePrice reads the tiers and fails closed for anything but a plain monthly price (H5)", async () => {
  const price = {
    id: "price_test", active: true, currency: "usd", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    tiers_mode: "graduated",
    tiers: [{ up_to: 1, unit_amount: 9900, flat_amount: null }, { up_to: null, unit_amount: 4900, flat_amount: null }],
    currency_options: { usd: { tiers: [] } },
  };
  const f = fakeStripe({ price });
  const gw = createStripeGateway({ client: f.client });
  assert.deepStrictEqual(await gw.retrievePrice("price_test"), {
    active: true, currency: "usd", interval: "month", usageType: "licensed", otherCurrencies: false, tiersMode: "graduated",
    tiers: [{ upTo: 1, unitAmount: 9900 }, { upTo: null, unitAmount: 4900 }],
  });
  // an archived price can't start a new subscription; a price that doesn't say it is active counts as not active
  f.state.price = { ...price, active: false };
  assert.strictEqual((await gw.retrievePrice("price_test")).active, false);
  f.state.price = { ...price, active: undefined };
  assert.strictEqual((await gw.retrievePrice("price_test")).active, false);
  // neither the tiers nor the currency options are sent unless asked for
  assert.deepStrictEqual(f.calls[0], ["prices.retrieve", "price_test", { expand: ["tiers", "currency_options"] }]);

  // a metered price charges for usage, not per user; a price with options in other currencies could charge another amount
  f.state.price = { ...price, recurring: { ...price.recurring, usage_type: "metered" } };
  assert.strictEqual((await gw.retrievePrice("price_test")).usageType, "metered");
  f.state.price = { ...price, currency_options: { usd: { tiers: [] }, eur: { tiers: [] } } };
  assert.strictEqual((await gw.retrievePrice("price_test")).otherCurrencies, true);
  f.state.price = { ...price, currency_options: undefined };
  assert.strictEqual((await gw.retrievePrice("price_test")).otherCurrencies, false);

  // every 3 months is not monthly; a tier with a flat fee has no single unit amount; a $0 flat fee changes nothing
  f.state.price = { ...price, recurring: { interval: "month", interval_count: 3 } };
  assert.strictEqual((await gw.retrievePrice("price_test")).interval, "3 month");
  f.state.price = { ...price, tiers: [{ up_to: 1, unit_amount: 9900, flat_amount: 500 }, { up_to: null, unit_amount: 4900, flat_amount: 0 }] };
  assert.deepStrictEqual((await gw.retrievePrice("price_test")).tiers, [{ upTo: 1, unitAmount: null }, { upTo: null, unitAmount: 4900 }]);
  // a one-off, per-unit price
  f.state.price = { id: "price_once", active: true, currency: "usd", recurring: null, tiers_mode: null, unit_amount: 9900 };
  assert.deepStrictEqual(await gw.retrievePrice("price_once"),
    { active: true, currency: "usd", interval: null, usageType: null, otherCurrencies: false, tiersMode: null, tiers: [] });
});

test("createCheckout: card always, the terms tick, no promotion codes, the org on both, the user count and the plan's trial", async () => {
  const f = fakeStripe();
  const gw = createStripeGateway({ client: f.client });
  const base = { email: "bea@x.test", orgId: 12, priceId: "price_test", quantity: 3, successUrl: "https://app.test/?billing=done", cancelUrl: "https://app.test/?billing=cancelled" };

  assert.deepStrictEqual(await gw.createCheckout({ ...base, customerId: null, plan: { trial: "days", days: 14 } }),
    { id: "cs_new", url: "https://checkout.stripe.test/cs_new" });
  assert.deepStrictEqual(f.calls[0], ["checkout.sessions.create", {
    mode: "subscription",
    line_items: [{ price: "price_test", quantity: 3 }],
    payment_method_types: ["card"],
    payment_method_collection: "always",
    consent_collection: { terms_of_service: "required" },
    allow_promotion_codes: false,
    client_reference_id: "12",
    subscription_data: { metadata: { org_id: "12" }, trial_period_days: 14 },
    success_url: "https://app.test/?billing=done",
    cancel_url: "https://app.test/?billing=cancelled",
    customer_email: "bea@x.test",
  }]);

  // a tester month running: the trial ends when it does; an existing customer is reused (no second customer for the address)
  const endMs = (T0 + 20 * DAY) * 1000 + 999;
  await gw.createCheckout({ ...base, customerId: "cus_12", plan: { trial: "until", endMs } });
  const until = f.calls[1][1];
  assert.deepStrictEqual(until.subscription_data, { metadata: { org_id: "12" }, trial_end: T0 + 20 * DAY });
  assert.strictEqual(until.customer, "cus_12");
  assert.ok(!("customer_email" in until));

  // coming back: no trial at all
  await gw.createCheckout({ ...base, customerId: "cus_12", plan: { trial: "none" } });
  assert.deepStrictEqual(f.calls[2][1].subscription_data, { metadata: { org_id: "12" } });
  assert.strictEqual(f.calls[2][1].payment_method_collection, "always");
  // a card and nothing else (no bank debit or wallet a dashboard setting could add), for every plan
  for (const c of f.calls) assert.deepStrictEqual(c[1].payment_method_types, ["card"]);
});

test("createTesterSubscription: no card, cancels itself without one, the org on customer and subscription, the trial end", async () => {
  const f = fakeStripe();
  const gw = createStripeGateway({ client: f.client });
  const trialEndMs = (T0 + 30 * DAY) * 1000;
  const r = await gw.createTesterSubscription({ email: "t@x.test", orgId: 7, orgName: "Tess Mortgage", priceId: "price_test", quantity: 1, trialEndMs });
  assert.deepStrictEqual(f.calls[0], ["customers.create", { email: "t@x.test", name: "Tess Mortgage", metadata: { org_id: "7" } }]);
  assert.deepStrictEqual(f.calls[1], ["subscriptions.create", {
    customer: "cus_tester",
    items: [{ price: "price_test", quantity: 1 }],
    trial_end: T0 + 30 * DAY,
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    metadata: { org_id: "7" },
  }]);
  assert.strictEqual(f.calls.length, 2);
  assert.deepStrictEqual({ ...r, subscription: undefined }, {
    customerId: "cus_tester", subscriptionId: "sub_tester", itemId: "si_tester", status: "trialing", trialEndMs, subscription: undefined,
  });
  assert.strictEqual(r.subscription.id, "sub_tester");
});

test("setQuantity prorates; the portal, the Checkout read-back, the customer email and the signature check", async () => {
  const f = fakeStripe();
  const gw = createStripeGateway({ client: f.client });
  await gw.setQuantity({ subscriptionId: "sub_1", itemId: "si_1", quantity: 4 });
  assert.deepStrictEqual(f.calls.at(-1), ["subscriptions.update", "sub_1", { items: [{ id: "si_1", quantity: 4 }], proration_behavior: "create_prorations" }]);

  assert.deepStrictEqual(await gw.createPortal({ customerId: "cus_1", returnUrl: "https://app.test/", updateCard: true }), { url: "https://billing.stripe.test/p" });
  assert.deepStrictEqual(f.calls.at(-1)[1], { customer: "cus_1", return_url: "https://app.test/", flow_data: { type: "payment_method_update" } });
  await gw.createPortal({ customerId: "cus_1", returnUrl: "https://app.test/", updateCard: false });
  assert.deepStrictEqual(f.calls.at(-1)[1], { customer: "cus_1", return_url: "https://app.test/" });

  assert.deepStrictEqual(await gw.retrieveCheckout("cs_9"), { status: "complete", url: null, customerId: "cus_x", subscriptionId: "sub_x" });
  await gw.updateCustomerEmail("cus_1", "new@x.test");
  assert.deepStrictEqual(f.calls.at(-1), ["customers.update", "cus_1", { email: "new@x.test" }]);

  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  assert.strictEqual(gw.constructEvent(Buffer.from(payload), Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }), SECRET).id, "evt_1");
  assert.throws(() => gw.constructEvent(Buffer.from(payload), "t=1,v1=00", SECRET));
});

test("cancelAndRefund: cancels a live one, refunds only paid payments over $0, never a second refund, never an old paid subscription", async () => {
  const f = fakeStripe({
    subs: { sub_dup: { id: "sub_dup", object: "subscription", status: "active", latest_invoice: "in_dup", cancellation_details: null } },
    payments: {
      in_dup: [
        paidPayment("pi_zero", 0),                                                          // a trial's $0 invoice took nothing
        paidPayment("pi_paid", 14800),
        { id: "inpay_open", status: "open", amount_paid: null, payment: { type: "payment_intent", payment_intent: "pi_open" } },
        { id: "inpay_ch", status: "paid", amount_paid: 4900, payment: { type: "charge", charge: "ch_paid" } },
      ],
    },
  });
  const gw = createStripeGateway({ client: f.client });
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_dup", { recorded: true }), { cancelled: true, refunded: true });
  const cancel = f.calls.find((c) => c[0] === "subscriptions.cancel");
  assert.strictEqual(cancel[1], "sub_dup");
  assert.strictEqual(cancel[2].invoice_now, false);
  assert.strictEqual(cancel[2].prorate, false);
  assert.ok(cancel[2].cancellation_details.comment, "marked as our duplicate cancel");
  assert.deepStrictEqual(f.calls.find((c) => c[0] === "invoicePayments.list")[1], { invoice: "in_dup", status: "paid" });
  assert.deepStrictEqual(f.calls.filter((c) => c[0] === "refunds.create").map((c) => c[1]), [{ payment_intent: "pi_paid" }, { charge: "ch_paid" }]);

  // asked again (a retry, a replayed event): already cancelled and refunded, so nothing more goes out
  const before = f.calls.length;
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_dup", { recorded: true }), { cancelled: false, refunded: false });
  assert.deepStrictEqual(f.calls.slice(before).map((c) => c[0]).filter((n) => n === "subscriptions.cancel" || n === "refunds.create"), []);
  // a refund that failed at Stripe doesn't count as one
  f.state.refunds.find((r) => r.charge === "ch_paid").status = "failed";
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_dup", { recorded: true }), { cancelled: false, refunded: true });
  assert.deepStrictEqual(f.calls.filter((c) => c[0] === "refunds.create").map((c) => c[1]).at(-1), { charge: "ch_paid" });

  // an old subscription that ended on its own (legitimately paid) is never refunded, recorded or not
  f.state.subs.sub_old = { id: "sub_old", object: "subscription", status: "canceled", latest_invoice: "in_old", cancellation_details: { comment: null, reason: "cancellation_requested" } };
  f.state.payments.in_old = [paidPayment("pi_old", 9900)];
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_old", { recorded: true }), { cancelled: false, refunded: false });
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_old"), { cancelled: false, refunded: false });
  // and a call that isn't a recorded duplicate never refunds an ended one, even one we cancelled
  f.state.subs.sub_marked = { ...structuredClone(f.state.subs.sub_dup), id: "sub_marked", latest_invoice: "in_marked" };
  f.state.payments.in_marked = [paidPayment("pi_marked", 9900)];
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_marked"), { cancelled: false, refunded: false });
  assert.ok(!f.calls.some((c) => c[0] === "refunds.create" && ["pi_old", "pi_marked"].includes(c[1].payment_intent)));

  // a live one with no invoice yet: cancelled, nothing to refund
  f.state.subs.sub_new = { id: "sub_new", object: "subscription", status: "trialing", latest_invoice: null, cancellation_details: null };
  assert.deepStrictEqual(await gw.cancelAndRefund("sub_new", { recorded: true }), { cancelled: true, refunded: false });
});

// ── End to end: the webhook, the event rules, the follow-ups and the real gateway over the fake client ─────────────────────────────
let server, app, base;
before(async () => {
  app = express();
  app.use("/api/billing/webhook", webhookRoutes);
  app.set("sendBillingConfirmation", async () => true);
  app.set("billingConfig", { enabled: true, webhookSecret: SECRET, priceId: "price_test" });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

let orgSeq = 0;
function addOrgWithLiveSubscription(subscriptionId) {
  const n = ++orgSeq;
  const orgId = Number(db.prepare("INSERT INTO organizations (name, billing_status, billing_confirmation_sent) VALUES (?, 'none', 1)").run(`GW Org ${n}`).lastInsertRowid);
  db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'broker', 'Bea', 'B', ?, 'h', 1)").run(orgId, `gw${n}@x.test`);
  storeSubscription(db, orgId, {
    id: subscriptionId, customer: `cus_${orgId}`, status: "active", trial_end: null, cancel_at_period_end: false, default_payment_method: "pm_1",
    metadata: { org_id: String(orgId) }, items: { data: [{ id: `si_${orgId}`, quantity: 1, current_period_end: T0 + 30 * DAY }] },
  }, T0 * 1000);
  return orgId;
}
const pendingOf = (orgId) => db.prepare("SELECT billing_duplicate_pending FROM organizations WHERE id = ?").get(orgId).billing_duplicate_pending;
let evSeq = 0;
async function post(type, object, created) {
  const payload = JSON.stringify({ id: `evt_gw_${++evSeq}`, object: "event", type, created, data: { object } });
  const res = await fetch(base + "/api/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) },
    body: payload,
  });
  return { status: res.status, data: await res.json() };
}
const liveSub = (orgId, id, over = {}) => ({
  id, object: "subscription", customer: `cus_${orgId}`, status: "active", trial_end: null, cancel_at_period_end: false, default_payment_method: "pm_2",
  metadata: { org_id: String(orgId) }, items: { data: [{ id: `si_${id}`, quantity: 1, current_period_end: T0 + 30 * DAY }] }, ...over,
});
const invoicePaid = (orgId) => ({ id: `in_${++evSeq}`, object: "invoice", customer: `cus_${orgId}` });

test("end to end: a late event for an old, legitimately paid subscription never refunds it", async (t) => {
  t.mock.method(console, "log", () => {});
  const orgId = addOrgWithLiveSubscription("sub_current");
  const f = fakeStripe({
    subs: { sub_former: { id: "sub_former", object: "subscription", status: "canceled", latest_invoice: "in_former", cancellation_details: { comment: null, reason: "cancellation_requested" } } },
    payments: { in_former: [paidPayment("pi_former", 9900)] },
  });
  app.set("billingGateway", createStripeGateway({ client: f.client }));
  // Stripe redelivers an update from when the former subscription was still active
  const r = await post("customer.subscription.updated", liveSub(orgId, "sub_former"), T0 - 60 * DAY);
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);
  assert.ok(!f.names().includes("subscriptions.cancel"));
  assert.ok(!f.names().includes("refunds.create"));
  assert.strictEqual(pendingOf(orgId), null, "looked at, found already over, and let go");
  assert.strictEqual(db.prepare("SELECT stripe_subscription_id FROM organizations WHERE id = ?").get(orgId).stripe_subscription_id, "sub_current");
});

test("end to end: a refund that fails after the cancel is kept and refunded once on the next event; a failed cancel likewise", async (t) => {
  t.mock.method(console, "log", () => {});
  const errors = [];
  t.mock.method(console, "error", (...a) => { errors.push(a.map(String).join(" ")); });

  // the refund fails after the cancel went through
  const orgId = addOrgWithLiveSubscription("sub_first");
  const f = fakeStripe({
    subs: { sub_second: { id: "sub_second", object: "subscription", status: "active", latest_invoice: "in_second", cancellation_details: null } },
    payments: { in_second: [paidPayment("pi_second", 9900)] },
    failRefund: 1,
  });
  app.set("billingGateway", createStripeGateway({ client: f.client }));
  let r = await post("customer.subscription.created", liveSub(orgId, "sub_second"), T0 + 10);
  assert.deepStrictEqual([r.status, r.data], [200, { received: true }]);   // the event is recorded, so Stripe needn't resend it
  assert.strictEqual(pendingOf(orgId), "sub_second");
  assert.ok(errors.some((l) => l.startsWith(`[billing] cancel_duplicate failed for org ${orgId}: `)), errors.join("\n"));
  assert.strictEqual(f.calls.filter((c) => c[0] === "subscriptions.cancel").length, 1);

  await post("invoice.paid", invoicePaid(orgId), T0 + 20);   // any next event for the organization
  assert.strictEqual(pendingOf(orgId), null);
  assert.strictEqual(f.calls.filter((c) => c[0] === "subscriptions.cancel").length, 1, "not cancelled twice");
  assert.deepStrictEqual(f.state.refunds.map((x) => x.payment_intent), ["pi_second"]);
  await post("invoice.paid", invoicePaid(orgId), T0 + 30);
  assert.deepStrictEqual(f.state.refunds.map((x) => x.payment_intent), ["pi_second"], "refunded once");

  // the cancel itself fails: kept, and the next event cancels and refunds
  const org2 = addOrgWithLiveSubscription("sub_one");
  const g = fakeStripe({
    subs: { sub_two: { id: "sub_two", object: "subscription", status: "active", latest_invoice: "in_two", cancellation_details: null } },
    payments: { in_two: [paidPayment("pi_two", 14800)] },
    failCancel: 1,
  });
  app.set("billingGateway", createStripeGateway({ client: g.client }));
  await post("customer.subscription.created", liveSub(org2, "sub_two"), T0 + 10);
  assert.strictEqual(pendingOf(org2), "sub_two");
  assert.strictEqual(g.state.subs.sub_two.status, "active");
  assert.ok(!g.names().includes("refunds.create"));
  await post("customer.updated", { id: `cus_${org2}`, object: "customer", metadata: {}, invoice_settings: { default_payment_method: null } }, T0 + 20);
  assert.strictEqual(pendingOf(org2), null);
  assert.strictEqual(g.state.subs.sub_two.status, "canceled");
  assert.deepStrictEqual(g.state.refunds.map((x) => x.payment_intent), ["pi_two"]);
});
