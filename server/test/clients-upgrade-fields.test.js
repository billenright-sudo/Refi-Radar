"use strict";
// The loan-upgrade client fields (loan program, mortgage insurance, originals, ZIP, occupancy, as-of dates, known credit score):
// the migration's backfills and /api/clients (routes/clients.js) against a throwaway DB. No model call, no network but the local test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-clients-upgrade-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

// A database that predates the columns: the clients table as it was before this feature, three rows, made before db.js runs.
{
  const Database = require("better-sqlite3");
  const old = new Database(path.join(process.env.DATA_DIR, "refi-radar.db"));
  old.exec(`CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    email TEXT DEFAULT '', phone TEXT DEFAULT '', loan_type TEXT NOT NULL DEFAULT '30yr_fixed',
    current_rate REAL NOT NULL, loan_balance REAL NOT NULL, property_value REAL NOT NULL, close_date TEXT DEFAULT '',
    credit_score INTEGER DEFAULT 700, notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_by_hand TEXT NOT NULL DEFAULT '')`);
  const ins = old.prepare(`INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value, credit_score, edited_by_hand, created_at, updated_at)
    VALUES (1, 1, ?, 6.5, 300000, 400000, ?, ?, '2025-01-01 09:00:00', '2025-04-02 10:00:00')`);
  ins.run("Default 700", 700, "");
  ins.run("Real 742", 742, "");
  ins.run("Typed 700", 700, "credit_score");
  old.close();
}

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const clientRoutes = require("../routes/clients");

// The migration ran when db was required: read its result before anything else touches the table.
const migrated = db.prepare("SELECT * FROM clients ORDER BY id").all();

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, career_stage) VALUES (?, ?, ?, 'User', ?, 'established')"
).run(orgId, role, first, email).lastInsertRowid);
const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@upgrade.test", "Ann");

const today = () => new Date().toISOString().slice(0, 10);
const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);

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
beforeEach(() => { db.prepare("DELETE FROM clients").run(); });

const api = async (method, p, body) => {
  const headers = { "content-type": "application/json", cookie: "rr_token=" + signToken({ userId: ann }) };
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};

const BASE = { name: "Pat Upgrade", currentRate: "6.5", loanBalance: "300000", propertyValue: "400000", loanType: "30yr_fixed" };
const create = (extra = {}) => api("POST", "/api/clients", { ...BASE, ...extra });

test("migration backfills as-of dates and credit_score_known", () => {
  assert.strictEqual(migrated.length, 3);
  assert.deepStrictEqual(migrated.map((r) => r.credit_score_known), [0, 1, 1]);
  for (const r of migrated) {
    assert.strictEqual(r.balance_as_of, "2025-04-02");
    assert.strictEqual(r.value_as_of, "2025-04-02");
    assert.strictEqual(r.loan_program, "");
    assert.strictEqual(r.property_zip, "");
    assert.strictEqual(r.occupancy, "");
    assert.strictEqual(r.monthly_mi, null);
    assert.strictEqual(r.original_amount, null);
    assert.strictEqual(r.original_value, null);
  }
});

test("POST stores the new fields", async () => {
  const r = await create({ loanProgram: "fha", monthlyMi: "212.5", originalAmount: "289500", originalValue: "300000",
    propertyZip: "85016", occupancy: "primary", creditScore: "688" });
  assert.strictEqual(r.status, 201);
  const c = r.data.client;
  assert.deepStrictEqual(
    [c.loanProgram, c.monthlyMi, c.originalAmount, c.originalValue, c.propertyZip, c.occupancy, c.creditScore, c.creditScoreKnown, c.balanceAsOf, c.valueAsOf],
    ["fha", 212.5, 289500, 300000, "85016", "primary", 688, true, today(), today()]);
  assert.strictEqual(clientRow(c.id).credit_score_known, 1);
});

test("POST with nothing for the new fields stores blanks and NULLs", async () => {
  const c = (await create()).data.client;
  assert.deepStrictEqual([c.loanProgram, c.monthlyMi, c.originalAmount, c.originalValue, c.propertyZip, c.occupancy],
    ["", null, null, null, "", ""]);
});

test("POST with a blank credit score stores 700 and creditScoreKnown false", async () => {
  for (const creditScore of ["", undefined]) {
    const c = (await create({ creditScore })).data.client;
    assert.strictEqual(c.creditScore, 700);
    assert.strictEqual(c.creditScoreKnown, false);
  }
});

test("validation", async () => {
  const bad = async (extra) => { const r = await create(extra); assert.strictEqual(r.status, 400); return r.data.errors; };
  assert.strictEqual((await bad({ loanProgram: "nonqm" })).loanProgram, "Invalid loan program");
  assert.strictEqual((await bad({ monthlyMi: "6000" })).monthlyMi, "Mortgage insurance is a monthly amount from 0 to 5,000");
  assert.strictEqual((await bad({ originalAmount: "-1" })).originalAmount, "Valid original loan amount required");
  assert.strictEqual((await bad({ originalValue: "0" })).originalValue, "Valid original home value required");
  assert.strictEqual((await bad({ propertyZip: "8501" })).propertyZip, "ZIP is 5 digits");
  assert.strictEqual((await bad({ occupancy: "rental" })).occupancy, "Invalid occupancy");
  // Blank is valid for all six; 0 and 5000 are valid mortgage insurance.
  const ok = await create({ loanProgram: "", monthlyMi: "", originalAmount: "", originalValue: "", propertyZip: "", occupancy: "" });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual((await create({ monthlyMi: "0" })).data.client.monthlyMi, 0);
  assert.strictEqual((await create({ monthlyMi: "5000" })).status, 201);
  assert.deepStrictEqual(clientRoutes.OCCUPANCIES, ["primary", "second_home", "investment"]);
  assert.deepStrictEqual(clientRoutes.PROGRAMS, ["conventional", "fha", "va", "usda", "jumbo"]);
});

const putBody = (c, extra = {}) => ({ ...BASE, loanBalance: String(c.loanBalance), propertyValue: String(c.propertyValue), ...extra });

test("PUT moves as-of dates only when the figure changes", async () => {
  const c = (await create({ loanBalance: "300000", propertyValue: "400000" })).data.client;
  db.prepare("UPDATE clients SET balance_as_of = '2024-01-01', value_as_of = '2024-01-01' WHERE id = ?").run(c.id);
  const r = await api("PUT", `/api/clients/${c.id}`, putBody(c));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([clientRow(c.id).balance_as_of, clientRow(c.id).value_as_of], ["2024-01-01", "2024-01-01"]);
  await api("PUT", `/api/clients/${c.id}`, putBody(c, { loanBalance: "295000" }));
  assert.deepStrictEqual([clientRow(c.id).balance_as_of, clientRow(c.id).value_as_of], [today(), "2024-01-01"]);
  db.prepare("UPDATE clients SET balance_as_of = '2024-01-01' WHERE id = ?").run(c.id);
  await api("PUT", `/api/clients/${c.id}`, putBody(c, { loanBalance: "295000", propertyValue: "410000" }));
  assert.deepStrictEqual([clientRow(c.id).balance_as_of, clientRow(c.id).value_as_of], ["2024-01-01", today()]);
});

test("PUT marks hand edits on the new columns", async () => {
  const c = (await create({ loanProgram: "conventional" })).data.client;
  assert.strictEqual(clientRow(c.id).edited_by_hand, "");
  await api("PUT", `/api/clients/${c.id}`, putBody(c, { loanProgram: "fha" }));
  assert.deepStrictEqual(clientRow(c.id).edited_by_hand.split(","), ["loan_program"]);
  await api("PUT", `/api/clients/${c.id}`, putBody(c, { loanProgram: "fha", monthlyMi: "150", propertyZip: "85016", occupancy: "second_home", originalAmount: "250000", originalValue: "300000" }));
  assert.strictEqual(clientRow(c.id).edited_by_hand, "loan_program,monthly_mi,original_amount,original_value,property_zip,occupancy");
});

test("PUT with a new credit score sets creditScoreKnown true; PUT with a blank one sets it false", async () => {
  const c = (await create()).data.client;
  assert.strictEqual(c.creditScoreKnown, false);
  let r = await api("PUT", `/api/clients/${c.id}`, putBody(c, { creditScore: "655" }));
  assert.deepStrictEqual([r.data.client.creditScore, r.data.client.creditScoreKnown], [655, true]);
  r = await api("PUT", `/api/clients/${c.id}`, putBody(c, { creditScore: "" }));
  assert.deepStrictEqual([r.data.client.creditScore, r.data.client.creditScoreKnown], [700, false]);
});
