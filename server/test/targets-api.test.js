"use strict";
// Target-rate alerts over REST (routes/clients.js): the `target` key on every client answer and PUT /:id/target, against a
// throwaway DB behind a signed rr_token cookie. No model call and no network but the local test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-targets-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { recordSnapshot } = require("../lib/rateHistory");
const T = require("../lib/targets");
const { ingest } = require("../lib/intake/ingest");
const clientRoutes = require("../routes/clients");

const BASE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
const live = (obs, numbers = {}) => ({ ...BASE, ...numbers, date: obs, source: `Optimal Blue lock data (${obs})` });
const LOW = { rate_30yr_fixed: 5.0, rate_30yr_top_tier: 4.95, rate_15yr_fixed: 4.5, rate_5_1_arm: 4.6 };
const RANGE = "A target rate is a number from 1.000 to 15.000.";
const TARGET_COLS = ["target_rate", "target_set_by", "target_set_at", "target_reached_on", "target_reached_rate",
  "target_reached_at", "target_announced_on", "target_checked_on"];
const FULL_HIT = `UPDATE clients SET target_rate = 6, target_set_by = ?, target_set_at = '2026-11-01 10:00:00', target_reached_on = '2026-11-02',
  target_reached_rate = 5.9, target_reached_at = '2026-11-02 10:00:00', target_announced_on = '2026-11-02', target_checked_on = '2026-11-02'
  WHERE id = ?`;

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, 'User', ?)"
).run(orgId, role, first, email).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email FROM users WHERE id = ?").get(id);
const addClient = (orgId, userId, name, rate = 6.75) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, loan_number, loan_type, current_rate, loan_balance, property_value, credit_score, close_date)
  VALUES (?, ?, ?, 'L' || ?, '30yr_fixed', ?, 300000, 400000, 760, '2024-03-14')
`).run(orgId, userId, name, name, rate).lastInsertRowid);
const row = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@tapi.test", "Ann");
const lou = addUser(orgA, "lo", "lou@tapi.test", "Lou");
const lia = addUser(orgA, "lo", "lia@tapi.test", "Lia");
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@tapi.test", "Bea");

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
  for (const table of ["charlie_recommendations", "contact_log", "rate_snapshots", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

const as = (userId) => async (method, p, body) => {
  const headers = { "content-type": "application/json" };
  if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};
const snap = (obs, numbers) => recordSnapshot(live(obs, numbers), obs, "fred");
const getClient = async (who, id) => (await as(who)("GET", "/api/clients")).data.clients.find((c) => c.id === id);

test("GET /api/clients carries target: null without one, and the watching view with one", async () => {
  snap("2026-11-02");
  const plain = addClient(orgA, ann, "Plain");
  const watched = addClient(orgA, ann, "Watched");
  db.prepare("UPDATE clients SET target_rate = 6, target_set_by = ? WHERE id = ?").run(ann, watched);
  const res = await as(ann)("GET", "/api/clients");
  assert.strictEqual(res.status, 200);
  const byId = Object.fromEntries(res.data.clients.map((c) => [c.id, c]));
  assert.strictEqual(byId[plain].target, null);
  assert.strictEqual(byId[watched].target.rate, 6);
  assert.strictEqual(byId[watched].target.state, "watching");
  assert.strictEqual(byId[watched].target.estRate, T.estimateRate(row(watched), live("2026-11-02")));
});

test("GET shows the stored hit after a newer observation", async () => {
  snap("2026-11-02", LOW);
  const id = addClient(orgA, ann, "Hit");
  db.prepare("UPDATE clients SET target_rate = 6 WHERE id = ?").run(id);
  const first = await getClient(ann, id);
  assert.strictEqual(first.target.state, "at_target");
  assert.strictEqual(first.target.reachedOn, "2026-11-02");
  snap("2026-11-03", { ...LOW, rate_30yr_fixed: 5.1 });
  const later = await getClient(ann, id);
  assert.strictEqual(later.target.state, "at_target");
  assert.strictEqual(later.target.reachedOn, "2026-11-02");
});

test("PUT target sets it, recording who and when", async () => {
  const id = addClient(orgA, ann, "Set");
  const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: 6 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.strictEqual(res.data.client.target.rate, 6);
  const r = row(id);
  assert.strictEqual(r.target_rate, 6);
  assert.strictEqual(r.target_set_by, ann);
  assert.match(r.target_set_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test("PUT target at or above the current rate is a 400 with the exact copy", async () => {
  const id = addClient(orgA, ann, "Bob");
  const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: 7 });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(res.data, { success: false, error: "A target has to be below Bob's current rate of 6.750%." });
  assert.strictEqual((await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: 6.75 })).status, 400);
  assert.strictEqual(row(id).target_rate, null);
});

test("PUT target out of range or not a number is a 400 with the range copy", async () => {
  const id = addClient(orgA, ann, "Range");
  for (const targetRate of ["abc", 0.5, 16]) {
    const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate });
    assert.strictEqual(res.status, 400, String(targetRate));
    assert.deepStrictEqual(res.data, { success: false, error: RANGE });
  }
});

test("PUT target null clears all eight columns", async () => {
  const id = addClient(orgA, ann, "Clear");
  db.prepare(FULL_HIT).run(ann, id);
  const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: null });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.client.target, null);
  for (const col of TARGET_COLS) assert.strictEqual(row(id)[col], null, col);
});

test("PUT target without the targetRate key is a 400 and changes nothing", async () => {
  const id = addClient(orgA, ann, "Keep");
  db.prepare("UPDATE clients SET target_rate = 6 WHERE id = ?").run(id);
  for (const body of [{}, { rate: 5 }]) {
    const res = await as(ann)("PUT", `/api/clients/${id}/target`, body);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.data, { success: false, error: "targetRate required" });
  }
  assert.strictEqual(row(id).target_rate, 6);
});

test("PUT target: an LO on a teammate's client, another org, an unknown id", async () => {
  const mine = addClient(orgA, lou, "Mine");
  const theirs = addClient(orgA, lia, "Theirs");
  assert.strictEqual((await as(lou)("PUT", `/api/clients/${theirs}/target`, { targetRate: 6 })).status, 403);
  assert.strictEqual((await as(lou)("PUT", `/api/clients/${mine}/target`, { targetRate: 6 })).status, 200);
  assert.strictEqual((await as(bea)("PUT", `/api/clients/${mine}/target`, { targetRate: 5 })).status, 403);
  assert.strictEqual((await as(ann)("PUT", "/api/clients/999999/target", { targetRate: 6 })).status, 404);
  assert.strictEqual(row(theirs).target_rate, null);
});

test("re-setting the same value keeps the hit", async () => {
  snap("2026-11-02", LOW);
  const id = addClient(orgA, ann, "Same");
  db.prepare("UPDATE clients SET target_rate = 6 WHERE id = ?").run(id);
  await getClient(ann, id);   // the check stores the hit
  const stored = row(id);
  assert.strictEqual(stored.target_reached_on, "2026-11-02");
  const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: 6.0001 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(row(id), stored);
  assert.strictEqual(res.data.client.target.state, "at_target");
});

test("a new value re-arms it, and the next GET re-checks the same observation", async () => {
  snap("2026-11-02", LOW);
  const id = addClient(orgA, ann, "Rearm");
  db.prepare("UPDATE clients SET target_rate = 6 WHERE id = ?").run(id);
  await getClient(ann, id);
  assert.strictEqual(row(id).target_reached_on, "2026-11-02");
  const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: 4 });
  assert.strictEqual(res.status, 200);
  const r = row(id);
  assert.strictEqual(r.target_rate, 4);
  assert.strictEqual(r.target_set_by, ann);
  for (const col of ["target_reached_on", "target_reached_rate", "target_reached_at", "target_announced_on"]) {
    assert.strictEqual(r[col], null, col);
  }
  // The answer's own check ran against the same observation date (the cleared check date made it eligible again).
  assert.strictEqual(r.target_checked_on, "2026-11-02");
  assert.strictEqual(res.data.client.target.state, "watching");
  assert.strictEqual((await getClient(ann, id)).target.state, "watching");
});

test("a broker sets a target on an LO's client, and the LO sees it", async () => {
  const id = addClient(orgA, lou, "LoClient");
  const res = await as(ann)("PUT", `/api/clients/${id}/target`, { targetRate: 6 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(row(id).target_set_by, ann);
  const seen = await getClient(lou, id);
  assert.strictEqual(seen.target.rate, 6);
});

test("logging a contact handles it", async () => {
  snap("2026-11-02", LOW);
  const id = addClient(orgA, ann, "Called");
  db.prepare("UPDATE clients SET target_rate = 6 WHERE id = ?").run(id);
  assert.strictEqual((await getClient(ann, id)).target.state, "at_target");
  const res = await as(ann)("POST", `/api/clients/${id}/contact`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.client.target.state, "handled");
});

test("PUT /:id answers with the target too", async () => {
  const id = addClient(orgA, ann, "Edit");
  db.prepare("UPDATE clients SET target_rate = 6 WHERE id = ?").run(id);
  const res = await as(ann)("PUT", `/api/clients/${id}`, {
    name: "Edit", currentRate: 6.75, loanBalance: 300000, propertyValue: 400000, loanType: "30yr_fixed",
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.client.target.rate, 6);
});

test("an import of the matched loan leaves the target", () => {
  const id = addClient(orgA, lou, "Imp", 6.75);
  db.prepare(FULL_HIT).run(ann, id);
  const stored = row(id);
  const fields = {
    firstName: "Imp", lastName: "", email: "", phone: "", loanNumber: "LImp", noteRate: "6.250%", loanAmount: "$300,000",
    term: "360", amortization: "Fixed", appraisedValue: "400000", closingDate: "3/14/2024", purpose: "Refinance", creditScore: "760",
    loanOfficer: "lou@tapi.test", notes: "",
  };
  ingest(db, {
    actor: userRow(ann), source: "import", items: [{ row: fields, fields }], today: "2026-11-05",
    nowUtc: "2026-11-05 15:00:00", requireClosingDate: true, dryRun: false,
  });
  const after = row(id);
  assert.strictEqual(after.current_rate, 6.25, "the import did update the loan");
  for (const col of TARGET_COLS) assert.strictEqual(after[col], stored[col], col);
});
