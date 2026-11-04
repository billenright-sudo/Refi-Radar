"use strict";
// ingest() (lib/intake/ingest.js), the one write the file import and the ARIVE feed share, against a throwaway DB: new clients,
// refreshed loans, older loans and second properties, repeats inside one file, the dry-run review and its hash, and the A6a move
// of a client to the loan officer on their new loan. The library is called directly, so there is no HTTP and no network.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-intake-ingest-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const db = require("../db");
const followups = require("../lib/assistant/followups");
const { toRecord } = require("../lib/intake/record");
const { ingest } = require("../lib/intake/ingest");

after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => {
  for (const table of ["notifications", "charlie_recommendations", "contact_log", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first, last) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)"
).run(orgId, role, first, last, email).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT id, org_id, role, first_name, last_name, email FROM users WHERE id = ?").get(id);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.test", "Ann", "Lee");
const lou = addUser(orgA, "lo", "lou@a.test", "Lou", "Park");
const lia = addUser(orgA, "lo", "lia@a.test", "Lia", "Chen");

const TODAY = "2026-11-01";
const NOW = "2026-11-01 15:00:00";
const ROW = { firstName: "John", lastName: "Smith", email: "John@X.com", phone: "(555) 123-4567", loanNumber: "a100", noteRate: "6.500%", loanAmount: "$400,000", term: "360", amortization: "Fixed", appraisedValue: "520000", closingDate: "3/14/2024", purpose: "Refinance", creditScore: "742", loanOfficer: "lou@a.test", notes: " met at open house " };
const ESTIMATED = "balance estimated from the loan schedule";

const item = (row, patch = {}) => ({ row, fields: { ...ROW, ...patch } });
const run = (items, opts = {}) => ingest(db, {
  actor: userRow(ann), source: "import", items, today: TODAY, nowUtc: NOW, requireClosingDate: true, dryRun: false, ...opts,
});

// A stored client: John Smith with ROW's email and ROW's loan as of today (A100, 6.5%, closed 2024-03-14) unless the patch says
// otherwise, in `userId`'s book.
const addClient = (userId, f = {}) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, email, phone, loan_number, loan_type, current_rate, loan_balance, property_value,
                       close_date, credit_score, notes, last_contact)
  VALUES (@org_id, @user_id, @name, @email, @phone, @loan_number, @loan_type, @current_rate, @loan_balance, @property_value,
          @close_date, @credit_score, @notes, @last_contact)
`).run({
  org_id: orgA, user_id: userId, name: "John Smith", email: "john@x.com", phone: "(555) 123-4567", loan_number: "A100",
  loan_type: "30yr_fixed", current_rate: 6.5, loan_balance: 387830, property_value: 520000, close_date: "2024-03-14",
  credit_score: 742, notes: "", last_contact: null, ...f,
}).lastInsertRowid);
const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
const allClients = () => db.prepare("SELECT * FROM clients ORDER BY id").all();
const addRec = (userId, clientId, source, day, status = "open", resolvedAt = null) => Number(db.prepare(
  "INSERT INTO charlie_recommendations (user_id, client_id, day, source, status, resolved_at) VALUES (?, ?, ?, ?, ?, ?)"
).run(userId, clientId, day, source, status, resolvedAt).lastInsertRowid);
const recRow = (id) => db.prepare("SELECT user_id, status, resolved_at FROM charlie_recommendations WHERE id = ?").get(id);
const addCall = (userId, clientId) => Number(db.prepare(
  "INSERT INTO contact_log (client_id, user_id, at, outcome, notes) VALUES (?, ?, '2026-10-01 17:00:00', 'reached', 'talked rates')"
).run(clientId, userId).lastInsertRowid);
const tables = () => ({
  clients: allClients(),
  notifications: db.prepare("SELECT * FROM notifications ORDER BY id").all(),
  recs: db.prepare("SELECT * FROM charlie_recommendations ORDER BY id").all(),
  calls: db.prepare("SELECT * FROM contact_log ORDER BY id").all(),
});
const outcomes = (r) => r.results.map((x) => [x.row, x.outcome]);
// A refinance of ROW's loan: a new loan number, closed this year at today's rates.
const REFI = { loanNumber: "B200", closingDate: "3/2/2026", noteRate: "6.25", purpose: "Refinance" };

test("a new loan creates a client in the routed book, with source, loan number and notes, and no last contact", () => {
  const r = run([item(2)]);
  assert.deepStrictEqual(r.results, [{
    row: 2, outcome: "created", name: "John Smith", reason: null, note: null, flags: [ESTIMATED],
    owner: { id: lou, name: "Lou Park" }, movedFrom: null,
  }]);
  const rows = allClients();
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert.equal(c.org_id, orgA);
  assert.equal(c.user_id, lou);
  assert.equal(c.name, "John Smith");
  assert.equal(c.email, "john@x.com");
  assert.equal(c.phone, "(555) 123-4567");
  assert.equal(c.loan_number, "A100");
  assert.equal(c.source, "import");
  assert.equal(c.notes, "met at open house");
  assert.equal(c.last_contact, null);
  assert.equal(c.loan_balance, 387830);
  assert.equal(c.current_rate, 6.5);
  assert.equal(c.property_value, 520000);
  assert.equal(c.loan_type, "30yr_fixed");
  assert.equal(c.close_date, "2024-03-14");
  assert.equal(c.credit_score, 742);
  assert.deepStrictEqual(r.counts, {
    created: 1, updated: 0, unchanged: 0, ambiguous: 0, skipped: 0, moved: 0, byOwner: [{ id: lou, name: "Lou Park", rows: 1 }],
  });
  const expected = crypto.createHash("sha256")
    .update(JSON.stringify(r.results.map((x) => [x.row, x.outcome, x.reason, x.note, x.owner && x.owner.id, x.movedFrom])))
    .digest("hex");
  assert.equal(r.reviewHash, expected);
});

test("a row with no credit score is stored at 700, and the arive source is recorded", () => {
  run([item(2, { creditScore: "" })], { source: "arive" });
  const c = allClients()[0];
  assert.equal(c.credit_score, 700);
  assert.equal(c.source, "arive");
});

test("the same file again is all unchanged and writes nothing", () => {
  const items = [
    item(2),
    item(3, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", phone: "", loanNumber: "a200", loanOfficer: "lia@a.test" }),
    item(4, { firstName: "Bob", lastName: "Ray", email: "bob@x.com", phone: "", loanNumber: "", term: "", amortization: "", loanOfficer: "" }),
  ];
  assert.deepStrictEqual(outcomes(run(items)), [[2, "created"], [3, "created"], [4, "created"]]);
  // Backdate every row so that any write at all (even within this second) would show in updated_at.
  db.prepare("UPDATE clients SET updated_at = '2000-01-01 00:00:00'").run();
  const before = allClients();

  const again = run(items);
  assert.deepStrictEqual(outcomes(again), [[2, "unchanged"], [3, "unchanged"], [4, "unchanged"]]);
  assert.deepStrictEqual(allClients(), before);
  assert.deepStrictEqual(again.counts.byOwner, [
    { id: ann, name: "Ann Lee", rows: 1 }, { id: lia, name: "Lia Chen", rows: 1 }, { id: lou, name: "Lou Park", rows: 1 },
  ]);
});

test("a refinance replaces the loan, keeps the client, and never touches name, notes, last contact or the call log", () => {
  const id = addClient(lou, { close_date: "2021-05-01", current_rate: 3.0, loan_balance: 350000, notes: "VIP", last_contact: "2026-09-01" });
  addCall(lou, id);
  const callsBefore = tables().calls;

  const r = run([item(2, REFI)]);
  assert.deepStrictEqual(r.results, [{
    row: 2, outcome: "updated", name: "John Smith", reason: null, note: null, flags: [ESTIMATED],
    owner: { id: lou, name: "Lou Park" }, movedFrom: null,
  }]);
  const rows = allClients();
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert.equal(c.id, id);
  assert.equal(c.current_rate, 6.25);
  assert.equal(c.loan_number, "B200");
  assert.equal(c.close_date, "2026-03-02");
  const reestimated = toRecord({ ...ROW, ...REFI }, { today: TODAY }).record.balance;
  assert.notEqual(reestimated, 350000);
  assert.equal(c.loan_balance, reestimated);
  assert.equal(c.name, "John Smith");
  assert.equal(c.notes, "VIP");
  assert.equal(c.last_contact, "2026-09-01");
  assert.equal(c.source, "manual");
  assert.deepStrictEqual(tables().calls, callsBefore);
});

test("the same loan: an estimate never overwrites a stored balance; a current balance does", () => {
  const id = addClient(lou, { loan_balance: 380000 });
  const estimate = run([item(2)]);
  assert.deepStrictEqual(outcomes(estimate), [[2, "unchanged"]]);
  assert.deepStrictEqual(estimate.results[0].owner, { id: lou, name: "Lou Park" });
  assert.equal(clientRow(id).loan_balance, 380000);

  const given = run([item(2, { currentBalance: "379,500" })]);
  assert.deepStrictEqual(outcomes(given), [[2, "updated"]]);
  assert.equal(clientRow(id).loan_balance, 379500);
});

test("a close date the old importer stored as typed is the same day, so the balance stays and only the date is tidied", () => {
  const id = addClient(lou, { close_date: "3/14/2024", loan_balance: 380000 });
  const r = run([item(2)]);
  assert.deepStrictEqual(outcomes(r), [[2, "updated"]]);
  assert.equal(clientRow(id).close_date, "2024-03-14");
  assert.equal(clientRow(id).loan_balance, 380000);
  // A closing date that really differs is a changed loan, so the estimate replaces the stored balance.
  db.prepare("UPDATE clients SET close_date = '3/14/2023' WHERE id = ?").run(id);
  run([item(2)]);
  assert.equal(clientRow(id).loan_balance, 387830);
});

test("email and phone are filled only where blank; loan type is kept when the row gives none", () => {
  const id = addClient(lou, { email: "old@x.com", phone: "", loan_type: "15yr_fixed" });
  const r = run([item(2, { email: "new@x.com", term: "", amortization: "" })]);
  assert.deepStrictEqual(outcomes(r), [[2, "updated"]]);
  const c = clientRow(id);
  assert.equal(c.email, "old@x.com");
  assert.equal(c.phone, "(555) 123-4567");
  assert.equal(c.loan_type, "15yr_fixed");
  // The row's balance is only the original amount, and the loan is the same, so the stored balance stays.
  assert.equal(c.loan_balance, 387830);
});

test("an older loan is unchanged with the note; a purchase with a different loan number is a second client", () => {
  const id = addClient(lou);
  const before = clientRow(id);
  const r = run([
    item(2, { loanNumber: "A050", closingDate: "2019-01-01" }),
    item(3, { loanNumber: "C300", closingDate: "2026-04-01", purpose: "Purchase" }),
  ]);
  assert.deepStrictEqual(r.results.map((x) => ({ row: x.row, outcome: x.outcome, note: x.note, owner: x.owner })), [
    { row: 2, outcome: "unchanged", note: "older loan", owner: { id: lou, name: "Lou Park" } },
    { row: 3, outcome: "created", note: "second property", owner: { id: lou, name: "Lou Park" } },
  ]);
  const johns = db.prepare("SELECT * FROM clients WHERE name = 'John Smith' ORDER BY id").all();
  assert.equal(johns.length, 2);
  assert.deepStrictEqual(johns[0], before);
  assert.equal(johns[1].loan_number, "C300");
  assert.equal(johns[1].user_id, lou);
});

test("a refinance listed beside its original in one file: one client, holding the newer loan", () => {
  const r = run([
    item(2, { loanNumber: "B200", closingDate: "2024-02-01", noteRate: "6.0" }),
    item(3, { loanNumber: "A100", closingDate: "2020-01-01", noteRate: "3.0" }),
  ]);
  const rows = allClients();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].loan_number, "B200");
  assert.equal(rows[0].current_rate, 6.0);
  assert.equal(rows[0].close_date, "2024-02-01");
  assert.deepStrictEqual(outcomes(r), [[2, "updated"], [3, "created"]]);
});

test("the same loan listed twice in one export: one client, the second row unchanged", () => {
  const r = run([item(2), item(3)]);
  assert.deepStrictEqual(outcomes(r), [[2, "created"], [3, "unchanged"]]);
  assert.equal(allClients().length, 1);
});

test("a client this run created or changed is matched by later rows as the run left it: by email, and by a bare name", () => {
  // by email alone: a refinance under another spelling of the name, with a new loan number and no phone
  const byEmail = run([item(2), item(3, { ...REFI, firstName: "Johnny", phone: "" })]);
  assert.deepStrictEqual(outcomes(byEmail), [[2, "created"], [3, "updated"]]);
  assert.deepStrictEqual(allClients().map((c) => [c.name, c.loan_number]), [["John Smith", "B200"]]);

  db.prepare("DELETE FROM clients").run();
  const bare = { firstName: "Bea", lastName: "Bare", email: "", phone: "", loanNumber: "", loanOfficer: "", closingDate: "1/5/2024" };
  const r = run([
    item(2, bare),
    item(3, { ...bare, noteRate: "6.25" }),                         // the bare client, by name alone
    item(4, { ...bare, noteRate: "6.25", email: "bea@bare.test" }),  // by name alone again, and fills the blank email
    item(5, { ...bare, firstName: "B.", email: "bea@bare.test" }),   // by the email row 4 gave her
    item(6, { ...bare, noteRate: "6.25" }),                          // she has an email now, but row 6 gives none to disagree (Bill 11/3)
  ]);
  assert.deepStrictEqual(outcomes(r), [[2, "created"], [3, "updated"], [4, "updated"], [5, "updated"], [6, "updated"]]);
  assert.deepStrictEqual(allClients().map((c) => [c.name, c.email, c.current_rate]), [["Bea Bare", "bea@bare.test", 6.25]]);
});

test("a 5,000-row first import (every row new) is reviewed in under 3 seconds", () => {
  const items = Array.from({ length: 5000 }, (_, i) => item(i + 2, {
    firstName: `Person${i}`, lastName: `Number${i}`, email: `p${i}@x.test`, phone: `555${String(i).padStart(7, "0")}`, loanNumber: `N${i}`,
  }));
  const start = process.hrtime.bigint();
  const r = run(items, { dryRun: true });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(r.counts.created, 5000);
  assert.equal(allClients().length, 0);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

test("ambiguous rows write nothing; front-door skips and record failures are skipped with their reason", () => {
  addClient(lou, { loan_number: "" });
  addClient(lia, { loan_number: "" });
  const before = allClients();
  const r = run([
    item(2),
    { row: 3, fields: { ...ROW }, skip: "not funded" },
    item(4, { noteRate: "N/A" }),
    item(5, { closingDate: "" }),
  ]);
  const blank = { note: null, flags: [], owner: null, movedFrom: null };
  assert.deepStrictEqual(r.results, [
    { row: 2, outcome: "ambiguous", name: "John Smith", reason: "matched 2 clients", ...blank },
    { row: 3, outcome: "skipped", name: "John Smith", reason: "not funded", ...blank },
    { row: 4, outcome: "skipped", name: "John Smith", reason: "no note rate between 0 and 20", ...blank },
    { row: 5, outcome: "skipped", name: "John Smith", reason: "not funded yet", ...blank },
  ]);
  assert.deepStrictEqual(allClients(), before);
  assert.deepStrictEqual(r.counts, { created: 0, updated: 0, unchanged: 0, ambiguous: 1, skipped: 3, moved: 0, byOwner: [] });
});

test("the routed-to-your-book flag goes only on a row that creates a client in the broker's book", () => {
  const routed = 'routed to your book: no loan officer in your company matches "Nobody"';
  const id = addClient(lia);
  addClient(lou, { name: "Kim Wu", email: "kim@x.com", loan_number: "" });
  addClient(lia, { name: "Kim Wu", email: "kim@x.com", loan_number: "" });
  const r = run([
    item(2, { loanOfficer: "Nobody" }),
    item(3, { loanOfficer: "Nobody", currentBalance: "379,500" }),
    item(4, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", loanNumber: "a200", loanOfficer: "Nobody" }),
    item(5, { loanNumber: "C300", closingDate: "2026-04-01", purpose: "Purchase", loanOfficer: "Nobody" }),
    item(6, { firstName: "Kim", lastName: "Wu", email: "kim@x.com", loanNumber: "", loanOfficer: "Nobody" }),
  ]);
  assert.deepStrictEqual(r.results.map((x) => [x.row, x.outcome, x.note, x.owner, x.flags]), [
    [2, "unchanged", null, { id: lia, name: "Lia Chen" }, []],
    [3, "updated", null, { id: lia, name: "Lia Chen" }, []],
    [4, "created", null, { id: ann, name: "Ann Lee" }, [ESTIMATED, routed]],
    [5, "created", "second property", { id: ann, name: "Ann Lee" }, [ESTIMATED, routed]],
    [6, "ambiguous", null, null, []],
  ]);
  assert.equal(clientRow(id).user_id, lia);
});

test("a balance flag is shown only when the balance was written; a loan type flag always is", () => {
  const ORIGINAL = "balance = original loan amount (no rate/term/date to estimate from)";
  const TWENTY = "20-year fixed priced as a 30-year";
  const flagsOf = (r) => r.results.map((x) => [x.row, x.outcome, x.flags]);
  const id = addClient(lou, { loan_balance: 380000, phone: "" });

  // An update that keeps the stored balance (only the phone is filled) carries no balance flag.
  assert.deepStrictEqual(flagsOf(run([item(2)])), [[2, "updated", []]]);
  assert.equal(clientRow(id).loan_balance, 380000);
  // Unchanged: no balance flag, but a 20-year term is still flagged as priced as a 30-year.
  assert.deepStrictEqual(flagsOf(run([item(2, { term: "240" })])), [[2, "unchanged", [TWENTY]]]);
  // A new rate is a changed loan, so the estimate is written, and flagged.
  assert.deepStrictEqual(flagsOf(run([item(2, { noteRate: "6.0" })])), [[2, "updated", [ESTIMATED]]]);
  assert.notEqual(clientRow(id).loan_balance, 380000);
  // A created client always shows how its balance was found.
  assert.deepStrictEqual(flagsOf(run([item(3, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", loanNumber: "a200", term: "", amortization: "" })])),
    [[3, "created", [ORIGINAL]]]);
});

test("a refinance with no loan number clears the old number, so the old loan never rolls the client back", () => {
  const file = [
    item(2, { loanNumber: "A100", closingDate: "2020-01-01", noteRate: "3.0" }),
    item(3, { loanNumber: "", closingDate: "2024-02-01", noteRate: "6.0" }),
  ];
  assert.deepStrictEqual(outcomes(run(file)), [[2, "created"], [3, "updated"]]);
  const [c] = allClients();
  assert.equal(c.loan_number, "");
  assert.equal(c.current_rate, 6.0);
  assert.equal(c.close_date, "2024-02-01");

  assert.deepStrictEqual(outcomes(run(file)), [[2, "unchanged"], [3, "unchanged"]]);
  const old = run([file[0]]);
  assert.deepStrictEqual(old.results.map((x) => [x.outcome, x.note]), [["unchanged", "older loan"]]);
  assert.deepStrictEqual(allClients(), [c]);
});

test("a client this run created and a later row hands to another loan officer is not a move", () => {
  const r = run([
    item(2, { loanNumber: "B200", closingDate: "2024-02-01", noteRate: "6.0", loanOfficer: "lou@a.test" }),
    item(3, { loanNumber: "A100", closingDate: "2020-01-01", noteRate: "3.0", loanOfficer: "lia@a.test" }),
  ]);
  assert.deepStrictEqual(r.results.map((x) => [x.row, x.outcome, x.owner, x.movedFrom]), [
    [2, "updated", { id: lou, name: "Lou Park" }, null],
    [3, "created", { id: lia, name: "Lia Chen" }, null],
  ]);
  assert.equal(r.counts.moved, 0);
  const [c] = allClients();
  assert.equal(c.user_id, lou);
  assert.equal(c.loan_number, "B200");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});

test("a dry run returns exactly what the real run does, with the same reviewHash, and writes nothing", () => {
  const id = addClient(lia, { close_date: "2021-05-01", current_rate: 3.0, loan_balance: 350000 });
  addRec(lia, id, "briefing", "2026-10-30");
  const items = [
    item(2, REFI),
    item(3, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", loanNumber: "a200" }),
    item(4, { noteRate: "N/A" }),
  ];
  const before = tables();

  const dry = run(items, { dryRun: true });
  assert.deepStrictEqual(tables(), before);
  assert.deepStrictEqual(outcomes(dry), [[2, "updated"], [3, "created"], [4, "skipped"]]);
  assert.equal(dry.counts.moved, 1);

  const real = run(items);
  assert.deepStrictEqual(real.results, dry.results);
  assert.deepStrictEqual(real.counts, dry.counts);
  assert.equal(real.reviewHash, dry.reviewHash);
  // ...and the real run did write.
  const after = tables();
  assert.equal(after.clients.length, 2);
  assert.equal(after.notifications.length, 1);
  assert.equal(after.recs[0].status, "expired");
});

test("an error during the run rolls everything back and is not taken for a dry run", () => {
  const id = addClient(lia, { close_date: "2021-05-01", current_rate: 3.0 });
  const items = [item(2, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", loanNumber: "a200" }), item(3, REFI)];
  const before = tables();
  const real = followups.resolveForClient;
  followups.resolveForClient = () => { throw new Error("boom"); };
  try {
    assert.throws(() => run(items), /boom/);
    assert.deepStrictEqual(tables(), before);
    assert.throws(() => run(items, { dryRun: true }), /boom/);
    assert.deepStrictEqual(tables(), before);
  } finally {
    followups.resolveForClient = real;
  }
  assert.equal(clientRow(id).user_id, lia);
});

test("a bad source, today or nowUtc is refused before anything is read", () => {
  assert.throws(() => run([item(2)], { source: "csv" }), TypeError);
  assert.throws(() => run([item(2)], { today: "11/1/2026" }), TypeError);
  assert.throws(() => run([item(2)], { nowUtc: "2026-11-01T15:00:00Z" }), TypeError);
  assert.equal(allClients().length, 0);
});

test("A6a: a refinance under a different named loan officer moves the client, closes the old owner's open follow-ups and tells them in-app", () => {
  const id = addClient(lia, { close_date: "2021-05-01", current_rate: 3.0, notes: "VIP" });
  const briefing = addRec(lia, id, "briefing", "2026-10-30");
  const carry = addRec(lia, id, "carry", "2026-10-31");
  const reached = addRec(lia, id, "sweep", "2026-10-29", "reached", "2026-10-29 18:00:00");
  const annOwn = addRec(ann, id, "briefing", "2026-10-30");
  const call = addCall(lia, id);

  const r = run([item(2, REFI)]);
  assert.deepStrictEqual(r.results, [{
    row: 2, outcome: "updated", name: "John Smith", reason: null, note: null, flags: [ESTIMATED],
    owner: { id: lou, name: "Lou Park" }, movedFrom: "Lia Chen",
  }]);
  assert.equal(r.counts.moved, 1);
  assert.deepStrictEqual(r.counts.byOwner, [{ id: lou, name: "Lou Park", rows: 1 }]);

  const c = clientRow(id);
  assert.equal(c.user_id, lou);
  assert.equal(c.notes, "VIP");
  assert.deepStrictEqual(recRow(briefing), { user_id: lia, status: "expired", resolved_at: NOW });
  assert.deepStrictEqual(recRow(carry), { user_id: lia, status: "expired", resolved_at: NOW });
  assert.deepStrictEqual(recRow(reached), { user_id: lia, status: "reached", resolved_at: "2026-10-29 18:00:00" });
  assert.deepStrictEqual(recRow(annOwn), { user_id: ann, status: "open", resolved_at: null });
  assert.equal(db.prepare("SELECT user_id FROM contact_log WHERE id = ?").get(call).user_id, lia);

  const notes = db.prepare("SELECT org_id, from_user, to_user, client_id, message, read FROM notifications").all();
  assert.deepStrictEqual(notes, [{
    org_id: orgA, from_user: ann, to_user: lia, client_id: id, read: 0,
    message: "John Smith moved to Lou Park's book: their new loan came in under Lou.",
  }]);
});

test("A6a: no move on a fallback, an older loan, or a second property; a same-loan reassignment moves; no notice to the actor", () => {
  const id = addClient(lia);
  const original = clientRow(id);

  const fallback = run([item(2, { loanOfficer: "" })]);
  assert.deepStrictEqual(fallback.results.map((x) => [x.outcome, x.owner, x.movedFrom]), [["unchanged", { id: lia, name: "Lia Chen" }, null]]);
  assert.deepStrictEqual(clientRow(id), original);

  const older = run([item(2, { loanNumber: "A050", closingDate: "2019-01-01" })]);
  assert.deepStrictEqual(older.results.map((x) => [x.outcome, x.note, x.owner, x.movedFrom]), [["unchanged", "older loan", { id: lia, name: "Lia Chen" }, null]]);
  assert.equal(clientRow(id).user_id, lia);

  const purchase = run([item(2, { loanNumber: "C300", closingDate: "2026-04-01", purpose: "Purchase" })]);
  assert.deepStrictEqual(purchase.results.map((x) => [x.outcome, x.note, x.owner, x.movedFrom]), [["created", "second property", { id: lou, name: "Lou Park" }, null]]);
  assert.equal(clientRow(id).user_id, lia);
  assert.equal(db.prepare("SELECT user_id FROM clients WHERE loan_number = 'C300'").get().user_id, lou);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);

  const same = run([item(2)]);
  assert.deepStrictEqual(same.results.map((x) => [x.outcome, x.owner, x.movedFrom]), [["updated", { id: lou, name: "Lou Park" }, "Lia Chen"]]);
  assert.equal(same.counts.moved, 1);
  assert.equal(clientRow(id).user_id, lou);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE to_user = ?").get(lia).n, 1);

  // Ann ran the import, so the client leaving her book tells nobody; her open follow-up for them still closes.
  const janeId = addClient(ann, { name: "Jane Doe", email: "jane@x.com", loan_number: "D400" });
  const annRec = addRec(ann, janeId, "briefing", "2026-10-30");
  const fromAnn = run([item(2, { firstName: "Jane", lastName: "Doe", email: "jane@x.com", loanNumber: "D400" })]);
  assert.deepStrictEqual(fromAnn.results.map((x) => [x.outcome, x.owner, x.movedFrom]), [["updated", { id: lou, name: "Lou Park" }, "Ann Lee"]]);
  assert.equal(clientRow(janeId).user_id, lou);
  assert.deepStrictEqual(recRow(annRec), { user_id: ann, status: "expired", resolved_at: NOW });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE client_id = ?").get(janeId).n, 0);
});

// ── Bill's rulings, 2026-11-03 ──────────────────────────────────────────────────────────────────────────────────────────
const NAME_ONLY = "matched by name only: check it's the same person";
const handEdited = (id, marks) => db.prepare("UPDATE clients SET edited_by_hand = ? WHERE id = ?").run(marks, id);

test("Bill 11/3: a file of names and loan numbers lists a refinance beside its original: one client, flagged as a name match", () => {
  const plain = { email: "", phone: "", loanOfficer: "" };
  const r = run([
    item(2, { ...plain, loanNumber: "A100", closingDate: "2020-01-01", noteRate: "3.0" }),
    item(3, { ...plain, loanNumber: "B200", closingDate: "2024-02-01", noteRate: "6.0" }),
  ]);
  assert.deepStrictEqual(outcomes(r), [[2, "created"], [3, "updated"]]);
  assert.deepStrictEqual(allClients().map((c) => [c.name, c.loan_number, c.current_rate]), [["John Smith", "B200", 6.0]]);
  assert.ok(r.results[1].flags.includes(NAME_ONLY), r.results[1].flags.join(" | "));
  assert.ok(!r.results[0].flags.includes(NAME_ONLY));
});

test("Bill 11/3: a client typed in with a phone and no email is found by a row with an email and no phone; a different email is not", () => {
  const id = addClient(lou, { email: "", loan_number: "" });
  const r = run([item(2, { phone: "" })]);
  assert.deepStrictEqual(outcomes(r), [[2, "updated"]]);
  assert.deepStrictEqual(r.results[0].flags, [NAME_ONLY]);
  assert.equal(allClients().length, 1);
  assert.equal(clientRow(id).email.toLowerCase(), "john@x.com");
  assert.equal(clientRow(id).loan_number, "A100");

  db.prepare("DELETE FROM clients").run();
  addClient(lou, { email: "other@x.com", loan_number: "", phone: "" });
  const other = run([item(2, { phone: "" })]);
  assert.deepStrictEqual(outcomes(other), [[2, "created"]]);
  assert.ok(!other.results[0].flags.includes(NAME_ONLY));
  assert.equal(allClients().length, 2);
});

test("Bill 11/3: the same loan keeps a rate, property value or credit score edited by hand, and the row says so", () => {
  const id = addClient(lou, { current_rate: 6.125, property_value: 560000, credit_score: 760, loan_balance: 380000 });
  handEdited(id, "current_rate,property_value");
  const r = run([item(2)]);
  assert.deepStrictEqual(r.results.map((x) => [x.outcome, x.flags]), [["updated", ["kept hand-edited rate, property value"]]]);
  let c = clientRow(id);
  // the marked two are kept, the unmarked score is the row's, and a kept rate is not a changed loan, so the balance stays
  assert.deepStrictEqual([c.current_rate, c.property_value, c.credit_score, c.loan_balance], [6.125, 560000, 742, 380000]);
  assert.equal(c.edited_by_hand, "current_rate,property_value");

  // the same row again: only the kept values differ, so nothing is written, and the row still says why
  const again = run([item(2)]);
  assert.deepStrictEqual(again.results.map((x) => [x.outcome, x.flags]), [["unchanged", ["kept hand-edited rate, property value"]]]);

  // unmarked, the rate and value are the row's again (a new rate is a changed loan, so the balance is re-estimated), and a
  // marked value the row agrees with is not reported as kept
  handEdited(id, "credit_score");
  assert.deepStrictEqual(run([item(2)]).results.map((x) => [x.outcome, x.flags]), [["updated", [ESTIMATED]]]);
  c = clientRow(id);
  assert.deepStrictEqual([c.current_rate, c.property_value, c.credit_score], [6.5, 520000, 742]);
});

test("Bill 11/3: a refinance is a new loan, so it replaces hand-edited values and clears their marks; one it doesn't bring stays marked", () => {
  const id = addClient(lou, { close_date: "2021-05-01", current_rate: 3.0, property_value: 600000, credit_score: 790 });
  handEdited(id, "current_rate,property_value,credit_score");
  const r = run([item(2, { ...REFI, creditScore: "" })]);
  assert.deepStrictEqual(outcomes(r), [[2, "updated"]]);
  assert.ok(!r.results[0].flags.some((f) => f.startsWith("kept hand-edited")), r.results[0].flags.join(" | "));
  const c = clientRow(id);
  assert.deepStrictEqual([c.current_rate, c.property_value, c.credit_score, c.edited_by_hand], [6.25, 520000, 790, "credit_score"]);
});

test("Bill 11/3: an LO's own key changes only their own clients; another LO's is skipped, and told when it is a newer loan", () => {
  const id = addClient(lia, { close_date: "2021-05-01", current_rate: 3.0 });
  const before = clientRow(id);
  const asLou = { actor: userRow(lou), source: "arive" };
  const lias = "in Lia Chen's book: a loan officer's feed only changes their own clients";

  const refi = run([item(2, { ...REFI, loanOfficer: "" })], asLou);
  assert.deepStrictEqual(refi.results, [{
    row: 2, outcome: "skipped", name: "John Smith", reason: lias, note: null, flags: [],
    owner: { id: lia, name: "Lia Chen" }, movedFrom: null,
  }]);
  assert.deepStrictEqual(clientRow(id), before);
  const told = [{
    from_user: lou, to_user: lia, client_id: id,
    message: "Lou Park's ARIVE feed sent a newer loan for John Smith (closed 2026-03-02). Nothing was changed, and John Smith stays in your book.",
  }];
  assert.deepStrictEqual(db.prepare("SELECT from_user, to_user, client_id, message FROM notifications").all(), told);
  // the Zap replayed: skipped again, and Lia is not told twice
  assert.deepStrictEqual(outcomes(run([item(2, { ...REFI, loanOfficer: "" })], asLou)), [[2, "skipped"]]);
  assert.deepStrictEqual(db.prepare("SELECT from_user, to_user, client_id, message FROM notifications").all(), told);

  // the same loan from Lou's key is skipped too, and nobody is told
  db.prepare("DELETE FROM notifications").run();
  const same = run([item(2, { loanOfficer: "" })], asLou);
  assert.deepStrictEqual(same.results.map((x) => [x.outcome, x.reason]), [["skipped", lias]]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);

  // an older loan is unchanged, and a newer purchase is a new client in Lou's own book; Lia's client never moves
  const older = run([item(2, { loanNumber: "Z1", closingDate: "2019-01-01", loanOfficer: "" })], asLou);
  assert.deepStrictEqual(outcomes(older), [[2, "unchanged"]]);
  const purchase = run([item(2, { loanNumber: "P9", closingDate: "2026-06-01", purpose: "Purchase", loanOfficer: "" })], asLou);
  assert.deepStrictEqual(purchase.results.map((x) => [x.outcome, x.note, x.owner]), [["created", "second property", { id: lou, name: "Lou Park" }]]);
  assert.deepStrictEqual(clientRow(id), before);

  // Lou's own client takes the refinance as before
  db.prepare("DELETE FROM clients").run();
  const mine = addClient(lou, { close_date: "2021-05-01", current_rate: 3.0 });
  const own = run([item(2, { ...REFI, loanOfficer: "" })], asLou);
  assert.deepStrictEqual(own.results.map((x) => [x.outcome, x.movedFrom]), [["updated", null]]);
  assert.equal(clientRow(mine).current_rate, 6.25);
});
