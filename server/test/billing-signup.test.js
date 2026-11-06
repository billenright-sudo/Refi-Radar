"use strict";
// Billing-aware sign-up (spec §6.1, §6.6): the terms tick and the limited tester code on POST /register, the tester month and its
// card-less Stripe trial at POST /register/complete, the acceptances recorded there and at POST /accept-invite, and
// POST /terms/accept for a user the gate stops with "terms". Throwaway DB, the real routers. Nothing reaches Stripe or sends mail:
// the gateway is a fake that records its calls, and every sender comes in through an app seam. Sign-up with billing off is covered
// in full by signup-api.test.js; here only the billing fields being ignored is checked. Every request carries its own
// X-Forwarded-For (the app trusts one proxy hop), so the module-level IP limiters never get in the way, and so req.ip is known.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-billing-signup-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
delete process.env.APP_URL;

const crypto = require("crypto");
const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const authRoutes = require("../routes/auth");
const clientRoutes = require("../routes/clients");
const { signToken } = require("../middleware/auth");
const { createSendCounter, hashToken } = require("../lib/passwordReset");
const { addBroker } = require("../test-support/accounts");
const { TERMS_VERSION, PRIVACY_VERSION, termsCurrent } = require("../lib/terms");
const { TESTER_DAYS } = require("../lib/billing/config");

const DAY_MS = 86_400_000;
const READY_ENV = { NODE_ENV: "test", EMAIL_USER: "a", EMAIL_PASS: "b" };
const CODE = "early-bird";
const CONFIG = Object.freeze({
  enabled: true, stripeConfigured: true, secretKey: "sk_test_must_never_be_logged", webhookSecret: "whsec_test", priceId: "price_test",
  testerCode: CODE, testerMaxUses: 25, testerExpiresMs: null, exemptEmails: [],
});
const TERMS_LINE = "Please agree to the Terms of Service and Privacy Policy.";
const TESTER_LINE = "That tester code isn't valid.";
const NEEDS_ATTENTION = "Broker Radar needs attention before you can continue.";
const OK = { success: true };
// The sign-up form as the page sends it with billing on (the tick given); PLAIN is the form from before billing.
const FORM = Object.freeze({ firstName: "Tia", lastName: "Tester", email: "tia@x.test", password: "password123", orgName: "Tia Mortgage", acceptTerms: true });
const { acceptTerms: _tick, ...PLAIN } = FORM;

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const signupRow = (mail) => db.prepare("SELECT * FROM signup_requests WHERE email = ?").get(mail);
const orgRow = (id) => db.prepare("SELECT * FROM organizations WHERE id = ?").get(id);
const userByEmail = (mail) => db.prepare("SELECT * FROM users WHERE email = ?").get(mail);
const acceptances = (userId) => db.prepare("SELECT * FROM terms_acceptances WHERE user_id = ? ORDER BY id").all(userId);
const testerOrgs = () => db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE billing_via_tester_code = 1").get().n;
// An organization that already came in on the tester code (it counts against the code's limit).
const usedTesterPlace = (i) => db.prepare("INSERT INTO organizations (name, billing_status, billing_via_tester_code) VALUES (?, 'trialing', 1)").run(`Earlier tester ${i}`);
const cookieFor = (user) => `rr_token=${signToken({ userId: user.id, sv: user.session_version || 0 })}`;

// The fake gateway: everything that would reach Stripe is recorded in `calls`; `fail` names methods that throw, as an outage would;
// `hold` (a promise) keeps the tester subscription from coming back until the test lets it.
let calls;
function fakeGateway() {
  const state = { seq: 0, fail: new Set(), hold: null };
  const rec = (name, ...args) => {
    calls.push([name, ...args]);
    if (state.fail.has(name)) throw new Error(`${name} failed`);
  };
  const unused = (name) => async (...args) => { rec(name, ...args); throw new Error(`${name} not used here`); };
  return {
    state,
    // What Stripe answers for the tester month: a trialing subscription with no card, ending when the month ends.
    createTesterSubscription: async (args) => {
      rec("createTesterSubscription", args);
      if (state.hold) await state.hold;
      const n = ++state.seq;
      const trialEnd = Math.floor(args.trialEndMs / 1000);
      const subscription = {
        id: `sub_tester_${n}`, object: "subscription", customer: `cus_tester_${n}`, status: "trialing", trial_end: trialEnd,
        cancel_at_period_end: false, default_payment_method: null, metadata: { org_id: String(args.orgId) },
        items: { object: "list", data: [{ id: `si_tester_${n}`, object: "subscription_item", quantity: args.quantity, current_period_end: trialEnd }] },
      };
      return { customerId: subscription.customer, subscriptionId: subscription.id, itemId: `si_tester_${n}`, status: "trialing", trialEndMs: trialEnd * 1000, subscription };
    },
    setQuantity: unused("setQuantity"),
    retrieveSubscription: unused("retrieveSubscription"),
    retrieveCheckout: unused("retrieveCheckout"),
    createCheckout: unused("createCheckout"),
    createPortal: unused("createPortal"),
    cancelAndRefund: unused("cancelAndRefund"),
    updateCustomerEmail: unused("updateCustomerEmail"),
  };
}

let server, app, base, gateway, signupCalls, takenCalls, confirmations, ipCounter = 0;
// When set, the answer to /register/complete goes out and THEN throws, as a broken response would: what the route does with that.
let breakAnswer = false;
before(async () => {
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (breakAnswer && req.path === "/api/auth/register/complete") {
      const json = res.json.bind(res);
      res.json = (body) => { json(body); throw new Error("the answer broke"); };
    }
    next();
  });
  app.use("/api/auth", authRoutes);
  app.use("/api/clients", clientRoutes);
  app.set("sendSignup", async (args) => { signupCalls.push(args); return true; });
  app.set("sendAlreadyRegistered", async (args) => { takenCalls.push(args); return true; });
  app.set("sendPasswordReset", async () => true);
  app.set("sendInvite", async () => {});
  app.set("sendBillingConfirmation", async (args) => { confirmations.push(args); return true; });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  // a clean slate: no accounts (deleting an organization deletes its users and their acceptances), no waiting sign-ups
  db.prepare("DELETE FROM signup_requests").run();
  db.prepare("DELETE FROM terms_acceptances").run();
  db.prepare("DELETE FROM organizations").run();
  calls = []; signupCalls = []; takenCalls = []; confirmations = [];
  gateway = fakeGateway();
  app.set("billingConfig", { ...CONFIG });
  app.set("billingGateway", gateway);
  app.set("authEnv", { ...READY_ENV });
  app.set("resetSendCounter", createSendCounter());
  app.set("resetSiteSendCounter", createSendCounter({ max: 60 }));
  app.set("signupSiteSendCounter", createSendCounter({ max: 100 }));
});

// One request, from a fresh client address unless `ip` pins one; `cookie` carries a session. One that never answers fails the test.
async function call(method, p, body, { ip, cookie } = {}) {
  const headers = { "content-type": "application/json", "x-forwarded-for": ip || `10.4.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}` };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, { method, headers, signal: AbortSignal.timeout(10000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data, cookie: setCookie ? setCookie.split(";")[0] : null };
}
const register = (over = {}, opts) => call("POST", "/api/auth/register", { ...FORM, ...over }, opts);
const complete = (token, opts) => call("POST", "/api/auth/register/complete", { token, password: FORM.password }, opts);
const clients = (cookie) => call("GET", "/api/clients", undefined, { cookie });

// Everything after an answer happens later (sign-up's starts with a cost-12 bcrypt hash), so a test that looks at it waits.
async function until(check, ms = 5000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
// Room for a wrong, extra call (or a row) to show up before a test says there was none.
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// Asks for a sign-up link (with the tick, for FORM's address unless `over` says otherwise) and returns its token.
async function signupToken(over = {}, opts) {
  const n = signupCalls.length;
  const r = await register(over, opts);
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  await until(() => signupCalls.length === n + 1);
  return signupCalls[n].link.split("#signup=")[1];
}

test("billing on: the terms tick is required with the exact line; billing off: not needed", async () => {
  const refused = async (body, error, what) => {
    const r = await call("POST", "/api/auth/register", body);
    assert.deepStrictEqual([r.status, r.data], [400, { success: false, error }], what);
    assert.strictEqual(r.cookie, null);
  };
  // anything but the boolean true is no tick
  for (const tick of [undefined, false, null, "true", 1, "on", [true], {}]) await refused({ ...FORM, acceptTerms: tick }, TERMS_LINE, JSON.stringify(tick));
  await refused(PLAIN, TERMS_LINE, "the form from before billing");

  // its place among the 400s: after the fields, the password, the email and the names; before the tester code and the 503
  await refused({ ...PLAIN, orgName: "" }, "All fields required");
  await refused({ ...PLAIN, password: "short" }, "Password must be at least 8 characters");
  await refused({ ...PLAIN, email: "nope" }, "Enter a valid email address");
  await refused({ ...PLAIN, lastName: "n".repeat(101) }, "Names and the brokerage name can be at most 100 characters");
  await refused({ ...PLAIN, testerCode: "not-the-code" }, TERMS_LINE, "the tick is asked before the code");
  app.set("authEnv", { NODE_ENV: "test" });   // mail not set up
  await refused(PLAIN, TERMS_LINE, "the tick is asked before the 503");
  assert.strictEqual((await register()).status, 503, "with the tick, the 503");
  app.set("authEnv", { ...READY_ENV });
  await settle();
  assert.strictEqual(signupCalls.length + takenCalls.length, 0, "a refused request sends nothing");
  assert.strictEqual(count("signup_requests"), 0, "and stores nothing");

  // with the tick: the usual answer, and the request remembers the versions the person was shown
  assert.deepStrictEqual(await register().then((r) => [r.status, r.data, r.cookie]), [200, OK, null]);
  await until(() => signupRow("tia@x.test"));
  const row = signupRow("tia@x.test");
  assert.deepStrictEqual([row.terms_version, row.privacy_version, row.tester], [TERMS_VERSION, PRIVACY_VERSION, 0]);
  // a taken address gets the same answer and email B, and nothing is stored, as before billing (a right code changes nothing)
  addBroker(db, { email: "lou@x.test", firstName: "Lou" });
  assert.deepStrictEqual(await register({ email: "lou@x.test", testerCode: CODE }).then((r) => [r.status, r.data]), [200, OK]);
  await until(() => takenCalls.length === 1);
  await settle();
  assert.deepStrictEqual(takenCalls[0], { to: "lou@x.test", firstName: "Lou" });
  assert.strictEqual(signupRow("lou@x.test"), undefined);
  assert.strictEqual(testerOrgs(), 0);

  // billing off (switched off, or never set up): no tick needed, and a tick or a code sent anyway is ignored completely
  let n = 0;
  for (const config of [{ ...CONFIG, enabled: false }, undefined]) {
    app.set("billingConfig", config);
    const asks = [PLAIN, { ...FORM, acceptTerms: false, testerCode: "not-the-code" }, { ...FORM, testerCode: 42 }, { ...FORM, testerCode: CODE }];
    const tokens = [];
    for (const body of asks) tokens.push(await signupToken({ ...body, email: `off${++n}@x.test` }));
    for (let i = n - asks.length + 1; i <= n; i++) {
      const r = signupRow(`off${i}@x.test`);
      assert.deepStrictEqual([r.tester, r.terms_version, r.privacy_version], [0, null, null], `off${i}`);
    }
    // finishing is as before billing: no acceptance recorded, no billing state, no tester month, nothing sent to Stripe
    for (const token of tokens) {
      const done = await complete(token);
      assert.strictEqual(done.status, 200);
      assert.deepStrictEqual([done.data.success, done.data.tester], [true, false]);
      const org = orgRow(done.data.user.orgId);
      assert.deepStrictEqual([org.billing_status, org.billing_tester_until, org.billing_via_tester_code], [null, null, 0]);
      assert.deepStrictEqual(acceptances(done.data.user.id), []);
      assert.strictEqual((await clients(done.cookie)).status, 200, "no gate with billing off");
    }
  }
  await settle();
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(confirmations, []);
});

test("tester code: wrong, unset, expired or used up is 400; right (any case) gives a 30-day month and a Stripe trial with no card", async () => {
  const refused = async (config, testerCode, what) => {
    app.set("billingConfig", { ...CONFIG, ...config });
    const r = await register({ email: "tess@x.test", testerCode });
    assert.deepStrictEqual([r.status, r.data], [400, { success: false, error: TESTER_LINE }], what);
  };
  await refused({}, "late-bird", "wrong");
  await refused({}, `${CODE}-2`, "wrong");
  for (const notText of [42, true, [CODE], { code: CODE }]) await refused({}, notText, JSON.stringify(notText));
  await refused({ testerCode: null }, CODE, "no code is set");
  await refused({ testerExpiresMs: Date.now() - 1 }, CODE, "expired");
  // used up: as many organizations as the limit already came in on the code
  usedTesterPlace(1); usedTesterPlace(2);
  await refused({ testerMaxUses: 2 }, CODE, "used up");
  await refused({ testerMaxUses: 0 }, CODE, "a limit of 0");
  // the code is checked before the 503
  app.set("authEnv", { NODE_ENV: "test" });
  await refused({}, "late-bird", "before the 503");
  app.set("authEnv", { ...READY_ENV });
  await settle();
  assert.strictEqual(signupCalls.length + takenCalls.length, 0, "a refused request sends nothing");
  assert.strictEqual(count("signup_requests"), 0, "and stores nothing");

  // a blank code is no code: a normal sign-up
  app.set("billingConfig", { ...CONFIG });
  for (const [i, blank] of ["", "   ", null].entries()) {
    await signupToken({ email: `blank${i}@x.test`, testerCode: blank });
    assert.strictEqual(signupRow(`blank${i}@x.test`).tester, 0, JSON.stringify(blank));
  }

  // the right code, in any case and with spaces: the request is marked, and finishing it starts the month
  const token = await signupToken({ testerCode: "  Early-BIRD " });
  assert.strictEqual(signupRow("tia@x.test").tester, 1);
  const startedAt = Date.now();
  const r = await complete(token);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.data).sort(), ["success", "tester", "user"]);
  assert.deepStrictEqual([r.data.success, r.data.tester, r.data.user.email], [true, true, "tia@x.test"]);
  // the month, from our own database: 30 days from now, counted against the code
  const org = orgRow(r.data.user.orgId);
  assert.strictEqual(org.billing_via_tester_code, 1);
  assert.ok(Math.abs(org.billing_tester_until - (startedAt + TESTER_DAYS * DAY_MS)) < 5000, "a 30-day month from now");
  // and Stripe's side was done before the answer (ruling 9): one card-less trial for one user, ending with the month, stored by the
  // webhook's own rules, and the test-month confirmation sent once
  assert.deepStrictEqual(calls, [["createTesterSubscription", {
    email: "tia@x.test", orgId: org.id, orgName: "Tia Mortgage", priceId: "price_test", quantity: 1, trialEndMs: org.billing_tester_until,
  }]]);
  assert.deepStrictEqual(
    [org.stripe_customer_id, org.stripe_subscription_id, org.stripe_item_id, org.billing_status, org.billing_quantity, org.billing_has_card],
    ["cus_tester_1", "sub_tester_1", "si_tester_1", "trialing", 1, 0],
  );
  assert.strictEqual(org.billing_trial_end, Math.floor(org.billing_tester_until / 1000) * 1000);
  assert.strictEqual(confirmations.length, 1);
  assert.strictEqual(confirmations[0].to, "tia@x.test");
  assert.strictEqual(confirmations[0].kind, "tester");
  assert.strictEqual(confirmations[0].orgName, "Tia Mortgage");
  assert.strictEqual(org.billing_confirmation_sent, 1);
  assert.strictEqual((await clients(r.cookie)).status, 200, "in, with no card");
  await settle();
  assert.strictEqual(confirmations.length, 1);
  assert.strictEqual(calls.length, 1, "nothing else reached Stripe");
  assert.strictEqual(testerOrgs(), 3);
});

test("a Stripe that hangs holds up the tester's answer only up to the bound, with tester: true; the work then carries on", async (t) => {
  const logged = [];
  for (const m of ["error", "warn", "log"]) t.mock.method(console, m, (...args) => { logged.push(args.map(String).join(" ")); });
  const BOUND_MS = 300;
  app.set("testerSubscriptionWaitMs", BOUND_MS);
  let release;
  gateway.state.hold = new Promise((r) => { release = r; });
  try {
    const token = await signupToken({ testerCode: CODE });
    const startedAt = Date.now();
    const r = await complete(token);
    const took = Date.now() - startedAt;
    assert.deepStrictEqual([r.status, r.data.success, r.data.tester], [200, true, true]);
    assert.ok(took >= BOUND_MS, `it waited for Stripe first (${took} ms)`);
    assert.ok(took < BOUND_MS + 3000, `then answered at the bound (${took} ms)`);
    // the month runs from our database without Stripe's answer
    const orgId = r.data.user.orgId;
    const org = orgRow(orgId);
    assert.deepStrictEqual([org.billing_status, org.billing_via_tester_code, org.stripe_subscription_id], ["none", 1, null]);
    assert.ok(org.billing_tester_until > Date.now() + (TESTER_DAYS - 1) * DAY_MS);
    assert.strictEqual((await clients(r.cookie)).status, 200, "in, with no card and no Stripe yet");
    assert.deepStrictEqual(calls.map((c) => c[0]), ["createTesterSubscription"]);
    assert.deepStrictEqual(confirmations, []);
    assert.ok(logged.some((l) => l.includes(`org ${orgId}`) && l.includes(`not finished after ${BOUND_MS} ms`)), logged.join("\n"));
    assert.ok(!logged.join("\n").includes("@x.test"), "no address in the log");

    // Stripe answers late: the subscription is still stored and the confirmation still sent
    release();
    await until(() => confirmations.length === 1);
    assert.deepStrictEqual([orgRow(orgId).stripe_subscription_id, orgRow(orgId).billing_status], ["sub_tester_1", "trialing"]);
  } finally {
    release();
    app.set("testerSubscriptionWaitMs", undefined);
  }
});

test("a tester's answer that throws after the Stripe side is caught and logged by message, never an unhandled rejection", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...args) => { logged.push(args.map(String).join(" ")); });
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const token = await signupToken({ testerCode: CODE });
    breakAnswer = true;
    const r = await complete(token);
    assert.deepStrictEqual([r.status, r.data.success, r.data.tester], [200, true, true], "the answer itself went out");
    await settle(100);
    assert.deepStrictEqual(unhandled.map((e) => e?.message), [], "no unhandled rejection");
    assert.ok(logged.includes("[auth] register/complete answer failed: the answer broke"), logged.join("\n"));
    assert.ok(!logged.join("\n").includes("@x.test"), "no address in the log");
  } finally {
    breakAnswer = false;
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the 26th tester sign-up with a limit of 25 gets the normal card ask (re-checked at complete)", async () => {
  for (let i = 1; i <= 24; i++) usedTesterPlace(i);
  // two people ask while one place is left: both requests are marked as testers
  const first = await signupToken({ email: "t25@x.test", testerCode: CODE });
  const second = await signupToken({ email: "t26@x.test", testerCode: CODE });
  assert.deepStrictEqual([signupRow("t25@x.test").tester, signupRow("t26@x.test").tester], [1, 1]);

  const a = await complete(first);
  assert.deepStrictEqual([a.status, a.data.tester], [200, true]);
  assert.strictEqual(testerOrgs(), 25);
  // no place left: a new request with the code is refused...
  const late = await register({ email: "t27@x.test", testerCode: CODE });
  assert.deepStrictEqual([late.status, late.data], [400, { success: false, error: TESTER_LINE }]);
  // ...and the one still waiting becomes a normal sign-up: the brokerage exists, and is asked for a card
  const b = await complete(second);
  assert.deepStrictEqual([b.status, b.data.success, b.data.tester, b.data.user.email], [200, true, false, "t26@x.test"]);
  const org = orgRow(b.data.user.orgId);
  assert.deepStrictEqual([org.billing_status, org.billing_tester_until, org.billing_via_tester_code], ["none", null, 0]);
  assert.strictEqual(testerOrgs(), 25, "never past the limit");
  assert.deepStrictEqual(await clients(b.cookie).then((x) => [x.status, x.data]), [402, { success: false, error: NEEDS_ATTENTION, reason: "needs_card" }]);
  assert.strictEqual(termsCurrent(db, b.data.user.id), true, "the terms were still recorded");
  await until(() => confirmations.length === 1);
  await settle();
  assert.deepStrictEqual(calls.map((c) => [c[0], c[1].orgId]), [["createTesterSubscription", a.data.user.orgId]], "Stripe only for the 25th");
  assert.deepStrictEqual(confirmations.map((c) => c.to), ["t25@x.test"]);

  // the same when the code runs out of days, or is switched off, between asking and finishing
  app.set("billingConfig", { ...CONFIG, testerMaxUses: 100 });
  const expiring = await signupToken({ email: "exp@x.test", testerCode: CODE });
  const switchedOff = await signupToken({ email: "off@x.test", testerCode: CODE });
  app.set("billingConfig", { ...CONFIG, testerMaxUses: 100, testerExpiresMs: Date.now() - 1 });
  const e = await complete(expiring);
  assert.deepStrictEqual([e.status, e.data.tester, orgRow(e.data.user.orgId).billing_tester_until], [200, false, null]);
  app.set("billingConfig", { ...CONFIG, testerMaxUses: 100, testerCode: null });
  const o = await complete(switchedOff);
  assert.deepStrictEqual([o.status, o.data.tester, orgRow(o.data.user.orgId).billing_tester_until], [200, false, null]);
  await settle();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(testerOrgs(), 25);
});

// Round 2, item 7: an address on BILLING_EXEMPT_EMAILS is exempt from the moment its brokerage is created, not only from the next
// start-up: no card ask, no tester month (even with the code: it would use up a place for nothing), nothing at Stripe.
test("an exempt address is exempt at sign-up: billing_exempt = 1, no tester month even with the code, nothing at Stripe, the app opens", async () => {
  app.set("billingConfig", { ...CONFIG, exemptEmails: ["tia@x.test"] });
  const token = await signupToken({ email: "TIA@x.test", testerCode: CODE });
  const r = await complete(token);
  assert.deepStrictEqual([r.status, r.data.success, r.data.tester, r.data.user.email], [200, true, false, "tia@x.test"]);
  const org = orgRow(r.data.user.orgId);
  assert.deepStrictEqual(
    [org.billing_exempt, org.billing_status, org.billing_tester_until, org.billing_via_tester_code],
    [1, "none", null, 0],
  );
  assert.strictEqual(testerOrgs(), 0, "no tester place used");
  assert.strictEqual((await clients(r.cookie)).status, 200, "in, with no card and no month");
  // an address that is not on the list signs up as before: asked for a card
  const other = await complete(await signupToken({ email: "ola@x.test" }));
  assert.deepStrictEqual([orgRow(other.data.user.orgId).billing_exempt, (await clients(other.cookie)).status], [0, 402]);
  await settle();
  assert.deepStrictEqual(calls, [], "nothing reached Stripe");
  assert.deepStrictEqual(confirmations, [], "and no confirmation email");
});

test("complete records both acceptances (versions, time, IP); a failing tester subscription leaves the month working", async (t) => {
  const logged = [];
  for (const m of ["error", "warn", "log"]) t.mock.method(console, m, (...args) => { logged.push(args.map(String).join(" ")); });

  // the address that finished it (req.ip), at that moment, for both documents
  const token = await signupToken({}, { ip: "203.0.113.10" });
  const from = Date.now();
  const r = await complete(token, { ip: "198.51.100.23" });
  const to = Date.now();
  assert.deepStrictEqual([r.status, r.data.tester], [200, false]);
  const rows = acceptances(r.data.user.id);
  assert.deepStrictEqual(rows.map((a) => [a.document, a.version, a.ip]), [["terms", TERMS_VERSION, "198.51.100.23"], ["privacy", PRIVACY_VERSION, "198.51.100.23"]]);
  for (const a of rows) assert.ok(a.accepted_at >= from && a.accepted_at <= to, "accepted now");
  assert.strictEqual(termsCurrent(db, r.data.user.id), true);
  // past the terms: next is the card ask (no card, no tester month)
  assert.strictEqual((await clients(r.cookie)).data.reason, "needs_card");

  // the versions recorded are the ones on the request (what the person was shown), whatever is current when they finish
  const shown = await signupToken({ email: "shown@x.test" });
  db.prepare("UPDATE signup_requests SET terms_version = '2026-01-01', privacy_version = '2026-01-02' WHERE email = 'shown@x.test'").run();
  const s = await complete(shown);
  assert.deepStrictEqual(acceptances(s.data.user.id).map((a) => [a.document, a.version]), [["terms", "2026-01-01"], ["privacy", "2026-01-02"]]);
  assert.strictEqual((await clients(s.cookie)).data.reason, "terms", "an old version is accepted again on the next visit");

  // a refused finish (the wrong password) records nothing and creates nothing
  const wrong = await signupToken({ email: "wrong@x.test" });
  const w = await call("POST", "/api/auth/register/complete", { token: wrong, password: "not-the-password" });
  assert.strictEqual(w.status, 400);
  assert.strictEqual(userByEmail("wrong@x.test"), undefined);

  // Stripe failing: the tester still gets in, the month still runs, and the log has our org id and the message, nothing more
  gateway.state.fail.add("createTesterSubscription");
  const failToken = await signupToken({ email: "fail@x.test", testerCode: CODE });
  const f = await complete(failToken);
  assert.deepStrictEqual([f.status, f.data.tester], [200, true]);
  const failOrg = f.data.user.orgId;
  await until(() => logged.some((l) => l.includes(`org ${failOrg}`)));
  await settle();
  assert.ok(logged.some((l) => l.includes(`org ${failOrg}`) && l.includes("createTesterSubscription failed")), logged.join("\n"));
  const org = orgRow(failOrg);
  assert.ok(org.billing_tester_until > Date.now() + (TESTER_DAYS - 1) * DAY_MS);
  assert.deepStrictEqual([org.billing_status, org.billing_via_tester_code, org.stripe_customer_id, org.stripe_subscription_id], ["none", 1, null, null]);
  assert.strictEqual((await clients(f.cookie)).status, 200, "the month works without Stripe");
  assert.strictEqual(termsCurrent(db, f.data.user.id), true);
  assert.deepStrictEqual(confirmations, []);

  // billing on with no payment service: the month starts here, nothing is sent anywhere, and the log says so by message
  app.set("billingGateway", undefined);
  calls = [];
  const bare = await complete(await signupToken({ email: "bare@x.test", testerCode: CODE }));
  assert.deepStrictEqual([bare.status, bare.data.tester], [200, true]);
  const bareOrg = bare.data.user.orgId;
  await until(() => logged.some((l) => l.includes(`org ${bareOrg}`)));
  assert.ok(orgRow(bareOrg).billing_tester_until > Date.now());
  assert.strictEqual((await clients(bare.cookie)).status, 200);
  await settle();
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(confirmations, []);

  // no log line holds an address, a link, a token or a secret
  const text = logged.join("\n");
  for (const secret of ["@x.test", "#signup=", "sk_test", "whsec", failToken]) assert.ok(!text.includes(secret), `a log line holds ${secret}`);
  assert.ok(!/[0-9a-f]{64}/.test(text), "a log line holds a token");
});

test("accept-invite: on requires and records the tick; off unchanged", async () => {
  const broker = addBroker(db, { email: "bea@x.test", firstName: "Bea" });
  // a tester month, so the gate below can only stop a loan officer for the terms
  db.prepare("UPDATE organizations SET billing_status = 'none', billing_tester_until = ? WHERE id = ?").run(Date.now() + DAY_MS, broker.org_id);
  // an invitation, the way POST /invite leaves one (the secret only as its hash)
  const invite = (mail) => {
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, invite_token_hash, invite_expires, invite_accepted)
      VALUES (?, 'lo', 'Lou', 'Officer', ?, ?, ?, 0)
    `).run(broker.org_id, mail, hashToken(token), new Date(Date.now() + DAY_MS).toISOString());
    return token;
  };
  const accept = (body, opts) => call("POST", "/api/auth/accept-invite", body, opts);
  const token = invite("lou@x.test");

  // no tick: 400 with the sign-up's line, and the invitation is untouched and still good
  for (const tick of [undefined, false, null, "true", 1]) {
    const r = await accept({ token, password: "password123", acceptTerms: tick });
    assert.deepStrictEqual([r.status, r.data, r.cookie], [400, { success: false, error: TERMS_LINE }, null], JSON.stringify(tick));
  }
  // checked with the password, before the invitation is looked up: a bad password is named first, and a bad link still gets the 400
  assert.strictEqual((await accept({ token, password: "short" })).data.error, "Password must be at least 8 characters");
  assert.strictEqual((await accept({ token, password: "x".repeat(257) })).data.error, "Password must be at most 256 characters");
  assert.deepStrictEqual(await accept({ token: "ab".repeat(32), password: "password123" }).then((r) => [r.status, r.data.error]), [400, TERMS_LINE]);
  assert.strictEqual(userByEmail("lou@x.test").invite_accepted, 0);
  assert.strictEqual((await call("POST", "/api/auth/invite/check", { token })).status, 200, "the invitation is still good");
  // a bad link with the tick: the usual 410
  assert.strictEqual((await accept({ token: "ab".repeat(32), password: "password123", acceptTerms: true })).status, 410);

  // with the tick: in, and both documents accepted at the current versions, from the address it came from
  const from = Date.now();
  const ok = await accept({ token, password: "password123", acceptTerms: true }, { ip: "198.51.100.40" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.user.email, "lou@x.test");
  const lou = userByEmail("lou@x.test");
  const rows = acceptances(lou.id);
  assert.deepStrictEqual(rows.map((a) => [a.document, a.version, a.ip]), [["terms", TERMS_VERSION, "198.51.100.40"], ["privacy", PRIVACY_VERSION, "198.51.100.40"]]);
  assert.ok(rows.every((a) => a.accepted_at >= from && a.accepted_at <= Date.now()));
  assert.strictEqual((await clients(ok.cookie)).status, 200, "past the gate");
  // used: a second try records nothing more
  assert.strictEqual((await accept({ token, password: "password123", acceptTerms: true })).status, 410);
  assert.strictEqual(acceptances(lou.id).length, 2);

  // billing off: as before billing, no tick needed and nothing recorded
  app.set("billingConfig", { ...CONFIG, enabled: false });
  const offToken = invite("mo@x.test");
  const off = await accept({ token: offToken, password: "password123" });
  assert.strictEqual(off.status, 200);
  assert.deepStrictEqual(acceptances(userByEmail("mo@x.test").id), []);
  const offTick = invite("ned@x.test");
  assert.strictEqual((await accept({ token: offTick, password: "password123", acceptTerms: true })).status, 200);
  assert.deepStrictEqual(acceptances(userByEmail("ned@x.test").id), [], "a tick sent anyway is ignored");
  assert.strictEqual((await clients(off.cookie)).status, 200);
  await settle();
  assert.deepStrictEqual(calls, []);
});

test("an existing user without an acceptance gets 402 terms until POST /api/auth/terms/accept", async () => {
  // a brokerage from before billing, in its free month: only the terms stand in the way
  const broker = addBroker(db, { email: "old@x.test" });
  db.prepare("UPDATE organizations SET billing_status = 'none', billing_tester_until = ? WHERE id = ?").run(Date.now() + DAY_MS, broker.org_id);
  const cookie = cookieFor(broker);
  const TERMS_402 = [402, { success: false, error: NEEDS_ATTENTION, reason: "terms" }];
  assert.deepStrictEqual(await clients(cookie).then((r) => [r.status, r.data]), TERMS_402);
  assert.strictEqual((await call("GET", "/api/auth/me", undefined, { cookie })).status, 200, "sign-in itself still works");

  // the call needs a sign-in, and is not behind the gate
  assert.strictEqual((await call("POST", "/api/auth/terms/accept", {})).status, 401);
  assert.deepStrictEqual(acceptances(broker.id), []);
  const from = Date.now();
  const r = await call("POST", "/api/auth/terms/accept", {}, { cookie, ip: "198.51.100.77" });
  assert.deepStrictEqual([r.status, r.data], [200, OK]);
  const rows = acceptances(broker.id);
  assert.deepStrictEqual(rows.map((a) => [a.document, a.version, a.ip]), [["terms", TERMS_VERSION, "198.51.100.77"], ["privacy", PRIVACY_VERSION, "198.51.100.77"]]);
  assert.ok(rows.every((a) => a.accepted_at >= from && a.accepted_at <= Date.now()));
  assert.strictEqual(termsCurrent(db, broker.id), true);
  assert.strictEqual((await clients(cookie)).status, 200, "in");

  // an acceptance of an older version counts for nothing: "We've updated our terms" until the current one is accepted
  const loId = Number(db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', 'Lou', 'Officer', 'lou@x.test', 'h', 1)"
  ).run(broker.org_id).lastInsertRowid);
  for (const doc of ["terms", "privacy"]) {
    db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at, ip) VALUES (?, ?, '2025-01-01', ?, '127.0.0.1')").run(loId, doc, Date.now() - DAY_MS);
  }
  const loCookie = cookieFor({ id: loId });
  assert.deepStrictEqual(await clients(loCookie).then((x) => [x.status, x.data]), TERMS_402);
  assert.deepStrictEqual(await call("POST", "/api/auth/terms/accept", {}, { cookie: loCookie }).then((x) => [x.status, x.data]), [200, OK]);
  assert.strictEqual((await clients(loCookie)).status, 200);

  // billing off: nobody is asked
  const other = addBroker(db, { email: "new@x.test", orgName: "Other Mortgage" });
  assert.strictEqual((await clients(cookieFor(other))).data.reason, "terms");
  app.set("billingConfig", { ...CONFIG, enabled: false });
  assert.strictEqual((await clients(cookieFor(other))).status, 200);
  app.set("billingConfig", undefined);
  assert.strictEqual((await clients(cookieFor(other))).status, 200);
});
