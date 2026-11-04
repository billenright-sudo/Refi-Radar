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
const { findMatch, createMatchIndex, relation } = require("../lib/intake/match");
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

test("migrations add loan_number (''), source ('manual') and edited_by_hand (''), the org/loan index and integration_keys", () => {
  const id = Number(db.prepare(
    "INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (?, ?, 'Plain Client', 6, 1, 1)"
  ).run(orgA, ann).lastInsertRowid);
  const row = clientRow(id);
  assert.strictEqual(row.loan_number, "");
  assert.strictEqual(row.source, "manual");
  assert.strictEqual(row.edited_by_hand, "");

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
      const row = db.prepare("SELECT loan_number, source, edited_by_hand FROM clients").get();
      const idx = db.prepare("PRAGMA index_list(clients)").all().filter((i) => i.name === "idx_clients_org_loan").length;
      const keys = db.prepare("PRAGMA table_info(integration_keys)").all().length;
      process.stdout.write(JSON.stringify({ row, idx, keys }));
    `;
    const run = () => JSON.parse(execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
    }));
    const expected = { row: { loan_number: "", source: "manual", edited_by_hand: "" }, idx: 1, keys: 4 };
    assert.deepStrictEqual(run(), expected);
    assert.deepStrictEqual(run(), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findMatch: loan number, then email, then name + phone, then the name alone; never another org", () => {
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
  // a match before step 4 does not say how it was found; the wrong phone is somebody else
  assert.strictEqual(phone.by, undefined);
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Phone Owner", phone: "5559999999" })), { kind: "none" });

  // 4. the name alone, spacing and case aside, and the result says it was the name alone
  const name = findMatch(db, orgA, rec({ name: "mary  jones" }));
  assert.strictEqual(name.kind, "one");
  assert.strictEqual(name.client.id, bare);
  assert.strictEqual(name.by, "name");
  // (Bill, 2026-11-03) a stored client with a phone is found by the name alone when the record has no phone to disagree
  const noPhone = findMatch(db, orgA, rec({ name: "Phone Owner" }));
  assert.deepStrictEqual([noPhone.kind, noPhone.client.id, noPhone.by], ["one", byPhone, "name"]);

  // another org's client is never found, by loan number, email or name
  assert.deepStrictEqual(findMatch(db, orgB, rec({ name: "Nobody Here", loanNumber: "ZZZ" })), { kind: "none" });
  assert.deepStrictEqual(findMatch(db, orgB, rec({ name: "Mary Jones" })), { kind: "none" });
  assert.strictEqual(findMatch(db, orgA, rec({ name: "Nobody Atall" })).kind, "none");
});

test("findMatch: names compare through nameKey on both sides (accents, case, inner spacing)", () => {
  const accented = addClient(orgA, ann, "Álvarez Ortiz");
  const shouting = addClient(orgA, ann, "JOSÉ GARCIA", { phone: "(555) 222-3333" });
  const spaced = addClient(orgA, lou, "  Dee   Fox ");
  addClient(orgB, bea, "Zoë Quinn");

  // step 4: a bare stored name, matched whatever the accent's case or the spacing
  const bare = findMatch(db, orgA, rec({ name: "ÁLVAREZ  ORTIZ" }));
  assert.strictEqual(bare.kind, "one");
  assert.strictEqual(bare.client.id, accented);
  assert.strictEqual(findMatch(db, orgA, rec({ name: "álvarez ortiz" })).client.id, accented);
  // a different accent is a different name
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Alvarez Ortiz" })), { kind: "none" });

  // step 3: the stored name is upper-case with an accent, the incoming one is not; the phone digits agree
  const withPhone = findMatch(db, orgA, rec({ name: "José Garcia", phone: "5552223333" }));
  assert.strictEqual(withPhone.kind, "one");
  assert.strictEqual(withPhone.client.id, shouting);
  // step 4: with no phone in the record nothing disagrees, so the name alone finds the same client
  assert.strictEqual(findMatch(db, orgA, rec({ name: "José Garcia" })).client.id, shouting);

  // a stored name with extra spaces inside and around it
  const found = findMatch(db, orgA, rec({ name: "dee fox" }));
  assert.strictEqual(found.kind, "one");
  assert.strictEqual(found.client.id, spaced);

  // still only the importer's own company
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "ZOË QUINN" })), { kind: "none" });
  assert.strictEqual(findMatch(db, orgB, rec({ name: "ZOË QUINN" })).kind, "one");
});

test("findMatch: the name function is registered once per connection and works on any connection it is given", () => {
  const other = new Database(":memory:");
  try {
    other.exec("CREATE TABLE clients (id INTEGER PRIMARY KEY, org_id INTEGER, name TEXT, email TEXT, phone TEXT, loan_number TEXT, close_date TEXT)");
    other.prepare("INSERT INTO clients (org_id, name, email, phone, loan_number) VALUES (1, 'ÉLODIE  Roy', '', '', '')").run();
    for (let i = 0; i < 2; i++) assert.strictEqual(findMatch(other, 1, rec({ name: "élodie roy" })).kind, "one");
    assert.strictEqual(findMatch(other, 2, rec({ name: "élodie roy" })).kind, "none");
  } finally {
    other.close();
  }
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

test("findMatch: two at the first step that finds any is ambiguous; so are two same-name clients the record can't tell apart", () => {
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

  // two same-name clients, neither bare, and nothing in the record that disagrees with either: ambiguous
  addClient(orgA, ann, "Lee Wong", { phone: "555-111-2222" });
  addClient(orgA, lou, "Lee Wong", { email: "lee@wong.com" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Lee Wong" })), { kind: "ambiguous", count: 2 });
  // two with the same name and the same phone are ambiguous at step 3
  addClient(orgA, ann, "Kay Ito", { phone: "555-333-4444" });
  addClient(orgA, lou, "Kay Ito", { phone: "(555) 333-4444" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Kay Ito", phone: "5553334444" })), { kind: "ambiguous", count: 2 });
});

test("findMatch step 4 (Bill, 2026-11-03): the name alone finds a client unless their own email or phone disagrees", () => {
  // a refinance in a file of names and loan numbers: the client has the old loan's number, the record a new one
  const numbered = addClient(orgA, ann, "Nia Ross", { loan_number: "N100", close_date: "2020-01-01" });
  const refi = findMatch(db, orgA, rec({ name: "Nia Ross", loanNumber: "N200" }));
  assert.deepStrictEqual([refi.kind, refi.client.id, refi.by], ["one", numbered, "name"]);

  // a client typed in with a phone and no email, and a record with an email and no phone
  const typed = addClient(orgA, lou, "Omar Diaz", { phone: "555-444-1000" });
  const byName = findMatch(db, orgA, rec({ name: "Omar Diaz", email: "omar@diaz.test" }));
  assert.deepStrictEqual([byName.kind, byName.client.id, byName.by], ["one", typed, "name"]);
  // a different phone in the record says it is somebody else
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Omar Diaz", phone: "555-444-2000" })), { kind: "none" });

  // a different email on the stored client says it is somebody else
  addClient(orgA, ann, "Ida Park", { email: "ida@one.test" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Ida Park", email: "ida@two.test" })), { kind: "none" });

  // of two same-name clients, the one whose email disagrees drops out and the other is the match
  addClient(orgA, ann, "Ray Holt", { email: "ray@old.test" });
  const ray = addClient(orgA, lou, "Ray Holt", { phone: "555-777-0000" });
  const one = findMatch(db, orgA, rec({ name: "Ray Holt", email: "ray@new.test" }));
  assert.deepStrictEqual([one.kind, one.client.id, one.by], ["one", ray, "name"]);

  // a match index gives the same answers
  const index = createMatchIndex(db, orgA);
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Ray Holt", email: "ray@new.test" }), index), one);
  assert.deepStrictEqual(findMatch(db, orgA, rec({ name: "Ida Park", email: "ida@two.test" }), index), { kind: "none" });
});

test("findMatch with a match index answers exactly what the DB does, and refresh() keeps it current", () => {
  // Stored values that SQLite and JavaScript would read differently: SQL trim() drops spaces only and lower() folds only ASCII.
  addClient(orgA, ann, "Idx Mixed", { email: "  MIXED@Case.Test " });
  addClient(orgA, ann, "Idx Accent", { email: "JOSÉ@X.TEST" });
  addClient(orgA, ann, "Idx Tab", { email: "\ttab@x.test" });
  addClient(orgA, ann, "Idx Lower Loan", { loan_number: "z100x" });
  addClient(orgA, lou, "Idx  Twin");
  addClient(orgA, lia, "idx twin", { phone: "555-777-8888" });

  // Every record the tests above used, and the edge cases just added, for both companies (the DB holds every earlier test's clients).
  const records = [
    {}, { name: "" }, { loanNumber: "A100", name: "Someone Else" }, { email: "JOHN@X.COM", name: "Another Name" }, { email: "john@x.com" },
    { name: "phone  owner", phone: "5551234567" }, { name: "Phone Owner", phone: "+1 555 123 4567" }, { name: "Phone Owner" },
    { name: "Phone Owner", phone: "5559999999" }, { name: "mary  jones" }, { name: "Mary Jones With Phone" }, { loanNumber: "ZZZ" },
    { name: "Mary Jones" }, { name: "Nobody Atall" }, { name: "ÁLVAREZ  ORTIZ" }, { name: "Alvarez Ortiz" }, { name: "José Garcia", phone: "5552223333" },
    { name: "José Garcia" }, { name: "dee fox" }, { name: "ZOË QUINN" }, { loanNumber: "C300", email: "step@two.com", name: "Step Two" },
    { loanNumber: "B200" }, { email: "same@mail.com" }, { name: "Pat Kim" }, { name: "Pat Kim", email: "pat@kim.com" }, { name: "Lee Wong" },
    { name: "Kay Ito", phone: "5553334444" }, { email: "mixed@case.test" }, { email: "josé@x.test" }, { email: "JOSÉ@X.TEST" },
    { email: "tab@x.test", name: "Idx Tab" }, { loanNumber: "Z100X" }, { loanNumber: " z100x ", name: "Idx Lower Loan" },
    { name: "IDX TWIN" }, { name: "idx twin", phone: "5557778888" },
  ].map(rec);
  for (const orgId of [orgA, orgB]) {
    const index = createMatchIndex(db, orgId);
    for (const r of records) assert.deepStrictEqual(findMatch(db, orgId, r, index), findMatch(db, orgId, r), `${orgId} ${JSON.stringify(r)}`);
  }

  // A client written after the index was made is found once the run refreshes it, as the DB now holds it.
  const index = createMatchIndex(db, orgA);
  const late = addClient(orgA, ann, "Idx Late", { email: "late@x.test" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ email: "late@x.test" }), index), { kind: "none" });
  index.refresh(late);
  assert.strictEqual(findMatch(db, orgA, rec({ email: "late@x.test" }), index).client.id, late);
  db.prepare("UPDATE clients SET email = 'later@x.test', phone = '5550001111' WHERE id = ?").run(late);
  index.refresh(late);
  assert.deepStrictEqual(findMatch(db, orgA, rec({ email: "late@x.test", name: "Nobody" }), index), { kind: "none" });
  assert.deepStrictEqual(findMatch(db, orgA, rec({ email: "later@x.test" }), index), findMatch(db, orgA, rec({ email: "later@x.test" })));
  assert.strictEqual(findMatch(db, orgA, rec({ name: "idx late", phone: "555-000-1111" }), index).client.phone, "5550001111");
  // another company's client is never filed, and an index is only ever used for its own company
  const theirs = addClient(orgB, bea, "Idx Late", { email: "late2@x.test" });
  index.refresh(theirs);
  assert.deepStrictEqual(findMatch(db, orgA, rec({ email: "late2@x.test" }), index), { kind: "none" });
  assert.throws(() => findMatch(db, orgB, rec({ email: "late2@x.test" }), index), TypeError);
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
  // a stored date that is not a calendar date counts as missing, never as earlier or later (read by shape alone, "2021-13-45"
  // would sort after the incoming date and "2021-02-30" before it)
  assert.strictEqual(relation(stored("A100", "last spring"), inc("B1", "2021-05-01")), "refinance");
  assert.strictEqual(relation(stored("A100", "2021-13-45"), inc("B1", "2021-05-01")), "refinance");
  assert.strictEqual(relation(stored("A100", "2021-02-30"), inc("B1", "2021-01-15")), "refinance");
  assert.strictEqual(relation(stored("A100", "2021-02-30"), inc("B1", "2021-01-15", "purchase")), "second_property");
  // ... so with one loan number missing the other side's date cannot show a difference, and it is the same loan
  assert.strictEqual(relation(stored("", "2021-13-45"), inc("B1", "2024-02-01")), "same");
  // a real stored date with a time on the end still reads as that day
  assert.strictEqual(relation(stored("A100", "2024-02-29T00:00:00"), inc("B1", "2021-05-01")), "older");
  // a stored date the old importer kept as typed is read the way an imported row is: "3/14/2024" or the Excel serial 45365
  assert.strictEqual(relation(stored("", "3/14/2024"), inc("B1", "2024-03-14")), "same");
  assert.strictEqual(relation(stored("", "3/14/2024"), inc("B1", "2024-05-01")), "refinance");
  assert.strictEqual(relation(stored("A1", "3/14/2024"), inc("B1", "2021-01-01")), "older");
  assert.strictEqual(relation(stored("A1", "45365"), inc("B1", "2021-01-01")), "older");
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
