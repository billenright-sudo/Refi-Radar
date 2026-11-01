"use strict";
// The import's new columns and tables (db.js), the org-wide client matcher (lib/intake/match.js) and the loan officer router
// (lib/intake/owner.js), against a throwaway DB. The library functions are called directly, so there is no HTTP and no network.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-intake-match-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");

const db = require("../db");
const { findMatch, relation } = require("../lib/intake/match");
const { resolveOwner } = require("../lib/intake/owner");

after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first, last) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)"
).run(orgId, role, first, last, email).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email FROM users WHERE id = ?").get(id);

const orgA = addOrg("Alpha");
const orgB = addOrg("Beta");
const ann = addUser(orgA, "broker", "ann@a.test", "Ann", "Lee");
const lou = addUser(orgA, "lo", "lou@a.test", "Lou", "Park");
const lia = addUser(orgA, "lo", "lia@a.test", "Lia", "Chen");
addUser(orgA, "lo", "sam1@a.test", "Sam", "Lee");
addUser(orgA, "lo", "sam2@a.test", "Sam", "Lee");
const bea = addUser(orgB, "broker", "bea@b.test", "Bea", "Ng");

// A stored client. Only the fields a matcher cares about are settable; the money columns are required by the schema.
const addClient = (orgId, userId, name, f = {}) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, email, phone, loan_number, close_date, current_rate, loan_balance, property_value)
  VALUES (?, ?, ?, ?, ?, ?, ?, 6.5, 300000, 400000)
`).run(orgId, userId, name, f.email ?? "", f.phone ?? "", f.loan_number ?? "", f.close_date ?? "").lastInsertRowid);
const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
// An incoming record: John Smith with no email, phone or loan number unless the patch says otherwise.
const rec = (patch = {}) => ({
  name: "John Smith", email: "", phone: "", loanNumber: "", rate: 6.5, balance: 300000, balanceBasis: "given",
  propertyValue: 400000, loanType: "30yr_fixed", loanTypeGiven: false, closeDate: "", creditScore: null, purpose: "",
  loanOfficer: "", notes: "", ...patch,
});

test("migrations add loan_number ('') and source ('manual'), the org/loan index and integration_keys", () => {
  const id = Number(db.prepare(
    "INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (?, ?, 'Plain Client', 6, 1, 1)"
  ).run(orgA, ann).lastInsertRowid);
  const row = clientRow(id);
  assert.strictEqual(row.loan_number, "");
  assert.strictEqual(row.source, "manual");

  const indexes = db.prepare("PRAGMA index_list(clients)").all().map((i) => i.name);
  assert.ok(indexes.includes("idx_clients_org_loan"), `indexes: ${indexes.join(", ")}`);
  const indexCols = db.prepare("PRAGMA index_info(idx_clients_org_loan)").all().map((c) => c.name);
  assert.deepStrictEqual(indexCols, ["org_id", "loan_number"]);

  const cols = db.prepare("PRAGMA table_info(integration_keys)").all().map((c) => c.name);
  assert.deepStrictEqual(cols, ["user_id", "key_hash", "created_at", "last_used_at"]);
});

test("migrations upgrade an older database in place and a second start changes nothing", () => {
  // A database made before this change: a clients table without the new columns, and a client in it. db.js is started on it
  // twice in child processes (it opens its file at require time), and each start reports what the old row now holds.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-intake-legacy-"));
  try {
    const legacy = new Database(path.join(dir, "refi-radar.db"));
    legacy.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL,
        email TEXT DEFAULT '', phone TEXT DEFAULT '', loan_type TEXT NOT NULL DEFAULT '30yr_fixed', current_rate REAL NOT NULL,
        loan_balance REAL NOT NULL, property_value REAL NOT NULL, close_date TEXT DEFAULT '', credit_score INTEGER DEFAULT 700,
        notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (1, 1, 'Old Client', 6, 1, 1);
    `);
    legacy.close();
    const script = `
      const db = require(${JSON.stringify(path.join(__dirname, "..", "db.js"))});
      const row = db.prepare("SELECT loan_number, source FROM clients").get();
      const idx = db.prepare("PRAGMA index_list(clients)").all().filter((i) => i.name === "idx_clients_org_loan").length;
      const keys = db.prepare("PRAGMA table_info(integration_keys)").all().length;
      process.stdout.write(JSON.stringify({ row, idx, keys }));
    `;
    const run = () => JSON.parse(execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
    }));
    const expected = { row: { loan_number: "", source: "manual" }, idx: 1, keys: 4 };
    assert.deepStrictEqual(run(), expected);
    assert.deepStrictEqual(run(), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findMatch: loan number, then email, then name + phone, then a bare name; never another org", () => {
  const byLoan = addClient(orgA, ann, "Loan Owner", { loan_number: "A100" });
  const byEmail = addClient(orgA, ann, "Email Owner", { email: "john@x.com" });
  addClient(orgB, bea, "John Smith", { email: "john@x.com", loan_number: "A100" });
  const byPhone = addClient(orgA, lou, "Phone Owner", { phone: "(555) 123-4567" });
  const bare = addClient(orgA, ann, "Mary Jones");
  addClient(orgA, ann, "Mary Jones With Phone", { phone: "555-000-1111" });

  // 1. loan number, even when the name is different
  const one = findMatch(db, orgA, rec({ loanNumber: "A100", name: "Someone Else" }));
  assert.strictEqual(one.kind, "one");
  assert.strictEqual(one.client.id, byLoan);
  assert.strictEqual(one.client.org_id, orgA);

  // 2. email, case-insensitive, and org A's row rather than org B's
  const email = findMatch(db, orgA, rec({ email: "JOHN@X.COM", name: "Another Name" }));
  assert.strictEqual(email.kind, "one");
  assert.strictEqual(email.client.id, byEmail);
  assert.strictEqual(findMatch(db, orgB, rec({ email: "john@x.com" })).client.org_id, orgB);

  // 3. the same name and the same phone digits, whatever the stored punctuation
  const phone = findMatch(db, orgA, rec({ name: "phone  owner", phone: "5551234567" }));
  assert.strictEqual(phone.kind, "one");
  assert.strictEqual(phone.client.id, byPhone);
  assert.strictEqual(findMatch(db, orgA, rec({ name: "Phone Owner", phone: "+1 555 123 4567" })).client.id, byPhone);
  // the name alone is not enough for a stored client that has a phone, and the wrong phone is not a match
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Phone Owner" })), { kind: "none" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Phone Owner", phone: "5559999999" })), { kind: "none" });

  // 4. a bare stored client matches on the name alone, spacing and case aside
  const name = findMatch(db, orgA, rec({ name: "mary  jones" }));
  assert.strictEqual(name.kind, "one");
  assert.strictEqual(name.client.id, bare);
  // a stored "Mary Jones" that has a phone is not matched by name alone
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Mary Jones With Phone" })), { kind: "none" });

  // another org's client is never found, by loan number, email or name
  assert.deepStrictEqual(findMatch(db, orgB, rec({ loanNumber: "ZZZ" })), { kind: "none" });
  assert.deepStrictEqual(findMatch(db, orgB, rec({ name: "Mary Jones" })), { kind: "none" });
  assert.strictEqual(findMatch(db, orgA, rec({ name: "Nobody Atall" })).kind, "none");
});

test("findMatch: the first step that finds any client decides, even when a later step would find another", () => {
  const byLoan = addClient(orgA, ann, "Step One", { loan_number: "C300" });
  addClient(orgA, ann, "Step Two", { email: "step@two.com" });
  const r = findMatch(db, orgA, rec({ loanNumber: "C300", email: "step@two.com", name: "Step Two" }));
  assert.strictEqual(r.kind, "one");
  assert.strictEqual(r.client.id, byLoan);
  // a blank field never matches a blank field: a record with no email or loan number does not find every bare client
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "" })), { kind: "none" });
});

test("findMatch: two at the first step that finds any is ambiguous; two same-name clients with one bare is ambiguous", () => {
  addClient(orgA, ann, "Dup One", { loan_number: "B200" });
  addClient(orgA, lou, "Dup Two", { loan_number: "B200" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ loanNumber: "B200" })), { kind: "ambiguous", count: 2 });

  addClient(orgA, ann, "Shared Mail One", { email: "same@mail.com" });
  addClient(orgA, lou, "Shared Mail Two", { email: "same@mail.com" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ email: "same@mail.com" })), { kind: "ambiguous", count: 2 });

  addClient(orgA, ann, "Pat Kim");
  addClient(orgA, lou, "Pat Kim", { email: "pat@kim.com" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Pat Kim" })), { kind: "ambiguous", count: 2 });
  // the same two, but the record's own email picks the one who has it (step 2 decides before the name is looked at)
  assert.strictEqual(findMatch(db, orgA, rec({ name: "Pat Kim", email: "pat@kim.com" })).kind, "one");

  // two same-name clients and neither bare: the name alone finds nothing
  addClient(orgA, ann, "Lee Wong", { phone: "555-111-2222" });
  addClient(orgA, lou, "Lee Wong", { email: "lee@wong.com" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Lee Wong" })), { kind: "none" });
  // two with the same name and the same phone are ambiguous at step 3
  addClient(orgA, ann, "Kay Ito", { phone: "555-333-4444" });
  addClient(orgA, lou, "Kay Ito", { phone: "(555) 333-4444" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Kay Ito", phone: "5553334444" })), { kind: "ambiguous", count: 2 });
});

test("relation: same, refinance, second property, older, and the one-sided loan number rule", () => {
  const stored = (loan_number, close_date) => ({ loan_number, close_date });
  const inc = (loanNumber, closeDate, purpose = "") => rec({ loanNumber, closeDate, purpose });

  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("A100", "2024-02-01")), "same");
  assert.strictEqual(relation(stored("", "2021-05-01"), inc("", "2024-02-01")), "same");
  assert.strictEqual(relation(stored("", ""), inc("", "")), "same");

  // one side has a loan number: the same loan when the closing dates agree or either is missing
  assert.strictEqual(relation(stored("", "2021-05-01"), inc("B1", "2021-05-01")), "same");
  assert.strictEqual(relation(stored("", ""), inc("B1", "2021-05-01")), "same");
  assert.strictEqual(relation(stored("", "2021-05-01"), inc("B1", "")), "same");
  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("", "2021-05-01")), "same");
  // ... and otherwise the "differ" rules apply
  assert.strictEqual(relation(stored("", "2021-05-01"), inc("B1", "2024-02-01")), "refinance");
  assert.strictEqual(relation(stored("", "2024-02-01"), inc("B1", "2021-05-01")), "older");

  // both numbers present and different
  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("B1", "2024-02-01")), "refinance");
  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("B1", "2024-02-01", "purchase")), "second_property");
  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("B1", "2024-02-01", "refinance")), "refinance");
  assert.strictEqual(relation(stored("A100", "2024-02-01"), inc("B1", "2021-05-01")), "older");
  assert.strictEqual(relation(stored("A100", "2024-02-01"), inc("B1", "2021-05-01", "purchase")), "older");
  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("B1", "2021-05-01")), "refinance");
  // a closing date missing on either side is a refinance, or a second property for a purchase (R3)
  assert.strictEqual(relation(stored("A100", "2021-05-01"), inc("B1", "")), "refinance");
  assert.strictEqual(relation(stored("A100", ""), inc("B1", "2021-05-01")), "refinance");
  assert.strictEqual(relation(stored("A100", ""), inc("B1", "", "purchase")), "second_property");
  // a stored date that is not a calendar date counts as missing, never as earlier or later
  assert.strictEqual(relation(stored("A100", "last spring"), inc("B1", "2021-05-01")), "refinance");
});

test("resolveOwner: email, unique full name, fallback with a flag, other org, LO actor", () => {
  const broker = userRow(ann);
  const noMatch = (v) => `routed to your book: no loan officer in your company matches "${v}"`;

  assert.deepStrictEqual(resolveOwner(db, broker, ""), { id: ann, name: "Ann Lee", named: false, flag: null });
  assert.deepStrictEqual(resolveOwner(db, broker, "   "), { id: ann, name: "Ann Lee", named: false, flag: null });
  assert.deepStrictEqual(resolveOwner(db, broker, undefined), { id: ann, name: "Ann Lee", named: false, flag: null });

  assert.deepStrictEqual(resolveOwner(db, broker, "LOU@A.TEST"), { id: lou, name: "Lou Park", named: true, flag: null });
  assert.deepStrictEqual(resolveOwner(db, broker, "lia  chen"), { id: lia, name: "Lia Chen", named: true, flag: null });
  assert.deepStrictEqual(resolveOwner(db, broker, "  LIA CHEN "), { id: lia, name: "Lia Chen", named: true, flag: null });

  assert.deepStrictEqual(resolveOwner(db, broker, "Nobody"), { id: ann, name: "Ann Lee", named: false, flag: noMatch("Nobody") });
  // another company's user, by email or by name, is not one of ours
  assert.deepStrictEqual(resolveOwner(db, broker, "bea@b.test"), { id: ann, name: "Ann Lee", named: false, flag: noMatch("bea@b.test") });
  assert.deepStrictEqual(resolveOwner(db, broker, "Bea Ng"), { id: ann, name: "Ann Lee", named: false, flag: noMatch("Bea Ng") });
  // two loan officers share a name: it names nobody in particular
  assert.deepStrictEqual(resolveOwner(db, broker, "Sam Lee"), { id: ann, name: "Ann Lee", named: false, flag: noMatch("Sam Lee") });
  // but either of them is reachable by email
  assert.strictEqual(resolveOwner(db, broker, "sam2@a.test").named, true);

  // a loan officer's own import is always their own book, whoever the row names
  assert.deepStrictEqual(resolveOwner(db, userRow(lou), "lia@a.test"), { id: lou, name: "Lou Park", named: true, flag: null });
  assert.deepStrictEqual(resolveOwner(db, userRow(lou), ""), { id: lou, name: "Lou Park", named: true, flag: null });

  // org B's broker is routed within org B only
  assert.deepStrictEqual(resolveOwner(db, userRow(bea), "lou@a.test"), {
    id: bea, name: "Bea Ng", named: false, flag: noMatch("lou@a.test"),
  });
});
