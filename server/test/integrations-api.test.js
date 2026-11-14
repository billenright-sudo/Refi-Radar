"use strict";
// The ARIVE (Zapier) feed and its key: /api/integrations (routes/integrations.js) against a throwaway DB. The key routes are used
// the way the Settings page uses them (a signed rr_token cookie); the webhook is used the way a Zap does (a Bearer key and a JSON
// body). The app mounts the router BEFORE the app-wide 20 MB JSON parser and the cookie parser, as index.js does (R9), so what
// passes here also passes there. No model call, no email and no network but the local test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-integrations-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { createIntegrationsRouter } = require("../routes/integrations");

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first, last) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)"
).run(orgId, role, first, last, email).lastInsertRowid);
const clientRows = () => db.prepare("SELECT * FROM clients ORDER BY id").all();
const keyRow = (userId) => db.prepare("SELECT * FROM integration_keys WHERE user_id = ?").get(userId);
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.test", "Ann", "Lee");
const lou = addUser(orgA, "lo", "lou@a.test", "Lou", "Park");
const lia = addUser(orgA, "lo", "lia@a.test", "Lia", "Chen");
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@b.test", "Bea", "Ray");

// A key for a user, made straight in the table (the lifecycle test is the one that goes through the key routes).
const giveKey = (userId, los = "arive") => {
  const key = "br_" + crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT OR REPLACE INTO integration_keys (user_id, key_hash, los) VALUES (?, ?, ?)").run(userId, sha256(key), los);
  return key;
};

// A funded loan, the way the Zap sends it. The SSN and date of birth are extras the feed must never read or keep.
const BODY = {
  loan_id: "L1",
  borrower_name: "John Smith",
  email: "john@x.test",
  phone: "(555) 123-4567",
  note_rate: 7.25,
  current_balance: 395000,
  loan_amount: 400000,
  term_months: 360,
  amortization_type: "Fixed",
  first_payment_date: "2026-04-01",
  property_value: 500000,
  closing_date: "2026-03-02",
  credit_score: 745,
  status: "Funded",
  ssn: "123-45-6789",
  dob: "1980-01-01",
};
const without = (body, ...keys) => Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)));
const UTC_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ── harness ──────────────────────────────────────────────────────────────────

// An app that mounts the router the way index.js does: above the app-wide JSON parser, which sits above the cookie parser.
async function startApp(limiter) {
  const app = express();
  app.use("/api/integrations", createIntegrationsRouter({ limiter }));
  app.use(express.json({ limit: "20mb" }));
  app.use(cookieParser());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { base: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Ruling P2: one shared app with a limit nothing here reaches; the 429 test builds its own with a small one.
let main;
let post;
before(async () => { main = await startApp({ max: 1000 }); post = postTo(main.base); });
after(async () => {
  await main.close();
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => {
  for (const table of ["notifications", "charlie_recommendations", "contact_log", "clients", "integration_keys"]) db.prepare(`DELETE FROM ${table}`).run();
});

const send = async (base, method, p, headers, payload) => {
  const res = await fetch(base + p, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, data, text, headers: res.headers };
};

// `post(key, body)` is the Zap: a Bearer key (none when `key` is null) and a JSON body (a string is sent as it is).
const postTo = (base) => (key, body, headers = {}) => send(
  base, "POST", "/api/integrations/loans",
  { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  typeof body === "string" ? body : JSON.stringify(body),
);

// `as(userId)` -> a request function for the key routes, signed in as that user; `as(null)` is anonymous.
// A `body` is sent as JSON (a string is sent as it is); with none, no body and no content-type go out.
const as = (userId) => (method, p = "/api/integrations/key", body) => send(
  main.base, method, p,
  {
    ...(userId != null ? { cookie: "rr_token=" + signToken({ userId }) } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  },
  body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
);

// Captures console.log / warn / error while fn runs.
async function captured(fn) {
  const lines = [];
  const saved = {};
  for (const name of ["log", "warn", "error"]) {
    saved[name] = console[name];
    console[name] = (...args) => lines.push(args.map(String).join(" "));
  }
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join("\n");
}

// ── the key ──────────────────────────────────────────────────────────────────

test("GET /key answers los: null before connecting, the key's LOS after", async () => {
  const me = as(ann);
  assert.strictEqual((await me("GET")).data.los, null);
  await me("POST", undefined, { los: "lendingpad" });
  assert.strictEqual((await me("GET")).data.los, "lendingpad");
});

test("POST /key stores the LOS it is given; with none it keeps the current one, or means arive", async () => {
  const me = as(ann);

  let r = await me("POST");
  assert.strictEqual(r.data.los, "arive");
  assert.strictEqual(keyRow(ann).los, "arive");

  r = await me("POST", undefined, { los: "lendingpad" });
  assert.strictEqual(r.data.los, "lendingpad");
  assert.strictEqual(keyRow(ann).los, "lendingpad");

  // a Regenerate from an old page sends no body: the LOS stays, the key is new
  const before = keyRow(ann).key_hash;
  r = await me("POST");
  assert.strictEqual(r.data.los, "lendingpad");
  assert.notStrictEqual(keyRow(ann).key_hash, before);

  r = await me("POST", undefined, { los: null });
  assert.strictEqual(r.data.los, "lendingpad");

  // switching is Disconnect, then Connect
  await me("DELETE");
  r = await me("POST", undefined, { los: "arive" });
  assert.strictEqual(r.data.los, "arive");
  assert.strictEqual(keyRow(ann).los, "arive");
});

test("POST /key with any other los is a 400 and the old key keeps working", async () => {
  const me = as(ann);
  await me("POST", undefined, { los: "lendingpad" });
  const before = keyRow(ann);
  for (const los of ["calyx", "", "ARIVE", 7, true, ["arive"]]) {
    const r = await me("POST", undefined, { los });
    assert.deepStrictEqual([r.status, r.data], [400, { success: false, error: "los must be arive or lendingpad" }], JSON.stringify(los));
    assert.deepStrictEqual(keyRow(ann), before);
  }
  for (const body of ["{", "[]", "[\"arive\"]"]) {
    const r = await me("POST", undefined, body);
    assert.deepStrictEqual([r.status, r.data], [400, { success: false, error: "The body must be a JSON object" }], body);
    assert.deepStrictEqual(keyRow(ann), before);
  }
});

test("key lifecycle: connect, use, regenerate, disconnect", async () => {
  const me = as(ann);

  let r = await me("GET");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.success, true);
  assert.strictEqual(r.data.connected, false);
  assert.strictEqual(r.data.createdAt, null);
  assert.strictEqual(r.data.lastUsedAt, null);
  assert.ok(r.data.webhookUrl.endsWith("/api/integrations/loans"), r.data.webhookUrl);
  assert.strictEqual(r.headers.get("cache-control"), "no-store");

  r = await me("POST");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("cache-control"), "no-store");
  const first = r.data.key;
  assert.match(first, /^br_[0-9a-f]{64}$/);
  assert.strictEqual(r.data.success, true);
  assert.ok(r.data.webhookUrl.endsWith("/api/integrations/loans"));
  assert.match(r.data.createdAt, UTC_TEXT);
  const row = keyRow(ann);
  assert.strictEqual(row.key_hash, sha256(first));
  assert.ok(Object.values(row).every((v) => !String(v).includes(first)), "no column holds the key itself");

  r = await me("GET");
  assert.deepStrictEqual([r.data.connected, r.data.lastUsedAt], [true, null]);
  assert.strictEqual(r.data.createdAt, row.created_at);
  assert.ok(!r.text.includes(first), "the key is never read back");

  r = await post(first, BODY);
  assert.deepStrictEqual([r.status, r.data], [200, { result: "created" }]);
  r = await me("GET");
  assert.match(r.data.lastUsedAt, UTC_TEXT);

  // a new key replaces the old one, and has not been used yet
  r = await me("POST");
  const second = r.data.key;
  assert.notStrictEqual(second, first);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM integration_keys WHERE user_id = ?").get(ann).n, 1);
  assert.strictEqual((await me("GET")).data.lastUsedAt, null);
  r = await post(first, BODY);
  assert.deepStrictEqual([r.status, r.data], [401, { error: "Unauthorized" }]);
  r = await post(second, BODY);
  assert.deepStrictEqual([r.status, r.data], [200, { result: "unchanged" }]);

  r = await me("DELETE");
  assert.deepStrictEqual([r.status, r.data], [200, { success: true, connected: false }]);
  assert.strictEqual(r.headers.get("cache-control"), "no-store");
  r = await post(second, BODY);
  assert.deepStrictEqual([r.status, r.data], [401, { error: "Unauthorized" }]);
  r = await me("GET");
  assert.strictEqual(r.data.connected, false);
  assert.strictEqual(keyRow(ann), undefined);
  // disconnecting again is not an error
  assert.deepStrictEqual((await me("DELETE")).data, { success: true, connected: false });
});

test("the key routes need a signed-in user (any role), act only on that user, and a loan officer may have a key", async () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const r = await as(null)(method);
    assert.strictEqual(r.status, 401, method);
    assert.strictEqual(r.headers.get("cache-control"), "no-store", method);
  }
  assert.strictEqual(keyRow(ann), undefined);

  const annKey = giveKey(ann);
  const mine = await as(lou)("POST");
  assert.strictEqual(mine.status, 200);
  assert.strictEqual((await as(lou)("DELETE")).status, 200);
  assert.strictEqual(keyRow(lou), undefined);
  assert.ok(keyRow(ann), "Ann's key is untouched by Lou's");
  assert.strictEqual((await post(annKey, BODY)).status, 200);
});

test("401 for no header, a non-Bearer header, a malformed or unknown key, and a cookie alone", async () => {
  const good = giveKey(ann);
  const UNAUTHORIZED = { error: "Unauthorized" };
  const headers = [
    {},
    { authorization: "" },
    { authorization: good },                       // the key without the scheme
    { authorization: `Basic ${good}` },
    { authorization: `Token ${good}` },
    { authorization: "Bearer" },
    { authorization: "Bearer " },
    { authorization: "Bearer nope" },
    { authorization: `Bearer ${good.slice(0, -1)}` },
    { authorization: `Bearer ${good}0` },
    { authorization: `Bearer ${good.toUpperCase()}` },
    { authorization: `Bearer ${good.replace("br_", "xx_")}` },
    { authorization: `Bearer br_${"0".repeat(64)}` },   // well-formed, but nobody's
  ];
  for (const h of headers) {
    const r = await post(null, BODY, h);
    assert.deepStrictEqual([r.status, r.data], [401, UNAUTHORIZED], JSON.stringify(h));
  }
  // a signed-in browser session is not a key
  const r = await post(null, BODY, { cookie: "rr_token=" + signToken({ userId: ann }) });
  assert.deepStrictEqual([r.status, r.data], [401, UNAUTHORIZED]);
  assert.strictEqual(clientRows().length, 0);
  assert.strictEqual(keyRow(ann).last_used_at, null, "a refused call does not count as a use");
  // the scheme is not case-sensitive
  assert.strictEqual((await post(null, BODY, { authorization: `bearer ${good}` })).status, 200);
});

// ── the webhook ──────────────────────────────────────────────────────────────

test("a broker's key routes by loan_officer_email; an LO's key always fills their own book", async () => {
  const annKey = giveKey(ann);
  const louKey = giveKey(lou);

  let r = await post(annKey, { ...BODY, loan_officer_email: "lou@a.test" });
  assert.deepStrictEqual(r.data, { result: "created" });
  r = await post(annKey, { ...BODY, loan_id: "L2", borrower_name: "Mary Jones", email: "mary@x.test", loan_officer_email: "nobody@a.test" });
  assert.deepStrictEqual(r.data, { result: "created", routed_to_you: 'no loan officer in your company matches "nobody@a.test"' });
  // a loan officer at another company is nobody the broker can route to
  r = await post(annKey, { ...BODY, loan_id: "L3", borrower_name: "Ned Poe", email: "ned@x.test", loan_officer_email: "bea@b.test" });
  assert.deepStrictEqual(r.data, { result: "created", routed_to_you: 'no loan officer in your company matches "bea@b.test"' });
  r = await post(louKey, { ...BODY, loan_id: "L4", borrower_name: "Pat Doe", email: "pat@x.test", loan_officer_email: "lia@a.test" });
  assert.deepStrictEqual(r.data, { result: "created" });

  const owner = Object.fromEntries(clientRows().map((c) => [c.loan_number, c.user_id]));
  assert.deepStrictEqual(owner, { L1: lou, L2: ann, L3: ann, L4: lou });
  assert.ok(clientRows().every((c) => c.org_id === orgA && c.source === "arive"));
});

test("a key never reaches another company's clients", async () => {
  const annKey = giveKey(ann);
  const beaKey = giveKey(bea);
  assert.deepStrictEqual((await post(annKey, BODY)).data, { result: "created" });
  assert.deepStrictEqual((await post(beaKey, BODY)).data, { result: "created" });
  assert.deepStrictEqual(clientRows().map((c) => [c.org_id, c.user_id]), [[orgA, ann], [orgB, bea]]);
});

test("created, then unchanged on replay, updated on a rate change, ambiguous on two matches", async () => {
  const key = giveKey(ann);

  let r = await post(key, BODY);
  assert.deepStrictEqual([r.status, r.data], [200, { result: "created" }]);
  let [c] = clientRows();
  assert.deepStrictEqual(
    [c.name, c.email, c.loan_number, c.current_rate, c.loan_balance, c.property_value, c.close_date, c.credit_score, c.user_id, c.source],
    ["John Smith", "john@x.test", "L1", 7.25, 395000, 500000, "2026-03-02", 745, ann, "arive"],
  );
  assert.strictEqual(c.last_contact, null, "a new client has not been contacted (A3)");

  r = await post(key, BODY);
  assert.deepStrictEqual([r.status, r.data], [200, { result: "unchanged" }]);
  assert.strictEqual(clientRows().length, 1);

  r = await post(key, { ...BODY, note_rate: 6.9 });
  assert.deepStrictEqual([r.status, r.data], [200, { result: "updated" }]);
  [c] = clientRows();
  assert.strictEqual(clientRows().length, 1);
  assert.strictEqual(c.current_rate, 6.9);
  assert.strictEqual(c.name, "John Smith");

  // two clients with the name and nothing else cannot be told apart: nothing is written
  for (let i = 0; i < 2; i++) db.prepare("INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (?, ?, 'Jane Roe', 7, 300000, 400000)").run(orgA, ann);
  r = await post(key, { ...BODY, loan_id: "L9", borrower_name: "Jane Roe", email: undefined, phone: undefined });
  assert.deepStrictEqual([r.status, r.data], [200, { result: "ambiguous" }]);
  assert.strictEqual(clientRows().length, 3);
  assert.strictEqual(clientRows().filter((x) => x.name === "Jane Roe" && x.loan_number).length, 0);
});

test("a LendingPad key's clients are lendingpad; a key made before LendingPad still makes arive clients", async () => {
  const lpKey = giveKey(ann, "lendingpad");
  const oldKey = giveKey(lou);
  assert.deepStrictEqual((await post(lpKey, BODY)).data, { result: "created" });
  assert.deepStrictEqual((await post(oldKey, { ...BODY, loan_id: "L2", borrower_name: "Mary Jones", email: "mary@x.test" })).data, { result: "created" });
  assert.deepStrictEqual(Object.fromEntries(clientRows().map((c) => [c.loan_number, c.source])), { L1: "lendingpad", L2: "arive" });
});

test("Review 1: a funded LendingPad loan sent five times is created once, then unchanged, and its notes are untouched", async () => {
  const key = giveKey(ann, "lendingpad");
  assert.deepStrictEqual((await post(key, BODY)).data, { result: "created" });
  db.prepare("UPDATE clients SET notes = ?").run("Called 11/8, wants numbers");
  for (let i = 0; i < 4; i++) assert.deepStrictEqual((await post(key, BODY)).data, { result: "unchanged" });
  const rows = clientRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].notes, "Called 11/8, wants numbers");
  assert.strictEqual(rows[0].source, "lendingpad");
});

test("Review 2: with no Filter step, pipeline loans are ignored", async () => {
  const key = giveKey(ann, "lendingpad");
  for (const status of ["Processing", "Submitted", "Approved"]) {
    const r = await post(key, { ...without(BODY, "closing_date"), status });
    assert.deepStrictEqual([r.status, r.data], [200, { result: "ignored", reason: "no closing date" }], status);
  }
  const r = await post(key, { ...BODY, closing_date: "2999-01-01" });
  assert.deepStrictEqual(r.data, { result: "ignored", reason: "closing date is in the future" });
  assert.strictEqual(clientRows().length, 0);
});

test("Review 3: loan officers by name; an unknown one comes to the broker with routed_to_you", async () => {
  const key = giveKey(ann, "lendingpad");
  const loan = (n, name, lo) => ({ ...BODY, loan_id: `R${n}`, borrower_name: name, email: `r${n}@x.test`, loan_officer: lo });
  assert.deepStrictEqual((await post(key, loan(1, "Ray One", "Lou Park"))).data, { result: "created" });
  assert.deepStrictEqual((await post(key, loan(2, "Ray Two", "Lia Chen"))).data, { result: "created" });
  assert.deepStrictEqual((await post(key, loan(3, "Ray Three", "Sam Green"))).data,
    { result: "created", routed_to_you: 'no loan officer in your company matches "Sam Green"' });
  assert.deepStrictEqual(Object.fromEntries(clientRows().map((c) => [c.loan_number, c.user_id])), { R1: lou, R2: lia, R3: ann });
});

test("loan_officer wins over loan_officer_email, and a blank one leaves the email in charge", async () => {
  const key = giveKey(ann, "lendingpad");
  await post(key, { ...BODY, loan_officer: "Lia Chen", loan_officer_email: "lou@a.test" });
  await post(key, { ...BODY, loan_id: "L2", borrower_name: "Mary Jones", email: "mary@x.test", loan_officer: "", loan_officer_email: "lou@a.test" });
  assert.deepStrictEqual(Object.fromEntries(clientRows().map((c) => [c.loan_number, c.user_id])), { L1: lia, L2: lou });
});

test("routed_to_you is only for a created client", async () => {
  const annKey = giveKey(ann, "lendingpad");
  assert.deepStrictEqual((await post(annKey, { ...BODY, loan_officer: "Lou Park" })).data, { result: "created" });
  assert.deepStrictEqual((await post(annKey, { ...BODY, loan_officer: "Sam Green" })).data, { result: "unchanged" });
  assert.strictEqual(clientRows()[0].user_id, lou);

  const louKey = giveKey(lou, "lendingpad");
  const r = await post(louKey, { ...BODY, loan_id: "L2", borrower_name: "Mary Jones", email: "mary@x.test", loan_officer: "Sam Green" });
  assert.deepStrictEqual(r.data, { result: "created" });
  assert.strictEqual(clientRows().find((c) => c.loan_number === "L2").user_id, lou);
});

test("A6a over the webhook: moved_from names the old loan officer", async () => {
  const annKey = giveKey(ann);
  const liaKey = giveKey(lia);

  assert.deepStrictEqual((await post(liaKey, BODY)).data, { result: "created" });
  const [client] = clientRows();
  assert.strictEqual(client.user_id, lia);

  const r = await post(annKey, { ...BODY, loan_officer_email: "lou@a.test" });
  assert.deepStrictEqual([r.status, r.data], [200, { result: "updated", moved_from: "Lia Chen" }]);
  assert.strictEqual(clientRows()[0].user_id, lou);
  // the old loan officer is told in the app, and only there (A1)
  const notes = db.prepare("SELECT from_user, to_user, message FROM notifications").all();
  assert.deepStrictEqual(notes, [{ from_user: ann, to_user: lia, message: "John Smith moved to Lou Park's book: their new loan came in under Lou." }]);

  // a replay with the same loan officer moves nobody, so no moved_from
  assert.deepStrictEqual((await post(annKey, { ...BODY, loan_officer_email: "lou@a.test" })).data, { result: "unchanged" });
});

test("ignored: no closing date, a future one, a dead status", async () => {
  const key = giveKey(ann);
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const ignored = (reason) => [200, { result: "ignored", reason }];
  const check = async (body, expected) => {
    const r = await post(key, body);
    assert.deepStrictEqual([r.status, r.data], expected, JSON.stringify(body.status || body.closing_date));
  };

  await check(without(BODY, "closing_date"), ignored("no closing date"));
  await check({ ...BODY, closing_date: "" }, ignored("no closing date"));
  await check({ ...BODY, closing_date: tomorrow }, ignored("closing date is in the future"));
  for (const status of ["Denied", "Withdrawn", "Cancelled", "Canceled", "Adverse Action", "Archived", "application denied"]) {
    await check({ ...BODY, status }, ignored("status is not funded"));
  }
  // the status is checked before the loan's own fields, but after the loan_id
  await check({ loan_id: "L5", status: "Withdrawn" }, ignored("status is not funded"));
  await check({ ...BODY, status: "Funded" }, [200, { result: "created" }]);
  assert.strictEqual(clientRows().length, 1, "only the funded loan was written");
});

test("the closing date is checked before the loan's other fields, so a pipeline loan missing them is ignored, not a 400", async () => {
  const key = giveKey(ann);
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const answer = async (body) => { const r = await post(key, body); return [r.status, r.data]; };

  assert.deepStrictEqual(await answer(without(BODY, "note_rate", "closing_date")), [200, { result: "ignored", reason: "no closing date" }]);
  assert.deepStrictEqual(await answer({ loan_id: "L6" }), [200, { result: "ignored", reason: "no closing date" }]);
  assert.deepStrictEqual(await answer({ ...without(BODY, "borrower_name", "property_value"), closing_date: tomorrow }),
    [200, { result: "ignored", reason: "closing date is in the future" }]);
  // a date that is there but cannot be read is the Zap's mistake, and it is named before the other fields
  assert.deepStrictEqual(await answer({ ...without(BODY, "note_rate"), closing_date: "garbage99" }), [400, { error: "closing_date is not a date" }]);
  // with a funded date, the other fields are checked as before
  assert.deepStrictEqual(await answer(without(BODY, "note_rate")), [400, { error: "note_rate is missing or not between 0 and 20" }]);
  // a closing date with a time of day is that day
  assert.deepStrictEqual(await answer({ ...BODY, closing_date: "2026-03-02 00:00:00.000" }), [200, { result: "created" }]);
  assert.strictEqual(clientRows().length, 1);
});

test("400s name the field and never echo the value", async () => {
  const key = giveKey(ann);
  const cases = [
    [without(BODY, "loan_id"), "loan_id is required"],
    [{ ...BODY, loan_id: "L".repeat(65) }, "loan_id is too long"],
    [{ ...BODY, loan_id: "   " }, "loan_id is required"],
    [without(BODY, "borrower_name"), "borrower_name (or borrower_first_name and borrower_last_name) is required"],
    [without(BODY, "note_rate"), "note_rate is missing or not between 0 and 20"],
    [{ ...BODY, note_rate: "abc123" }, "note_rate is missing or not between 0 and 20"],
    [{ ...BODY, note_rate: 0 }, "note_rate is missing or not between 0 and 20"],
    [{ ...BODY, note_rate: 25 }, "note_rate is missing or not between 0 and 20"],
    [without(BODY, "current_balance", "loan_amount"), "current_balance or loan_amount is required"],
    [without(BODY, "property_value"), "property_value, appraised_value or purchase_price is required"],
    [{ ...BODY, closing_date: "garbage99" }, "closing_date is not a date"],
    [{ ...BODY, closing_date: "2026-02-30" }, "closing_date is not a date"],
  ];
  for (const [body, error] of cases) {
    const r = await post(key, body);
    assert.deepStrictEqual([r.status, r.data], [400, { error }], error);
  }

  // no answer repeats what was sent
  const probes = [
    { ...BODY, note_rate: "abc123" },
    { ...BODY, closing_date: "garbage99" },
    { ...BODY, loan_id: "ZZ".repeat(40) },
    { ...without(BODY, "property_value"), borrower_name: "Zelda Zork" },
  ];
  for (const body of probes) {
    const r = await post(key, body);
    for (const secret of ["abc123", "garbage99", "ZZZZ", "Zelda", "Zork", "John", "L1", "123-45-6789", "1980-01-01", "john@x.test"]) {
      assert.ok(!r.text.includes(secret), `${r.text} echoes ${secret}`);
    }
  }
  assert.strictEqual(clientRows().length, 0, "a refused loan writes nothing");
});

test("first and last name stand in for borrower_name; funding_date stands in for a blank closing_date", async () => {
  const key = giveKey(ann);
  const body = { ...without(BODY, "borrower_name", "closing_date"), borrower_first_name: "Ada", borrower_last_name: "Byron", closing_date: "", funding_date: "2026-03-09" };
  assert.deepStrictEqual((await post(key, body)).data, { result: "created" });
  const [c] = clientRows();
  assert.deepStrictEqual([c.name, c.close_date], ["Ada Byron", "2026-03-09"]);
  // closing_date wins when both are there
  assert.deepStrictEqual((await post(key, { ...BODY, loan_id: "L7", borrower_name: "Eve Ash", email: "eve@x.test", funding_date: "2026-03-20" })).data, { result: "created" });
  assert.strictEqual(clientRows()[1].close_date, "2026-03-02");
});

test("empty strings are absent and numbers may come as strings", async () => {
  const key = giveKey(ann);
  const body = { ...BODY, current_balance: "", note_rate: "6.5", loan_amount: "400000", term_months: "360", email: "", phone: "" };
  const r = await post(key, body);
  assert.deepStrictEqual([r.status, r.data], [200, { result: "created" }]);
  const [c] = clientRows();
  assert.strictEqual(c.current_rate, 6.5);
  assert.ok(c.loan_balance > 0 && c.loan_balance < 400000, `an estimated balance, not ${c.loan_balance}`);
  assert.strictEqual(c.email, "");

  db.prepare("DELETE FROM clients").run();
  const zero = await post(key, { ...without(BODY, "loan_amount"), current_balance: 0 });
  assert.deepStrictEqual([zero.status, zero.data], [400, { error: "current_balance or loan_amount is required" }]);
  // only a string or a number is a value: null, a boolean, a list and an object are the same as not sent
  for (const odd of [null, true, false, ["6.5"], { rate: 6.5 }]) {
    const x = await post(key, { ...BODY, note_rate: odd });
    assert.deepStrictEqual([x.status, x.data], [400, { error: "note_rate is missing or not between 0 and 20" }], JSON.stringify(odd));
  }
  assert.strictEqual(clientRows().length, 0);
});

test("unknown fields are never stored", async () => {
  const key = giveKey(ann);
  const body = { ...BODY, income: 250000, employer: "Initech", account_number: "9988776655", notes: "call after 5", name: "Mallory", user_id: lia, org_id: orgB };
  assert.deepStrictEqual((await post(key, body)).data, { result: "created" });
  const rows = clientRows();
  assert.strictEqual(rows.length, 1);
  for (const c of rows) {
    for (const [column, value] of Object.entries(c)) {
      for (const secret of ["123-45-6789", "1980-01-01", "250000", "Initech", "9988776655", "call after 5", "Mallory"]) {
        assert.ok(!String(value).includes(secret), `clients.${column} holds ${secret}`);
      }
    }
  }
  assert.deepStrictEqual([rows[0].name, rows[0].user_id, rows[0].org_id, rows[0].notes], ["John Smith", ann, orgA, ""]);
});

test("bodies: over 32 KB is 413; an array or bad JSON is 400", async () => {
  const key = giveKey(ann);
  const NOT_OBJECT = { error: "The body must be a JSON object" };

  let r = await post(key, JSON.stringify({ ...BODY, padding: "x".repeat(40 * 1024) }));
  assert.deepStrictEqual([r.status, r.data], [413, { error: "The body is over 32 KB" }]);
  // under the limit with room to spare is read (the app-wide 20 MB parser is not the one that runs)
  r = await post(key, JSON.stringify({ ...BODY, padding: "x".repeat(20 * 1024) }));
  assert.deepStrictEqual([r.status, r.data], [200, { result: "created" }]);

  for (const raw of ["[1,2]", "[]", "[" + JSON.stringify(BODY) + "]", "{bad json", "", "null", "42", '"John Smith"', "{}{}"]) {
    r = await post(key, raw);
    const expected = raw === "" ? { error: "loan_id is required" } : NOT_OBJECT;   // an empty body is an empty object
    assert.deepStrictEqual([r.status, r.data], [400, expected], JSON.stringify(raw));
  }
  // a body that is not JSON at all (a Zap set to send form fields) is not a JSON object either
  r = await post(key, "loan_id=L1&borrower_name=John+Smith", { "content-type": "application/x-www-form-urlencoded" });
  assert.deepStrictEqual([r.status, r.data], [400, NOT_OBJECT]);
  assert.ok(!r.text.includes("John"));
  assert.strictEqual(clientRows().length, 1);

  // a body is not read for a caller with no key: the 401 comes first, whatever the size
  r = await post(null, JSON.stringify({ padding: "x".repeat(40 * 1024) }));
  assert.deepStrictEqual([r.status, r.data], [401, { error: "Unauthorized" }]);
});

test("over 60 a minute is 429, counted per key", async () => {
  const small = await startApp({ max: 3 });
  try {
    const call = postTo(small.base);
    const annKey = giveKey(ann);
    const louKey = giveKey(lou);
    for (let i = 0; i < 3; i++) assert.strictEqual((await call(annKey, BODY)).status, 200, `call ${i + 1}`);
    const over = await call(annKey, BODY);
    assert.deepStrictEqual([over.status, over.data], [429, { error: "Too many requests: at most 60 a minute" }]);
    // another user's key has its own count
    assert.deepStrictEqual((await call(louKey, { ...BODY, loan_id: "L8", borrower_name: "Kim Fox", email: "kim@x.test" })).data, { result: "created" });
    // a refused key is not counted at all
    assert.strictEqual((await call("br_" + "1".repeat(64), BODY)).status, 401);
    // with no override the limit is the documented 60
    const standard = await startApp();
    try {
      const r = await postTo(standard.base)(giveKey(bea), BODY);
      assert.strictEqual(r.headers.get("ratelimit-limit"), "60");
    } finally {
      await standard.close();
    }
  } finally {
    await small.close();
  }
});

test("the payload is never logged", async () => {
  const key = giveKey(ann);
  const SECRETS = ["John Smith", "123-45-6789", "L1", "1980-01-01", "john@x.test", "Smith"];
  const clean = (text, what) => { for (const s of SECRETS) assert.ok(!text.includes(s), `${what} logged ${s}: ${text}`); };

  clean(await captured(async () => { assert.strictEqual((await post(key, BODY)).status, 200); }), "a created call");
  clean(await captured(async () => { assert.strictEqual((await post(key, { ...BODY, note_rate: "abc123" })).status, 400); }), "a 400");
  clean(await captured(async () => { assert.strictEqual((await post(key, "{bad json John Smith L1")).status, 400); }), "bad JSON");
  clean(await captured(async () => { assert.strictEqual((await post(key, { ...BODY, padding: "x".repeat(40 * 1024) })).status, 413); }), "a 413");

  // a database error whose own message quotes the payload: only its name is logged, and the answer is a plain 500. The first
  // prepare() is the key's lookup, the third is the loan's own write, so both places a failure can land are covered.
  for (const failing of [1, 3]) {
    const real = Object.getPrototypeOf(db).prepare;
    let calls = 0;
    db.prepare = function (...args) {
      calls += 1;
      if (calls === failing) { delete db.prepare; throw new Error("boom: John Smith 123-45-6789 L1 1980-01-01"); }
      return real.apply(this, args);
    };
    let r;
    let logged;
    try {
      logged = await captured(async () => { r = await post(key, { ...BODY, loan_id: "L1", borrower_name: "John Smith" }); });
    } finally { delete db.prepare; }
    assert.deepStrictEqual([r.status, r.data], [500, { error: "Server error" }], `prepare #${failing}`);
    clean(logged, `a failure at prepare #${failing}`);
    assert.match(logged, /POST \/api\/integrations\/loans: Error/, `prepare #${failing}`);
    clean(r.text, `the answer to a failure at prepare #${failing}`);
  }
  assert.strictEqual(clientRows().length, 1, "the failed calls wrote nothing: only the first, created call is there");
});

test("index.js mounts /api/integrations before the app-wide JSON parser", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const mount = text.indexOf('app.use("/api/integrations"');
  const parser = text.indexOf("app.use(express.json(");
  assert.ok(mount !== -1, "index.js mounts /api/integrations");
  assert.ok(parser !== -1, "index.js has the app-wide JSON parser");
  assert.ok(mount < parser, "the 32 KB parser in the router must run before the 20 MB one");
  assert.ok(text.indexOf('require("./routes/integrations")') !== -1);
});

test("Bill 11/3: a loan officer's own key skips another loan officer's client and says why", async () => {
  assert.deepStrictEqual((await post(giveKey(lia), BODY)).data, { result: "created" });
  const r = await post(giveKey(lou), { ...BODY, note_rate: 6.5 });
  assert.deepStrictEqual([r.status, r.data], [200, {
    result: "skipped", reason: "in Lia Chen's book: a loan officer's feed only changes their own clients",
  }]);
  const [client] = clientRows();
  assert.deepStrictEqual([client.user_id, client.current_rate], [lia, 7.25]);
});

test("a feed's loan_program is stored; without it, the amortization text names the program", async () => {
  const key = giveKey(ann);
  let r = await post(key, { ...BODY, loan_program: "FHA" });
  assert.deepStrictEqual([r.status, r.data], [200, { result: "created" }]);
  assert.strictEqual(clientRows()[0].loan_program, "fha");

  db.prepare("DELETE FROM clients").run();
  r = await post(key, { ...BODY, amortization_type: "FHA 30 Fixed" });
  assert.deepStrictEqual([r.status, r.data], [200, { result: "created" }]);
  assert.strictEqual(clientRows()[0].loan_program, "fha");
  assert.strictEqual(clientRows()[0].loan_type, "30yr_fixed");
});
