"use strict";
// /api/assistant/confirm for a cancelEvent and a moveEvent (routes/assistant.js confirmChangeEvent): the delete or the patch on the
// signed-in user's own Google calendar, guarded by the event's etag, with nobody notified, and a repeat of the same confirm never
// changing anything twice. Throwaway DB, a scripted fake Anthropic client and a scripted fake Google that records every request:
// NO test here touches the network. All values are fake.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-change-confirm-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "test-client-" + Math.random().toString(16).slice(2) + ".apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret-" + Math.random().toString(16).slice(2);
process.env.GOOGLE_REDIRECT_URI = "http://localhost:8080/api/google/callback";
process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString("base64");

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const gcrypto = require("../lib/google/crypto");
const oauth = require("../lib/google/oauth");
const assistantRoutes = require("../routes/assistant");
const clientRoutes = require("../routes/clients");
const { CHANGE_CHANGED, ALREADY_OFF, COULD_NOT_CHANGE } = require("../lib/assistant/prompt");

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const PHX = "America/Phoenix";
const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
const ACCESS = "ya29.change-confirm-access-" + Math.random().toString(16).slice(2);
const REFRESH = "1//change-confirm-refresh-" + Math.random().toString(16).slice(2);
const RECONNECT = "your Google connection has expired — reconnect it on your Profile page";

const logged = [];
const realConsoleError = console.error;
console.error = (...args) => { logged.push(args.map(String).join(" ")); };
after(() => { console.error = realConsoleError; });

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, nmls_id) VALUES (?, ?, ?, 'User', ?, '123456')"
).run(orgId, role, first, email).lastInsertRowid);
const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.co", "Ann");
const lou = addUser(orgA, "lo", "lou@a.co", "Lou");

function seedConnection(userId, { status = "connected", timeZone = PHX } = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO google_connections
      (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc, status)
    VALUES (?, 'ann@gmail.example', ?, ?, ?, ?, ?, ?)
  `).run(userId, timeZone, oauth.SCOPES.join(" "), gcrypto.encrypt(ACCESS), Date.now() + 3_600_000, gcrypto.encrypt(REFRESH), status);
}
const statusOf = (userId) => (db.prepare("SELECT status FROM google_connections WHERE user_id = ?").get(userId) || {}).status;
const rowOf = (confirmId) => db.prepare("SELECT * FROM assistant_confirmations WHERE confirm_id = ?").get(confirmId);
const rowCount = () => db.prepare("SELECT COUNT(*) AS n FROM assistant_confirmations").get().n;

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
const noNetwork = () => fakeFetch(() => { throw new Error("no Google call was expected"); });
const changes = (g) => g.calls.filter((c) => c.method === "DELETE" || c.method === "PATCH");

let app, server, as;
const useGoogle = (fetchFn) => { app.set("googleFetch", fetchFn); return fetchFn; };
before(async () => {
  app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(cookieParser());
  app.use("/api/clients", clientRoutes);
  app.use("/api/assistant", assistantRoutes.createAssistantRouter({ limiter: { max: 100000 } }));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}`;
  as = (userId) => async (method, p, body) => {
    const headers = { "content-type": "application/json" };
    if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  };
});
after(() => {
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => {
  db.prepare("DELETE FROM google_connections").run();
  db.prepare("DELETE FROM assistant_confirmations").run();
  seedConnection(ann);
  useGoogle(noNetwork());
  logged.length = 0;
});

const newId = () => crypto.randomUUID();
// 2099-06-16 is a Tuesday, far enough ahead that these never go stale (the route reads the real clock)
const CANCEL = {
  id: "evtcancel01", etag: '"etag-one"', title: "Walkthrough with Sam", date: "2099-06-16", time: "10:00", allDay: false,
  startAt: Date.UTC(2099, 5, 16, 17, 0), durationMinutes: 30, timeZone: PHX,
};
const MOVE = {
  id: "evtmove0001", etag: '"etag-two"', title: "Walkthrough with Sam", date: "2099-06-16", time: "10:00", startAt: Date.UTC(2099, 5, 16, 17, 0),
  newDate: "2099-06-17", newTime: "14:30", durationMinutes: 45, timeZone: PHX,
};
const NEW_START = Date.UTC(2099, 5, 17, 21, 30);   // 14:30 in Phoenix
const cancelBody = (confirmId, event = {}) => ({ sideEffect: { type: "cancelEvent", event: { ...CANCEL, ...event }, confirmId } });
const moveBody = (confirmId, event = {}) => ({ sideEffect: { type: "moveEvent", event: { ...MOVE, ...event }, confirmId } });
const post = (userId, body) => as(userId)("POST", "/api/assistant/confirm", body);
const DONE_CANCEL = 'Done — "Walkthrough with Sam" on Tuesday, June 16th is off your calendar.';
const DONE_MOVE = 'Done — "Walkthrough with Sam" is now Wednesday, June 17th at 2:30 PM Mountain Standard Time.';
const urlOf = (call) => new URL(call.url);

// ── cancel ───────────────────────────────────────────────────────────────────

test("cancelEvent: confirmed -> one DELETE on that event (sendUpdates=none, If-Match the etag), the code-written Done line, a done row; nothing else is asked of Google", async () => {
  const google = useGoogle(fakeFetch(() => empty(204)));
  const id = newId();
  const r = await post(ann, cancelBody(id));
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.reply, DONE_CANCEL);
  assert.equal(google.calls.length, 1);
  const [call] = google.calls;
  assert.equal(call.method, "DELETE");
  assert.equal(urlOf(call).origin + urlOf(call).pathname, `${EVENTS}/evtcancel01`);
  assert.equal(urlOf(call).searchParams.get("sendUpdates"), "none");
  assert.equal(call.headers["If-Match"], '"etag-one"');
  assert.equal(call.headers.Authorization, `Bearer ${ACCESS}`);
  const row = rowOf(id);
  assert.equal(row.state, "done");
  assert.equal(row.user_id, ann);
  assert.equal(row.action_type, "cancelEvent");
  assert.ok(!JSON.stringify(r.data).includes(ACCESS) && !JSON.stringify(r.data).includes("etag-one"), "no token, no etag in the answer");
  assert.ok(!row.result_json.includes("etag-one"), "no etag kept");
});

test("cancelEvent: a repeat of the same confirm changes nothing a second time and answers with the same Done line", async () => {
  const google = useGoogle(fakeFetch(() => empty(204)));
  const id = newId();
  const first = await post(ann, cancelBody(id));
  const again = await post(ann, cancelBody(id));
  const upper = await post(ann, cancelBody(id.toUpperCase()));
  assert.equal(first.data.reply, DONE_CANCEL);
  assert.deepEqual([again.status, again.data.duplicate, again.data.reply], [200, true, DONE_CANCEL]);
  assert.deepEqual([upper.status, upper.data.duplicate, upper.data.reply], [200, true, DONE_CANCEL]);
  assert.equal(changes(google).length, 1, "Google was asked to delete once");
});

test("cancelEvent: two confirms at once make one delete; the second is told it is still working", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const google = useGoogle(fakeFetch(async () => { await gate; return empty(204); }));
  const id = newId();
  const a = post(ann, cancelBody(id));
  for (let i = 0; i < 400 && google.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const b = await post(ann, cancelBody(id));
  assert.deepEqual([b.status, b.data.pending], [409, true]);
  release();
  assert.equal((await a).data.reply, DONE_CANCEL);
  assert.equal(changes(google).length, 1);
});

test("cancelEvent: the event changed after the read-back (412): nothing is changed, the changed line, the claim is given back", async () => {
  const google = useGoogle(fakeFetch(() => json({}, 412)));
  const id = newId();
  const r = await post(ann, cancelBody(id));
  assert.deepEqual([r.status, r.data.success, r.data.say], [409, false, CHANGE_CHANGED]);
  assert.equal(r.data.error, CHANGE_CHANGED);
  assert.equal(rowOf(id), undefined);
  assert.equal(changes(google).length, 1, "one try, no second guess");
});

test("cancelEvent: gone or not found (404, 410) is the already-off line", async () => {
  for (const status of [404, 410]) {
    useGoogle(fakeFetch(() => json({}, status)));
    const id = newId();
    const r = await post(ann, cancelBody(id));
    assert.deepEqual([r.status, r.data.success, r.data.say], [409, false, ALREADY_OFF], String(status));
    assert.equal(rowOf(id), undefined);
  }
});

test("cancelEvent: Google refusing the token is the reconnect path; any other failure is the could-not-change line; nothing is claimed", async () => {
  useGoogle(fakeFetch(() => json({}, 401)));
  const a = await post(ann, cancelBody(newId()));
  assert.deepEqual([a.status, a.data.success, a.data.error], [409, false, RECONNECT]);
  assert.equal(statusOf(ann), "reconnect");
  seedConnection(ann);
  useGoogle(fakeFetch(() => json({}, 500)));
  const id = newId();
  const b = await post(ann, cancelBody(id));
  assert.deepEqual([b.status, b.data.success, b.data.say], [409, false, COULD_NOT_CHANGE]);
  assert.equal(rowOf(id), undefined, "the id is good for a retry");
  const c = await post(ann, cancelBody(newId()));   // the next try with Google down again, still nothing claimed
  assert.equal(c.data.say, COULD_NOT_CHANGE);
  assert.ok(logged.every((l) => !l.includes(ACCESS) && !l.includes("etag-one")));
});

test("cancelEvent: no Google connection is refused before any request", async () => {
  db.prepare("DELETE FROM google_connections").run();
  const google = useGoogle(noNetwork());
  const r = await post(ann, cancelBody(newId()));
  assert.deepEqual([r.status, r.data.success], [409, false]);
  assert.match(r.data.error, /isn't connected/);
  assert.equal(google.calls.length, 0);
  const lo = await post(lou, cancelBody(newId()));
  assert.equal(lo.status, 409, "a user with no connection of their own");
});

test("cancelEvent: all-day, and an event that has already started", async () => {
  const google = useGoogle(fakeFetch(() => empty(204)));
  const trip = await post(ann, cancelBody(newId(), { title: "Out of town", allDay: true, time: null, startAt: null, durationMinutes: null }));
  assert.equal(trip.data.reply, 'Done — "Out of town" on Tuesday, June 16th is off your calendar.');
  assert.equal(changes(google).length, 1);
  const started = await post(ann, cancelBody(newId(), { date: "2020-06-16", startAt: Date.UTC(2020, 5, 16, 17, 0) }));
  assert.deepEqual([started.status, started.data.success, started.data.say], [409, false, '"Walkthrough with Sam" has already started, so I\'ll leave it alone.']);
  assert.equal(changes(google).length, 1, "it was not even tried");
});

test("cancelEvent: a body that is not a well-formed change is 400 and records nothing", async () => {
  const google = useGoogle(noNetwork());
  const id = newId();
  for (const [event, why] of [
    [{ id: "../calendars" }, "an id that is a path"], [{ id: "ab" }, "a short id"], [{ id: 7 }, "an id that is not text"], [{ etag: "" }, "no etag"], [{ etag: undefined }, "an etag that is missing"],
    [{ title: "a\nb" }, "a multi-line title"], [{ title: "" }, "no title"], [{ title: "x".repeat(300) }, "a long title"], [{ date: "2099-02-30" }, "a day that does not exist"],
    [{ time: "ten" }, "a bad time"], [{ allDay: "no" }, "allDay not a boolean"], [{ startAt: "soon" }, "a start that is not a number"], [{ timeZone: 5 }, "a zone that is not text"],
    [{ durationMinutes: 0 }, "no length"],
  ]) {
    const r = await post(ann, cancelBody(id, event));
    assert.equal(r.status, 400, why);
    assert.equal(r.data.success, false);
  }
  assert.equal((await post(ann, { sideEffect: { type: "cancelEvent", confirmId: id } })).status, 400);
  assert.equal((await post(ann, { sideEffect: { type: "cancelEvent", event: CANCEL } })).data.error, "confirmId required");
  assert.equal((await post(ann, { sideEffect: { type: "cancelEvent", event: CANCEL, confirmId: "nope" } })).data.error, "confirmId must be a UUID");
  assert.equal(rowCount(), 0);
  assert.equal(google.calls.length, 0);
  // a zone that is not the connected calendar's
  const ny = await post(ann, cancelBody(newId(), { timeZone: "America/New_York" }));
  assert.deepEqual([ny.status, ny.data.error], [400, "that event isn't for the calendar you connected"]);
});

test("cancelEvent: a confirmId is bound to its user and its action", async () => {
  useGoogle(fakeFetch(() => empty(204)));
  seedConnection(lou);
  const id = newId();
  assert.equal((await post(ann, cancelBody(id))).status, 200);
  assert.deepEqual([(await post(lou, cancelBody(id))).status, (await post(lou, cancelBody(id))).data.error], [409, "confirmId already used"]);
  assert.equal((await post(ann, cancelBody(id, { id: "evtother0002" }))).data.error, "confirmId was used for a different action");
  assert.equal((await post(ann, moveBody(id))).data.error, "confirmId was used for a different action");
});

// ── move ─────────────────────────────────────────────────────────────────────

test("moveEvent: confirmed -> one PATCH with the new start and end only (same length), sendUpdates=none, If-Match the etag; the Done line", async () => {
  const google = useGoogle(fakeFetch(() => json({ id: MOVE.id })));
  const id = newId();
  const r = await post(ann, moveBody(id));
  assert.equal(r.status, 200);
  assert.equal(r.data.reply, DONE_MOVE);
  assert.equal(google.calls.length, 1);
  const [call] = google.calls;
  assert.equal(call.method, "PATCH");
  assert.equal(urlOf(call).origin + urlOf(call).pathname, `${EVENTS}/evtmove0001`);
  assert.equal(urlOf(call).searchParams.get("sendUpdates"), "none");
  assert.equal(call.headers["If-Match"], '"etag-two"');
  assert.deepEqual(call.json, {
    start: { dateTime: new Date(NEW_START).toISOString().replace(".000Z", "Z"), timeZone: PHX },
    end: { dateTime: new Date(NEW_START + 45 * 60_000).toISOString().replace(".000Z", "Z"), timeZone: PHX },
  });
  assert.equal(rowOf(id).state, "done");
  assert.equal(rowOf(id).action_type, "moveEvent");
});

test("moveEvent: a repeat of the same confirm changes nothing a second time", async () => {
  const google = useGoogle(fakeFetch(() => json({ id: MOVE.id })));
  const id = newId();
  assert.equal((await post(ann, moveBody(id))).data.reply, DONE_MOVE);
  const again = await post(ann, moveBody(id));
  assert.deepEqual([again.status, again.data.duplicate, again.data.reply], [200, true, DONE_MOVE]);
  assert.equal(changes(google).length, 1);
});

test("moveEvent: the event changed (412) but already sits at the requested new time: one read, then the Done line (a repeat whose first answer was lost)", async () => {
  const google = useGoogle(fakeFetch((call) => {
    if (call.method === "PATCH") return json({}, 412);
    return json({ status: "confirmed", start: { dateTime: new Date(NEW_START).toISOString() }, end: { dateTime: new Date(NEW_START + 45 * 60_000).toISOString() } });
  }));
  const id = newId();
  const r = await post(ann, moveBody(id));
  assert.equal(r.status, 200);
  assert.equal(r.data.reply, DONE_MOVE);
  assert.deepEqual(google.calls.map((c) => c.method), ["PATCH", "GET"], "one patch, one read, nothing more");
  assert.equal(urlOf(google.calls[1]).searchParams.get("fields"), "status,start,end");
  assert.equal(rowOf(id).state, "done");
});

test("moveEvent: the event changed (412) and sits somewhere else: nothing is changed, the changed line; gone is the already-off line", async () => {
  const elsewhere = Date.UTC(2099, 5, 18, 17, 0);
  const google = useGoogle(fakeFetch((call) => (call.method === "PATCH"
    ? json({}, 412)
    : json({ status: "confirmed", start: { dateTime: new Date(elsewhere).toISOString() }, end: { dateTime: new Date(elsewhere + 1_800_000).toISOString() } }))));
  const id = newId();
  const r = await post(ann, moveBody(id));
  assert.deepEqual([r.status, r.data.success, r.data.say], [409, false, CHANGE_CHANGED]);
  assert.equal(rowOf(id), undefined);
  assert.equal(google.calls.filter((c) => c.method === "PATCH").length, 1);
  useGoogle(fakeFetch((call) => (call.method === "PATCH" ? json({}, 412) : json({}, 404))));
  assert.equal((await post(ann, moveBody(newId()))).data.say, ALREADY_OFF);
  useGoogle(fakeFetch((call) => (call.method === "PATCH" ? json({}, 412) : json({}, 500))));
  assert.equal((await post(ann, moveBody(newId()))).data.say, CHANGE_CHANGED, "an unreadable event is left alone");
});

test("moveEvent: gone (404, 410) is already off; a refused token reconnects; other failures are the could-not-change line", async () => {
  for (const status of [404, 410]) {
    useGoogle(fakeFetch(() => json({}, status)));
    assert.equal((await post(ann, moveBody(newId()))).data.say, ALREADY_OFF);
  }
  useGoogle(fakeFetch(() => json({}, 500)));
  assert.equal((await post(ann, moveBody(newId()))).data.say, COULD_NOT_CHANGE);
  useGoogle(fakeFetch(() => json({}, 403)));
  assert.equal((await post(ann, moveBody(newId()))).data.say, COULD_NOT_CHANGE, "a 403 that is not an auth refusal");
  useGoogle(fakeFetch(() => json({}, 401)));
  const r = await post(ann, moveBody(newId()));
  assert.deepEqual([r.status, r.data.error], [409, RECONNECT]);
  assert.equal(statusOf(ann), "reconnect");
});

test("moveEvent: a new start that has passed, that the clocks skip, or a bad shape is refused before any request", async () => {
  const google = useGoogle(noNetwork());
  const past = await post(ann, moveBody(newId(), { newDate: "2020-01-01" }));
  assert.deepEqual([past.status, past.data.error], [400, "that time has already passed"]);
  seedConnection(ann, { timeZone: "America/New_York" });
  const skipped = await post(ann, moveBody(newId(), { timeZone: "America/New_York", newDate: "2099-03-08", newTime: "02:30" }));   // the clocks spring forward on 2099-03-08
  assert.equal(skipped.status, 400);
  seedConnection(ann);
  for (const [event, why] of [[{ newDate: "2099-13-01" }, "a bad new day"], [{ newTime: "2pm" }, "a bad new time"], [{ newTime: undefined }, "no new time"], [{ durationMinutes: 0 }, "no length"], [{ durationMinutes: 1.5 }, "a part-minute length"], [{ startAt: null }, "no start"]]) {
    assert.equal((await post(ann, moveBody(newId(), event))).status, 400, why);
  }
  assert.equal(rowCount(), 0);
  assert.equal(google.calls.length, 0);
  // an event that has already started is left alone
  const started = await post(ann, moveBody(newId(), { date: "2020-06-16", startAt: Date.UTC(2020, 5, 16, 17, 0) }));
  assert.equal(started.data.say, '"Walkthrough with Sam" has already started, so I\'ll leave it alone.');
  assert.equal(google.calls.length, 0);
});

// ── end to end: /turn -> /confirm ────────────────────────────────────────────

function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const next = script[calls.length - 1];
        if (next === undefined) throw new Error("fake client: script exhausted at call " + calls.length);
        return typeof next === "function" ? next(params) : next;
      },
    },
  };
}
const resp = (content, stop_reason) => ({ id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 } });
const useTool = (name, input = {}, id = "toolu_1") => resp([{ type: "tool_use", id, name, input }], "tool_use");

const DAY = {
  items: [
    {
      id: "evtsamsam01", etag: '"3210000000000001"', summary: "Walkthrough with Sam", status: "confirmed",
      start: { dateTime: "2099-06-16T10:00:00-07:00" }, end: { dateTime: "2099-06-16T10:30:00-07:00" }, organizer: { self: true }, attendees: [{ self: true }],
    },
    {
      id: "evtlunch001", etag: '"3210000000000002"', summary: "Lunch with Pat", status: "confirmed",
      start: { dateTime: "2099-06-16T12:00:00-07:00" }, end: { dateTime: "2099-06-16T12:30:00-07:00" }, organizer: { self: true },
      attendees: [{ self: true }, { email: "pat.guest@example.test" }],
    },
  ],
};
const dayAndChanges = () => fakeFetch((call) => {
  if (call.method === "GET") return json(DAY);
  if (call.method === "DELETE") return empty(204);
  return json({ id: "evtsamsam01" });
});

test("turn -> confirm, cancel: the real adapter reads the day with the code-only fields, the model sees none of them, /confirm deletes that event once", async () => {
  const google = useGoogle(dayAndChanges());
  const model = fakeClient([useTool("cancelEventTool", { date: "2099-06-16", time: "10:00" })]);
  app.set("anthropicClient", model);
  const turn = await as(ann)("POST", "/api/assistant/turn", { rates: RATES, messages: [{ role: "user", content: "cancel my 10 AM walkthrough on June sixteenth" }] });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.error, undefined, JSON.stringify(turn.data));
  assert.equal(turn.data.reply, 'Just to confirm — cancel "Walkthrough with Sam" on Tuesday, June 16th at 10:00 AM Mountain Standard Time?');
  const side = turn.data.sideEffect;
  assert.equal(side.type, "cancelEvent");
  assert.equal(side.event.id, "evtsamsam01");
  assert.match(side.confirmId, /^[0-9a-f]{8}-/);
  assert.deepEqual(google.calls.map((c) => c.method), ["GET"], "a turn changes nothing");
  assert.ok(new URL(google.calls[0].url).searchParams.get("fields").includes("etag"));
  const seen = JSON.stringify(model.calls);
  for (const secret of ["evtsamsam01", "evtlunch001", "3210000000000001", "pat.guest@example.test", "etag"]) assert.ok(!seen.includes(secret), `${secret} reached the model`);
  assert.equal(rowCount(), 0);

  const done = await post(ann, { sideEffect: side });
  assert.equal(done.status, 200);
  assert.equal(done.data.reply, 'Done — "Walkthrough with Sam" on Tuesday, June 16th is off your calendar.');
  assert.deepEqual(google.calls.map((c) => c.method), ["GET", "DELETE"]);
  assert.equal(google.calls[1].headers["If-Match"], '"3210000000000001"');
  const again = await post(ann, { sideEffect: side });
  assert.equal(again.data.duplicate, true);
  assert.deepEqual(google.calls.map((c) => c.method), ["GET", "DELETE"], "the second confirm asked Google for nothing");
});

test("turn -> confirm, move: the read-back, the card rows and one PATCH", async () => {
  const google = useGoogle(dayAndChanges());
  app.set("anthropicClient", fakeClient([useTool("moveEventTool", { date: "2099-06-16", title: "walkthrough", newTime: "12:15" })]));
  const turn = await as(ann)("POST", "/api/assistant/turn", { rates: RATES, messages: [{ role: "user", content: "move my walkthrough on June sixteenth to 12:15" }] });
  assert.equal(
    turn.data.reply,
    'Just to confirm — move "Walkthrough with Sam" from Tuesday, June 16th at 10:00 AM to Tuesday, June 16th at 12:15 PM Mountain Standard Time? Heads up: that overlaps "Lunch with Pat" at 12:00 PM.'
  );
  assert.deepEqual(turn.data.details.map((d) => d.label), ["Change", "Event", "Now", "Moves to", "Overlaps", "Guests"]);
  const done = await post(ann, { sideEffect: turn.data.sideEffect });
  assert.equal(done.data.reply, 'Done — "Walkthrough with Sam" is now Tuesday, June 16th at 12:15 PM Mountain Standard Time.');
  assert.deepEqual(google.calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.deepEqual(google.calls[1].json.start, { dateTime: "2099-06-16T19:15:00Z", timeZone: PHX });
  assert.deepEqual(google.calls[1].json.end, { dateTime: "2099-06-16T19:45:00Z", timeZone: PHX });
});

test("turn: an event with guests is refused in code's words and nothing reaches /confirm", async () => {
  const google = useGoogle(dayAndChanges());
  app.set("anthropicClient", fakeClient([useTool("cancelEventTool", { date: "2099-06-16", title: "lunch" })]));
  const turn = await as(ann)("POST", "/api/assistant/turn", { rates: RATES, messages: [{ role: "user", content: "cancel my lunch with Pat on June sixteenth" }] });
  assert.equal(turn.data.reply, '"Lunch with Pat" has guests, and I never email guests. Open Google Calendar to change it so they\'re told.');
  assert.equal(turn.data.sideEffect, undefined);
  assert.deepEqual(google.calls.map((c) => c.method), ["GET"]);
});

// ── the follow-up question follows the calendar (spec section 8) ─────────────

const { localToday, localTimeOf } = require("../lib/google/time");
const fu = require("../lib/assistant/followups");
const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// An event starting in a minute, so its day is today on the calendar's clock (a run that straddles midnight there skips: the
// route reads the real clock). Lucy's recorded "How did the call go?" row is due when it ends.
function todaysCall(title, minutes = 30) {
  const startAt = Date.now() + 60_000;
  const local = localTimeOf(new Date(startAt).toISOString(), PHX);
  const today = localToday(PHX, Date.now());
  if (local.date !== today) return null;
  const lucy = Number(db.prepare(
    "INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score) VALUES (?, ?, 'Lucy Tran', '30yr_fixed', 7.5, 400000, 600000, 700)"
  ).run(orgA, ann).lastInsertRowid);
  const endAt = startAt + minutes * 60_000;
  fu.recordRecommendations(db, ann, today, [{ clientId: lucy, source: "calendar", reasonCode: "calendar", dueAt: sqliteUtc(endAt) }]);
  const hhmm = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  return { lucy, today, startAt, endAt, hhmm, title, minutes };
}
const recRows = () => db.prepare("SELECT client_id AS clientId, status, due_at AS dueAt FROM charlie_recommendations WHERE source = 'calendar'").all();

test("cancel: the call's follow-up row is expired once Google has deleted it, so she never asks how it went", async (t) => {
  db.prepare("DELETE FROM charlie_recommendations").run();
  const call = todaysCall("Follow-up: Lucy Tran");
  if (!call) return t.skip("the calendar's midnight is within a minute");
  const google = useGoogle(fakeFetch((c) => (c.method === "GET" ? json({ items: [] }) : empty(204))));   // the day is empty after the delete
  const r = await post(ann, cancelBody(newId(), { id: "evtlucy0001", title: call.title, date: call.today, time: call.hhmm, startAt: call.startAt, durationMinutes: call.minutes }));
  assert.equal(r.status, 200);
  assert.deepEqual(google.calls.map((c) => c.method), ["DELETE", "GET"], "the change first, then one read of that day");
  assert.deepEqual(recRows().map((x) => x.status), ["expired"]);
  assert.deepEqual(fu.openFollowUps(db, ann, { localDate: call.today, localHour: 23, nowUtc: sqliteUtc(call.endAt + 3_600_000) }), []);
  db.prepare("DELETE FROM clients WHERE id = ?").run(call.lucy);
});

test("move: the call's follow-up row is due at the new end", async (t) => {
  db.prepare("DELETE FROM charlie_recommendations").run();
  const call = todaysCall("Follow-up: Lucy Tran");
  if (!call) return t.skip("the calendar's midnight is within a minute");
  const newStart = call.startAt + 3 * 3_600_000;
  const newLocal = localTimeOf(new Date(newStart).toISOString(), PHX);
  if (newLocal.date !== call.today) { db.prepare("DELETE FROM clients WHERE id = ?").run(call.lucy); return t.skip("the new time falls on tomorrow"); }
  const newEnd = newStart + call.minutes * 60_000;
  const google = useGoogle(fakeFetch((c) => (c.method === "GET"
    ? json({ items: [{ id: "evtlucy0001", summary: call.title, status: "confirmed", start: { dateTime: new Date(newStart).toISOString() }, end: { dateTime: new Date(newEnd).toISOString() } }] })
    : json({ id: "evtlucy0001" }))));
  const hhmm = (l) => `${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`;
  const r = await post(ann, moveBody(newId(), { id: "evtlucy0001", title: call.title, date: call.today, time: call.hhmm, startAt: call.startAt, newDate: call.today, newTime: hhmm(newLocal), durationMinutes: call.minutes }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(google.calls.map((c) => c.method), ["PATCH", "GET"]);
  assert.deepEqual(recRows().map((x) => [x.status, x.dueAt]), [["open", sqliteUtc(newEnd)]]);
  db.prepare("DELETE FROM clients WHERE id = ?").run(call.lucy);
});

test("a change on a far day asks Google for nothing more", async () => {
  const google = useGoogle(fakeFetch(() => empty(204)));
  assert.equal((await post(ann, cancelBody(newId()))).status, 200);   // 2099: no row was ever recorded for it
  assert.deepEqual(google.calls.map((c) => c.method), ["DELETE"]);
});
