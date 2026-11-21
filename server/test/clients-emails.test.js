"use strict";
// The occasion emails through /api/clients (routes/clients.js): POST /:id/email sets one up (and sends and saves nothing),
// POST /:id/email-sent is the broker's "Mark sent" (last_contact now; an occasion recorded in occasion_emails; no call logged, no
// follow-up closed), and each client the API returns carries occasionEmails. Throwaway DB, no model call, no network but the local
// test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-clients-emails-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const clientRoutes = require("../routes/clients");
const followups = require("../lib/assistant/followups");
const { renderEmail, composeLinks } = require("../lib/assistant/outreach");
const { EMPTY } = require("../lib/personal");

const addOrg = (name, nmls = null) => Number(db.prepare("INSERT INTO organizations (name, nmls_id) VALUES (?, ?)").run(name, nmls).lastInsertRowid);
const addUser = (orgId, role, email, first, nmls = null) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, career_stage, nmls_id) VALUES (?, ?, ?, 'User', ?, 'established', ?)"
).run(orgId, role, first, email, nmls).lastInsertRowid);
const orgA = addOrg("Alpha Mortgage", "654321");
const ann = addUser(orgA, "broker", "ann@emails.test", "Ann", "123456");
const lou = addUser(orgA, "lo", "lou@emails.test", "Lou");            // no NMLS ID
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@emails.test", "Bea", "111111");

function addClient(userId, name, { email = "pat@example.com", personal = null, doNotEmail = 0, orgId = orgA, lastContact = "2025-01-01" } = {}) {
  return Number(db.prepare(`
    INSERT INTO clients (org_id, user_id, name, email, loan_type, current_rate, loan_balance, property_value, do_not_email, personal, last_contact)
    VALUES (?, ?, ?, ?, '30yr_fixed', 6.5, 300000, 400000, ?, ?, ?)
  `).run(orgId, userId, name, email, doNotEmail, personal ? JSON.stringify({ ...EMPTY, ...personal }) : "", lastContact).lastInsertRowid);
}
const clientRow = (id) => db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
const sentRows = (id) => db.prepare("SELECT user_id, kind, who, occasion_date FROM occasion_emails WHERE client_id = ? ORDER BY id").all(id);
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

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
  for (const table of ["occasion_emails", "charlie_recommendations", "contact_log", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

const api = async (method, p, body, as = ann) => {
  const headers = { "content-type": "application/json", ...(as ? { cookie: "rr_token=" + signToken({ userId: as }) } : {}) };
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};

const FAMILY = { birthday: "03-09", spouseName: "Jordan", spouseBirthday: "12-31", anniversary: "06-14",
  children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }] };
const SENDER = { senderName: "Ann User", nmlsId: "123456", orgName: "Alpha Mortgage", orgNmlsId: "654321" };

// ── POST /:id/email ─────────────────────────────────────────────────────────

test("email: sets up the fixed email for the purpose, to the record's address, and saves nothing", async () => {
  const id = addClient(ann, "Pat Example", { personal: FAMILY });
  const before = JSON.stringify(clientRow(id));
  const r = await api("POST", `/api/clients/${id}/email`, { purpose: "family_birthday", who: "maya", to: "x@evil.test", body: "Lock in 3.1%" });
  assert.equal(r.status, 200);
  const { subject, body } = renderEmail({ ...SENDER, clientName: "Pat Example", purpose: "family_birthday", who: "Maya" });
  assert.deepStrictEqual(r.data, { success: true, email: { to: "pat@example.com", subject, body, links: composeLinks({ to: "pat@example.com", subject, body }) } });
  assert.equal(subject, "Happy birthday to Maya!");
  for (const purpose of ["check_in", "refi_review", "birthday", "wedding_anniversary", "home_anniversary"]) {
    const one = await api("POST", `/api/clients/${id}/email`, { purpose });
    assert.equal(one.status, 200, purpose);
    assert.equal(one.data.email.subject, renderEmail({ ...SENDER, clientName: "Pat Example", purpose }).subject);
  }
  assert.equal(JSON.stringify(clientRow(id)), before);
  assert.deepStrictEqual([count("occasion_emails"), count("contact_log")], [0, 0]);
});

test("email: each refusal is a 4xx with its code", async () => {
  const pat = addClient(ann, "Pat Example", { personal: FAMILY });
  const dne = addClient(ann, "Dee Example", { doNotEmail: 1 });
  const none = addClient(ann, "Nolan Example", { email: "" });
  const louOwn = addClient(lou, "Lou's Client");
  const cases = [
    [ann, pat, { purpose: "nonsense" }, 400, "invalid"],
    [ann, pat, {}, 400, "invalid"],
    [ann, pat, { purpose: "family_birthday", who: "Mallory" }, 400, "invalid"],
    [ann, pat, { purpose: "family_birthday" }, 400, "who_needed"],
    [ann, dne, { purpose: "check_in" }, 409, "do_not_email"],
    [ann, none, { purpose: "check_in" }, 409, "no_email"],
    [lou, louOwn, { purpose: "check_in" }, 409, "nmls_missing"],
  ];
  for (const [as, id, body, status, code] of cases) {
    const r = await api("POST", `/api/clients/${id}/email`, body, as);
    assert.deepStrictEqual([r.status, r.data], [status, { success: false, code }], JSON.stringify(body));
  }
});

test("email: scoped like the other client routes", async () => {
  const annClient = addClient(ann, "Ann's Client");
  const louClient = addClient(lou, "Lou's Client");
  const beaClient = addClient(bea, "Bea's Client", { orgId: orgB });
  assert.equal((await api("POST", `/api/clients/${annClient}/email`, { purpose: "check_in" }, lou)).status, 403, "an LO: their own clients only");
  assert.equal((await api("POST", `/api/clients/${beaClient}/email`, { purpose: "check_in" }, ann)).status, 403, "another org's");
  assert.equal((await api("POST", "/api/clients/99999999/email", { purpose: "check_in" })).status, 404);
  assert.equal((await api("POST", `/api/clients/${annClient}/email`, { purpose: "check_in" }, null)).status, 401);
  assert.equal((await api("POST", `/api/clients/${louClient}/email`, { purpose: "check_in" }, ann)).status, 200, "a broker: any client in their org");
});

// ── POST /:id/email-sent ────────────────────────────────────────────────────

test("email-sent: a check-in sets last_contact to now, logs no call, closes no follow-up and records no occasion", async () => {
  const id = addClient(ann, "Pat Example");
  followups.recordRecommendations(db, ann, utcDay(), [{ clientId: id, source: "briefing", reasonCode: "stale" }]);
  const r = await api("POST", `/api/clients/${id}/email-sent`, { purpose: "check_in" });
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.client.id, id);
  assert.notEqual(clientRow(id).last_contact, "2025-01-01");
  assert.ok(clientRow(id).last_contact.startsWith(utcDay()), clientRow(id).last_contact);
  assert.equal(r.data.client.lastContact, clientRow(id).last_contact);
  assert.deepStrictEqual(r.data.client.occasionEmails, []);
  assert.deepStrictEqual([count("contact_log"), count("occasion_emails")], [0, 0]);
  assert.deepStrictEqual(db.prepare("SELECT status FROM charlie_recommendations WHERE client_id = ?").all(id), [{ status: "open" }]);
  assert.equal(followups.reachedSince(db, ann, "2000-01-01 00:00:00").has(id), false, "not reached for the call list");
});

test("email-sent: an occasion with its date is recorded once, the family member as stored, and shows on the client", async () => {
  const today = utcDay();
  const md = today.slice(5);
  const id = addClient(ann, "Pat Example", { personal: { ...FAMILY, birthday: md, children: [{ name: "Maya", birthday: md, birthYear: null }] } });
  const r = await api("POST", `/api/clients/${id}/email-sent`, { purpose: "birthday", date: today });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data.client.occasionEmails, [{ kind: "birthday", who: "", date: today }]);
  assert.equal((await api("POST", `/api/clients/${id}/email-sent`, { purpose: "birthday", date: today })).status, 200, "a second tap is fine");
  const maya = await api("POST", `/api/clients/${id}/email-sent`, { purpose: "family_birthday", who: " MAYA ", date: today });
  assert.equal(maya.status, 200);
  assert.deepStrictEqual(sentRows(id), [
    { user_id: ann, kind: "birthday", who: "", occasion_date: today },
    { user_id: ann, kind: "child_birthday", who: "Maya", occasion_date: today },
  ]);
  assert.equal(count("contact_log"), 0);
  const listed = (await api("GET", "/api/clients")).data.clients.find((c) => c.id === id);
  assert.deepStrictEqual(listed.occasionEmails, [{ kind: "birthday", who: "", date: today }, { kind: "child_birthday", who: "Maya", date: today }]);
});

test("email-sent: an occasion purpose with no date only sets last_contact", async () => {
  const id = addClient(ann, "Pat Example", { personal: FAMILY });
  const r = await api("POST", `/api/clients/${id}/email-sent`, { purpose: "wedding_anniversary" });
  assert.equal(r.status, 200);
  assert.ok(clientRow(id).last_contact.startsWith(utcDay()));
  assert.equal(count("occasion_emails"), 0);
});

test("email-sent: refusals write nothing", async () => {
  const id = addClient(ann, "Pat Example", { personal: FAMILY });
  const dne = addClient(ann, "Dee Example", { doNotEmail: 1 });
  const cases = [
    [id, { purpose: "nonsense" }, 400, "invalid"],
    [id, { purpose: "birthday", date: "2026-03-10" }, 400, "invalid"],          // not the birthday
    [id, { purpose: "birthday", date: "2026-02-30" }, 400, "invalid"],          // not a day
    [id, { purpose: "birthday", date: 20260309 }, 400, "invalid"],
    [id, { purpose: "family_birthday", who: "Mallory", date: "2026-11-20" }, 400, "invalid"],
    [id, { purpose: "family_birthday", date: "2026-11-20" }, 400, "who_needed"],
    [dne, { purpose: "check_in" }, 409, "do_not_email"],
  ];
  for (const [cid, body, status, code] of cases) {
    const r = await api("POST", `/api/clients/${cid}/email-sent`, body);
    assert.deepStrictEqual([r.status, r.data], [status, { success: false, code }], JSON.stringify(body));
  }
  assert.equal(clientRow(id).last_contact, "2025-01-01");
  assert.equal(clientRow(dne).last_contact, "2025-01-01");
  assert.equal(count("occasion_emails"), 0);
  // the right date for the right family member does go in
  assert.equal((await api("POST", `/api/clients/${id}/email-sent`, { purpose: "family_birthday", who: "Jordan", date: "2026-12-31" })).status, 200);
  assert.deepStrictEqual(sentRows(id), [{ user_id: ann, kind: "spouse_birthday", who: "Jordan", occasion_date: "2026-12-31" }]);
});

test("email-sent: scoped like the other client routes, and a refused one writes nothing", async () => {
  const annClient = addClient(ann, "Ann's Client");
  const beaClient = addClient(bea, "Bea's Client", { orgId: orgB });
  assert.equal((await api("POST", `/api/clients/${annClient}/email-sent`, { purpose: "check_in" }, lou)).status, 403);
  assert.equal((await api("POST", `/api/clients/${beaClient}/email-sent`, { purpose: "check_in" }, ann)).status, 403);
  assert.equal((await api("POST", "/api/clients/99999999/email-sent", { purpose: "check_in" })).status, 404);
  assert.equal((await api("POST", `/api/clients/${annClient}/email-sent`, { purpose: "check_in" }, null)).status, 401);
  assert.equal(clientRow(annClient).last_contact, "2025-01-01");
  assert.equal(clientRow(beaClient).last_contact, "2025-01-01");
});

test("an unnamed spouse beside a child's birthday: both routes take who \"your spouse\", and the occasion row has no name", async () => {
  const id = addClient(ann, "Pat Example", { personal: { spouseBirthday: "12-31", children: [{ name: "Maya", birthday: "11-20", birthYear: null }] } });
  const set = await api("POST", `/api/clients/${id}/email`, { purpose: "family_birthday", who: "your spouse" });
  assert.equal(set.status, 200);
  assert.equal(set.data.email.subject, "Happy birthday to your spouse!");
  assert.equal((await api("POST", `/api/clients/${id}/email`, { purpose: "family_birthday" })).data.code, "who_needed");
  const sent = await api("POST", `/api/clients/${id}/email-sent`, { purpose: "family_birthday", who: "your spouse", date: "2026-12-31" });
  assert.equal(sent.status, 200);
  assert.deepStrictEqual(sentRows(id), [{ user_id: ann, kind: "spouse_birthday", who: "", occasion_date: "2026-12-31" }]);
  const named = addClient(ann, "Robin Example", { personal: { spouseName: "Jordan", spouseBirthday: "12-31" } });
  assert.deepStrictEqual((await api("POST", `/api/clients/${named}/email`, { purpose: "family_birthday", who: "your spouse" })).data, { success: false, code: "invalid" });
  assert.equal((await api("POST", `/api/clients/${named}/email-sent`, { purpose: "family_birthday", who: "your spouse", date: "2026-12-31" })).status, 400);
  assert.deepStrictEqual(sentRows(named), []);
});

// ── occasionEmails on the client payload ────────────────────────────────────

test("occasionEmails: each client carries the occasions emailed from 30 days ago onward, and only its own", async () => {
  const a = addClient(ann, "Pat Example");
  const b = addClient(ann, "Robin Example");
  const ins = db.prepare("INSERT INTO occasion_emails (client_id, user_id, kind, who, occasion_date) VALUES (?, ?, ?, ?, ?)");
  const day = (offset) => utcDay(Date.now() + offset * 86_400_000);
  ins.run(a, ann, "wedding", "", day(-31));
  ins.run(a, ann, "birthday", "", day(-30));
  ins.run(a, lou, "child_birthday", "Maya", day(5));
  const clients = (await api("GET", "/api/clients")).data.clients;
  assert.deepStrictEqual(clients.find((c) => c.id === a).occasionEmails, [
    { kind: "birthday", who: "", date: day(-30) }, { kind: "child_birthday", who: "Maya", date: day(5) },
  ]);
  assert.deepStrictEqual(clients.find((c) => c.id === b).occasionEmails, []);
});
