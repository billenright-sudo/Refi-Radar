"use strict";
// The billing API (routes/billing.js), the access gate (middleware/access.js) on the gated routers, the start-up price check and
// tester month (lib/billing/startup.js), the seat push after an accepted invite (routes/auth.js) and the Overview chip (routes/org.js
// /stats, H12). Throwaway DB. Nothing here reaches Stripe or sends mail: the gateway is a fake that records its calls, and the
// confirmation and invite senders come in through the app seams.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-billing-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
process.env.APP_URL = "https://app.broker-radar.test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { addBroker } = require("../test-support/accounts");
const { hashToken } = require("../lib/passwordReset");
const authRoutes = require("../routes/auth");
const billingRoutes = require("../routes/billing");
const clientRoutes = require("../routes/clients");
const orgRoutes = require("../routes/org");
const notifRoutes = require("../routes/notifications");
const profileRoutes = require("../routes/profile");
const { verifyPrice, applyBillingStartup, startBilling } = require("../lib/billing/startup");
const { TERMS_VERSION, PRIVACY_VERSION, termsCurrent } = require("../lib/terms");

const APP_URL = "https://app.broker-radar.test";
const DAY_MS = 86_400_000;
const CONFIG = Object.freeze({
  enabled: true, stripeConfigured: true, secretKey: "sk_test_must_never_be_logged", webhookSecret: "whsec_test", priceId: "price_test",
  exemptEmails: [],
});
const NEEDS_ATTENTION = "Broker Radar needs attention before you can continue.";
const UNREACHABLE = { success: false, error: "Couldn't reach the payment service. Please try again." };
const GOOD_PRICE = Object.freeze({
  active: true, currency: "usd", interval: "month", usageType: "licensed", tiersMode: "graduated", otherCurrencies: false,
  tiers: [{ upTo: 1, unitAmount: 9900 }, { upTo: null, unitAmount: 4900 }],
});

// The fake gateway: everything that would reach Stripe is recorded in `calls`; `fail` names methods that throw, as an outage would.
let calls;
function fakeGateway() {
  const state = { checkouts: {}, subs: {}, seq: 0, fail: new Set(), checkoutDelayMs: 0, price: GOOD_PRICE };
  const rec = (name, ...args) => {
    calls.push([name, ...args]);
    if (state.fail.has(name)) throw new Error(`${name} failed`);
  };
  return {
    state,
    retrievePrice: async (id) => { rec("retrievePrice", id); return structuredClone(state.price); },
    createCheckout: async (args) => {
      rec("createCheckout", args);
      if (state.checkoutDelayMs) await new Promise((r) => setTimeout(r, state.checkoutDelayMs));
      const id = `cs_new_${++state.seq}`;
      const url = `https://checkout.stripe.test/${id}`;
      state.checkouts[id] = { status: "open", url, customerId: null, subscriptionId: null };
      return { id, url };
    },
    retrieveCheckout: async (id) => {
      rec("retrieveCheckout", id);
      // what Stripe's SDK throws for a session it doesn't have (a test-mode one asked for with live keys, say)
      if (!state.checkouts[id]) {
        throw Object.assign(new Error("No such checkout.session"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 });
      }
      return { ...state.checkouts[id] };
    },
    retrieveSubscription: async (id) => {
      rec("retrieveSubscription", id);
      if (!state.subs[id]) throw new Error("No such subscription");
      return structuredClone(state.subs[id]);
    },
    createPortal: async (args) => { rec("createPortal", args); return { url: args.updateCard ? "https://billing.stripe.test/card" : "https://billing.stripe.test/portal" }; },
    setQuantity: async (args) => { rec("setQuantity", args); },
    cancelAndRefund: async (id, opts) => { rec("cancelAndRefund", id, opts); return { cancelled: true, refunded: false }; },
    createTesterSubscription: async (args) => { rec("createTesterSubscription", args); throw new Error("not used here"); },
    updateCustomerEmail: async (...args) => { rec("updateCustomerEmail", ...args); },
    constructEvent: () => { throw new Error("not used here"); },
  };
}
const names = () => calls.map((c) => c[0]);

let server, app, base, gateway, sent, ipCounter = 0;
before(async () => {
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/clients", clientRoutes);
  app.use("/api/org", orgRoutes);
  app.use("/api/notifications", notifRoutes);
  app.use("/api/profile", profileRoutes);
  app.set("sendInvite", async () => {});
  app.set("sendBillingConfirmation", async (args) => { sent.push(args); return true; });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  calls = []; sent = [];
  gateway = fakeGateway();
  app.set("billingConfig", { ...CONFIG });
  app.set("billingGateway", gateway);
});
const billingOff = () => { app.set("billingConfig", { ...CONFIG, enabled: false }); };

// One request as `user` (a users row, or null for none), each from its own client address (the auth limiters count per IP).
async function call(method, p, { as, body } = {}) {
  const headers = { "x-forwarded-for": `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as) headers.cookie = `rr_token=${signToken({ userId: as.id, sv: as.session_version || 0 })}`;
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text, headers: res.headers };
}
const get = (p, as) => call("GET", p, { as });
const post = (p, as, body = {}) => call("POST", p, { as, body });

// A brokerage on billing: its broker (terms accepted unless `terms: false`), `los` accepted loan officers, `pending` invitations,
// and any billing columns. billing_status starts at 'none' (a new brokerage with no card yet).
let seq = 0;
const orgRow = (id) => db.prepare("SELECT * FROM organizations WHERE id = ?").get(id);
const userRow = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
function accept(userId, terms = TERMS_VERSION, privacy = PRIVACY_VERSION, at = Date.now()) {
  db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at, ip) VALUES (?, 'terms', ?, ?, '127.0.0.1')").run(userId, terms, at);
  db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at, ip) VALUES (?, 'privacy', ?, ?, '127.0.0.1')").run(userId, privacy, at);
}
function addLo(orgId, { accepted = 1, terms = true } = {}) {
  const n = ++seq;
  const id = Number(db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', 'Lou', 'Officer', ?, 'h', ?)"
  ).run(orgId, `lo${n}@api.test`, accepted).lastInsertRowid);
  if (terms && accepted) accept(id);
  return userRow(id);
}
function brokerage({ los = 0, pending = 0, terms = true, ...cols } = {}) {
  const n = ++seq;
  const broker = addBroker(db, { email: `broker${n}@api.test`, firstName: "Bea", orgName: `Brokerage ${n}` });
  const orgId = broker.org_id;
  db.prepare("UPDATE organizations SET billing_status = 'none' WHERE id = ?").run(orgId);
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE organizations SET ${k} = ? WHERE id = ?`).run(v, orgId);
  if (terms) accept(broker.id);
  const loRows = [];
  for (let i = 0; i < los; i++) loRows.push(addLo(orgId));
  for (let i = 0; i < pending; i++) addLo(orgId, { accepted: 0 });
  return { orgId, broker, los: loRows };
}
const addClient = (user, over = {}) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes)
  VALUES (@org_id, @user_id, @name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes)
`).run({
  org_id: user.org_id, user_id: user.id, name: "Carla Client", email: "carla@client.test", phone: "555-0100", loan_type: "30yr_fixed",
  current_rate: 7.25, loan_balance: 350000, property_value: 500000, close_date: "2023-06-01", credit_score: 740, notes: "", ...over,
}).lastInsertRowid);

// A Stripe subscription as a recent API version sends it (the period end on the item).
const T = () => Math.floor(Date.now() / 1000);
function subscription(orgId, over = {}) {
  const { item = {}, ...rest } = over;
  return {
    id: `sub_${orgId}`, object: "subscription", customer: `cus_${orgId}`, status: "trialing",
    trial_end: T() + 14 * 86_400, cancel_at_period_end: false, default_payment_method: `pm_${orgId}`,
    metadata: { org_id: String(orgId) },
    items: { object: "list", data: [{ id: `si_${orgId}`, object: "subscription_item", quantity: 1, current_period_end: T() + 14 * 86_400, ...item }] },
    ...rest,
  };
}

// The follow-ups after an answer run on their own, so a test that looks at what they did waits for it.
async function until(check, ms = 1000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40));

// Captures console output for the length of `fn`.
async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...args) => lines.push(args.map(String).join(" "));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}

// A minimal CSV reader for the export: every cell quoted, "" inside a cell, CRLF between rows.
function readCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test("billing off: no 402, status enabled false, card/portal 404, export still works for a broker", async () => {
  // a brokerage that would be locked with billing on: no terms accepted, no card, a canceled subscription
  const { broker, los: [lo] } = brokerage({ terms: false, los: 1, billing_status: "canceled", stripe_customer_id: "cus_off" });
  addClient(broker);
  for (const config of [{ ...CONFIG, enabled: false }, undefined]) {
    app.set("billingConfig", config);
    calls = [];
    assert.strictEqual((await get("/api/clients", broker)).status, 200);
    assert.strictEqual((await get("/api/clients", lo)).status, 200);
    assert.strictEqual((await get("/api/org/stats", broker)).status, 200);
    assert.strictEqual((await get("/api/notifications", lo)).status, 200);
    assert.deepStrictEqual((await get("/api/billing/public")).data, { enabled: false });
    assert.deepStrictEqual((await get("/api/billing/status", broker)).data,
      { success: true, access: { ok: true }, role: "broker", billing: { enabled: false } });
    assert.deepStrictEqual((await get("/api/billing/status", lo)).data, { success: true, access: { ok: true }, role: "lo", billing: null });
    assert.strictEqual((await post("/api/billing/card", broker)).status, 404);
    assert.strictEqual((await post("/api/billing/portal", broker)).status, 404);
    const csv = await get("/api/billing/export.csv", broker);
    assert.strictEqual(csv.status, 200);
    assert.match(csv.text, /Carla Client/);
    // an invitation goes out as today
    const invite = await post("/api/auth/invite", broker, { firstName: "Ivy", lastName: "Invitee", email: `ivy${++seq}@api.test` });
    assert.strictEqual(invite.status, 201);
    assert.deepStrictEqual(calls, [], "billing off never calls the payment service");
  }
  // with billing on, the same brokerage is locked (terms first)
  app.set("billingConfig", { ...CONFIG });
  const locked = await get("/api/clients", broker);
  assert.strictEqual(locked.status, 402);
  assert.deepStrictEqual(locked.data, { success: false, error: NEEDS_ATTENTION, reason: "terms" });
  assert.deepStrictEqual((await get("/api/billing/public")).data, { enabled: true });
});

test("a mismatched or unreadable Stripe price leaves billing off and logs why (H5)", async () => {
  const check = async (price) => {
    const gw = fakeGateway();
    gw.state.price = price;
    return verifyPrice(gw, "price_test");
  };
  assert.deepStrictEqual(await check(GOOD_PRICE), { ok: true });
  assert.deepStrictEqual(await check({ ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: 9900 }, { upTo: "inf", unitAmount: 4900 }] }), { ok: true });
  const bad = [
    { ...GOOD_PRICE, active: false },   // archived: Checkout would refuse it, and nobody could add a card
    { ...GOOD_PRICE, active: undefined },
    { ...GOOD_PRICE, interval: "year" },
    { ...GOOD_PRICE, interval: "3 month" },
    { ...GOOD_PRICE, interval: null },
    { ...GOOD_PRICE, currency: "cad" },
    { ...GOOD_PRICE, usageType: "metered" },
    { ...GOOD_PRICE, usageType: undefined },
    { ...GOOD_PRICE, otherCurrencies: true },
    { ...GOOD_PRICE, otherCurrencies: undefined },
    { ...GOOD_PRICE, tiersMode: "volume" },
    { ...GOOD_PRICE, tiersMode: null, tiers: [] },
    { ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: 4995 }, { upTo: null, unitAmount: 4995 }] },
    { ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: 9900 }, { upTo: null, unitAmount: 4995 }] },
    { ...GOOD_PRICE, tiers: [{ upTo: 2, unitAmount: 9900 }, { upTo: null, unitAmount: 4900 }] },
    { ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: null }, { upTo: null, unitAmount: 4900 }] },   // a flat fee on the tier
    { ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: 9900 }, { upTo: 10, unitAmount: 4900 }] },
    { ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: 9900 }, { upTo: 5, unitAmount: 4900 }, { upTo: null, unitAmount: 4900 }] },
    { ...GOOD_PRICE, tiers: [{ upTo: 1, unitAmount: 9900 }] },
    null,
  ];
  for (const price of bad) {
    const r = await check(price);
    assert.strictEqual(r.ok, false, JSON.stringify(price));
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
  const unreadable = fakeGateway();
  unreadable.state.fail.add("retrievePrice");
  const r = await verifyPrice(unreadable, "price_test");
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /retrievePrice failed/);

  // start-up: Stripe configured but the price wrong -> off, the reason logged, no gateway on the app, the orgs untouched
  const env = { STRIPE_SECRET_KEY: "sk_test_must_never_be_logged", STRIPE_WEBHOOK_SECRET: "whsec_never_logged", STRIPE_PRICE_ID: "price_test" };
  const { orgId } = brokerage();
  db.prepare("UPDATE organizations SET billing_status = NULL WHERE id = ?").run(orgId);
  const starts = [
    { setup: (gw) => { gw.state.price = { ...GOOD_PRICE, currency: "eur" }; }, why: /\[billing\] off: / },
    { setup: (gw) => { gw.state.price = { ...GOOD_PRICE, active: false }; }, why: /\[billing\] off: the Stripe price is archived/ },
    { setup: (gw) => { gw.state.fail.add("retrievePrice"); }, why: /\[billing\] off: .*retrievePrice failed/ },
    { setup: (gw) => { gw.retrievePrice = () => new Promise(() => {}); }, why: /\[billing\] off: .*took longer than/ },   // Stripe never answers
    { setup: () => { throw new Error("bad key sk_test_must_never_be_logged"); }, why: /\[billing\] off: / },
  ];
  for (const { setup, why } of starts) {
    let result;
    const lines = await captureLogs(async () => {
      result = await startBilling(db, env, (config) => { const gw = fakeGateway(); setup(gw); return gw; }, { timeoutMs: 50 });
    });
    assert.strictEqual(result.config.enabled, false);
    assert.strictEqual(result.gateway, null);
    assert.ok(lines.some((l) => why.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => /must_never_be_logged|whsec_never_logged/.test(l)), "no secret in a log line");
    assert.strictEqual(orgRow(orgId).billing_status, null, "billing off changes no organization");
  }
  // not configured at all: off, and nothing logged for a deployment that never set billing up
  let quiet;
  const none = await captureLogs(async () => { quiet = await startBilling(db, {}, () => assert.fail("no gateway without settings")); });
  assert.strictEqual(quiet.config.enabled, false);
  assert.strictEqual(quiet.gateway, null);
  assert.deepStrictEqual(none, []);
  // half configured: off, and the missing setting is named (never a value)
  const half = await captureLogs(async () => {
    const r2 = await startBilling(db, { STRIPE_SECRET_KEY: "sk_test_must_never_be_logged" }, () => assert.fail("no gateway"));
    assert.strictEqual(r2.config.enabled, false);
  });
  assert.ok(half.some((l) => /\[billing\] off: .*STRIPE_WEBHOOK_SECRET.*STRIPE_PRICE_ID/.test(l)), half.join("\n"));
  assert.ok(!half.some((l) => /must_never_be_logged/.test(l)));

  // a good price: on, the gateway handed back, the start-up applied
  let on;
  const lines = await captureLogs(async () => { on = await startBilling(db, env, () => fakeGateway(), { timeoutMs: 1000 }); });
  assert.strictEqual(on.config.enabled, true);
  assert.ok(on.gateway && typeof on.gateway.createCheckout === "function");
  assert.strictEqual(orgRow(orgId).billing_status, "none");
  assert.ok(!lines.some((l) => /must_never_be_logged|whsec_never_logged/.test(l)));
});

test("no card: gated routes 402 needs_card; /me, /billing/status, /profile, export still answer", async () => {
  const { orgId, broker } = brokerage({ los: 1, pending: 1 });
  addClient(broker);
  const refused = { success: false, error: NEEDS_ATTENTION, reason: "needs_card" };
  for (const [method, p, body] of [
    ["GET", "/api/clients"], ["POST", "/api/clients", { name: "X" }], ["GET", "/api/org/stats"], ["GET", "/api/org/los"],
    ["GET", "/api/notifications"], ["POST", "/api/auth/invite", { firstName: "A", lastName: "B", email: "new@api.test" }],
  ]) {
    const r = await call(method, p, { as: broker, body });
    assert.strictEqual(r.status, 402, `${method} ${p}`);
    assert.deepStrictEqual(r.data, refused, `${method} ${p}`);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'new@api.test'").get().n, 0, "no invitation while locked");
  assert.strictEqual((await get("/api/auth/me", broker)).status, 200);
  assert.strictEqual((await get("/api/profile", broker)).status, 200);
  assert.strictEqual((await get("/api/billing/export.csv", broker)).status, 200);
  assert.strictEqual((await post("/api/auth/logout", broker)).status, 200);
  const status = await get("/api/billing/status", broker);
  assert.strictEqual(status.status, 200);
  assert.deepStrictEqual(status.data, {
    success: true, access: { ok: false, reason: "needs_card" }, role: "broker",
    billing: {
      enabled: true, status: "none", users: 2, baseCents: 9900, additionalCents: 4900, monthlyTotalCents: 14800,
      trialEnd: null, testerUntil: null, periodEnd: null, cancelAtPeriodEnd: false, exempt: false, hasCustomer: false, banner: null,
    },
  });
  assert.deepStrictEqual(calls, [], "nothing to sync: no subscription, no Checkout");

  // the terms come first: a broker who hasn't accepted the current versions gets "terms", even with a card
  const old = brokerage({ terms: false, billing_status: "active", stripe_subscription_id: "sub_t", billing_synced_at: Date.now() });
  accept(old.broker.id, "2025-01-01", PRIVACY_VERSION, Date.now() - DAY_MS);
  assert.strictEqual(termsCurrent(db, old.broker.id), false);
  assert.strictEqual((await get("/api/clients", old.broker)).data.reason, "terms");
  accept(old.broker.id);
  assert.strictEqual(termsCurrent(db, old.broker.id), true);
  assert.strictEqual((await get("/api/clients", old.broker)).status, 200);

  // allowed: a running tester month, an exemption, and each live status; ended: the rest
  const cases = [
    [{ billing_tester_until: Date.now() + DAY_MS }, 200],
    [{ billing_tester_until: Date.now() - 1000 }, 402, "needs_card"],
    [{ billing_exempt: 1 }, 200],
    [{ billing_status: "trialing" }, 200], [{ billing_status: "active" }, 200], [{ billing_status: "past_due" }, 200],
    [{ billing_status: "canceled" }, 402, "ended"], [{ billing_status: "unpaid" }, 402, "ended"],
    [{ billing_status: "incomplete" }, 402, "needs_card"],
  ];
  for (const [cols, code, reason] of cases) {
    const b = brokerage({ ...cols, billing_synced_at: Date.now() });
    const r = await get("/api/clients", b.broker);
    assert.strictEqual(r.status, code, JSON.stringify(cols));
    if (reason) assert.strictEqual(r.data.reason, reason, JSON.stringify(cols));
  }
  assert.ok(orgRow(orgId));
});

test("loan officers get 402 like their broker but billing: null and 403 on card, portal, export", async () => {
  const locked = brokerage({ los: 1, stripe_customer_id: "cus_lo" });
  const [lo] = locked.los;
  addClient(lo);
  const r = await get("/api/clients", lo);
  assert.strictEqual(r.status, 402);
  assert.deepStrictEqual(r.data, { success: false, error: NEEDS_ATTENTION, reason: "needs_card" });
  const status = await get("/api/billing/status", lo);
  assert.deepStrictEqual(status.data, { success: true, access: { ok: false, reason: "needs_card" }, role: "lo", billing: null });
  for (const [method, p] of [["POST", "/api/billing/card"], ["POST", "/api/billing/portal"], ["GET", "/api/billing/export.csv"]]) {
    const res = await call(method, p, { as: lo, body: method === "POST" ? {} : undefined });
    assert.strictEqual(res.status, 403, p);
    assert.doesNotMatch(res.text, /9900|4900|\$99|\$49|cus_/);
  }
  assert.deepStrictEqual(calls, []);

  // an LO whose own terms are out of date sees "terms"; a working brokerage: in, and still no billing details
  const lo2 = addLo(locked.orgId, { terms: false });
  assert.strictEqual((await get("/api/clients", lo2)).data.reason, "terms");
  const ok = brokerage({ los: 1, billing_status: "active", stripe_subscription_id: "sub_lo_ok", billing_synced_at: Date.now(), stripe_customer_id: "cus_ok" });
  assert.strictEqual((await get("/api/clients", ok.los[0])).status, 200);
  const okStatus = await get("/api/billing/status", ok.los[0]);
  assert.deepStrictEqual(okStatus.data, { success: true, access: { ok: true }, role: "lo", billing: null });
  assert.doesNotMatch(okStatus.text, /9900|4900|cus_|sub_/);
  // the 402 itself carries no billing details either
  assert.deepStrictEqual(Object.keys(r.data).sort(), ["error", "reason", "success"]);
});

test("card: first time -> Checkout 14-day trial for the user count; an open pending Checkout is reused (H1); live -> portal; returning -> no trial", async () => {
  // first time: the user count is the broker plus accepted loan officers (pending invites are free)
  const first = brokerage({ los: 2, pending: 1 });
  const r1 = await post("/api/billing/card", first.broker);
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(r1.data, { url: "https://checkout.stripe.test/cs_new_1" });
  assert.deepStrictEqual(calls, [["createCheckout", {
    customerId: null, email: first.broker.email, orgId: first.orgId, priceId: "price_test", quantity: 3,
    plan: { trial: "days", days: 14 }, successUrl: `${APP_URL}/?billing=done`, cancelUrl: `${APP_URL}/?billing=cancelled`,
  }]]);
  assert.strictEqual(orgRow(first.orgId).billing_pending_checkout, "cs_new_1");

  // H1: the same Checkout page again while it is still open, never a second one
  calls = [];
  const r2 = await post("/api/billing/card", first.broker);
  assert.deepStrictEqual(r2.data, { url: "https://checkout.stripe.test/cs_new_1" });
  assert.deepStrictEqual(names(), ["retrieveCheckout"]);

  // H1: two tabs at the same moment, one Checkout
  const twin = brokerage();
  gateway.state.checkoutDelayMs = 100;
  calls = [];
  const [a, b] = await Promise.all([post("/api/billing/card", twin.broker), post("/api/billing/card", twin.broker)]);
  assert.strictEqual(a.data.url, b.data.url);
  assert.strictEqual(names().filter((n) => n === "createCheckout").length, 1);
  gateway.state.checkoutDelayMs = 0;

  // an expired Checkout is forgotten and a new one made
  gateway.state.checkouts.cs_new_1.status = "expired";
  calls = [];
  const r3 = await post("/api/billing/card", first.broker);
  assert.deepStrictEqual(names(), ["retrieveCheckout", "createCheckout"]);
  assert.notStrictEqual(r3.data.url, r1.data.url);
  assert.strictEqual(orgRow(first.orgId).billing_pending_checkout, r3.data.url.split("/").pop());

  // live (trialing, active, past due) -> the portal's card form, never Checkout; a tester's no-card month included (ruling 3)
  for (const cols of [
    { billing_status: "trialing" }, { billing_status: "active" }, { billing_status: "past_due" },
    { billing_status: "trialing", billing_via_tester_code: 1, billing_has_card: 0, billing_tester_until: Date.now() + 5 * DAY_MS },
  ]) {
    const live = brokerage({ ...cols, stripe_customer_id: "cus_live", stripe_subscription_id: `sub_live_${seq}`, billing_synced_at: Date.now() });
    calls = [];
    const r = await post("/api/billing/card", live.broker);
    assert.deepStrictEqual(r.data, { url: "https://billing.stripe.test/card" }, JSON.stringify(cols));
    assert.deepStrictEqual(calls, [["createPortal", { customerId: "cus_live", returnUrl: `${APP_URL}/?billing=done`, updateCard: true }]]);
  }
  // a pending Checkout left over while live: still the portal, the old page is not reopened
  const leftover = brokerage({ billing_status: "active", stripe_customer_id: "cus_lo2", stripe_subscription_id: "sub_lo2", billing_synced_at: Date.now(), billing_pending_checkout: "cs_new_1" });
  calls = [];
  gateway.state.checkouts.cs_new_1.status = "open";
  assert.deepStrictEqual((await post("/api/billing/card", leftover.broker)).data, { url: "https://billing.stripe.test/card" });
  assert.deepStrictEqual(names(), ["createPortal"]);

  // a pending Checkout finished before its webhook: stored, then the portal (no second subscription)
  const done = brokerage({ billing_pending_checkout: "cs_done" });
  gateway.state.checkouts.cs_done = { status: "complete", url: null, customerId: `cus_${done.orgId}`, subscriptionId: `sub_${done.orgId}` };
  gateway.state.subs[`sub_${done.orgId}`] = subscription(done.orgId);
  calls = [];
  assert.deepStrictEqual((await post("/api/billing/card", done.broker)).data, { url: "https://billing.stripe.test/card" });
  assert.deepStrictEqual(names().filter((n) => n !== "setQuantity"), ["retrieveCheckout", "retrieveSubscription", "createPortal"]);
  assert.strictEqual(orgRow(done.orgId).billing_pending_checkout, null);

  // a tester month running with no subscription (an existing brokerage when billing was switched on): the trial ends with it
  const testerUntil = Date.now() + 20 * DAY_MS;
  const tester = brokerage({ billing_tester_until: testerUntil });
  calls = [];
  await post("/api/billing/card", tester.broker);
  assert.deepStrictEqual(calls[0][1].plan, { trial: "until", endMs: testerUntil });

  // returning after a cancellation: the same customer, no second trial
  const back = brokerage({ billing_status: "canceled", billing_ever_subscribed: 1, stripe_customer_id: "cus_back", stripe_subscription_id: "sub_old", billing_synced_at: Date.now() });
  calls = [];
  await post("/api/billing/card", back.broker);
  assert.deepStrictEqual(names(), ["createCheckout"]);
  assert.strictEqual(calls[0][1].customerId, "cus_back");
  assert.deepStrictEqual(calls[0][1].plan, { trial: "none" });
  assert.strictEqual(calls[0][1].quantity, 1);

  // the payment service down: 502 with the one line, nothing stored
  const down = brokerage();
  gateway.state.fail.add("createCheckout");
  const r502 = await post("/api/billing/card", down.broker);
  assert.strictEqual(r502.status, 502);
  assert.deepStrictEqual(r502.data, UNREACHABLE);
  assert.strictEqual(orgRow(down.orgId).billing_pending_checkout, null);
  gateway.state.fail.clear();

  // the portal: a broker with a customer gets Stripe's portal; one without has nothing to manage yet
  calls = [];
  const portal = await post("/api/billing/portal", back.broker);
  assert.deepStrictEqual(portal.data, { url: "https://billing.stripe.test/portal" });
  assert.deepStrictEqual(calls, [["createPortal", { customerId: "cus_back", returnUrl: `${APP_URL}/?billing=done`, updateCard: false }]]);
  const none = await post("/api/billing/portal", brokerage().broker);
  assert.strictEqual(none.status, 409);
  assert.strictEqual(none.data.success, false);
  gateway.state.fail.add("createPortal");
  assert.deepStrictEqual((await post("/api/billing/portal", back.broker)).data, UNREACHABLE);
  // not signed in
  assert.strictEqual((await post("/api/billing/card", null)).status, 401);
});

test("status syncs a pending Checkout (back before the webhook) and re-reads a subscription older than 24 h (H4)", async () => {
  // back from Checkout before Stripe's webhook: the status call reads the Checkout and its subscription, and the broker is in
  const back = brokerage({ los: 1, billing_pending_checkout: "cs_back" });
  addClient(back.broker);
  gateway.state.checkouts.cs_back = { status: "complete", url: null, customerId: `cus_${back.orgId}`, subscriptionId: `sub_${back.orgId}` };
  gateway.state.subs[`sub_${back.orgId}`] = subscription(back.orgId, { item: { quantity: 2 } });
  assert.strictEqual((await get("/api/clients", back.broker)).status, 402);
  const s1 = await get("/api/billing/status", back.broker);
  assert.deepStrictEqual(s1.data.access, { ok: true });
  assert.strictEqual(s1.data.billing.status, "trialing");
  assert.strictEqual(s1.data.billing.hasCustomer, true);
  assert.strictEqual(s1.data.billing.users, 2);
  assert.ok(s1.data.billing.trialEnd > Date.now());
  assert.deepStrictEqual(names(), ["retrieveCheckout", "retrieveSubscription"]);
  const row = orgRow(back.orgId);
  assert.strictEqual(row.billing_pending_checkout, null);
  assert.strictEqual(row.stripe_subscription_id, `sub_${back.orgId}`);
  assert.strictEqual(row.stripe_customer_id, `cus_${back.orgId}`);
  assert.strictEqual(row.billing_event_at % 1000, 0, "a re-read counts as of its whole second, so a same-second event still applies");
  assert.strictEqual((await get("/api/clients", back.broker)).status, 200, "lands on Home, not the card page again");
  // the missed webhook's confirmation email still goes, once
  await until(() => sent.length === 1);
  assert.strictEqual(sent[0].to, back.broker.email);

  // a fresh state is not re-read
  calls = [];
  await get("/api/billing/status", back.broker);
  assert.deepStrictEqual(calls, []);

  // a Checkout still open: read, kept; an expired one: forgotten
  const open = brokerage({ billing_pending_checkout: "cs_open" });
  gateway.state.checkouts.cs_open = { status: "open", url: "https://checkout.stripe.test/cs_open", customerId: null, subscriptionId: null };
  calls = [];
  assert.deepStrictEqual((await get("/api/billing/status", open.broker)).data.access, { ok: false, reason: "needs_card" });
  assert.deepStrictEqual(names(), ["retrieveCheckout"]);
  assert.strictEqual(orgRow(open.orgId).billing_pending_checkout, "cs_open");
  gateway.state.checkouts.cs_open.status = "expired";
  await get("/api/billing/status", open.broker);
  assert.strictEqual(orgRow(open.orgId).billing_pending_checkout, null);

  // H4: a subscription last synced over 24 h ago (or never) is re-read; a missed "active" no longer leaves it trialing
  for (const synced of [Date.now() - 25 * 3600_000, null]) {
    const stale = brokerage({ billing_status: "past_due", stripe_subscription_id: null, billing_synced_at: synced });
    const subId = `sub_${stale.orgId}`;
    db.prepare("UPDATE organizations SET stripe_subscription_id = ?, stripe_customer_id = ?, stripe_item_id = ?, billing_quantity = 1 WHERE id = ?")
      .run(subId, `cus_${stale.orgId}`, `si_${stale.orgId}`, stale.orgId);
    gateway.state.subs[subId] = subscription(stale.orgId, { status: "active", trial_end: null });
    calls = [];
    const s = await get("/api/billing/status", stale.broker);
    assert.deepStrictEqual(names(), ["retrieveSubscription"], String(synced));
    assert.strictEqual(s.data.billing.status, "active");
    assert.strictEqual(s.data.billing.banner, null);
    assert.ok(orgRow(stale.orgId).billing_synced_at >= Date.now() - 5000);
  }
  // a stale subscription Stripe says has ended: locked as ended
  const gone = brokerage({ billing_status: "active", billing_synced_at: Date.now() - 2 * DAY_MS });
  db.prepare("UPDATE organizations SET stripe_subscription_id = ? WHERE id = ?").run(`sub_${gone.orgId}`, gone.orgId);
  gateway.state.subs[`sub_${gone.orgId}`] = subscription(gone.orgId, { status: "canceled" });
  assert.deepStrictEqual((await get("/api/billing/status", gone.broker)).data.access, { ok: false, reason: "ended" });

  // a failed re-read never fails the request; the state stays as it was
  const flaky = brokerage({ billing_status: "active", billing_synced_at: Date.now() - 2 * DAY_MS });
  db.prepare("UPDATE organizations SET stripe_subscription_id = 'sub_missing' WHERE id = ?").run(flaky.orgId);
  const lines = await captureLogs(async () => {
    const s = await get("/api/billing/status", flaky.broker);
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(s.data.access, { ok: true });
  });
  assert.ok(lines.some((l) => /\[billing\].*org \d+/.test(l)), lines.join("\n"));
  // a pending Checkout that can't be read (Stripe down): kept, to be read again; /card answers 502 and makes no second Checkout
  gateway.state.fail.add("retrieveCheckout");
  const failing = brokerage({ billing_pending_checkout: "cs_x" });
  assert.strictEqual((await captureLogs(async () => assert.strictEqual((await get("/api/billing/status", failing.broker)).status, 200))).length > 0, true);
  assert.strictEqual(orgRow(failing.orgId).billing_pending_checkout, "cs_x", "kept, to be read again");
  calls = [];
  await captureLogs(async () => assert.deepStrictEqual((await post("/api/billing/card", failing.broker)).data, UNREACHABLE));
  assert.deepStrictEqual(names(), ["retrieveCheckout"], "no second Checkout while the first can't be read");
  assert.strictEqual(orgRow(failing.orgId).billing_pending_checkout, "cs_x");
  gateway.state.fail.clear();
  // but one Stripe doesn't have (resource_missing: a test-mode Checkout after the switch to live keys) is forgotten, and /card makes
  // a new one instead of a 502 for ever
  const missing = brokerage({ billing_pending_checkout: "cs_from_test_mode" });
  calls = [];
  const fresh = await captureLogs(async () => {
    const r = await post("/api/billing/card", missing.broker);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(orgRow(missing.orgId).billing_pending_checkout, r.data.url.split("/").pop());
  });
  assert.deepStrictEqual(names(), ["retrieveCheckout", "createCheckout"]);
  assert.ok(!fresh.some((l) => l.includes("cs_from_test_mode")), "no Stripe id in the log");
  // the status call forgets it too
  const goneToo = brokerage({ billing_pending_checkout: "cs_gone_too" });
  await captureLogs(async () => assert.strictEqual((await get("/api/billing/status", goneToo.broker)).status, 200));
  assert.strictEqual(orgRow(goneToo.orgId).billing_pending_checkout, null);
  // a bare 404 from the gateway counts as missing too
  const savedRead = gateway.retrieveCheckout;
  gateway.retrieveCheckout = async (id) => { calls.push(["retrieveCheckout", id]); throw Object.assign(new Error("Not Found"), { statusCode: 404 }); };
  try {
    const notFound = brokerage({ billing_pending_checkout: "cs_404" });
    calls = [];
    await captureLogs(async () => assert.strictEqual((await post("/api/billing/card", notFound.broker)).status, 200));
    assert.deepStrictEqual(names(), ["retrieveCheckout", "createCheckout"]);
  } finally {
    gateway.retrieveCheckout = savedRead;
  }

  // the user count is put back when it differs (H2), and a recorded second subscription is retried (H1)
  const seats = brokerage({ los: 2, billing_status: "active", stripe_subscription_id: "sub_seats", stripe_item_id: "si_seats", billing_quantity: 1, billing_synced_at: Date.now() });
  calls = [];
  await get("/api/billing/status", seats.broker);
  assert.deepStrictEqual(calls, [["setQuantity", { subscriptionId: "sub_seats", itemId: "si_seats", quantity: 3 }]]);
  assert.strictEqual(orgRow(seats.orgId).billing_quantity, 3);
  const dup = brokerage({ billing_status: "active", stripe_subscription_id: "sub_keep", billing_synced_at: Date.now(), billing_duplicate_pending: "sub_dup" });
  calls = [];
  await get("/api/billing/status", dup.broker);
  assert.deepStrictEqual(calls, [["cancelAndRefund", "sub_dup", { recorded: true }]]);
  assert.strictEqual(orgRow(dup.orgId).billing_duplicate_pending, null);

  // an LO's status call repairs the brokerage too (it is their access as well), still without billing details
  const loCase = brokerage({ los: 1, billing_status: "trialing", billing_synced_at: Date.now() - 2 * DAY_MS });
  db.prepare("UPDATE organizations SET stripe_subscription_id = ? WHERE id = ?").run(`sub_${loCase.orgId}`, loCase.orgId);
  gateway.state.subs[`sub_${loCase.orgId}`] = subscription(loCase.orgId, { status: "unpaid", item: { quantity: 2 } });
  const loStatus = await get("/api/billing/status", loCase.los[0]);
  assert.deepStrictEqual(loStatus.data, { success: true, access: { ok: false, reason: "ended" }, role: "lo", billing: null });

  // a Stripe that doesn't answer can't hold the status call up: it answers from what is stored once the wait is over
  const slow = brokerage({ billing_pending_checkout: "cs_slow" });
  const savedRetrieve = gateway.retrieveCheckout;
  gateway.retrieveCheckout = () => new Promise(() => {});
  app.set("billingRepairWaitMs", 50);
  try {
    const started = Date.now();
    const s = await get("/api/billing/status", slow.broker);
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(s.data.access, { ok: false, reason: "needs_card" });
    assert.ok(Date.now() - started < 1000, `answered in ${Date.now() - started} ms`);
  } finally {
    gateway.retrieveCheckout = savedRetrieve;
    app.set("billingRepairWaitMs", undefined);
  }
});

test("accept-invite pushes the user count when there is a subscription and calls nothing when there isn't", async () => {
  // An invitation, the way POST /invite leaves one (the secret only as its hash).
  const invite = (orgId) => {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, invite_token_hash, invite_expires, invite_accepted)
      VALUES (?, 'lo', 'Nia', 'Newhire', ?, ?, ?, 0)
    `).run(orgId, `nia${++seq}@api.test`, hashToken(token), new Date(Date.now() + DAY_MS).toISOString());
    return token;
  };
  const acceptInvite = (token) => post("/api/auth/accept-invite", null, { token, password: "password123", acceptTerms: true });

  const subbed = brokerage({ billing_status: "trialing", stripe_subscription_id: "sub_inv", stripe_item_id: "si_inv", billing_quantity: 1, billing_synced_at: Date.now() });
  const r = await acceptInvite(invite(subbed.orgId));
  assert.strictEqual(r.status, 200);
  await until(() => calls.length === 1);
  assert.deepStrictEqual(calls, [["setQuantity", { subscriptionId: "sub_inv", itemId: "si_inv", quantity: 2 }]]);
  await until(() => orgRow(subbed.orgId).billing_quantity === 2);

  // no subscription yet: nothing to push
  calls = [];
  const bare = brokerage();
  assert.strictEqual((await acceptInvite(invite(bare.orgId))).status, 200);
  await settle();
  assert.deepStrictEqual(calls, []);

  // billing off: nothing, even with a subscription on file
  billingOff();
  const offSub = brokerage({ billing_status: "active", stripe_subscription_id: "sub_off", stripe_item_id: "si_off", billing_quantity: 1 });
  assert.strictEqual((await acceptInvite(invite(offSub.orgId))).status, 200);
  await settle();
  assert.deepStrictEqual(calls, []);
  app.set("billingConfig", { ...CONFIG });

  // a failed push is logged by its message only; the person is still in
  gateway.state.fail.add("setQuantity");
  const failing = brokerage({ billing_status: "active", stripe_subscription_id: "sub_f", stripe_item_id: "si_f", billing_quantity: 1, billing_synced_at: Date.now() });
  const lines = await captureLogs(async () => {
    assert.strictEqual((await acceptInvite(invite(failing.orgId))).status, 200);
    await until(() => calls.length === 1);
    await settle();
  });
  assert.ok(lines.some((l) => l.includes(`org ${failing.orgId}`) && l.includes("setQuantity failed")), lines.join("\n"));
  assert.ok(!lines.some((l) => /sub_f|si_f|nia\d+@/.test(l)), "no Stripe id or address in the log");
  assert.strictEqual(orgRow(failing.orgId).billing_quantity, 1, "kept for the next try");
});

test("export.csv: this org's clients only, formula cells neutralised, locked broker allowed", async () => {
  const mine = brokerage({ los: 1, billing_status: "canceled" });   // locked: its subscription has ended
  const [lo] = mine.los;
  addClient(mine.broker, { name: "Zed Broker-Client", notes: 'said "call me", then left' });
  addClient(lo, { name: "=HYPERLINK(\"http://evil.test\",\"x\")", email: "+1@evil.test", phone: "-2+3", notes: "@SUM(A1)", loan_type: "5_1_arm", current_rate: 6.5 });
  addClient(lo, { name: "Amy LO-Client", notes: "line one\nline two" });
  const theirs = brokerage();
  addClient(theirs.broker, { name: "Other Org Client" });

  assert.strictEqual((await get("/api/clients", mine.broker)).status, 402, "locked");
  const r = await get("/api/billing/export.csv", mine.broker);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/csv; charset=utf-8/);
  assert.strictEqual(r.headers.get("content-disposition"), 'attachment; filename="broker-radar-clients.csv"');
  assert.match(r.headers.get("cache-control"), /no-store/);
  // a byte-order mark first, so spreadsheet programs read the names right (fetch's text() drops it, so the bytes are read)
  const raw = await fetch(base + "/api/billing/export.csv", { headers: { cookie: `rr_token=${signToken({ userId: mine.broker.id, sv: 0 })}` } });
  assert.deepStrictEqual([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const rows = readCsv(r.text);
  assert.deepStrictEqual(rows[0], [
    "Name", "Email", "Phone", "Loan type", "Current rate", "Loan balance", "Property value", "Close date", "Credit score",
    "Last contact", "Notes", "Loan number", "Loan officer", "Loan officer email", "Added", "Updated",
  ]);
  assert.strictEqual(rows.length, 4, "a header and this brokerage's three clients, every loan officer's included");
  const byName = Object.fromEntries(rows.slice(1).map((row) => [row[0], row]));
  assert.ok(!r.text.includes("Other Org Client"));
  const evil = byName["'=HYPERLINK(\"http://evil.test\",\"x\")"];
  assert.ok(evil, Object.keys(byName).join(" | "));
  assert.strictEqual(evil[1], "'+1@evil.test");
  assert.strictEqual(evil[2], "'-2+3");
  assert.strictEqual(evil[3], "5/1 ARM");
  assert.strictEqual(evil[4], "6.5");
  assert.strictEqual(evil[10], "'@SUM(A1)");
  assert.strictEqual(evil[12], "Lou Officer");
  assert.strictEqual(evil[13], lo.email);
  assert.ok(r.text.includes('"=HYPERLINK(') === false && r.text.includes('"\'=HYPERLINK(""http://evil.test"",""x"")"'), "inner quotes doubled");
  const zed = byName["Zed Broker-Client"];
  assert.strictEqual(zed[10], 'said "call me", then left');
  assert.strictEqual(zed[3], "30-Yr Fixed");
  assert.strictEqual(zed[5], "350000");
  assert.strictEqual(zed[12], "Bea Broker");
  assert.strictEqual(byName["Amy LO-Client"][10], "line one\nline two");

  // an LO may not; not signed in may not; billing off still may
  assert.strictEqual((await get("/api/billing/export.csv", lo)).status, 403);
  assert.strictEqual((await get("/api/billing/export.csv", null)).status, 401);
  billingOff();
  assert.strictEqual((await get("/api/billing/export.csv", mine.broker)).status, 200);
  assert.deepStrictEqual(calls, []);
});

test("start-up: existing orgs get a 30-day month once; exempt follows the list; off changes nothing", () => {
  const NOW = Date.now();
  const existing = brokerage();
  db.prepare("UPDATE organizations SET billing_status = NULL WHERE id = ?").run(existing.orgId);
  const bill = brokerage();
  db.prepare("UPDATE organizations SET billing_status = NULL WHERE id = ?").run(bill.orgId);
  const paying = brokerage({ billing_status: "active", billing_exempt: 1 });
  const before = (id) => ({ ...orgRow(id) });

  // off: nothing at all
  const snapshot = [existing.orgId, bill.orgId, paying.orgId].map(before);
  applyBillingStartup(db, { ...CONFIG, enabled: false, exemptEmails: [bill.broker.email] }, NOW);
  assert.deepStrictEqual([existing.orgId, bill.orgId, paying.orgId].map(before), snapshot);

  // on: every organization from before billing gets a free month (not as a tester-code sign-up) and a status; the exempt list is
  // matched without regard to case, and an organization off the list is not exempt
  applyBillingStartup(db, { ...CONFIG, exemptEmails: [bill.broker.email.toUpperCase()] }, NOW);
  const e = orgRow(existing.orgId);
  assert.strictEqual(e.billing_status, "none");
  assert.strictEqual(e.billing_tester_until, NOW + 30 * DAY_MS);
  assert.strictEqual(e.billing_via_tester_code, 0);
  assert.strictEqual(e.billing_exempt, 0);
  assert.strictEqual(orgRow(bill.orgId).billing_exempt, 1);
  assert.strictEqual(orgRow(paying.orgId).billing_exempt, 0, "off the list, so no longer exempt");
  assert.strictEqual(orgRow(paying.orgId).billing_tester_until, null, "an organization already on billing gets no free month");
  assert.strictEqual(orgRow(paying.orgId).billing_status, "active");

  // once: a later start (a day on) leaves the month where it was; the list changes, the exemption follows
  applyBillingStartup(db, { ...CONFIG, exemptEmails: [paying.broker.email] }, NOW + DAY_MS);
  assert.strictEqual(orgRow(existing.orgId).billing_tester_until, NOW + 30 * DAY_MS);
  assert.strictEqual(orgRow(bill.orgId).billing_exempt, 0);
  assert.strictEqual(orgRow(paying.orgId).billing_exempt, 1);
  // no list at all exempts no one
  applyBillingStartup(db, { ...CONFIG, exemptEmails: undefined }, NOW + DAY_MS);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE billing_exempt = 1").get().n, 0);
});

test("/org/stats shows the billing state instead of the old trial date when billing is on (H12)", async () => {
  const stats = async (user) => (await get("/api/org/stats", user)).data.stats;
  const trialEnd = Date.now() + 10 * DAY_MS;
  const trial = brokerage({ los: 1, billing_status: "trialing", billing_trial_end: trialEnd, stripe_subscription_id: "sub_st", billing_synced_at: Date.now() });
  const legacy = orgRow(trial.orgId);

  billingOff();
  assert.deepStrictEqual(await stats(trial.broker), { loCount: 1, totalClients: 0, orgName: legacy.name, plan: "trial", trialEnds: legacy.trial_ends });
  app.set("billingConfig", { ...CONFIG });
  const on = await stats(trial.broker);
  assert.strictEqual(on.plan, "trialing");
  assert.strictEqual(on.trialEnds, new Date(trialEnd).toISOString());

  const testerUntil = Date.now() + 20 * DAY_MS;
  const tester = brokerage({ billing_tester_until: testerUntil });
  assert.deepStrictEqual([(await stats(tester.broker)).plan, (await stats(tester.broker)).trialEnds], ["none", new Date(testerUntil).toISOString()]);
  // a paid subscription keeps Stripe's old trial end, which is not shown
  const active = brokerage({ billing_status: "active", billing_trial_end: Date.now() - DAY_MS, stripe_subscription_id: "sub_sa", billing_synced_at: Date.now() });
  assert.deepStrictEqual([(await stats(active.broker)).plan, (await stats(active.broker)).trialEnds], ["active", null]);
  const pastDue = brokerage({ billing_status: "past_due", stripe_subscription_id: "sub_pd", billing_synced_at: Date.now() });
  assert.strictEqual((await stats(pastDue.broker)).plan, "past_due");
  const exempt = brokerage({ billing_exempt: 1 });
  assert.deepStrictEqual([(await stats(exempt.broker)).plan, (await stats(exempt.broker)).trialEnds], ["exempt", null]);
});
