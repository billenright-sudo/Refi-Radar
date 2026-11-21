"use strict";
// setUpEmail (lib/assistant/emailSetup.js): the one way a client email is set up, for Charlie's draftEmailTool and the Dates Coming
// Up button alike, and the occasion_emails table behind "Mark sent" (lib/occasionEmails.js). Throwaway DB; no model call, no network.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-email-setup-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { setUpEmail, matchingOccasion } = require("../lib/assistant/emailSetup");
const { renderEmail, composeLinks } = require("../lib/assistant/outreach");
const occasionEmails = require("../lib/occasionEmails");
const { EMPTY } = require("../lib/personal");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const orgId = Number(db.prepare("INSERT INTO organizations (name, nmls_id) VALUES ('Example Mortgage Co', '654321')").run().lastInsertRowid);
const samId = Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, nmls_id) VALUES (?, 'broker', 'Sam', 'Sender', 'sam@example.com', '123456')"
).run(orgId).lastInsertRowid);
const noNmlsId = Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'lo', 'Nia', 'None', 'nia@example.com')"
).run(orgId).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const sam = userRow(samId);

function addClient(name, { email = "pat@example.com", personal = null, doNotEmail = 0, closeDate = "" } = {}) {
  const id = Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, email, loan_type, current_rate, loan_balance, property_value, close_date, do_not_email, personal)
    VALUES (?, ?, ?, ?, '30yr_fixed', 6.5, 300000, 400000, ?, ?, ?)
  `).run(orgId, samId, name, email, closeDate, doNotEmail, personal ? JSON.stringify({ ...EMPTY, ...personal }) : "").lastInsertRowid);
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
}
const SENDER = { senderName: "Sam Sender", nmlsId: "123456", orgName: "Example Mortgage Co", orgNmlsId: "654321" };
const expected = (clientName, purpose, who) => {
  const { subject, body } = renderEmail({ ...SENDER, clientName, purpose, who });
  return { to: "pat@example.com", subject, body, links: composeLinks({ to: "pat@example.com", subject, body }) };
};

test("the two existing purposes set up exactly the email they always did", () => {
  const row = addClient("Pat Example");
  for (const purpose of ["check_in", "refi_review"]) {
    assert.deepStrictEqual(setUpEmail(db, sam, row, { purpose }), { ok: true, email: expected("Pat Example", purpose), who: null });
  }
});

test("birthday, wedding and home anniversary need no family member", () => {
  const row = addClient("Pat Example");
  for (const purpose of ["birthday", "wedding_anniversary", "home_anniversary"]) {
    assert.deepStrictEqual(setUpEmail(db, sam, row, { purpose, who: "Mallory" }), { ok: true, email: expected("Pat Example", purpose), who: null }, purpose);
  }
});

test("family_birthday: `who` must be the stored spouse or a stored child, compared trimmed and case-insensitively; the stored spelling prints", () => {
  const row = addClient("Pat Example", { personal: {
    spouseName: "Jordan", spouseBirthday: "05-01", children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }, { name: "Leo", birthday: "", birthYear: null }],
  } });
  const r = setUpEmail(db, sam, row, { purpose: "family_birthday", who: "  maya " });
  assert.deepStrictEqual(r, { ok: true, email: expected("Pat Example", "family_birthday", "Maya"), who: "Maya", kind: "child_birthday" });
  assert.equal(r.email.subject, "Happy birthday to Maya!");
  assert.equal(setUpEmail(db, sam, row, { purpose: "family_birthday", who: "JORDAN" }).email.subject, "Happy birthday to Jordan!");
  assert.equal(setUpEmail(db, sam, row, { purpose: "family_birthday", who: "JORDAN" }).kind, "spouse_birthday");
  assert.equal(setUpEmail(db, sam, row, { purpose: "family_birthday", who: "Leo" }).who, "Leo", "a named child with no birthday on file can be named");
  for (const who of ["Mallory", "your spouse", 5, ["Maya"]]) {
    assert.deepStrictEqual(setUpEmail(db, sam, row, { purpose: "family_birthday", who }), { ok: false, code: "invalid" }, String(who));
  }
  assert.deepStrictEqual(setUpEmail(db, sam, row, { purpose: "family_birthday" }), { ok: false, code: "who_needed", client: "Pat Example" },
    "two family members with a birthday on file: which one is needed");
});

test("family_birthday with `who` left out: the one family member with a birthday on file; none is who_needed", () => {
  const child = addClient("Pat Example", { personal: { spouseName: "Jordan", children: [{ name: "Maya", birthday: "11-20", birthYear: null }] } });
  assert.equal(setUpEmail(db, sam, child, { purpose: "family_birthday" }).who, "Maya");
  assert.equal(setUpEmail(db, sam, child, { purpose: "family_birthday", who: "  " }).who, "Maya", "a blank `who` is left out");
  const spouse = addClient("Pat Example", { personal: { spouseName: "Jordan", spouseBirthday: "05-01" } });
  assert.equal(setUpEmail(db, sam, spouse, { purpose: "family_birthday" }).email.subject, "Happy birthday to Jordan!");
  const nameless = addClient("Pat Example", { personal: { spouseBirthday: "05-01" } });
  const r = setUpEmail(db, sam, nameless, { purpose: "family_birthday" });
  assert.deepStrictEqual(r, { ok: true, email: expected("Pat Example", "family_birthday", "your spouse"), who: null, kind: "spouse_birthday" });
  assert.equal(r.email.subject, "Happy birthday to your spouse!");
  const none = addClient("Pat Example");
  assert.deepStrictEqual(setUpEmail(db, sam, none, { purpose: "family_birthday" }), { ok: false, code: "who_needed", client: "Pat Example" });
});

test("refusals, in order: invalid purpose, do not email, unavailable, NMLS missing, no email, then the family member", () => {
  const row = addClient("Pat Example");
  for (const purpose of ["nonsense", "", undefined, null, 5, "constructor", "__proto__"]) {
    assert.deepStrictEqual(setUpEmail(db, sam, row, { purpose }), { ok: false, code: "invalid" }, String(purpose));
  }
  const dne = addClient("Dee Nottoemail", { doNotEmail: 1, email: "" });
  assert.deepStrictEqual(setUpEmail(db, userRow(noNmlsId), dne, { purpose: "family_birthday" }), { ok: false, code: "do_not_email", client: "Dee Nottoemail" });
  assert.deepStrictEqual(setUpEmail(db, { ...sam, id: 99999999 }, row, { purpose: "check_in" }), { ok: false, code: "unavailable" });
  const noEmail = addClient("Nolan Address", { email: "not-an-email" });
  assert.deepStrictEqual(setUpEmail(db, userRow(noNmlsId), noEmail, { purpose: "check_in" }), { ok: false, code: "nmls_missing" });
  assert.deepStrictEqual(setUpEmail(db, sam, noEmail, { purpose: "family_birthday" }), { ok: false, code: "no_email", client: "Nolan Address" });
});

test("matchingOccasion: the soonest coming occasion of that purpose (and family member) within the days given", () => {
  const row = addClient("Pat Example", { closeDate: "2020-12-01", personal: {
    birthday: "11-25", spouseName: "Jordan", spouseBirthday: "12-10", children: [{ name: "Maya", birthday: "11-22", birthYear: null }],
  } });
  const today = "2026-11-21";
  assert.deepStrictEqual(matchingOccasion(row, "birthday", {}, today, 60), { kind: "birthday", who: "", date: "2026-11-25" });
  assert.deepStrictEqual(matchingOccasion(row, "family_birthday", { who: "Jordan", kind: "spouse_birthday" }, today, 60), { kind: "spouse_birthday", who: "Jordan", date: "2026-12-10" });
  assert.deepStrictEqual(matchingOccasion(row, "family_birthday", { who: "Maya", kind: "child_birthday" }, today, 60), { kind: "child_birthday", who: "Maya", date: "2026-11-22" });
  assert.deepStrictEqual(matchingOccasion(row, "home_anniversary", {}, today, 60), { kind: "loan", who: "", date: "2026-12-01" });
  assert.equal(matchingOccasion(row, "wedding_anniversary", {}, today, 60), null);
  assert.equal(matchingOccasion(row, "check_in", {}, today, 60), null);
  assert.equal(matchingOccasion(row, "birthday", {}, today, 2), null, "outside the window");
});

// ── occasion_emails ─────────────────────────────────────────────────────────

test("occasion_emails: the table's columns, and a second record of the same occasion changes nothing", () => {
  const cols = db.prepare("PRAGMA table_info(occasion_emails)").all().map((c) => c.name);
  assert.deepStrictEqual(cols, ["id", "client_id", "user_id", "kind", "who", "occasion_date", "created_at"]);
  const row = addClient("Pat Example");
  const rec = { clientId: row.id, userId: samId, kind: "child_birthday", who: "Maya", date: "2026-11-22" };
  assert.equal(occasionEmails.record(db, rec), true);
  assert.equal(occasionEmails.record(db, rec), false);
  assert.equal(occasionEmails.record(db, { ...rec, who: "" , kind: "birthday" }), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM occasion_emails WHERE client_id = ?").get(row.id).n, 2);
  assert.throws(() => occasionEmails.record(db, { ...rec, kind: "nonsense" }));
  assert.throws(() => occasionEmails.record(db, { ...rec, date: "2026-13-40" }));
});

test("occasion_emails: read back per client from a day onward, and a row matched to an occasion", () => {
  const a = addClient("Pat Example");
  const b = addClient("Robin Example");
  occasionEmails.record(db, { clientId: a.id, userId: samId, kind: "birthday", who: "", date: "2026-10-01" });
  occasionEmails.record(db, { clientId: a.id, userId: samId, kind: "wedding", who: "", date: "2026-11-30" });
  occasionEmails.record(db, { clientId: b.id, userId: samId, kind: "spouse_birthday", who: "Jordan", date: "2026-11-25" });
  const map = occasionEmails.forClients(db, [a.id, b.id], "2026-10-22");
  assert.deepStrictEqual(map.get(a.id), [{ kind: "wedding", who: "", date: "2026-11-30" }]);
  assert.deepStrictEqual(map.get(b.id), [{ kind: "spouse_birthday", who: "Jordan", date: "2026-11-25" }]);
  assert.equal(occasionEmails.isEmailed(map.get(b.id), { kind: "spouse_birthday", who: "Jordan", date: "2026-11-25" }), true);
  assert.equal(occasionEmails.isEmailed(map.get(b.id), { kind: "spouse_birthday", who: null, date: "2026-11-25" }), false);
  assert.equal(occasionEmails.isEmailed(map.get(a.id), { kind: "wedding", who: null, date: "2026-11-30" }), true, "no family member is ''");
  assert.equal(occasionEmails.isEmailed(undefined, { kind: "wedding", who: null, date: "2026-11-30" }), false);
  db.prepare("DELETE FROM clients WHERE id = ?").run(a.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM occasion_emails WHERE client_id = ?").get(a.id).n, 0, "a deleted client's rows go with it");
});
