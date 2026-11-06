"use strict";
// lib/billing/*: the pure billing rules (price, access, banner, checkout plan, seats, tester code) and the billing columns.
// Throwaway DB; nothing here talks to Stripe.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-billing-rules-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { billingConfig, monthlyTotalCents, BASE_CENTS, ADDITIONAL_CENTS, TRIAL_DAYS, TESTER_DAYS, TESTER_WARN_DAYS, STALE_MS, TERMS_VERSION, PRIVACY_VERSION } = require("../lib/billing/config");
const { orgBilling, accessFor, bannerFor } = require("../lib/billing/access");
const { checkoutPlan } = require("../lib/billing/plan");
const { seatCount, testerSlotOpen, testerCodeUsable } = require("../lib/billing/seats");

const NOW = 1_800_000_000_000;
const H = 3600_000;
const D = 24 * H;
const STRIPE = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_ID: "price_x" };
const addOrg = (name, cols = {}) => {
  const id = Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE organizations SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
};
let seq = 0;
const addUser = (orgId, accepted, removedAt = null) => db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted, removed_at) VALUES (?, 'lo', 'A', 'B', ?, ?, ?)"
).run(orgId, `u${++seq}@bill.test`, accepted, removedAt);

test("billingConfig: Stripe configured only with all three; tester limits, exempt list and feedback address normalised", () => {
  const c = billingConfig({});
  assert.strictEqual(c.stripeConfigured, false);
  assert.strictEqual(c.testerCode, null);
  assert.strictEqual(c.testerMaxUses, 25);
  assert.strictEqual(c.testerExpiresMs, null);
  assert.deepStrictEqual(c.exemptEmails, []);
  assert.strictEqual(c.feedbackTo, null);
  assert.ok(!("enabled" in c), "enabled is set by the app, not here");

  assert.strictEqual(billingConfig(STRIPE).stripeConfigured, true);
  assert.strictEqual(billingConfig(STRIPE).secretKey, "sk_test_x");
  assert.strictEqual(billingConfig(STRIPE).webhookSecret, "whsec_x");
  assert.strictEqual(billingConfig(STRIPE).priceId, "price_x");
  for (const missing of Object.keys(STRIPE)) {
    const env = { ...STRIPE, [missing]: "  " };
    assert.strictEqual(billingConfig(env).stripeConfigured, false, missing);
    const gone = { ...STRIPE }; delete gone[missing];
    assert.strictEqual(billingConfig(gone).stripeConfigured, false, missing);
  }

  assert.strictEqual(billingConfig({ BILLING_TESTER_CODE: "  Beta-Crew " }).testerCode, "beta-crew");
  assert.strictEqual(billingConfig({ BILLING_TESTER_CODE: "   " }).testerCode, null);
  assert.strictEqual(billingConfig({ BILLING_TESTER_MAX_USES: "5" }).testerMaxUses, 5);
  assert.strictEqual(billingConfig({ BILLING_TESTER_MAX_USES: "0" }).testerMaxUses, 0);
  assert.strictEqual(billingConfig({ BILLING_TESTER_MAX_USES: "abc" }).testerMaxUses, 25);
  assert.strictEqual(billingConfig({ BILLING_TESTER_MAX_USES: "-3" }).testerMaxUses, 25);
  assert.strictEqual(billingConfig({ BILLING_TESTER_EXPIRES: "2026-12-31" }).testerExpiresMs, Date.UTC(2026, 11, 31, 23, 59, 59, 999));
  assert.strictEqual(billingConfig({ BILLING_TESTER_EXPIRES: "soon" }).testerExpiresMs, null);
  assert.deepStrictEqual(billingConfig({ BILLING_EXEMPT_EMAILS: " A@X.test, ,b@y.test ,," }).exemptEmails, ["a@x.test", "b@y.test"]);
  // commas, semicolons or any whitespace separate the addresses, so the gcloud command never needs its ^;^ delimiter
  assert.deepStrictEqual(billingConfig({ BILLING_EXEMPT_EMAILS: "a@x.test;b@y.test c@z.test\td@w.test\n e@v.test ;; ,f@u.test" }).exemptEmails,
    ["a@x.test", "b@y.test", "c@z.test", "d@w.test", "e@v.test", "f@u.test"]);
  assert.strictEqual(billingConfig({ FEEDBACK_TO: " me@x.test " }).feedbackTo, "me@x.test");
  assert.strictEqual(billingConfig({ FEEDBACK_TO: " " }).feedbackTo, null);
});

test("the value constants", () => {
  assert.deepStrictEqual(
    [BASE_CENTS, ADDITIONAL_CENTS, TRIAL_DAYS, TESTER_DAYS, TESTER_WARN_DAYS, STALE_MS, TERMS_VERSION, PRIVACY_VERSION],
    [9900, 4900, 14, 30, 7, 24 * H, "2026-11-05", "2026-11-05"]);
});

test("monthlyTotalCents: 1 -> 9900, 3 -> 19700, 5 -> 29500, 10 -> 54000", () => {
  assert.strictEqual(monthlyTotalCents(1), 9900);
  assert.strictEqual(monthlyTotalCents(3), 19700);
  assert.strictEqual(monthlyTotalCents(5), 29500);
  assert.strictEqual(monthlyTotalCents(10), 54000);
});

test("orgBilling: the organization's row, or undefined for an unknown id", () => {
  const id = addOrg("OB", { billing_status: "active" });
  assert.strictEqual(orgBilling(db, id).billing_status, "active");
  assert.strictEqual(orgBilling(db, id).id, id);
  assert.strictEqual(orgBilling(db, 999999), undefined);
});

test("accessFor: off ok; terms first; exempt, tester month, live statuses; ended vs needs_card", () => {
  const on = { enabled: true, exemptEmails: [] };
  const off = { enabled: false, exemptEmails: [] };
  const org = (o = {}) => ({ billing_status: null, billing_exempt: 0, billing_tester_until: null, ...o });
  const acc = (o, termsOk = true, config = on) => accessFor({ config, org: org(o), termsOk, nowMs: NOW });

  assert.deepStrictEqual(acc({ billing_status: "canceled" }, false, off), { ok: true });
  assert.deepStrictEqual(acc({}, true, off), { ok: true });
  assert.deepStrictEqual(acc({ billing_exempt: 1 }, false), { ok: false, reason: "terms" });
  assert.deepStrictEqual(acc({ billing_status: "active" }, false), { ok: false, reason: "terms" });

  assert.deepStrictEqual(acc({ billing_exempt: 1 }), { ok: true });
  assert.deepStrictEqual(acc({ billing_tester_until: NOW + 1 }), { ok: true });
  assert.deepStrictEqual(acc({ billing_tester_until: NOW }), { ok: false, reason: "needs_card" });
  assert.deepStrictEqual(acc({ billing_tester_until: NOW - 1 }), { ok: false, reason: "needs_card" });
  // the tester month beats an ended subscription status
  assert.deepStrictEqual(acc({ billing_tester_until: NOW + D, billing_status: "canceled" }), { ok: true });
  for (const s of ["trialing", "active", "past_due"]) assert.deepStrictEqual(acc({ billing_status: s }), { ok: true }, s);
  for (const s of ["canceled", "unpaid", "incomplete_expired", "paused"]) assert.deepStrictEqual(acc({ billing_status: s }), { ok: false, reason: "ended" }, s);
  for (const s of [null, "incomplete", "something_new"]) assert.deepStrictEqual(acc({ billing_status: s }), { ok: false, reason: "needs_card" }, String(s));
});

test("bannerFor: past_due; tester_ending only in the last 7 days and only without a card", () => {
  const org = (o = {}) => ({ billing_status: null, billing_tester_until: null, billing_has_card: 0, ...o });
  assert.strictEqual(bannerFor(org({ billing_status: "past_due" }), NOW), "past_due");
  assert.strictEqual(bannerFor(org({ billing_status: "active" }), NOW), null);
  assert.strictEqual(bannerFor(org(), NOW), null);

  const ending = (ms, extra = {}) => bannerFor(org({ billing_tester_until: NOW + ms, ...extra }), NOW);
  assert.strictEqual(ending(7 * D), "tester_ending");
  assert.strictEqual(ending(7 * D + 1), null);
  assert.strictEqual(ending(1), "tester_ending");
  assert.strictEqual(ending(0), null, "the month is over");
  assert.strictEqual(ending(-D), null);
  assert.strictEqual(ending(3 * D, { billing_has_card: 1 }), null);
  assert.strictEqual(ending(3 * D, { billing_status: "past_due" }), "past_due");
  // an exempt brokerage is never asked for a card or told about a payment, whatever its columns say
  assert.strictEqual(ending(3 * D, { billing_exempt: 1 }), null);
  assert.strictEqual(bannerFor(org({ billing_exempt: 1, billing_status: "past_due" }), NOW), null);
});

test("checkoutPlan: first time 14 days; tester month -> until (at least 49 h away); after any subscription or free month -> none", () => {
  const org = (o = {}) => ({ billing_tester_until: null, billing_ever_subscribed: 0, ...o });
  assert.deepStrictEqual(checkoutPlan(org(), NOW), { trial: "days", days: 14 });
  // one free period per brokerage: a free month that is over (a tester code's or the start-up month's) was the free period
  assert.deepStrictEqual(checkoutPlan(org({ billing_tester_until: NOW - 1 }), NOW), { trial: "none" }, "a free month already given");
  assert.deepStrictEqual(checkoutPlan(org({ billing_tester_until: NOW }), NOW), { trial: "none" }, "the month's last moment has passed");
  assert.deepStrictEqual(checkoutPlan(org({ billing_tester_until: NOW - 40 * D }), NOW), { trial: "none" });
  assert.deepStrictEqual(checkoutPlan(org({ billing_tester_until: NOW + 10 * D }), NOW), { trial: "until", endMs: NOW + 10 * D });
  assert.deepStrictEqual(checkoutPlan(org({ billing_tester_until: NOW + 2 * H }), NOW), { trial: "until", endMs: NOW + 49 * H });
  assert.deepStrictEqual(checkoutPlan(org({ billing_tester_until: NOW + 49 * H }), NOW), { trial: "until", endMs: NOW + 49 * H });
  assert.deepStrictEqual(checkoutPlan(org({ billing_ever_subscribed: 1 }), NOW), { trial: "none" });
  assert.deepStrictEqual(checkoutPlan(org({ billing_ever_subscribed: 1, billing_tester_until: NOW - D }), NOW), { trial: "none" });
});

test("seatCount: accepted, not removed, this organization only", () => {
  const a = addOrg("SeatsA");
  const b = addOrg("SeatsB");
  addUser(a, 1); addUser(a, 1);
  addUser(a, 0);                    // an invite not yet accepted
  addUser(a, 1, NOW - 1);           // removed
  addUser(b, 1);
  assert.strictEqual(seatCount(db, a), 2);
  assert.strictEqual(seatCount(db, b), 1);
  assert.strictEqual(seatCount(db, addOrg("Empty")), 0);
});

test("testerCodeUsable: right code any case; wrong, unset, expired, or at the use limit -> false", () => {
  db.prepare("UPDATE organizations SET billing_via_tester_code = 0").run();
  const cfg = (o = {}) => ({ testerCode: "beta-crew", testerMaxUses: 2, testerExpiresMs: null, ...o });
  assert.strictEqual(testerCodeUsable(db, cfg(), "beta-crew", NOW), true);
  assert.strictEqual(testerCodeUsable(db, cfg(), "  BETA-Crew ", NOW), true);
  assert.strictEqual(testerCodeUsable(db, cfg(), "nope", NOW), false);
  assert.strictEqual(testerCodeUsable(db, cfg(), "", NOW), false);
  assert.strictEqual(testerCodeUsable(db, cfg(), undefined, NOW), false);
  assert.strictEqual(testerCodeUsable(db, cfg({ testerCode: null }), "beta-crew", NOW), false);
  assert.strictEqual(testerCodeUsable(db, cfg({ testerExpiresMs: NOW }), "beta-crew", NOW), true, "the last moment still works");
  assert.strictEqual(testerCodeUsable(db, cfg({ testerExpiresMs: NOW - 1 }), "beta-crew", NOW), false);

  addOrg("T1", { billing_via_tester_code: 1 });
  assert.strictEqual(testerCodeUsable(db, cfg(), "beta-crew", NOW), true);
  addOrg("T2", { billing_via_tester_code: 1 });
  assert.strictEqual(testerCodeUsable(db, cfg(), "beta-crew", NOW), false, "2 of 2 used");
  assert.strictEqual(testerCodeUsable(db, cfg({ testerMaxUses: 3 }), "beta-crew", NOW), true);
  assert.strictEqual(testerCodeUsable(db, cfg({ testerMaxUses: 0 }), "beta-crew", NOW), false);
});

test("testerSlotOpen: the code switched on, not past its day, and under its use limit; no code match involved", () => {
  db.prepare("UPDATE organizations SET billing_via_tester_code = 0").run();
  const cfg = (o = {}) => ({ testerCode: "beta-crew", testerMaxUses: 2, testerExpiresMs: null, ...o });
  assert.strictEqual(testerSlotOpen(db, cfg(), NOW), true);
  assert.strictEqual(testerSlotOpen(db, cfg({ testerCode: null }), NOW), false, "switched off");
  assert.strictEqual(testerSlotOpen(db, null, NOW), false, "no billing config");
  assert.strictEqual(testerSlotOpen(db, cfg({ testerExpiresMs: NOW }), NOW), true, "the last moment still works");
  assert.strictEqual(testerSlotOpen(db, cfg({ testerExpiresMs: NOW - 1 }), NOW), false, "past its day");
  assert.strictEqual(testerSlotOpen(db, cfg({ testerMaxUses: 0 }), NOW), false, "a limit of 0");

  addOrg("S1", { billing_via_tester_code: 1 });
  addOrg("S-not", { billing_via_tester_code: 0 });   // only organizations that came in on the code count
  assert.strictEqual(testerSlotOpen(db, cfg(), NOW), true, "1 of 2 used");
  addOrg("S2", { billing_via_tester_code: 1 });
  assert.strictEqual(testerSlotOpen(db, cfg(), NOW), false, "2 of 2 used");
  // testerCodeUsable is this rule after the code match: the right code with no place left is refused
  assert.strictEqual(testerCodeUsable(db, cfg(), "beta-crew", NOW), false);
  assert.strictEqual(testerSlotOpen(db, cfg({ testerMaxUses: 3 }), NOW), true);
  assert.strictEqual(testerCodeUsable(db, cfg({ testerMaxUses: 3 }), "beta-crew", NOW), true);
});

const ORG_COLS = {
  stripe_customer_id: "TEXT", stripe_subscription_id: "TEXT", stripe_item_id: "TEXT", billing_status: "TEXT",
  billing_quantity: "INTEGER", billing_trial_end: "INTEGER", billing_period_end: "INTEGER",
  billing_cancel_at_period_end: "INTEGER", billing_exempt: "INTEGER", billing_tester_until: "INTEGER",
  billing_via_tester_code: "INTEGER", billing_ever_subscribed: "INTEGER", billing_has_card: "INTEGER",
  billing_event_at: "INTEGER", billing_synced_at: "INTEGER", billing_pending_checkout: "TEXT", billing_confirmation_sent: "INTEGER",
  billing_duplicate_pending: "TEXT",
};
const ORG_ZERO = ["billing_cancel_at_period_end", "billing_exempt", "billing_via_tester_code", "billing_ever_subscribed", "billing_has_card", "billing_confirmation_sent"];

test("the migration adds every column and table, idempotently, to a database that predates them", () => {
  const colsOf = (d, t) => Object.fromEntries(d.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c]));
  const oc = colsOf(db, "organizations");
  for (const [name, type] of Object.entries(ORG_COLS)) {
    assert.ok(oc[name], name);
    assert.strictEqual(oc[name].type, type, name);
    assert.strictEqual(oc[name].dflt_value, ORG_ZERO.includes(name) ? "0" : null, name);
  }
  assert.strictEqual(oc.billing_status.notnull, 0, "NULL = existed before billing");
  const uc = colsOf(db, "users");
  assert.ok(uc.removed_at && uc.removed_email);
  const sc = colsOf(db, "signup_requests");
  assert.strictEqual(sc.tester.dflt_value, "0");
  assert.ok(sc.terms_version && sc.privacy_version);
  assert.deepStrictEqual(Object.keys(colsOf(db, "stripe_events")), ["id", "type", "received_at"]);
  assert.deepStrictEqual(Object.keys(colsOf(db, "terms_acceptances")), ["id", "user_id", "document", "version", "accepted_at", "ip"]);
  assert.deepStrictEqual(Object.keys(colsOf(db, "feedback")), ["id", "user_id", "org_id", "page", "message", "created_at"]);

  // terms_acceptances: document is limited to terms / privacy, and rows go with their user
  const o = addOrg("TA");
  const uid = Number(addUser(o, 1).lastInsertRowid);
  const ins = (doc) => db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at) VALUES (?, ?, '2026-11-05', ?)").run(uid, doc, NOW);
  ins("terms"); ins("privacy");
  assert.throws(() => ins("other"));
  db.prepare("DELETE FROM users WHERE id = ?").run(uid);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM terms_acceptances WHERE user_id = ?").get(uid).n, 0);

  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-legacy-billing-"));
  const dbJs = JSON.stringify(path.join(__dirname, "..", "db.js"));
  const oldSchema = `
    const D = require("better-sqlite3");
    const d = new D(require("path").join(process.env.DATA_DIR, "refi-radar.db"));
    d.exec("CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'trial', trial_ends TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('broker','lo')), first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, invite_token TEXT, invite_expires TEXT, invite_accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE signup_requests (email TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, org_name TEXT NOT NULL, password_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    d.prepare("INSERT INTO organizations (name) VALUES ('Old Org')").run();
    d.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (1, 'broker', 'Old', 'Timer', 'old@x.co')").run();
    d.prepare("INSERT INTO signup_requests VALUES ('s@x.co', 'h', 'S', 'T', 'O', 'p', 1)").run();
    d.close();
  `;
  const report = `
    const db = require(${dbJs});
    const names = (t) => db.prepare("PRAGMA table_info(" + t + ")").all().map((c) => c.name);
    console.log(JSON.stringify({
      org: names("organizations"), users: names("users"), signup: names("signup_requests"),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('stripe_events','terms_acceptances','feedback') ORDER BY name").all().map((r) => r.name),
      orgRow: db.prepare("SELECT * FROM organizations").get(),
      userRow: db.prepare("SELECT first_name, removed_at, removed_email FROM users").get(),
      signupRow: db.prepare("SELECT tester, terms_version, privacy_version FROM signup_requests").get(),
    }));
  `;
  const run = (script) => execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
  }).trim().split("\n").pop();
  try {
    run(oldSchema);
    const first = JSON.parse(run(report));          // first load of db.js: the migration runs
    const second = JSON.parse(run(report));         // second load: it must not run again (or fail)
    for (const r of [first, second]) {
      for (const name of Object.keys(ORG_COLS)) assert.strictEqual(r.org.filter((c) => c === name).length, 1, name);
      for (const name of Object.keys(ORG_COLS)) assert.strictEqual(r.orgRow[name], ORG_ZERO.includes(name) ? 0 : null, name);
      assert.deepStrictEqual(r.userRow, { first_name: "Old", removed_at: null, removed_email: null });
      assert.deepStrictEqual(r.signupRow, { tester: 0, terms_version: null, privacy_version: null });
      assert.deepStrictEqual(r.tables, ["feedback", "stripe_events", "terms_acceptances"]);
      for (const name of ["removed_at", "removed_email"]) assert.strictEqual(r.users.filter((c) => c === name).length, 1);
      for (const name of ["tester", "terms_version", "privacy_version"]) assert.strictEqual(r.signup.filter((c) => c === name).length, 1);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
