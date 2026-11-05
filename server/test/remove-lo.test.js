"use strict";
// DELETE /api/org/los/:id (routes/org.js): a broker removes an accepted loan officer or cancels a pending invitation, and the
// billing email follows a broker's confirmed login-email change (routes/profile.js, H14). Throwaway DB; the gateway is a fake
// that records its calls, so nothing reaches Stripe, and the invite/email-change mail goes through the app seams.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-remove-lo-"));
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
const authRoutes = require("../routes/auth");
const orgRoutes = require("../routes/org");
const profileRoutes = require("../routes/profile");
const { createIntegrationsRouter } = require("../routes/integrations");
const { hashToken } = require("../lib/passwordReset");
const { TERMS_VERSION, PRIVACY_VERSION } = require("../lib/terms");

const CONFIG = Object.freeze({ enabled: true, stripeConfigured: true, secretKey: "sk_test_x", webhookSecret: "whsec_test", priceId: "price_test", exemptEmails: [] });
let calls, app, gateway, server, base, ipCounter = 0, seq = 0, sentChange;

function setBilling(on) {
  app.set("billingConfig", { ...CONFIG, enabled: on });
  gateway = {
    setQuantity: async (a) => { calls.push(["setQuantity", a]); },
    updateCustomerEmail: async (...a) => { calls.push(["updateCustomerEmail", ...a]); },
  };
  app.set("billingGateway", gateway);
}

before(async () => {
  app = express();
  app.set("trust proxy", 1);
  app.use("/api/integrations", createIntegrationsRouter({ limiter: { max: 1000 } }));
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/org", orgRoutes);
  app.use("/api/profile", profileRoutes);
  app.set("sendInvite", async () => {});
  app.set("sendEmailChange", async (to, link) => { sentChange.push({ to, link }); return true; });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { calls = []; sentChange = []; setBilling(true); });

async function call(method, p, { as, headers = {}, body } = {}) {
  const h = { "x-forwarded-for": `10.7.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (as) h.cookie = `rr_token=${signToken({ userId: as.id, sv: db.prepare("SELECT session_version FROM users WHERE id = ?").get(as.id).session_version })}`;
  const res = await fetch(base + p, { method, headers: h, redirect: "manual", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, data, location: res.headers.get("location") };
}
const userRow = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const until = async (check, ms = 1000) => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) assert.fail("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); }
};
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function brokerage({ los = 1, pending = 0, ...cols } = {}) {
  const n = ++seq;
  const broker = addBroker(db, { email: `b${n}@rm.test`, orgName: `Org ${n}` });
  db.prepare("UPDATE organizations SET billing_status = 'active' WHERE id = ?").run(broker.org_id);
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE organizations SET ${k} = ? WHERE id = ?`).run(v, broker.org_id);
  const accept = (userId) => {
    for (const t of ["terms", "privacy"]) {
      db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at, ip) VALUES (?, ?, ?, ?, '127.0.0.1')")
        .run(userId, t, t === "terms" ? TERMS_VERSION : PRIVACY_VERSION, Date.now());
    }
  };
  accept(broker.id);
  const mk = (accepted) => userRow(Number(db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', 'Lou', 'Officer', ?, 'h', ?)"
  ).run(broker.org_id, `lo${++seq}@rm.test`, accepted).lastInsertRowid));
  const mkAccepted = (accepted) => { const u = mk(accepted); if (accepted) accept(u.id); return u; };
  return { orgId: broker.org_id, broker, los: Array.from({ length: los }, () => mkAccepted(1)), pending: Array.from({ length: pending }, () => mk(0)) };
}
const addClient = (user) => Number(db.prepare(
  "INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score) VALUES (?, ?, 'Carla', '30yr_fixed', 7, 300000, 500000, 740)"
).run(user.org_id, user.id).lastInsertRowid);
const feedKey = (userId) => {
  const key = "br_" + crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO integration_keys (user_id, key_hash) VALUES (?, ?)").run(userId, crypto.createHash("sha256").update(key).digest("hex"));
  return key;
};
const del = (as, id) => call("DELETE", `/api/org/los/${id}`, { as });

test("removal moves clients, ends the session at once, and frees the address for a new invite", async () => {
  const { broker, los: [lo] } = brokerage();
  const clientId = addClient(lo);
  const oldEmail = lo.email;
  const r = await del(broker, lo.id);
  assert.deepStrictEqual([r.status, r.data], [200, { success: true }]);
  assert.strictEqual(db.prepare("SELECT user_id FROM clients WHERE id = ?").get(clientId).user_id, broker.id);
  const row = userRow(lo.id);
  assert.ok(Math.abs(row.removed_at - Date.now()) < 5000);
  assert.strictEqual(row.removed_email, oldEmail);
  assert.strictEqual(row.email, `removed-${lo.id}@removed.invalid`);
  assert.strictEqual(row.password_hash, null);
  assert.strictEqual(row.session_version, lo.session_version + 1);
  // the old token (old session version) no longer works
  const stale = await fetch(base + "/api/profile", { headers: { cookie: `rr_token=${signToken({ userId: lo.id, sv: lo.session_version })}` } });
  assert.strictEqual(stale.status, 401);
  // the address can be invited again
  const inv = await call("POST", "/api/auth/invite", { as: broker, body: { firstName: "New", lastName: "Hire", email: oldEmail } });
  assert.strictEqual(inv.status, 201);
  // a second removal of the same id is 404
  assert.strictEqual((await del(broker, lo.id)).status, 404);
});

test("removal revokes the ARIVE key (a feed post with it is refused), the Google connection and pending reset/email change (H3)", async () => {
  const { broker, los: [lo, keep] } = brokerage({ los: 2 });
  const key = feedKey(lo.id);
  feedKey(keep.id);
  db.prepare(
    "INSERT INTO google_connections (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc) VALUES (?, 'g@x.test', 'UTC', 's', 'a', 1, 'r')"
  ).run(lo.id);
  db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)").run(lo.id, hashToken("t1"), Date.now() + 1e6);
  db.prepare("INSERT INTO email_changes (user_id, new_email, token, expires_at) VALUES (?, 'n@x.test', ?, ?)").run(lo.id, "a".repeat(64), Date.now() + 1e6);
  const feed = (k) => call("POST", "/api/integrations/loans", { headers: { authorization: `Bearer ${k}` }, body: { loan_id: "L1" } });
  assert.notStrictEqual((await feed(key)).status, 401, "the key works before removal");
  assert.strictEqual((await del(broker, lo.id)).status, 200);
  const refused = await feed(key);
  assert.deepStrictEqual([refused.status, refused.data], [401, { error: "Unauthorized" }]);
  for (const t of ["integration_keys", "google_connections", "password_resets", "email_changes"]) {
    assert.strictEqual(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(lo.id).n, 0, t);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM integration_keys WHERE user_id = ?").get(keep.id).n, 1, "another LO's key stays");
});

test("a pending invite is deleted and its address freed; other orgs, brokers, unknown ids 404; an LO 403", async () => {
  const { broker, los: [lo], pending: [inv] } = brokerage({ pending: 1, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_item_id: "si_1", billing_quantity: 2 });
  const other = brokerage();
  const NOT_FOUND = { success: false, error: "LO not found in your org" };
  const r = await del(broker, inv.id);
  assert.deepStrictEqual([r.status, r.data], [200, { success: true }]);
  assert.strictEqual(userRow(inv.id), undefined);
  assert.strictEqual(db.prepare("SELECT 1 FROM users WHERE email = ?").get(inv.email), undefined);
  await pause(50);
  assert.deepStrictEqual(calls, [], "no seat change for a pending invite");
  for (const id of [other.los[0].id, other.broker.id, broker.id, 999999, "abc", "1x", "-1"]) {
    const x = await del(broker, id);
    assert.deepStrictEqual([x.status, x.data], [404, NOT_FOUND], String(id));
  }
  assert.strictEqual(userRow(other.los[0].id).removed_at, null);
  assert.strictEqual((await del(lo, lo.id)).status, 403);
  assert.strictEqual((await del(lo, other.los[0].id)).status, 403);
  assert.strictEqual((await call("DELETE", `/api/org/los/${lo.id}`)).status, 401);
});

test("the removed LO leaves /los and the user count, and the new count is pushed to Stripe", async () => {
  const { orgId, broker, los: [a, b], pending: [inv] } = brokerage({
    los: 2, pending: 1, stripe_customer_id: "cus_2", stripe_subscription_id: "sub_2", stripe_item_id: "si_2", billing_quantity: 3,
  });
  const first = await call("GET", "/api/org/los", { as: broker });
  assert.strictEqual(first.data.los.length, 3, "pending invites are still listed");
  assert.strictEqual((await call("GET", "/api/org/stats", { as: broker })).data.stats.loCount, 3);
  assert.strictEqual((await del(broker, a.id)).status, 200);
  const list = await call("GET", "/api/org/los", { as: broker });
  assert.deepStrictEqual(list.data.los.map((l) => l.id).sort(), [b.id, inv.id].sort());
  assert.strictEqual((await call("GET", "/api/org/stats", { as: broker })).data.stats.loCount, 2);
  await until(() => calls.length === 1);
  assert.deepStrictEqual(calls[0], ["setQuantity", { subscriptionId: "sub_2", itemId: "si_2", quantity: 2 }]);
  assert.strictEqual(db.prepare("SELECT billing_quantity FROM organizations WHERE id = ?").get(orgId).billing_quantity, 2);
  // a failing push still answers success and logs the message only
  const logged = []; const orig = console.error; console.error = (...x) => logged.push(x.join(" "));
  try {
    gateway.setQuantity = async () => { throw new Error("stripe down"); };
    assert.strictEqual((await del(broker, b.id)).status, 200);
    await until(() => logged.some((l) => l.includes("stripe down")));
  } finally { console.error = orig; }
});

test("with billing off, removal makes no Stripe call", async () => {
  const { broker, los: [lo] } = brokerage({ stripe_subscription_id: "sub_3", stripe_item_id: "si_3", billing_quantity: 2 });
  setBilling(false);
  assert.strictEqual((await del(broker, lo.id)).status, 200);
  await pause();
  assert.deepStrictEqual(calls, []);
});

test("a broker's confirmed email change updates the Stripe customer email; an LO's does nothing (H14)", async () => {
  const { broker, los: [lo] } = brokerage({ stripe_customer_id: "cus_9" });
  const confirm = async (u, email) => {
    const r = await call("POST", "/api/profile/email", { as: u, body: { email } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    return call("GET", new URL(sentChange.at(-1).link).pathname);
  };
  const r = await confirm(broker, "newboss@rm.test");
  assert.strictEqual(r.location, "/?emailChanged=1");
  await until(() => calls.length === 1);
  assert.deepStrictEqual(calls[0], ["updateCustomerEmail", "cus_9", "newboss@rm.test"]);
  calls.length = 0;
  assert.strictEqual((await confirm(lo, "newlo@rm.test")).location, "/?emailChanged=1");
  setBilling(false);   // billing off: no call
  assert.strictEqual((await confirm(broker, "again@rm.test")).location, "/?emailChanged=1");
  setBilling(true);    // no customer on file: no call
  const bare = brokerage();
  assert.strictEqual((await confirm(bare.broker, "bare@rm.test")).location, "/?emailChanged=1");
  await pause();
  assert.deepStrictEqual(calls, []);
});

test("a removed LO is treated like an unknown one by /clients, /stage and /alert (no notification, no mail)", async () => {
  const { broker, los: [lo, other] } = brokerage({ los: 2 });
  const clientId = addClient(other);
  const same = async (method, suffix, body) => {
    const gone = await call(method, `/api/org/los/${lo.id}${suffix}`, { as: broker, body });
    const unknown = await call(method, `/api/org/los/999999${suffix}`, { as: broker, body });
    return [gone, unknown];
  };
  assert.strictEqual((await del(broker, lo.id)).status, 200);
  const [c1, c2] = await same("GET", "/clients");
  assert.deepStrictEqual([c1.status, c1.data], [404, { success: false, error: "LO not found in your org" }]);
  assert.deepStrictEqual([c1.status, c1.data], [c2.status, c2.data]);
  const [s1, s2] = await same("PATCH", "/stage", { stage: "new" });
  assert.deepStrictEqual([s1.status, s1.data], [s2.status, s2.data]);
  assert.strictEqual(s1.status, 404);
  const alert = (loId) => call("POST", "/api/org/alert", { as: broker, body: { loId, clientId } });
  const a1 = await alert(lo.id), a2 = await alert(999999);
  assert.deepStrictEqual([a1.status, a1.data], [a2.status, a2.data]);
  assert.strictEqual(a1.status, 404);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE to_user = ?").get(lo.id).n, 0, "no alert is recorded, so no email is sent");
  assert.strictEqual((await alert(other.id)).status, 200, "a live LO still gets alerts");
});
