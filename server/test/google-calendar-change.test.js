"use strict";
// Cancelling and moving an event (lib/google/calendar.js listDayDetailed / getEvent / deleteEvent / patchEvent, and the googleFor
// adapter's wrappers of them). Every outbound call goes through a scripted fake fetch that records its requests: NO test here
// touches the network. All values are fake.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-google-change-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "test-client-" + Math.random().toString(16).slice(2) + ".apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret-" + Math.random().toString(16).slice(2);
process.env.GOOGLE_REDIRECT_URI = "http://localhost:8080/api/google/callback";
process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString("base64");

const test = require("node:test");
const { after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const db = require("../db");
const gcrypto = require("../lib/google/crypto");
const oauth = require("../lib/google/oauth");
const calendar = require("../lib/google/calendar");
const { googleFor } = require("../lib/google");

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const PHX = "America/Phoenix";
const NOW = Date.UTC(2026, 9, 27, 15, 0);   // Tuesday 2026-10-27, 08:00 in Phoenix
const ACCESS = "ya29.change-access-" + Math.random().toString(16).slice(2);
const REFRESH = "1//change-refresh-" + Math.random().toString(16).slice(2);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = (status) => new Response(null, { status });
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body, json: body && body.startsWith("{") ? JSON.parse(body) : undefined };
    calls.push(call);
    return handler(call);
  };
  fn.calls = calls;
  return fn;
}

const logged = [];
const realConsoleError = console.error;
console.error = (...args) => { logged.push(args.map(String).join(" ")); };
after(() => {
  console.error = realConsoleError;
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Alpha')").run().lastInsertRowid);
const userId = Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'Ann', 'User', 'ann@a.co')").run(orgId).lastInsertRowid);
function seedConnection() {
  db.prepare(`
    INSERT OR REPLACE INTO google_connections
      (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc, status)
    VALUES (?, 'ann@gmail.example', ?, ?, ?, ?, ?, 'connected')
  `).run(userId, PHX, oauth.SCOPES.join(" "), gcrypto.encrypt(ACCESS), NOW + 3_600_000, gcrypto.encrypt(REFRESH));
}
beforeEach(() => { db.prepare("DELETE FROM google_connections").run(); logged.length = 0; });

const mine = { self: true };
const item = (over = {}) => ({
  id: "evtone12345", etag: '"3100000000000000"', summary: "Walkthrough with Sam", status: "confirmed",
  start: { dateTime: "2026-10-28T10:00:00-07:00" }, end: { dateTime: "2026-10-28T10:30:00-07:00" },
  organizer: mine, creator: mine, ...over,
});

// ── listDayDetailed ──────────────────────────────────────────────────────────

test("listDayDetailed: asks for the extra code-only fields, and for no guest address", async () => {
  const fetchFn = fakeFetch(() => json({ items: [] }));
  await calendar.listDayDetailed(ACCESS, { date: "2026-10-28", timeZone: PHX }, fetchFn);
  const url = new URL(fetchFn.calls[0].url);
  const fields = url.searchParams.get("fields");
  for (const need of ["id", "etag", "summary", "status", "start", "end", "attendees", "recurringEventId", "organizer", "locked", "eventType"]) {
    assert.ok(fields.includes(need), `asks for ${need}`);
  }
  assert.ok(!/email|description|location|htmlLink|hangout|displayName/i.test(fields), "no address, name, description or link");
  assert.equal(url.searchParams.get("singleEvents"), "true");
});

test("listDayDetailed: id, etag and the instants for code; guests, repeating and whose it is worked out from Google's fields", async () => {
  const fetchFn = fakeFetch(() => json({
    items: [
      item(),
      item({ id: "evttwo12345", summary: "Call with Pat", attendees: [{ self: true, responseStatus: "accepted" }] }),                 // only the broker
      item({ id: "evtthree1234", summary: "Lunch", attendees: [{ self: true }, { responseStatus: "needsAction" }] }),               // a guest
      item({ id: "evtfour12345", summary: "Many", attendeesOmitted: true }),
      item({ id: "evtfive12345", summary: "Standup", recurringEventId: "series12345" }),
      item({ id: "evtsix123456", summary: "Theirs", organizer: { self: false }, creator: { self: false } }),
      item({ id: "evtseven1234", summary: "Locked", locked: true }),
      item({ id: "evteight1234", summary: "Birthday", eventType: "birthday" }),
      { id: "evtnine12345", etag: '"9"', summary: "Out of town", status: "confirmed", start: { date: "2026-10-28" }, end: { date: "2026-10-29" }, organizer: mine },
      item({ id: "evtgone12345", status: "cancelled" }),
    ],
  }));
  const out = await calendar.listDayDetailed(ACCESS, { date: "2026-10-28", timeZone: PHX }, fetchFn);
  const by = Object.fromEntries(out.events.map((e) => [e.id, e]));
  assert.equal(out.events.length, 9, "a cancelled one is left out");
  assert.deepEqual(by.evtone12345, {
    id: "evtone12345", etag: '"3100000000000000"', title: "Walkthrough with Sam", start: "10:00 AM", end: "10:30 AM", allDay: false,
    startAt: Date.UTC(2026, 9, 28, 17, 0), endAt: Date.UTC(2026, 9, 28, 17, 30), startDate: null,
    guests: false, repeats: false, mine: true,
  });
  assert.equal(by.evttwo12345.guests, false, "the broker alone is no guest");
  assert.equal(by.evtthree1234.guests, true);
  assert.equal(by.evtfour12345.guests, true, "a list Google left out counts as guests");
  assert.equal(by.evtfive12345.repeats, true);
  assert.equal(by.evtsix123456.mine, false);
  assert.equal(by.evtseven1234.mine, false, "Google says it can't be edited");
  assert.equal(by.evteight1234.mine, false, "not an ordinary event");
  assert.equal(by.evtnine12345.allDay, true);
  assert.equal(by.evtnine12345.startAt, null);
  assert.equal(by.evtnine12345.startDate, "2026-10-28");
});

test("listDayDetailed: a series' own event (recurrence) repeats too; failures are fixed messages; a refusal is the reconnect code", async () => {
  const rec = await calendar.listDayDetailed(ACCESS, { date: "2026-10-28", timeZone: PHX }, fakeFetch(() => json({ items: [item({ recurrence: ["RRULE:FREQ=WEEKLY"] })] })));
  assert.equal(rec.events[0].repeats, true);
  assert.deepEqual(await calendar.listDayDetailed(ACCESS, { date: "2026-10-28", timeZone: PHX }, fakeFetch(() => json({}, 500))), { error: "Google Calendar could not be read" });
  assert.deepEqual(await calendar.listDayDetailed(ACCESS, { date: "2026-10-28", timeZone: PHX }, fakeFetch(() => json({}, 401))), { code: "reconnect" });
  assert.deepEqual(await calendar.listDayDetailed(ACCESS, { date: "2026-10-28", timeZone: PHX }, fakeFetch(() => { throw new Error("boom ya29.SECRET"); })), { error: "Google Calendar could not be read" });
  assert.ok(logged.every((l) => !l.includes("SECRET")));
});

// ── deleteEvent ──────────────────────────────────────────────────────────────

test("deleteEvent: DELETE on the event with sendUpdates=none and If-Match", async () => {
  const fetchFn = fakeFetch(() => empty(204));
  assert.deepEqual(await calendar.deleteEvent(ACCESS, { id: "evtone12345", etag: '"3100000000000000"' }, fetchFn), { done: true });
  const [call] = fetchFn.calls;
  assert.equal(call.method, "DELETE");
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, `${EVENTS}/evtone12345`);
  assert.equal(url.searchParams.get("sendUpdates"), "none");
  assert.equal(call.headers["If-Match"], '"3100000000000000"');
  assert.equal(call.headers.Authorization, `Bearer ${ACCESS}`);
});

test("deleteEvent: 412 is changed, 404 and 410 are gone, an auth refusal is reconnect, the rest a fixed error; a bad id or etag sends nothing", async () => {
  const run = (handler) => calendar.deleteEvent(ACCESS, { id: "evtone12345", etag: '"1"' }, fakeFetch(handler));
  assert.deepEqual(await run(() => json({}, 412)), { changed: true });
  assert.deepEqual(await run(() => json({}, 404)), { gone: true });
  assert.deepEqual(await run(() => json({}, 410)), { gone: true });
  assert.deepEqual(await run(() => json({}, 401)), { code: "reconnect" });
  assert.deepEqual(await run(() => json({}, 500)), { error: "Google Calendar couldn't make that change" });
  assert.deepEqual(await run(() => { throw new Error("socket ya29.SECRET"); }), { error: "Google Calendar couldn't make that change" });
  const none = fakeFetch(() => { throw new Error("no request expected"); });
  assert.deepEqual(await calendar.deleteEvent(ACCESS, { id: "../calendars", etag: '"1"' }, none), { error: "Google Calendar couldn't make that change" });
  assert.deepEqual(await calendar.deleteEvent(ACCESS, { id: "evtone12345", etag: "" }, none), { error: "Google Calendar couldn't make that change" });
  assert.deepEqual(await calendar.deleteEvent(ACCESS, { id: "evtone12345" }, none), { error: "Google Calendar couldn't make that change" });
  assert.equal(none.calls.length, 0);
  assert.ok(logged.every((l) => !l.includes("SECRET")));
});

// ── patchEvent ───────────────────────────────────────────────────────────────

test("patchEvent: PATCH with the start and end only, in the calendar's zone, sendUpdates=none and If-Match", async () => {
  const fetchFn = fakeFetch(() => json({ id: "evtone12345" }));
  const startAt = Date.UTC(2026, 9, 29, 21, 0);   // 2:00 PM in Phoenix
  assert.deepEqual(await calendar.patchEvent(ACCESS, { id: "evtone12345", etag: '"7"', startAt, endAt: startAt + 30 * 60_000, timeZone: PHX }, fetchFn), { done: true });
  const [call] = fetchFn.calls;
  assert.equal(call.method, "PATCH");
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, `${EVENTS}/evtone12345`);
  assert.equal(url.searchParams.get("sendUpdates"), "none");
  assert.equal(call.headers["If-Match"], '"7"');
  assert.deepEqual(call.json, {
    start: { dateTime: "2026-10-29T21:00:00Z", timeZone: PHX },
    end: { dateTime: "2026-10-29T21:30:00Z", timeZone: PHX },
  });
});

test("patchEvent: the same answers as deleteEvent; a bad instant or zone sends nothing", async () => {
  const startAt = Date.UTC(2026, 9, 29, 21, 0);
  const move = { id: "evtone12345", etag: '"7"', startAt, endAt: startAt + 1_800_000, timeZone: PHX };
  const run = (handler, over = {}) => calendar.patchEvent(ACCESS, { ...move, ...over }, fakeFetch(handler));
  assert.deepEqual(await run(() => json({}, 412)), { changed: true });
  assert.deepEqual(await run(() => json({}, 404)), { gone: true });
  assert.deepEqual(await run(() => json({}, 410)), { gone: true });
  assert.deepEqual(await run(() => json({}, 403)), { error: "Google Calendar couldn't make that change" }, "a 403 that is not an auth refusal");
  assert.deepEqual(await run(() => json({}, 401)), { code: "reconnect" });
  const none = fakeFetch(() => { throw new Error("no request expected"); });
  for (const over of [{ endAt: startAt }, { startAt: "soon" }, { timeZone: "" }, { etag: undefined }]) {
    assert.deepEqual(await calendar.patchEvent(ACCESS, { ...move, ...over }, none), { error: "Google Calendar couldn't make that change" });
  }
  assert.equal(none.calls.length, 0);
});

// ── getEvent ─────────────────────────────────────────────────────────────────

test("getEvent: the start and end instants of one event, asked for nothing else", async () => {
  const fetchFn = fakeFetch(() => json({ id: "evtone12345", status: "confirmed", start: { dateTime: "2026-10-29T14:00:00-07:00" }, end: { dateTime: "2026-10-29T14:30:00-07:00" } }));
  assert.deepEqual(await calendar.getEvent(ACCESS, { id: "evtone12345" }, fetchFn), { startAt: Date.UTC(2026, 9, 29, 21, 0), endAt: Date.UTC(2026, 9, 29, 21, 30) });
  const url = new URL(fetchFn.calls[0].url);
  assert.equal(url.origin + url.pathname, `${EVENTS}/evtone12345`);
  assert.equal(url.searchParams.get("fields"), "status,start,end");
  assert.deepEqual(await calendar.getEvent(ACCESS, { id: "evtone12345" }, fakeFetch(() => json({}, 404))), { gone: true });
  assert.deepEqual(await calendar.getEvent(ACCESS, { id: "evtone12345" }, fakeFetch(() => json({ status: "cancelled" }))), { gone: true });
  assert.deepEqual(await calendar.getEvent(ACCESS, { id: "evtone12345" }, fakeFetch(() => json({}, 500))), { error: "Google Calendar could not be read" });
  assert.deepEqual(await calendar.getEvent(ACCESS, { id: "evtone12345" }, fakeFetch(() => json({}, 401))), { code: "reconnect" });
});

// ── the adapter ──────────────────────────────────────────────────────────────

test("googleFor: listDayDetailed, deleteEvent, patchEvent and getEvent need the token; a refusal flags the connection", async () => {
  seedConnection();
  const fetchFn = fakeFetch(() => json({ items: [item()] }));
  const g = googleFor({ db, userId, fetchFn, now: NOW });
  const day = await g.listDayDetailed({ date: "2026-10-28" });
  assert.equal(day.events[0].id, "evtone12345");
  assert.deepEqual(await googleFor({ db, userId, fetchFn: fakeFetch(() => empty(204)), now: NOW }).deleteEvent({ id: "evtone12345", etag: '"1"' }), { done: true });
  const startAt = Date.UTC(2026, 9, 29, 21, 0);
  assert.deepEqual(
    await googleFor({ db, userId, fetchFn: fakeFetch(() => json({})), now: NOW }).patchEvent({ id: "evtone12345", etag: '"1"', startAt, endAt: startAt + 1_800_000 }),
    { done: true }, "the calendar's own zone is the default"
  );
  assert.deepEqual(await googleFor({ db, userId, fetchFn: fakeFetch(() => json({ status: "confirmed", start: { dateTime: "2026-10-29T14:00:00-07:00" }, end: { dateTime: "2026-10-29T14:30:00-07:00" } })), now: NOW }).getEvent({ id: "evtone12345" }), { startAt, endAt: startAt + 1_800_000 });
  const refused = googleFor({ db, userId, fetchFn: fakeFetch(() => json({}, 401)), now: NOW });
  assert.deepEqual(await refused.deleteEvent({ id: "evtone12345", etag: '"1"' }), { code: "reconnect" });
  assert.equal(db.prepare("SELECT status FROM google_connections WHERE user_id = ?").get(userId).status, "reconnect");
});

test("googleFor: with no connection the change calls make no request", async () => {
  const quiet = fakeFetch(() => { throw new Error("no request expected"); });
  const g = googleFor({ db, userId, fetchFn: quiet, now: NOW });
  assert.deepEqual(await g.deleteEvent({ id: "evtone12345", etag: '"1"' }), { code: "not_connected" });
  assert.deepEqual(await g.listDayDetailed({ date: "2026-10-28" }), { code: "not_connected" });
  assert.equal(quiet.calls.length, 0);
});
