"use strict";
// After Charlie cancels or moves an event, the "How did the call with <client> go?" follow-up must follow the calendar:
// reconcileCalendarFollowUps (lib/assistant/calendarFollowUps.js) brings the day's open 'calendar' rows in line with the live
// day: a cancelled call is no longer asked about, a moved one is asked about when it now ends. A fake ctx.google stands in for
// Google: nothing here touches the network.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-calendar-followups-change-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { collectCalendarFollowUps, reconcileCalendarFollowUps } = require("../lib/assistant/calendarFollowUps");
const fu = require("../lib/assistant/followups");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email) => Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, 'T', 'User', ?)").run(orgId, role, email).lastInsertRowid);
const addClient = (orgId, userId, name) => Number(db.prepare("INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (?, ?, ?, 7.5, 400000, 600000)").run(orgId, userId, name).lastInsertRowid);
const orgId = addOrg("Calendar Change Followup Org");
const userId = addUser(orgId, "broker", "broker@calchange.test");

test.beforeEach(() => {
  db.prepare("DELETE FROM charlie_recommendations").run();
  db.prepare("DELETE FROM clients").run();
});

const rows = () => db.prepare("SELECT client_id AS clientId, day, source, status, due_at AS dueAt FROM charlie_recommendations ORDER BY id").all();
const PHX = "America/Phoenix";
const TODAY = "2026-10-30";
const TOMORROW = "2026-10-31";
const at = (date, hour, minute) => { const [y, m, d] = date.split("-").map(Number); return Date.UTC(y, m - 1, d, hour + 7, minute); };   // Phoenix is UTC-7
const sqlite = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const call = (title, date, hour, minute) => ({ title, start: "9:00 AM", end: "10:00 AM", allDay: false, endAt: at(date, hour, minute) });
function fakeGoogle(byDate, connection = { timeZone: PHX, googleEmail: "ann@gmail.example" }) {
  const asked = [];
  return { asked, connection: () => connection, listDay: async ({ date }) => { asked.push(date); const v = byDate[date]; return typeof v === "function" ? v() : { events: v || [] }; } };
}
const collect = (google) => collectCalendarFollowUps({ google }, { localDate: TODAY, db, userId });
const reconcile = (google, days) => reconcileCalendarFollowUps({ google }, { localDate: TODAY, days, db, userId });

test("a call that was cancelled is no longer asked about: its open calendar row expires", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  await collect(fakeGoogle({ [TODAY]: [call("Follow-up: Lucy Tran", TODAY, 10, 30)] }));
  assert.deepStrictEqual(rows().map((r) => [r.clientId, r.status, r.dueAt]), [[lucy, "open", sqlite(at(TODAY, 10, 30))]]);
  const google = fakeGoogle({ [TODAY]: [] });                 // the live day after the cancel
  assert.equal(await reconcile(google, [TODAY]), true);
  assert.deepStrictEqual(rows().map((r) => r.status), ["expired"]);
  assert.deepStrictEqual(google.asked, [TODAY]);
  const nowAfter = sqlite(at(TODAY, 11, 0));
  assert.deepStrictEqual(fu.openFollowUps(db, userId, { localDate: TODAY, localHour: 11, nowUtc: nowAfter }), []);
});

test("a call that was moved is asked about when it now ends", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  await collect(fakeGoogle({ [TODAY]: [call("Follow-up: Lucy Tran", TODAY, 10, 30)] }));
  await reconcile(fakeGoogle({ [TODAY]: [call("Follow-up: Lucy Tran", TODAY, 15, 0)] }), [TODAY]);
  assert.deepStrictEqual(rows().map((r) => [r.clientId, r.status, r.dueAt]), [[lucy, "open", sqlite(at(TODAY, 15, 0))]]);
  assert.deepStrictEqual(fu.openFollowUps(db, userId, { localDate: TODAY, localHour: 11, nowUtc: sqlite(at(TODAY, 11, 0)) }), [], "not asked at the old end time");
  assert.equal(fu.openFollowUps(db, userId, { localDate: TODAY, localHour: 16, nowUtc: sqlite(at(TODAY, 16, 0)) }).length, 1, "asked once it has ended");
});

test("a call moved to another day leaves today's list, and one moved INTO today joins it", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  const grace = addClient(orgId, userId, "Grace Okafor");
  await collect(fakeGoogle({ [TODAY]: [call("Follow-up: Lucy Tran", TODAY, 10, 30)] }));
  const g = fakeGoogle({ [TODAY]: [call("Grace Okafor closing", TODAY, 14, 0)], [TOMORROW]: [call("Follow-up: Lucy Tran", TOMORROW, 10, 30)] });
  await reconcile(g, [TODAY, TOMORROW]);
  const by = Object.fromEntries(rows().map((r) => [r.clientId, r]));
  assert.equal(by[lucy].status, "expired");
  assert.deepStrictEqual([by[grace].status, by[grace].dueAt, by[grace].day], ["open", sqlite(at(TODAY, 14, 0)), TODAY]);
  assert.deepStrictEqual(g.asked, [TODAY], "tomorrow is not recorded until tomorrow: nothing is read for it");
});

test("a client with another call that day keeps their row, due when the later one ends; rows already answered are left alone", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  const grace = addClient(orgId, userId, "Grace Okafor");
  await collect(fakeGoogle({ [TODAY]: [call("Lucy Tran call", TODAY, 9, 0), call("Lucy Tran closing", TODAY, 16, 0), call("Grace Okafor call", TODAY, 10, 0)] }));
  db.prepare("UPDATE charlie_recommendations SET status = 'reached' WHERE client_id = ?").run(grace);
  await reconcile(fakeGoogle({ [TODAY]: [call("Lucy Tran call", TODAY, 9, 0)] }), [TODAY]);   // the closing was cancelled; Grace's call too
  const by = Object.fromEntries(rows().map((r) => [r.clientId, r]));
  assert.deepStrictEqual([by[lucy].status, by[lucy].dueAt], ["open", sqlite(at(TODAY, 9, 0))]);
  assert.equal(by[grace].status, "reached", "an answered row is history");
});

test("nothing is changed when the day cannot be read, Google is not connected, or the day is not today or yesterday; it never throws", async () => {
  addClient(orgId, userId, "Lucy Tran");
  await collect(fakeGoogle({ [TODAY]: [call("Follow-up: Lucy Tran", TODAY, 10, 30)] }));
  const before = JSON.stringify(rows());
  for (const google of [
    fakeGoogle({ [TODAY]: () => ({ error: "Google Calendar could not be read" }) }),
    fakeGoogle({ [TODAY]: () => ({ code: "reconnect" }) }),
    fakeGoogle({ [TODAY]: () => { throw new Error("boom"); } }),
    fakeGoogle({}, { code: "not_connected" }),
    null,
  ]) {
    assert.equal(await reconcileCalendarFollowUps({ google }, { localDate: TODAY, days: [TODAY], db, userId }), false);
    assert.equal(JSON.stringify(rows()), before);
  }
  const far = fakeGoogle({ "2026-12-01": [] });
  assert.equal(await reconcile(far, ["2026-12-01"]), false);
  assert.deepStrictEqual(far.asked, [], "a far day was never recorded: nothing to reconcile, nothing read");
  assert.equal(JSON.stringify(rows()), before);
});
