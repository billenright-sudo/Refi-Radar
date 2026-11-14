"use strict";
// /api/clients (routes/clients.js) against a throwaway DB, behind a signed rr_token cookie: the Sweeps page's "Log contact" button
// (POST /:id/contact) and what Charlie's next briefing makes of it. No model call and no network but the local test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-clients-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const fu = require("../lib/assistant/followups");
const clientRoutes = require("../routes/clients");
const { buildBriefing } = require("../lib/assistant/briefing");
const { recordSnapshot } = require("../lib/rateHistory");

const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, career_stage) VALUES (?, ?, ?, 'User', ?, 'established')"
).run(orgId, role, first, email).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email, career_stage FROM users WHERE id = ?").get(id);
const addClient = (orgId, userId, name, fields = {}) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact)
  VALUES (?, ?, ?, '30yr_fixed', ?, ?, ?, 760, ?)
`).run(orgId, userId, name, fields.rate ?? 7.5, fields.balance ?? 400000, fields.value ?? 500000, fields.lastContact ?? "2025-01-01").lastInsertRowid);
const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
const callRows = (clientId) => db.prepare("SELECT user_id, outcome, notes FROM contact_log WHERE client_id = ? ORDER BY id").all(clientId);
const recRows = (clientId) => db.prepare("SELECT source, day, status, resolved_at FROM charlie_recommendations WHERE client_id = ? ORDER BY id").all(clientId);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@clients.test", "Ann");
const lou = addUser(orgA, "lo", "lou@clients.test", "Lou");
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@clients.test", "Bea");

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/clients", clientRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => {
  for (const table of ["charlie_recommendations", "contact_log", "user_briefing_state", "rate_snapshots", "client_upgrades", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

// `as(userId)` -> a request function signed in as that user; `as(null)` is anonymous.
const as = (userId) => async (method, p, body) => {
  const headers = { "content-type": "application/json" };
  if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};

// A briefing on the real clock (the button stamps the real time), at 9 AM on today's UTC date.
const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const briefNow = (userId) => {
  const user = userRow(userId);
  return buildBriefing({ user, ctx: { user, rates: RATES, db }, db, localHour: 9, localDate: utcDay(), nowMs: Date.now() });
};

// Silences console.error for the duration of fn.
async function quietly(fn) {
  const saved = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = saved; }
}

// ── the Sweeps page's "Log contact" (final review I4) ───────────────────────

test("I4: Log contact on the Sweeps page logs a reached call and closes the client's open follow-ups, carry included", async () => {
  const alpha = addClient(orgA, ann, "Alpha Sample");
  fu.recordRecommendations(db, ann, utcDay(-1), [{ clientId: alpha, source: "briefing", reasonCode: "rate_term" }]);
  fu.addCarry(db, ann, alpha, utcDay(-1));
  const r = await as(ann)("POST", `/api/clients/${alpha}/contact`);
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.client.id, alpha);
  assert.deepStrictEqual(callRows(alpha), [{ user_id: ann, outcome: "reached", notes: "" }]);
  const rows = recRows(alpha);
  assert.deepStrictEqual(rows.map((row) => [row.source, row.status]), [["briefing", "reached"], ["carry", "reached"]]);
  for (const row of rows) assert.match(row.resolved_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("I4: after Log contact the client is neither on the next briefing's list nor asked about", async () => {
  const alpha = addClient(orgA, ann, "Alpha Sample");               // asked about: recommended yesterday, still open
  const bravo = addClient(orgA, ann, "Bravo Sample", { rate: 7.25 }); // listed this morning
  fu.recordRecommendations(db, ann, utcDay(-1), [{ clientId: alpha, source: "briefing", reasonCode: "rate_term" }]);
  const morning = await briefNow(ann);
  assert.ok(morning.reply.endsWith("Yesterday I suggested calling Alpha Sample. Were you able to reach them?"), morning.reply);
  assert.ok(morning.reply.includes("Bravo Sample could save"), morning.reply);

  for (const id of [alpha, bravo]) assert.equal((await as(ann)("POST", `/api/clients/${id}/contact`)).status, 200);
  const reopen = await briefNow(ann);
  assert.ok(!reopen.reply.includes("Alpha Sample"), reopen.reply);
  assert.ok(!reopen.reply.includes("Bravo Sample"), reopen.reply);
  assert.equal(reopen.followUp, null);
});

test("I4: Log contact is one transaction: when closing the follow-ups fails, nothing is written", async () => {
  const alpha = addClient(orgA, ann, "Alpha Sample", { lastContact: "2025-01-01" });
  fu.recordRecommendations(db, ann, utcDay(-1), [{ clientId: alpha, source: "briefing", reasonCode: "rate_term" }]);
  const real = fu.resolveForClient;
  fu.resolveForClient = () => { throw new Error("boom"); };
  let r;
  try {
    r = await quietly(() => as(ann)("POST", `/api/clients/${alpha}/contact`));
  } finally {
    fu.resolveForClient = real;
  }
  assert.equal(r.status, 500);
  assert.equal(clientRow(alpha).last_contact, "2025-01-01");
  assert.deepStrictEqual(callRows(alpha), []);
  assert.equal(recRows(alpha)[0].status, "open");
});

test("I4: Log contact keeps its ownership rules, and a refused one writes no call", async () => {
  const annClient = addClient(orgA, ann, "Ann's Client");
  const louClient = addClient(orgA, lou, "Lou's Client");
  const beaClient = addClient(orgB, bea, "Bea's Client");
  assert.equal((await as(lou)("POST", `/api/clients/${annClient}/contact`)).status, 403, "an LO: their own clients only");
  assert.equal((await as(ann)("POST", `/api/clients/${beaClient}/contact`)).status, 403, "another org's");
  assert.equal((await as(ann)("POST", "/api/clients/99999999/contact")).status, 404);
  assert.equal((await as(null)("POST", `/api/clients/${annClient}/contact`)).status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contact_log").get().n, 0);
  assert.equal((await as(ann)("POST", `/api/clients/${louClient}/contact`)).status, 200, "a broker: any client in their org");
  assert.deepStrictEqual(callRows(louClient), [{ user_id: ann, outcome: "reached", notes: "" }]);
  assert.equal((await as(lou)("POST", `/api/clients/${louClient}/contact`)).status, 200);
});

// ── the client page's call log (final review I5, spec 5.4) ─────────────────

const logAt = (clientId, userId, at, outcome, notes) => db.prepare(
  "INSERT INTO contact_log (client_id, user_id, at, outcome, notes) VALUES (?, ?, ?, ?, ?)"
).run(clientId, userId, at, outcome, notes);

test("I5: GET /:id/calls returns the client's calls, newest first, as { at, outcome, notes } only", async () => {
  const louClient = addClient(orgA, lou, "Lou's Client");
  const other = addClient(orgA, lou, "Another Client");
  logAt(louClient, lou, "2026-10-28 15:00:00", "reached", "She wants to wait until spring.");
  logAt(louClient, lou, "2026-10-29 16:30:00", "not_reached", "");
  logAt(louClient, ann, "2026-10-29 16:30:00", "reached", "Called back <b>later</b>");   // same instant: the later row first
  logAt(other, lou, "2026-10-30 09:00:00", "reached", "not this client's");
  const r = await as(lou)("GET", `/api/clients/${louClient}/calls`);
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, {
    success: true,
    calls: [
      { at: "2026-10-29 16:30:00", outcome: "reached", notes: "Called back <b>later</b>" },
      { at: "2026-10-29 16:30:00", outcome: "not_reached", notes: "" },
      { at: "2026-10-28 15:00:00", outcome: "reached", notes: "She wants to wait until spring." },
    ],
  });
  const none = await as(lou)("GET", `/api/clients/${addClient(orgA, lou, "No Calls Yet")}/calls`);
  assert.deepStrictEqual(none.data, { success: true, calls: [] });
});

test("I5: GET /:id/calls keeps the client ownership rules: own and a broker's org, never another LO's or another org's", async () => {
  const annClient = addClient(orgA, ann, "Ann's Client");
  const louClient = addClient(orgA, lou, "Lou's Client");
  const beaClient = addClient(orgB, bea, "Bea's Client");
  for (const id of [annClient, louClient, beaClient]) logAt(id, ann, "2026-10-29 10:00:00", "reached", "private notes");
  assert.equal((await as(lou)("GET", `/api/clients/${louClient}/calls`)).status, 200, "an LO: their own client");
  assert.equal((await as(ann)("GET", `/api/clients/${louClient}/calls`)).status, 200, "a broker: an LO's client in their org");
  assert.equal((await as(ann)("GET", `/api/clients/${annClient}/calls`)).status, 200, "a broker: their own");
  const otherLo = await as(lou)("GET", `/api/clients/${annClient}/calls`);
  assert.deepStrictEqual([otherLo.status, otherLo.data], [403, { success: false, error: "Access denied" }], "an LO: not anyone else's");
  const otherOrg = await as(ann)("GET", `/api/clients/${beaClient}/calls`);
  assert.deepStrictEqual([otherOrg.status, otherOrg.data], [403, { success: false, error: "Access denied" }], "never another org's");
  for (const id of ["99999999", "abc", "0", "-3"]) {
    const r = await as(ann)("GET", `/api/clients/${id}/calls`);
    assert.deepStrictEqual([r.status, r.data], [404, { success: false, error: "Client not found" }], id);
  }
  assert.equal((await as(null)("GET", `/api/clients/${louClient}/calls`)).status, 401);
});

test("I5: GET /:id/calls returns at most the 50 newest calls", async () => {
  const id = addClient(orgA, ann, "Busy Client");
  for (let i = 0; i < 55; i++) logAt(id, ann, `2026-10-${String(1 + Math.floor(i / 2)).padStart(2, "0")} ${String(10 + (i % 2)).padStart(2, "0")}:00:00`, "reached", `call ${i}`);
  const r = await as(ann)("GET", `/api/clients/${id}/calls`);
  assert.equal(r.data.calls.length, 50);
  assert.equal(r.data.calls[0].notes, "call 54");
  assert.equal(r.data.calls[49].notes, "call 5");
});

test("I5: saved call notes never reach the model: no assistant code reads contact_log's notes, and none calls /calls", () => {
  const dir = path.join(__dirname, "..", "lib", "assistant");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
  files.push(path.join(__dirname, "..", "routes", "assistant.js"));
  let reads = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    // each SELECT's own column list (never reaching back past another FROM) that reads contact_log
    for (const m of src.matchAll(/SELECT\s+((?:(?!\bFROM\b)[\s\S])*?)\s+FROM\s+contact_log\b/gi)) {
      reads += 1;
      assert.ok(!/\bnotes\b|\*/.test(m[1]), `${path.basename(file)} reads ${m[1]} from contact_log`);
    }
    assert.ok(!/\/calls\b/.test(src), `${path.basename(file)} mentions /calls`);
  }
  assert.ok(reads >= 1, "the check sees reachedSince's read (client ids only), so it would see one of the notes");
});

test("Bill 11/3: a save that changes the rate, property value or credit score marks it as edited by hand, for the import to keep", async () => {
  const id = addClient(orgA, lou, "Hand Edit");
  const form = { name: "Hand Edit", loanType: "30yr_fixed", currentRate: "7.5", loanBalance: "400000", propertyValue: "500000", creditScore: "760" };
  const save = (who, patch) => as(who)("PUT", `/api/clients/${id}`, { ...form, ...patch });

  // a save that changes none of the three (here only the notes and the balance) marks nothing
  assert.strictEqual((await save(lou, { notes: "called", loanBalance: "398000" })).status, 200);
  assert.strictEqual(clientRow(id).edited_by_hand, "");
  // the property value changed: it alone is marked
  await save(lou, { propertyValue: "560000" });
  assert.strictEqual(clientRow(id).edited_by_hand, "property_value");
  // the broker then changes the rate and the score: the marks add up, always in the same order
  await save(ann, { propertyValue: "560000", currentRate: "6.875", creditScore: "781" });
  assert.strictEqual(clientRow(id).edited_by_hand, "current_rate,property_value,credit_score");
  // a refused save marks nothing
  const other = addClient(orgA, ann, "Not Lou's");
  assert.strictEqual((await as(lou)("PUT", `/api/clients/${other}`, { ...form, name: "Not Lou's", currentRate: "5" })).status, 403);
  assert.strictEqual(clientRow(other).edited_by_hand, "");
});

// ── Do not email (Bill 2026-11-06) ─────────────────────────────────────────────────────────────────────────────────────────
const NEW_CLIENT = { name: "Dana Noemail", email: "dana@example.com", loanType: "30yr_fixed", currentRate: 7.5, loanBalance: 300000, propertyValue: 450000 };

test("a client can be saved as do-not-email, and reads back that way", async () => {
  const made = await as(ann)("POST", "/api/clients", { ...NEW_CLIENT, doNotEmail: true });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.client.doNotEmail, true);
  assert.equal(clientRow(made.data.client.id).do_not_email, 1);
  const plain = await as(ann)("POST", "/api/clients", { ...NEW_CLIENT, name: "Eli Plain" });
  assert.equal(plain.data.client.doNotEmail, false, "unticked by default");
  const list = await as(ann)("GET", "/api/clients");
  const flags = Object.fromEntries((list.data.clients || list.data).map((c) => [c.name, c.doNotEmail]));
  assert.deepEqual(flags, { "Dana Noemail": true, "Eli Plain": false });
});

test("editing a client sets or clears do-not-email, and a save that doesn't mention it keeps it", async () => {
  const id = (await as(ann)("POST", "/api/clients", { ...NEW_CLIENT, doNotEmail: true })).data.client.id;
  const kept = await as(ann)("PUT", `/api/clients/${id}`, { ...NEW_CLIENT, currentRate: 7.25 });
  assert.equal(kept.status, 200, JSON.stringify(kept.data));
  assert.equal(kept.data.client.doNotEmail, true, "an older form without the field never clears it");
  const cleared = await as(ann)("PUT", `/api/clients/${id}`, { ...NEW_CLIENT, doNotEmail: false });
  assert.equal(cleared.data.client.doNotEmail, false);
  const set = await as(ann)("PUT", `/api/clients/${id}`, { ...NEW_CLIENT, doNotEmail: true });
  assert.equal(set.data.client.doNotEmail, true);
  assert.equal(clientRow(id).do_not_email, 1);
});

// ── upgrade views on the client list (spec 4.7) ─────────────────────────────

// A VA client whose IRRRL qualifies on the FRED set below (7.5% loan closed mid-2025, VA rate 5.8).
const addVaClient = (orgId, userId, name) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, credit_score_known,
    loan_program, close_date, balance_as_of, original_amount, original_value, property_zip, occupancy)
  VALUES (?, ?, ?, '30yr_fixed', 7.5, 300000, 400000, 720, 1, 'va', '2025-06-15', '2025-06-15', 300000, 400000, '85016', 'primary')
`).run(orgId, userId, name).lastInsertRowid);
const fredSet = (obs) => recordSnapshot({ ...RATES, rate_30yr_fha: 6.1, rate_30yr_va: 5.8, date: obs, source: `Optimal Blue lock data (${obs})` }, obs, "fred");

test("GET /api/clients items carry the upgrade view; a loan officer's list has views only for their own clients", async () => {
  const annVa = addVaClient(orgA, ann, "Ann's VA");
  const louVa = addVaClient(orgA, lou, "Lou's VA");
  const plain = addClient(orgA, ann, "Plain Sample");
  fredSet(utcDay(-1));

  const brokerList = (await as(ann)("GET", "/api/clients")).data.clients;
  assert.equal(brokerList.length, 3);
  const byId = new Map(brokerList.map((c) => [c.id, c]));
  for (const id of [annVa, louVa]) {
    const up = byId.get(id).upgrades;
    assert.deepStrictEqual(up.lenses.map((l) => [l.lens, l.isNew]), [["va_irrrl", true]]);
    assert.deepStrictEqual(up.newLenses, ["va_irrrl"]);
    assert.equal(up.today.balance > 0, true);
  }
  assert.deepStrictEqual(byId.get(plain).upgrades.lenses, []);
  assert.deepStrictEqual(byId.get(plain).upgrades.gaps, ["Add the loan program to check upgrades."]);

  const louList = (await as(lou)("GET", "/api/clients")).data.clients;
  assert.deepStrictEqual(louList.map((c) => c.id), [louVa]);
  assert.deepStrictEqual(louList[0].upgrades.newLenses, ["va_irrrl"]);

  // Logging a call clears "new" on the next read.
  assert.equal((await as(ann)("POST", `/api/clients/${annVa}/contact`)).status, 200);
  const after = (await as(ann)("GET", "/api/clients")).data.clients.find((c) => c.id === annVa);
  assert.deepStrictEqual(after.upgrades.newLenses, []);
  assert.equal(after.upgrades.lenses[0].isNew, false);
});
