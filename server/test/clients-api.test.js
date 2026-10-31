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
  for (const table of ["charlie_recommendations", "contact_log", "user_briefing_state", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
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
