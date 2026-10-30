"use strict";
// Calendar follow-up matching (Task 4): which of the user's OWN clients an event title names (clientsInText in
// lib/assistant/tools.js), and collectCalendarFollowUps (lib/assistant/calendarFollowUps.js), which reads yesterday's and today's
// events through ctx.google and records a 'calendar' recommendation due when each call ends. A fake ctx.google stands in for
// Google: nothing here touches the network.
const os = require("os");
const path = require("path");
const fs = require("fs");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-calendar-followups-"));
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const { clientsInText, getCalendarTool, namesClient } = require("../lib/assistant/tools");
const { collectCalendarFollowUps } = require("../lib/assistant/calendarFollowUps");
const fu = require("../lib/assistant/followups");

test.after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ── seed data ────────────────────────────────────────────────────────────────

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, 'T', 'User', ?)"
).run(orgId, role, email).lastInsertRowid);
const addClient = (orgId, userId, name) => Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value)
  VALUES (?, ?, ?, 7.5, 400000, 600000)
`).run(orgId, userId, name).lastInsertRowid);

const orgId = addOrg("Calendar Followup Org");
const userId = addUser(orgId, "broker", "broker@calfollow.test");
const colleagueId = addUser(orgId, "lo", "lo@calfollow.test");

test.beforeEach(() => {
  db.prepare("DELETE FROM charlie_recommendations").run();
  db.prepare("DELETE FROM clients").run();
});

const rows = () => db.prepare("SELECT * FROM charlie_recommendations ORDER BY id").all();
const own = (...names) => names.map((name, i) => ({ id: i + 1, name }));
const idsOf = (found) => found.map((c) => c.id);

// ── clientsInText ────────────────────────────────────────────────────────────

test("clientsInText: a full name in a title finds that client, as {id, name}", () => {
  assert.deepStrictEqual(clientsInText("Follow-up: Lucy Tran", own("Lucy Tran", "Grace Okafor")), [{ id: 1, name: "Lucy Tran" }]);
});

test("clientsInText: a colleague's client is not found, because only the user's own clients are passed in (team scope)", () => {
  const mine = own("Grace Okafor");
  assert.deepStrictEqual(clientsInText("Follow-up: Lucy Tran", mine), []);
});

test("clientsInText: a surname alone finds the client; a first name alone does not", () => {
  const mine = own("Lucy Tran");
  assert.deepStrictEqual(idsOf(clientsInText("Tran", mine)), [1]);
  assert.deepStrictEqual(idsOf(clientsInText("Call with the Trans? no, Tran closing", mine)), [1]);
  assert.deepStrictEqual(clientsInText("Lucy", mine), []);
  assert.deepStrictEqual(clientsInText("Lunch with Lucy at noon", mine), []);
});

test("clientsInText: whole words only, any case, accents folded, same as the screens", () => {
  const mine = own("Grace Brown", "Ana Martínez");
  assert.deepStrictEqual(clientsInText("the Browns are late", mine), []);
  assert.deepStrictEqual(idsOf(clientsInText("BROWN refi", mine)), [1]);
  assert.deepStrictEqual(idsOf(clientsInText("call martinez", mine)), [2]);
});

test("clientsInText: a suffix, a surname-first filing and a hyphenated surname are found as namesClient finds them", () => {
  const mine = own("Sam Lee Jr.", "Okafor, Grace", "Priya Wu-Okonkwo");
  assert.deepStrictEqual(idsOf(clientsInText("Lee closing", mine)), [1]);
  assert.deepStrictEqual(idsOf(clientsInText("Okafor review", mine)), [2]);
  assert.deepStrictEqual(idsOf(clientsInText("Okonkwo", mine)), [3]);
  assert.deepStrictEqual(idsOf(clientsInText("Wu", mine)), [3]);
  assert.deepStrictEqual(idsOf(clientsInText("Priya Wu-Okonkwo", mine)), [3]);
});

test("clientsInText: two clients in one title are both found; two clients sharing a surname are both found, in book order", () => {
  const mine = own("Ann Smith", "Bo Jones", "Cy Smith");
  assert.deepStrictEqual(idsOf(clientsInText("Jones and Smith", mine)), [1, 2, 3]);
  assert.deepStrictEqual(idsOf(clientsInText("Smith", mine)), [1, 3]);
  assert.deepStrictEqual(idsOf(clientsInText("Jones", mine)), [2]);
});

test("clientsInText: a name with no word in it is found whole, and nothing else matches by accident", () => {
  const mine = [{ id: 7, name: "&&" }, { id: 8, name: "Lucy Tran" }];
  assert.deepStrictEqual(idsOf(clientsInText("Closing && fees", mine)), [7]);
  assert.deepStrictEqual(clientsInText("Closing fees", mine), []);
});

test("clientsInText: the same clients as namesClient screens, for each name in a mixed book", () => {
  const names = ["Lucy Tran", "Okafor, Grace", "Sam Lee Jr.", "Priya Wu-Okonkwo", "Ana Martínez", "O'Brien Kelly"];
  const mine = own(...names);
  const orgClients = names.map((name) => addClient(orgId, userId, name));
  assert.equal(orgClients.length, names.length);
  const ctx = { user: { id: userId, org_id: orgId }, db };
  for (const text of ["Tran", "Lucy", "Okafor", "Grace", "Lee", "Sam", "Okonkwo", "Wu", "Martinez", "Ana", "Kelly", "O'Brien", "Brien", "lunch", ""]) {
    assert.equal(clientsInText(text, mine).length > 0, namesClient(text, ctx), `"${text}"`);
  }
});

test("clientsInText: nothing usable in, nothing out", () => {
  assert.deepStrictEqual(clientsInText("", own("Lucy Tran")), []);
  assert.deepStrictEqual(clientsInText("Tran", []), []);
  assert.deepStrictEqual(clientsInText(null, own("Lucy Tran")), []);
  assert.deepStrictEqual(clientsInText("Tran", null), []);
  assert.deepStrictEqual(clientsInText("Tran", [null, { id: 3, name: null }, { id: 4 }, { id: 5, name: "Lucy Tran" }]).map((c) => c.id), [5]);
});

test("clientsInText: a 4,000-character hyphen or apostrophe chain is read in linear time, even against a long hyphenated name", () => {
  const hyphens = "a-".repeat(2000);
  const apostrophes = "a'".repeat(2000);
  const timed = (text, mine) => {
    const started = process.hrtime.bigint();
    const found = clientsInText(text, mine);
    return { found, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  // a name word of 150 pieces joined by ' (its pieces are not words of their own), so a text chain walks deep and never matches
  const longApostrophe = "Zed " + "a'".repeat(150) + "z";
  // one joined by -: each of its parts is a surname of its own, so the chain does name this client
  const longHyphen = "Zed " + "a-".repeat(150) + "z";
  const cases = [
    [hyphens, own("Lucy Tran", "Aa Bee"), []],
    [hyphens, own(longApostrophe, "Lucy Tran", "A-B-C D-E-F"), []],
    [apostrophes, own(longApostrophe, "Lucy Tran"), []],
    [hyphens, own(longHyphen, "Lucy Tran"), [1]],
    [`${hyphens}Tran-${hyphens}`, own("Lucy Tran"), [1]],
  ];
  for (const [text, mine, expected] of cases) {
    const { found, ms } = timed(text, mine);
    assert.deepStrictEqual(idsOf(found), expected);
    assert.ok(ms < 200, `took ${ms.toFixed(1)} ms`);
  }
});

test("clientsInText: a thousand clients sharing one surname are found without a quadratic walk", () => {
  const mine = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `Person${i} Smith` }));
  const text = "Smith-".repeat(600) + "Smith";
  const started = process.hrtime.bigint();
  const found = clientsInText(text, mine);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(found.length, 1000);
  assert.ok(ms < 200, `took ${ms.toFixed(1)} ms`);
});

// ── a fake ctx.google ────────────────────────────────────────────────────────

const PHX = "America/Phoenix";
const TODAY = "2026-10-30";
const YESTERDAY = "2026-10-29";
const at = (date, hour, minute) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour + 7, minute);   // Phoenix is UTC-7 all year
};
const timed = (title, date, hour, minute) => ({
  title, start: "9:00 AM", end: "10:30 AM", allDay: false, endAt: at(date, hour, minute),
});

// A stand-in for googleFor(): connection() plus listDay, recording the dates it was asked for.
function fakeGoogle({ connection = { timeZone: PHX, googleEmail: "ann@gmail.example" }, byDate = {}, listed } = {}) {
  const asked = [];
  return {
    asked,
    connection: () => connection,
    listDay: async ({ date }) => {
      asked.push(date);
      return listed ? listed(date) : { events: byDate[date] || [] };
    },
  };
}
const collect = (google, extra = {}) => collectCalendarFollowUps({ google }, { localDate: TODAY, db, userId, ...extra });

// ── collectCalendarFollowUps ─────────────────────────────────────────────────

test("collectCalendarFollowUps: yesterday's \"Follow-up: Lucy Tran\" ending 10:30 local is one calendar row due at that instant in UTC", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [timed("Follow-up: Lucy Tran", YESTERDAY, 10, 30)] } });
  assert.strictEqual(await collect(google), 1);
  assert.deepStrictEqual(google.asked, [YESTERDAY, TODAY]);
  const [row, ...rest] = rows();
  assert.equal(rest.length, 0);
  assert.equal(row.user_id, userId);
  assert.equal(row.client_id, lucy);
  assert.equal(row.day, YESTERDAY);
  assert.equal(row.source, "calendar");
  assert.equal(row.reason_code, "calendar");
  assert.equal(row.status, "open");
  assert.equal(row.due_at, "2026-10-29 17:30:00");   // 10:30 in Phoenix is 17:30 UTC
});

test("collectCalendarFollowUps: today's events are read too, each recorded on its own day", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  const grace = addClient(orgId, userId, "Grace Okafor");
  const google = fakeGoogle({ byDate: {
    [YESTERDAY]: [timed("Lucy Tran closing", YESTERDAY, 9, 0)],
    [TODAY]: [timed("Okafor refi review", TODAY, 14, 15)],
  } });
  assert.strictEqual(await collect(google), 2);
  const byClient = Object.fromEntries(rows().map((r) => [r.client_id, r]));
  assert.deepStrictEqual([byClient[lucy].day, byClient[lucy].due_at], [YESTERDAY, "2026-10-29 16:00:00"]);
  assert.deepStrictEqual([byClient[grace].day, byClient[grace].due_at], [TODAY, "2026-10-30 21:15:00"]);
});

test("collectCalendarFollowUps: yesterday is worked out in code across a month and a year end", async () => {
  addClient(orgId, userId, "Lucy Tran");
  for (const [localDate, yesterday] of [["2026-11-01", "2026-10-31"], ["2027-01-01", "2026-12-31"], ["2028-03-01", "2028-02-29"]]) {
    const google = fakeGoogle();
    await collectCalendarFollowUps({ google }, { localDate, db, userId });
    assert.deepStrictEqual(google.asked, [yesterday, localDate]);
  }
});

test("collectCalendarFollowUps: the same call twice leaves one row, and the later event of a client that day sets the due time", async () => {
  addClient(orgId, userId, "Lucy Tran");
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [
    timed("Lucy Tran call", YESTERDAY, 15, 0),
    timed("Lucy Tran docs", YESTERDAY, 11, 0),
  ] } });
  assert.strictEqual(await collect(google), 1);
  assert.strictEqual(await collect(google), 1);
  const all = rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].due_at, "2026-10-29 22:00:00");
});

test("collectCalendarFollowUps: running again never reopens a row the broker has dealt with", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [timed("Lucy Tran call", YESTERDAY, 10, 0)] } });
  await collect(google);
  fu.resolveForClient(db, userId, lucy, "reached", "2026-10-30 16:00:00");
  await collect(google);
  assert.deepStrictEqual(rows().map((r) => r.status), ["reached"]);
});

test("collectCalendarFollowUps: an event listed on both days (it spans midnight) is one row, on the first day", async () => {
  addClient(orgId, userId, "Lucy Tran");
  const spanning = { title: "Lucy Tran late call", start: "11:00 PM", end: "1:00 AM", allDay: false, endAt: at(TODAY, 1, 0) };
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [spanning], [TODAY]: [spanning] } });
  assert.strictEqual(await collect(google), 1);
  assert.deepStrictEqual(rows().map((r) => [r.day, r.due_at]), [[YESTERDAY, "2026-10-30 08:00:00"]]);
});

test("collectCalendarFollowUps: only the user's own clients match, never a colleague's (team scope)", async () => {
  addClient(orgId, colleagueId, "Lucy Tran");
  const mine = addClient(orgId, userId, "Grace Okafor");
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [
    timed("Follow-up: Lucy Tran", YESTERDAY, 10, 0),
    timed("Follow-up: Grace Okafor", YESTERDAY, 11, 0),
  ] } });
  assert.strictEqual(await collect(google), 1);
  assert.deepStrictEqual(rows().map((r) => r.client_id), [mine]);
});

test("collectCalendarFollowUps: an all-day event, an event with no end, a title naming nobody and a first name alone record nothing", async () => {
  addClient(orgId, userId, "Lucy Tran");
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [
    { title: "Tran family out of town", start: null, end: null, allDay: true, endAt: null },
    { title: "Tran call", start: "9:00 AM", end: "9:30 AM", allDay: false },
    timed("Team lunch", YESTERDAY, 12, 0),
    timed("Coffee with Lucy", YESTERDAY, 8, 0),
    { title: 42, start: "9:00 AM", end: "9:30 AM", allDay: false, endAt: at(YESTERDAY, 9, 30) },
  ] } });
  assert.strictEqual(await collect(google), 0);
  assert.equal(rows().length, 0);
});

test("collectCalendarFollowUps: a user with no clients asks Google nothing", async () => {
  const google = fakeGoogle({ byDate: { [YESTERDAY]: [timed("Lucy Tran", YESTERDAY, 10, 0)] } });
  assert.strictEqual(await collect(google), 0);
  assert.deepStrictEqual(google.asked, []);
});

test("collectCalendarFollowUps: not connected, or no Google at all, returns 0 and reads nothing", async () => {
  addClient(orgId, userId, "Lucy Tran");
  for (const connection of [{ code: "not_connected" }, { code: "reconnect" }]) {
    const google = fakeGoogle({ connection });
    assert.strictEqual(await collect(google), 0);
    assert.deepStrictEqual(google.asked, []);
  }
  assert.strictEqual(await collectCalendarFollowUps({}, { localDate: TODAY, db, userId }), 0);
  assert.strictEqual(await collectCalendarFollowUps(undefined, { localDate: TODAY, db, userId }), 0);
  assert.equal(rows().length, 0);
});

test("collectCalendarFollowUps: any Google failure returns 0, never throws, and records nothing", async () => {
  addClient(orgId, userId, "Lucy Tran");
  const good = [timed("Lucy Tran call", YESTERDAY, 10, 0)];
  const realError = console.error;
  console.error = () => {};
  try {
    const cases = {
      "a code": (date) => (date === YESTERDAY ? { events: good } : { code: "reconnect" }),
      "an error": (date) => (date === YESTERDAY ? { events: good } : { error: "Google Calendar could not be read" }),
      "no event list": (date) => (date === YESTERDAY ? { events: good } : { events: "nope" }),
      "an empty reply": (date) => (date === YESTERDAY ? { events: good } : undefined),
      "a throw": (date) => { if (date === TODAY) throw new Error("boom"); return { events: good }; },
    };
    for (const [label, listed] of Object.entries(cases)) {
      assert.strictEqual(await collect(fakeGoogle({ listed })), 0, label);
      assert.equal(rows().length, 0, label);
    }
    // a connection() that throws, and a bad date
    const throwing = { connection: () => { throw new Error("db down"); }, listDay: async () => ({ events: [] }) };
    assert.strictEqual(await collect(throwing), 0);
    assert.strictEqual(await collect(fakeGoogle(), { localDate: "friday" }), 0);
    assert.strictEqual(await collect(fakeGoogle(), { localDate: undefined }), 0);
  } finally {
    console.error = realError;
  }
});

test("collectCalendarFollowUps: a calendar row is not due until its call has ended (openFollowUps)", async () => {
  const lucy = addClient(orgId, userId, "Lucy Tran");
  const google = fakeGoogle({ byDate: { [TODAY]: [timed("Lucy Tran call", TODAY, 10, 30)] } });
  await collect(google);
  const due = (nowUtc) => fu.openFollowUps(db, userId, { localDate: TODAY, localHour: 9, nowUtc });
  assert.deepStrictEqual(due("2026-10-30 17:29:59"), []);
  assert.deepStrictEqual(due("2026-10-30 17:30:00").map((r) => [r.clientId, r.source]), [[lucy, "calendar"]]);
});

// ── the model-facing calendar answer keeps its four keys ─────────────────────

test("getCalendarTool: events carrying endAt still reach the model as exactly {title, start, end, allDay}", async () => {
  const google = fakeGoogle({ byDate: { [TODAY]: [
    timed("Closing", TODAY, 10, 30),
    { title: "Out of town", start: null, end: null, allDay: true, endAt: null },
  ] } });
  const r = await getCalendarTool({}, { google, now: at(TODAY, 8, 0) });
  assert.equal(r.data.date, TODAY);
  assert.equal(r.data.events.length, 2);
  for (const e of r.data.events) assert.deepStrictEqual(Object.keys(e).sort(), ["allDay", "end", "start", "title"]);
  assert.ok(!JSON.stringify(r).includes("endAt"));
});
