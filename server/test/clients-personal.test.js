"use strict";
// The personal details on a client (lib/personal.js) through /api/clients and the My Team view: the migration, create, edit, an
// older page's save, an import of the same loan, and that nothing priced reads them. Throwaway DB, no model call, no network but
// the local test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-clients-personal-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

// A database that predates the column: one client, made before db.js runs.
{
  const Database = require("better-sqlite3");
  const old = new Database(path.join(process.env.DATA_DIR, "refi-radar.db"));
  old.exec(`CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    email TEXT DEFAULT '', phone TEXT DEFAULT '', loan_type TEXT NOT NULL DEFAULT '30yr_fixed',
    current_rate REAL NOT NULL, loan_balance REAL NOT NULL, property_value REAL NOT NULL, close_date TEXT DEFAULT '',
    credit_score INTEGER DEFAULT 700, notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.prepare("INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (1, 1, 'Before', 6.5, 300000, 400000)").run();
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
const { EMPTY } = require("../lib/personal");
const { ingest } = require("../lib/intake/ingest");
const refi = require("../lib/refi");

const migrated = db.prepare("SELECT * FROM clients ORDER BY id").all();

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, career_stage) VALUES (?, ?, ?, 'User', ?, 'established')"
).run(orgId, role, first, email).lastInsertRowid);
const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@personal.test", "Ann");
const lou = addUser(orgA, "lo", "lou@personal.test", "Lou");
const userRow = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/clients", clientRoutes);
  app.use("/api/org", require("../routes/org"));
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

const api = async (method, p, body, as = ann) => {
  const headers = { "content-type": "application/json", cookie: "rr_token=" + signToken({ userId: as }) };
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};

const BASE = { name: "Pat Personal", currentRate: "6.5", loanBalance: "300000", propertyValue: "400000", loanType: "30yr_fixed",
  loanProgram: "conventional", closeDate: "2023-11-19" };
const PERSONAL = {
  birthday: "03-09", spouseName: "Daniel", spouseBirthday: "12-31", anniversary: "06-14", anniversaryYear: 2015,
  children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }], pets: "Biscuit", purchaseDate: "2019-08-02",
  referredBy: "Dana at Keystone Realty", preferredContact: "text", retirementYear: 2041,
};

test("migration: a client stored before the column has no personal details", () => {
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(migrated[0].personal, "");
});

test("POST with no personal details stores none and answers the empty shape", async () => {
  const r = await api("POST", "/api/clients", BASE);
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.data.client.personal, EMPTY);
  assert.strictEqual(clientRow(r.data.client.id).personal, "");
});

test("POST stores the personal details; GET sends them back", async () => {
  const r = await api("POST", "/api/clients", { ...BASE, personal: PERSONAL });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.data.client.personal, PERSONAL);
  assert.deepStrictEqual(JSON.parse(clientRow(r.data.client.id).personal), PERSONAL);
  const list = await api("GET", "/api/clients");
  assert.deepStrictEqual(list.data.clients[0].personal, PERSONAL);
});

test("a personal detail that does not read is refused, on create and on edit, and nothing is written", async () => {
  const badPost = await api("POST", "/api/clients", { ...BASE, personal: { ...PERSONAL, birthday: "02-30" } });
  assert.strictEqual(badPost.status, 400);
  assert.match(badPost.data.errors.personal, /birthday/i);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM clients").get().n, 0);

  const made = await api("POST", "/api/clients", { ...BASE, personal: PERSONAL });
  const id = made.data.client.id;
  const badPut = await api("PUT", `/api/clients/${id}`, { ...BASE, personal: { ...PERSONAL, children: [{ name: "", birthday: "01-05" }] } });
  assert.strictEqual(badPut.status, 400);
  assert.match(badPut.data.errors.personal, /child/i);
  assert.deepStrictEqual(JSON.parse(clientRow(id).personal), PERSONAL);
});

test("PUT changes the details, clears them with an empty set, and a save that does not send them keeps them", async () => {
  const made = await api("POST", "/api/clients", { ...BASE, personal: PERSONAL });
  const id = made.data.client.id;

  // a page opened before this shipped sends no `personal` key: nothing is wiped
  const oldPage = await api("PUT", `/api/clients/${id}`, { ...BASE, notes: "called" });
  assert.strictEqual(oldPage.status, 200);
  assert.deepStrictEqual(oldPage.data.client.personal, PERSONAL);

  const changed = await api("PUT", `/api/clients/${id}`, { ...BASE, personal: { ...PERSONAL, pets: "", children: [] } });
  assert.deepStrictEqual(changed.data.client.personal, { ...PERSONAL, pets: "", children: [] });

  const cleared = await api("PUT", `/api/clients/${id}`, { ...BASE, personal: {} });
  assert.deepStrictEqual(cleared.data.client.personal, EMPTY);
  assert.strictEqual(clientRow(id).personal, "");
});

test("personal details are not hand marks: editing them marks nothing for the import", async () => {
  const made = await api("POST", "/api/clients", BASE);
  const id = made.data.client.id;
  await api("PUT", `/api/clients/${id}`, { ...BASE, personal: PERSONAL });
  assert.strictEqual(clientRow(id).edited_by_hand, "");
});

test("an import of the same loan keeps the personal details", async () => {
  const made = await api("POST", "/api/clients", { ...BASE, personal: PERSONAL });
  const id = made.data.client.id;
  db.prepare("UPDATE clients SET loan_number = 'LPers1' WHERE id = ?").run(id);
  const fields = {
    firstName: "Pat", lastName: "Personal", email: "", phone: "", loanNumber: "LPers1", noteRate: "6.250%", loanAmount: "$300,000",
    term: "360", amortization: "Fixed", appraisedValue: "400000", closingDate: "11/19/2023", purpose: "Refinance", creditScore: "760",
    loanOfficer: "ann@personal.test", notes: "",
  };
  ingest(db, {
    actor: userRow(ann), source: "import", items: [{ row: fields, fields }], today: "2026-11-17",
    nowUtc: "2026-11-17 15:00:00", requireClosingDate: true, dryRun: false,
  });
  assert.strictEqual(clientRow(id).current_rate, 6.25, "the import did update the loan");
  assert.deepStrictEqual(JSON.parse(clientRow(id).personal), PERSONAL);
});

test("a loan officer's client in the broker's My Team view carries the details too", async () => {
  const made = await api("POST", "/api/clients", { ...BASE, personal: PERSONAL }, lou);
  assert.strictEqual(made.status, 201);
  const view = await api("GET", `/api/org/los/${lou}/clients`);
  assert.strictEqual(view.status, 200);
  assert.deepStrictEqual(view.data.clients[0].personal, PERSONAL);
});

test("nothing priced reads them: a client's sweep and upgrade view are the same with and without personal details", async () => {
  const plain = await api("POST", "/api/clients", { ...BASE, name: "Plain" });
  const full = await api("POST", "/api/clients", { ...BASE, name: "Plain", personal: PERSONAL });
  const strip = (c) => { const { id, personal, createdAt, updatedAt, ...rest } = c; return JSON.parse(JSON.stringify(rest).replaceAll(`"clientId":${id}`, '"clientId":0')); };
  assert.deepStrictEqual(strip(full.data.client), strip(plain.data.client));
  const rates = { rate_30yr_fixed: 5.5, rate_15yr_fixed: 4.9, rate_5_1_arm: 5.4, rate_30yr_top_tier: 5.4, source: "test" };
  const sweep = (id) => {
    const out = refi.runSweep([clientRow(id)], rates, new Date(Date.UTC(2026, 10, 17)));
    return JSON.parse(JSON.stringify(out).replaceAll(`"clientId":${id}`, '"clientId":0'));
  };
  assert.deepStrictEqual(sweep(full.data.client.id), sweep(plain.data.client.id));
});
