"use strict";
// Charlie's follow-up storage against a throwaway DB: the three new tables and the synchronous functions in
// lib/assistant/followups.js. Every instant is SQLite UTC text (YYYY-MM-DD HH:MM:SS), every date YYYY-MM-DD.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-followups-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const fu = require("../lib/assistant/followups");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ── seed data ────────────────────────────────────────────────────────────────

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'T', 'User', ?)"
).run(orgId, email).lastInsertRowid);
const addClient = (orgId, userId, name) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value)
  VALUES (?, ?, ?, 7.5, 400000, 600000)
`).run(orgId, userId, name).lastInsertRowid);

const orgId = addOrg("Followup Org");
const userId = addUser(orgId, "broker@followups.test");
const otherUserId = addUser(orgId, "other@followups.test");

const TODAY = "2026-10-30";
const YESTERDAY = "2026-10-29";
const NOW = "2026-10-30 16:00:00";

const rows = () => db.prepare("SELECT * FROM charlie_recommendations ORDER BY id").all();
const open = (opts = {}) => fu.openFollowUps(db, userId, { localDate: TODAY, localHour: 9, nowUtc: NOW, ...opts });

test.beforeEach(() => {
  db.prepare("DELETE FROM charlie_recommendations").run();
  db.prepare("DELETE FROM contact_log").run();
  db.prepare("DELETE FROM user_briefing_state").run();
  db.prepare("DELETE FROM clients").run();
});

// ── recordRecommendations ────────────────────────────────────────────────────

test("recordRecommendations twice with the same item leaves one row", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const item = { clientId: lucy, source: "briefing", reasonCode: "rate_term" };
  fu.recordRecommendations(db, userId, YESTERDAY, [item]);
  fu.recordRecommendations(db, userId, YESTERDAY, [item]);
  const all = rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].client_id, lucy);
  assert.equal(all[0].day, YESTERDAY);
  assert.equal(all[0].source, "briefing");
  assert.equal(all[0].reason_code, "rate_term");
  assert.equal(all[0].status, "open");
  assert.equal(all[0].ask_count, 0);
  assert.equal(all[0].due_at, null);
});

test("recordRecommendations: a re-record refreshes the reason and due time but never reopens or resets a row", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, TODAY, [{ clientId: lucy, source: "calendar", reasonCode: "meeting", dueAt: "2026-10-30 15:00:00" }]);
  fu.resolveForClient(db, userId, lucy, "reached", NOW);
  fu.recordRecommendations(db, userId, TODAY, [{ clientId: lucy, source: "calendar", reasonCode: "meeting2", dueAt: "2026-10-30 15:30:00" }]);
  const [row] = rows();
  assert.equal(rows().length, 1);
  assert.equal(row.reason_code, "meeting2");
  assert.equal(row.due_at, "2026-10-30 15:30:00");
  assert.equal(row.status, "reached", "a resolved row stays resolved");
});

test("recordRecommendations: the same client on the same day under different sources is two rows", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, TODAY, [
    { clientId: lucy, source: "briefing", reasonCode: "a" },
    { clientId: lucy, source: "sweep", reasonCode: "b" },
  ]);
  assert.equal(rows().length, 2);
});

test("recordRecommendations is all-or-nothing and rejects a bad source or a non-UTC dueAt", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  assert.throws(() => fu.recordRecommendations(db, userId, TODAY, [
    { clientId: lucy, source: "briefing", reasonCode: "ok" },
    { clientId: lucy, source: "nonsense", reasonCode: "bad" },
  ]));
  assert.equal(rows().length, 0, "the good item before the bad one was rolled back");
  assert.throws(
    () => fu.recordRecommendations(db, userId, TODAY, [{ clientId: lucy, source: "calendar", reasonCode: "x", dueAt: "2026-10-30T15:00:00Z" }]),
    /dueAt/,
    "an ISO instant would compare wrongly against SQLite UTC text",
  );
  assert.equal(rows().length, 0);
});

// ── openFollowUps ────────────────────────────────────────────────────────────

test("openFollowUps returns a yesterday briefing row with the client's name", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "rate_term" }]);
  const got = open();
  assert.equal(got.length, 1);
  assert.deepStrictEqual(got[0], { id: rows()[0].id, clientId: lucy, name: "Lucy Park", source: "briefing", day: YESTERDAY, dueAt: null });
});

test("openFollowUps hides today's briefing and sweep rows before noon and shows them from noon", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.recordRecommendations(db, userId, TODAY, [
    { clientId: lucy, source: "briefing", reasonCode: "a" },
    { clientId: sam, source: "sweep", reasonCode: "b" },
  ]);
  assert.deepStrictEqual(open({ localHour: 11 }), []);
  assert.deepStrictEqual(open({ localHour: 0 }), []);
  assert.deepStrictEqual(open({ localHour: 12 }).map((r) => r.clientId).sort(), [lucy, sam].sort());
  assert.equal(open({ localHour: 17 }).length, 2);
});

test("openFollowUps shows a calendar row only once its due_at has passed", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, TODAY, [{ clientId: lucy, source: "calendar", reasonCode: "meeting", dueAt: "2026-10-30 16:30:00" }]);
  assert.deepStrictEqual(open({ nowUtc: "2026-10-30 16:29:59" }), []);
  const got = open({ nowUtc: "2026-10-30 16:30:00" });
  assert.equal(got.length, 1);
  assert.equal(got[0].source, "calendar");
  assert.equal(got[0].dueAt, "2026-10-30 16:30:00");
  assert.equal(open({ nowUtc: "2026-10-30 18:00:00" }).length, 1);
});

test("openFollowUps: a calendar row ignores the noon rule, and a calendar row with no due_at is never due", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.recordRecommendations(db, userId, TODAY, [
    { clientId: lucy, source: "calendar", reasonCode: "meeting", dueAt: "2026-10-30 13:00:00" },
    { clientId: sam, source: "calendar", reasonCode: "nodue" },
  ]);
  assert.deepStrictEqual(open({ localHour: 9 }).map((r) => r.clientId), [lucy]);
});

test("openFollowUps never returns carry rows, and orders oldest day first", () => {
  const a = addClient(orgId, userId, "A");
  const b = addClient(orgId, userId, "B");
  const c = addClient(orgId, userId, "C");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: b, source: "briefing", reasonCode: "x" }]);
  fu.recordRecommendations(db, userId, "2026-10-27", [{ clientId: a, source: "sweep", reasonCode: "x" }]);
  fu.addCarry(db, userId, c, "2026-10-26");
  assert.deepStrictEqual(open().map((r) => r.clientId), [a, b]);
});

test("openFollowUps is scoped to the user it is asked for", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  assert.equal(fu.openFollowUps(db, otherUserId, { localDate: TODAY, localHour: 9, nowUtc: NOW }).length, 0);
});

test("openFollowUps skips a row whose client was deleted", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.recordRecommendations(db, userId, YESTERDAY, [
    { clientId: lucy, source: "briefing", reasonCode: "x" },
    { clientId: sam, source: "briefing", reasonCode: "x" },
  ]);
  db.prepare("DELETE FROM clients WHERE id = ?").run(lucy);
  assert.deepStrictEqual(open().map((r) => r.clientId), [sam]);
});

test("openFollowUps skips a row whose client now belongs to another user", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.recordRecommendations(db, userId, YESTERDAY, [
    { clientId: lucy, source: "briefing", reasonCode: "x" },
    { clientId: sam, source: "briefing", reasonCode: "x" },
  ]);
  db.prepare("UPDATE clients SET user_id = ? WHERE id = ?").run(otherUserId, lucy);
  assert.deepStrictEqual(open().map((r) => r.clientId), [sam]);
});

// ── markAsked ────────────────────────────────────────────────────────────────

test("markAsked increments ask_count and sets asked_at; asked twice, openFollowUps returns nothing", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  const [first] = open();

  fu.markAsked(db, [first.id], "2026-10-30 14:00:00");
  let row = rows()[0];
  assert.equal(row.ask_count, 1);
  assert.equal(row.asked_at, "2026-10-30 14:00:00");
  assert.equal(row.status, "open");
  assert.equal(open().length, 1, "asked once: still due");

  fu.markAsked(db, [first.id], "2026-10-31 14:00:00");
  row = rows()[0];
  assert.equal(row.ask_count, 2);
  assert.equal(row.asked_at, "2026-10-31 14:00:00");
  assert.deepStrictEqual(open(), []);
});

test("markAsked with several ids, an empty list, or an unknown id", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.recordRecommendations(db, userId, YESTERDAY, [
    { clientId: lucy, source: "briefing", reasonCode: "x" },
    { clientId: sam, source: "briefing", reasonCode: "x" },
  ]);
  fu.markAsked(db, [], NOW);
  fu.markAsked(db, [999999], NOW);
  assert.deepStrictEqual(rows().map((r) => r.ask_count), [0, 0]);
  fu.markAsked(db, rows().map((r) => r.id), NOW);
  assert.deepStrictEqual(rows().map((r) => r.ask_count), [1, 1]);
});

// ── dismiss ──────────────────────────────────────────────────────────────────

test("dismiss removes a row from openFollowUps for good", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  const [item] = open();
  assert.equal(fu.dismiss(db, userId, item.id), true);
  assert.equal(rows()[0].status, "expired");
  assert.deepStrictEqual(open(), []);
  assert.deepStrictEqual(open({ localDate: "2026-11-05" }), []);
});

test("dismiss with another user's recId changes nothing", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  const [item] = open();
  assert.equal(fu.dismiss(db, otherUserId, item.id), false);
  assert.equal(rows()[0].status, "open");
  assert.equal(open().length, 1);
});

// ── resolveForClient ─────────────────────────────────────────────────────────

test("resolveForClient closes every open row for that client and nobody else's", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.recordRecommendations(db, userId, YESTERDAY, [
    { clientId: lucy, source: "briefing", reasonCode: "x" },
    { clientId: sam, source: "briefing", reasonCode: "x" },
  ]);
  fu.recordRecommendations(db, userId, TODAY, [{ clientId: lucy, source: "sweep", reasonCode: "y" }]);
  fu.addCarry(db, userId, lucy, YESTERDAY);

  fu.resolveForClient(db, userId, lucy, "reached", NOW);

  const byClient = (id) => rows().filter((r) => r.client_id === id);
  assert.ok(byClient(lucy).length === 3 && byClient(lucy).every((r) => r.status === "reached" && r.resolved_at === NOW));
  assert.ok(byClient(sam).every((r) => r.status === "open" && r.resolved_at === null));
  assert.deepStrictEqual(open().map((r) => r.clientId), [sam]);
  assert.deepStrictEqual(fu.carriedIds(db, userId, TODAY), [], "a resolved carry is no longer carried");
});

test("resolveForClient leaves rows that are already closed, and another user's rows, alone", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  fu.dismiss(db, userId, rows()[0].id);
  fu.resolveForClient(db, userId, lucy, "reached", NOW);
  assert.equal(rows()[0].status, "expired", "an expired row is not rewritten");
  assert.equal(rows()[0].resolved_at, null);

  fu.recordRecommendations(db, userId, TODAY, [{ clientId: lucy, source: "sweep", reasonCode: "y" }]);
  fu.resolveForClient(db, otherUserId, lucy, "not_reached", NOW);
  assert.equal(rows()[1].status, "open");
});

test("resolveForClient not_reached closes the row, and rejects a status that is not a resolution", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  assert.throws(() => fu.resolveForClient(db, userId, lucy, "open", NOW));
  assert.throws(() => fu.resolveForClient(db, userId, lucy, "bogus", NOW));
  assert.equal(rows()[0].status, "open");
  fu.resolveForClient(db, userId, lucy, "not_reached", NOW);
  assert.equal(rows()[0].status, "not_reached");
  assert.deepStrictEqual(open(), []);
});

// ── logCall / reachedSince ───────────────────────────────────────────────────

test("logCall not_reached writes the row and returns its id; reachedSince does not include that client", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const id = fu.logCall(db, { userId, clientId: lucy, outcome: "not_reached", notes: "left a voicemail", nowUtc: "2026-10-29 15:00:00" });
  assert.equal(typeof id, "number");
  const row = db.prepare("SELECT * FROM contact_log WHERE id = ?").get(id);
  assert.deepStrictEqual(
    { client_id: row.client_id, user_id: row.user_id, at: row.at, outcome: row.outcome, notes: row.notes },
    { client_id: lucy, user_id: userId, at: "2026-10-29 15:00:00", outcome: "not_reached", notes: "left a voicemail" },
  );
  assert.equal(fu.reachedSince(db, userId, "2026-10-01 00:00:00").has(lucy), false);
});

test("reachedSince returns the clients reached at or after the cutoff, for that user only", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  const old = addClient(orgId, userId, "Old Contact");
  fu.logCall(db, { userId, clientId: lucy, outcome: "reached", notes: "", nowUtc: "2026-10-25 17:00:00" });
  fu.logCall(db, { userId, clientId: sam, outcome: "reached", notes: "", nowUtc: "2026-10-23 17:00:00" });
  fu.logCall(db, { userId, clientId: old, outcome: "reached", notes: "", nowUtc: "2026-10-22 23:59:59" });
  const got = fu.reachedSince(db, userId, "2026-10-23 17:00:00");
  assert.ok(got instanceof Set);
  assert.deepStrictEqual([...got].sort(), [lucy, sam].sort(), "the cutoff itself counts; just before it does not");
  assert.equal(fu.reachedSince(db, otherUserId, "2000-01-01 00:00:00").size, 0);
});

test("logCall defaults notes to '' and rejects an outcome that is not reached/not_reached", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const id = fu.logCall(db, { userId, clientId: lucy, outcome: "reached", nowUtc: NOW });
  assert.equal(db.prepare("SELECT notes FROM contact_log WHERE id = ?").get(id).notes, "");
  assert.throws(() => fu.logCall(db, { userId, clientId: lucy, outcome: "voicemail", notes: "", nowUtc: NOW }));
});

test("deleting a client removes its contact_log and recommendation rows (ON DELETE CASCADE)", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.logCall(db, { userId, clientId: lucy, outcome: "reached", notes: "", nowUtc: NOW });
  fu.recordRecommendations(db, userId, YESTERDAY, [{ clientId: lucy, source: "briefing", reasonCode: "x" }]);
  db.prepare("DELETE FROM clients WHERE id = ?").run(lucy);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contact_log").get().n, 0);
  assert.equal(rows().length, 0);
});

// ── carry ────────────────────────────────────────────────────────────────────

test("carriedIds returns a carry from yesterday but not one from today", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  const sam = addClient(orgId, userId, "Sam Cho");
  fu.addCarry(db, userId, lucy, YESTERDAY);
  fu.addCarry(db, userId, sam, TODAY);
  assert.deepStrictEqual(fu.carriedIds(db, userId, TODAY), [lucy]);
  assert.deepStrictEqual(fu.carriedIds(db, userId, "2026-10-31").sort(), [lucy, sam].sort());
});

test("addCarry twice for the same day leaves one row; it reopens a carry that was closed", () => {
  const lucy = addClient(orgId, userId, "Lucy Park");
  fu.addCarry(db, userId, lucy, YESTERDAY);
  fu.addCarry(db, userId, lucy, YESTERDAY);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].source, "carry");
  fu.resolveForClient(db, userId, lucy, "reached", NOW);
  assert.deepStrictEqual(fu.carriedIds(db, userId, TODAY), []);
  fu.addCarry(db, userId, lucy, YESTERDAY);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].status, "open");
  assert.equal(rows()[0].resolved_at, null);
  assert.deepStrictEqual(fu.carriedIds(db, userId, TODAY), [lucy]);
});

test("carriedIds lists each client once, oldest carry first, only for open carries of that user's own clients", () => {
  const a = addClient(orgId, userId, "A");
  const b = addClient(orgId, userId, "B");
  const moved = addClient(orgId, userId, "Moved");
  fu.addCarry(db, userId, b, "2026-10-28");
  fu.addCarry(db, userId, a, "2026-10-26");
  fu.addCarry(db, userId, a, "2026-10-27");
  fu.addCarry(db, userId, moved, "2026-10-27");
  db.prepare("UPDATE clients SET user_id = ? WHERE id = ?").run(otherUserId, moved);
  assert.deepStrictEqual(fu.carriedIds(db, userId, TODAY), [a, b]);
  assert.deepStrictEqual(fu.carriedIds(db, otherUserId, TODAY), []);
});

// ── recentlyRecommended ──────────────────────────────────────────────────────

test("recentlyRecommended: open and not_reached rows since the day count; reached, expired and carry rows do not", () => {
  const ids = {};
  for (const n of ["open", "notReached", "reached", "expired", "carry", "old"]) ids[n] = addClient(orgId, userId, n);
  fu.recordRecommendations(db, userId, YESTERDAY, [
    { clientId: ids.open, source: "briefing", reasonCode: "x" },
    { clientId: ids.notReached, source: "sweep", reasonCode: "x" },
    { clientId: ids.reached, source: "briefing", reasonCode: "x" },
    { clientId: ids.expired, source: "briefing", reasonCode: "x" },
  ]);
  fu.recordRecommendations(db, userId, "2026-10-20", [{ clientId: ids.old, source: "briefing", reasonCode: "x" }]);
  fu.addCarry(db, userId, ids.carry, YESTERDAY);
  fu.resolveForClient(db, userId, ids.notReached, "not_reached", NOW);
  fu.resolveForClient(db, userId, ids.reached, "reached", NOW);
  fu.dismiss(db, userId, rows().find((r) => r.client_id === ids.expired).id);

  const got = fu.recentlyRecommended(db, userId, "2026-10-27");
  assert.ok(got instanceof Set);
  assert.deepStrictEqual([...got].sort(), [ids.open, ids.notReached].sort());
  assert.equal(fu.recentlyRecommended(db, userId, YESTERDAY).has(ids.open), true, "sinceDay itself counts");
  assert.equal(fu.recentlyRecommended(db, userId, TODAY).size, 0);
  assert.equal(fu.recentlyRecommended(db, otherUserId, "2000-01-01").size, 0);
});

// ── drop lead ────────────────────────────────────────────────────────────────

test("markDropLed, then dropAlreadyLed is true for that observation and false for a later one", () => {
  assert.equal(fu.dropAlreadyLed(db, userId, "2026-10-28"), false, "nothing led yet");
  fu.markDropLed(db, userId, "2026-10-28");
  assert.equal(fu.dropAlreadyLed(db, userId, "2026-10-28"), true);
  assert.equal(fu.dropAlreadyLed(db, userId, "2026-10-29"), false);
  assert.equal(fu.dropAlreadyLed(db, otherUserId, "2026-10-28"), false, "per user");
});

test("markDropLed upserts one row per user and never moves back to an earlier observation", () => {
  fu.markDropLed(db, userId, "2026-10-28");
  fu.markDropLed(db, userId, "2026-10-29");
  fu.markDropLed(db, userId, "2026-10-27");
  const all = db.prepare("SELECT * FROM user_briefing_state WHERE user_id = ?").all(userId);
  assert.equal(all.length, 1);
  assert.equal(all[0].last_drop_obs, "2026-10-29");
  assert.equal(fu.dropAlreadyLed(db, userId, "2026-10-29"), true);
  assert.equal(fu.dropAlreadyLed(db, userId, "2026-10-30"), false);
});

// ── the migration ────────────────────────────────────────────────────────────

test("the follow-up tables are added idempotently to a database that predates them", () => {
  const { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-legacy-followups-"));
  const dbJs = JSON.stringify(path.join(__dirname, "..", "db.js"));
  const oldSchema = `
    const D = require("better-sqlite3");
    const d = new D(require("path").join(process.env.DATA_DIR, "refi-radar.db"));
    d.exec("CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'trial', trial_ends TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('broker','lo')), first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, invite_token TEXT, invite_expires TEXT, invite_accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.prepare("INSERT INTO organizations (name) VALUES ('Old Org')").run();
    d.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (1, 'broker', 'Old', 'Timer', 'old@x.co')").run();
    d.close();
  `;
  const report = `
    const db = require(${dbJs});
    const cols = (t) => db.prepare("PRAGMA table_info(" + t + ")").all().map((c) => c.name);
    console.log(JSON.stringify({
      contact_log: cols("contact_log"),
      charlie_recommendations: cols("charlie_recommendations"),
      user_briefing_state: cols("user_briefing_state"),
      users: db.prepare("SELECT first_name FROM users").all().length,
    }));
  `;
  const run = (script) => execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
  }).trim().split("\n").pop();
  try {
    run(oldSchema);
    const first = JSON.parse(run(report));          // first load of db.js: the tables are created
    const second = JSON.parse(run(report));         // second load: CREATE TABLE IF NOT EXISTS must not fail or duplicate
    for (const result of [first, second]) {
      assert.deepStrictEqual(result.contact_log, ["id", "client_id", "user_id", "at", "outcome", "notes"]);
      assert.deepStrictEqual(result.charlie_recommendations, [
        "id", "user_id", "client_id", "day", "source", "reason_code", "due_at", "status", "ask_count", "asked_at", "resolved_at",
      ]);
      assert.deepStrictEqual(result.user_briefing_state, ["user_id", "last_drop_obs"]);
      assert.equal(result.users, 1, "existing users are untouched");
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
