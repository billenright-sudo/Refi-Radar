"use strict";
// /api/assistant (routes/assistant.js) with Google behind it: the asynchronous /confirm for a createEvent booking (a Calendar insert
// cannot run inside a better-sqlite3 transaction, so the confirmId row goes pending -> done around the call) and /turn's Google adapter
// and email `compose`. Throwaway DB, a scripted fake Anthropic client (app.set("anthropicClient")) and a scripted fake Google
// (app.set("googleFetch")) that records every request: NO test here touches the network. All env values are fake.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-assist-google-confirm-"));
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

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PHX = "America/Phoenix";
const NY = "America/New_York";
const RATES = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
const ACCESS = "ya29.confirm-access-" + Math.random().toString(16).slice(2);
const REFRESH = "1//confirm-refresh-" + Math.random().toString(16).slice(2);
const ACCESS_NEW = "ya29.confirm-new-" + Math.random().toString(16).slice(2);
const REFRESH_NEW = "1//confirm-refresh-new-" + Math.random().toString(16).slice(2);

const NOT_CONNECTED = "your Google calendar isn't connected";
const RECONNECT = "your Google connection has expired — reconnect it in the Charlie panel";
const UNREACHABLE = "couldn't reach Google — try again";
const CLOCKS = "that time doesn't exist that day — the clocks change";
const PAST = "that time has already passed";

// What the code logs on a failure is captured (the run stays quiet) and checked at the end: a status or an error name, never a token
// (final fix, Ruling 59).
const logged = [];
const realConsoleError = console.error;
console.error = (...args) => { logged.push(args.map(String).join(" ")); };
after(() => { console.error = realConsoleError; });

// ── seed data ────────────────────────────────────────────────────────────────

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, nmls_id) VALUES (?, ?, ?, 'User', ?, '123456')"
).run(orgId, role, first, email).lastInsertRowid);
const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.co", "Ann");
const lou = addUser(orgA, "lo", "lou@a.co", "Lou");
const CHEN_EMAIL = "linda.chen@example.com";
const chen = Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, email, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact)
  VALUES (?, ?, 'Robert & Linda Chen', ?, '30yr_fixed', 7.85, 485000, 650000, 760, '2024-01-01')
`).run(orgA, ann, CHEN_EMAIL).lastInsertRowid);

function seedConnection(userId, { expiresAt = Date.now() + 3_600_000, status = "connected", timeZone = PHX } = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO google_connections
      (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc, status)
    VALUES (?, 'ann@gmail.example', ?, ?, ?, ?, ?, ?)
  `).run(userId, timeZone, oauth.SCOPES.join(" "), gcrypto.encrypt(ACCESS), expiresAt, gcrypto.encrypt(REFRESH), status);
}
const statusOf = (userId) => (db.prepare("SELECT status FROM google_connections WHERE user_id = ?").get(userId) || {}).status;
const rowOf = (confirmId) => db.prepare("SELECT * FROM assistant_confirmations WHERE confirm_id = ?").get(confirmId);
const rowCount = () => db.prepare("SELECT COUNT(*) AS n FROM assistant_confirmations").get().n;

// ── harness ──────────────────────────────────────────────────────────────────

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake Google. `handler(call)` returns (or resolves to) a Response. Every request is recorded as { url, method, headers, json }.
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
const isInsert = (call) => call.method === "POST" && call.url.startsWith(EVENTS);
const booksEverything = () => fakeFetch((call) => (isInsert(call) ? json({ id: call.json.id }) : json({}, 500)));
const noNetwork = () => fakeFetch(() => { throw new Error("no Google call was expected"); });

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
});

const newId = () => crypto.randomUUID();
const eventIdOf = (confirmId) => "br" + confirmId.replace(/-/g, "");
const EVENT = { title: "Follow-up: Robert & Linda Chen", date: "2099-06-15", time: "10:00", durationMinutes: 30, timeZone: PHX };   // a Monday, far enough ahead that these never go stale
const booking = (confirmId, event = {}) => ({ sideEffect: { type: "createEvent", event: { ...EVENT, ...event }, confirmId } });
const confirm = (userId, confirmId, event) => as(userId)("POST", "/api/assistant/confirm", booking(confirmId, event));
const REPLY = 'Done — "Follow-up: Robert & Linda Chen" is on your calendar for Monday, June 15th at 10:00 AM Mountain Standard Time.';
const TARGET = JSON.stringify([EVENT.date, EVENT.time, EVENT.durationMinutes, EVENT.title]);

const waitFor = async (condition, what) => {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for " + what);
};

// The fake Anthropic client, as assistant-api.test.js scripts it.
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

// ── a confirmed booking ──────────────────────────────────────────────────────

test("createEvent: confirmed -> one events POST (id br + the confirmId's hex, sendUpdates=none, no attendees), the code-authored reply, a done row", async () => {
  const google = useGoogle(booksEverything());
  const id = newId();
  const r = await confirm(ann, id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    success: true,
    result: { eventId: eventIdOf(id), title: EVENT.title, date: EVENT.date, time: EVENT.time, timeZone: EVENT.timeZone },
    reply: REPLY,
  });
  assert.equal(google.calls.length, 1);
  const [call] = google.calls;
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, EVENTS);
  assert.equal(url.searchParams.get("sendUpdates"), "none");
  assert.equal(call.headers.Authorization, `Bearer ${ACCESS}`);
  assert.match(call.json.id, /^br[0-9a-f]{32}$/);
  assert.equal(call.json.id, eventIdOf(id));
  assert.equal(call.json.summary, EVENT.title);
  assert.deepEqual(call.json.start, { dateTime: "2099-06-15T17:00:00Z", timeZone: PHX });      // 10:00 in Phoenix (UTC-7) is 17:00Z
  assert.deepEqual(call.json.end, { dateTime: "2099-06-15T17:30:00Z", timeZone: PHX });
  assert.equal("attendees" in call.json, false, "nobody is invited");
  const row = rowOf(id);
  assert.equal(row.state, "done");
  assert.equal(row.user_id, ann);
  assert.equal(row.action_type, "createEvent");
  assert.equal(row.target, TARGET);
  assert.deepEqual(JSON.parse(row.result_json), r.data.result);
  assert.ok(!JSON.stringify(r.data).includes(ACCESS), "no token in the response");
});

test("createEvent: the id is lower-cased, so an upper-case confirmId books the same event id", async () => {
  const google = useGoogle(booksEverything());
  const id = newId();
  const r = await confirm(ann, id.toUpperCase());
  assert.equal(r.status, 200);
  assert.equal(google.calls[0].json.id, eventIdOf(id));
  assert.equal(rowOf(id).state, "done");
});

test("createEvent: the same confirmId again is a duplicate with the same reply, and Google is not called a second time", async () => {
  const google = useGoogle(booksEverything());
  const id = newId();
  const first = await confirm(ann, id);
  const again = await confirm(ann, id);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, { success: true, result: first.data.result, reply: REPLY, duplicate: true });
  assert.equal(google.calls.filter(isInsert).length, 1);
  assert.equal(rowCount(), 1);
});

test("createEvent: a second confirm while the first is still with Google is 409 'still working on that one'; afterwards it is a duplicate", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inserts = 0;
  // only the first POST is slow, and it is always let go in the end, so a failing assertion cannot leave the server hanging
  const google = useGoogle(fakeFetch(async (call) => { if (inserts++ === 0) await gate; return json({ id: call.json.id }); }));
  const id = newId();
  const first = confirm(ann, id);                                       // not awaited: its Google POST is slow
  try {
    await waitFor(() => google.calls.some(isInsert), "the first POST to reach Google");
    assert.equal(rowOf(id).state, "pending");
    const second = await confirm(ann, id);
    assert.equal(second.status, 409);
    // (final fix, Ruling 53: the live pending claim's 409 says `pending: true`, so the client keeps the card and lets the user retry)
    assert.deepEqual(second.data, { success: false, error: "still working on that one", pending: true });
  } finally {
    release();
  }
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.data.reply, REPLY);
  assert.equal(google.calls.filter(isInsert).length, 1, "the overlapped call never reached Google");
  const third = await confirm(ann, id);
  assert.equal(third.data.duplicate, true);
  assert.equal(rowOf(id).state, "done");
});

test("Final fix (Ruling 53): only the live pending claim's 409 says pending; a refusal that is final does not", async () => {
  useGoogle(booksEverything());
  const id = newId();
  assert.equal((await confirm(ann, id)).status, 200);
  seedConnection(lou);
  const other = await confirm(lou, id);
  assert.equal(other.status, 409);
  assert.deepEqual(other.data, { success: false, error: "confirmId already used" });
  const changed = await confirm(ann, id, { time: "11:00" });
  assert.deepEqual(changed.data, { success: false, error: "confirmId was used for a different action" });
});

test("createEvent: Google's 409 (that event id already exists) counts as booked", async () => {
  useGoogle(fakeFetch(() => json({ error: { code: 409, message: "The requested identifier already exists." } }, 409)));
  const id = newId();
  const r = await confirm(ann, id);
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.duplicate, undefined, "the reply is a first confirm's, whatever Google said");
  assert.deepEqual(r.data.result, { eventId: eventIdOf(id), title: EVENT.title, date: EVENT.date, time: EVENT.time, timeZone: EVENT.timeZone });
  assert.equal(r.data.reply, REPLY);
  assert.equal(rowOf(id).state, "done");
});

// ── refused before Google ────────────────────────────────────────────────────

test("createEvent: confirmId is required, and must be a UUID; nothing reaches Google and nothing is recorded", async () => {
  const google = useGoogle(noNetwork());
  for (const confirmId of [undefined, null]) {
    const r = await confirm(ann, confirmId);
    assert.equal(r.status, 400, String(confirmId));
    assert.equal(r.data.error, "confirmId required");
  }
  for (const confirmId of ["", "not-a-uuid", 42, {}, ["x"]]) {
    const r = await confirm(ann, confirmId);
    assert.equal(r.status, 400, JSON.stringify(confirmId));
    assert.equal(r.data.error, "confirmId must be a UUID");
  }
  assert.equal(google.calls.length, 0);
  assert.equal(rowCount(), 0);
});

test("createEvent: a past start, another time zone, a title with a line break, and a start in the clock-change gap are each 400 with no Google call", async () => {
  const google = useGoogle(noNetwork());
  const cases = [
    ["a start that has passed", { date: "2020-01-02" }, PAST],
    ["a time zone other than the connection's", { timeZone: "America/Denver" }, null],
    ["a title with a line feed", { title: "Chen\nBCC: x@y.z" }, null],
    ["a title with a carriage return", { title: "Chen\rfollow-up" }, null],
    ["a title with a line separator", { title: "Chen\u2028follow-up" }, null],
    ["a blank title", { title: "   " }, null],
    ["a title over 120 characters", { title: "x".repeat(121) }, null],
    ["a title that is not text", { title: 7 }, null],
    ["a date that is not a date", { date: "2027-02-30" }, null],
    ["a date in words", { date: "friday" }, null],
    ["a time that is not HH:MM", { time: "10am" }, null],
    ["an hour past 23", { time: "24:00" }, null],
    ["a duration under 15", { durationMinutes: 10 }, null],
    ["a duration over 240", { durationMinutes: 241 }, null],
    ["a duration that is not whole", { durationMinutes: 30.5 }, null],
    ["a duration that is text", { durationMinutes: "30" }, null],
    ["a time zone that is not text", { timeZone: 7 }, null],
  ];
  for (const [label, event, error] of cases) {
    const id = newId();
    const r = await confirm(ann, id, event);
    assert.equal(r.status, 400, label);
    assert.equal(r.data.success, false, label);
    if (error) assert.equal(r.data.error, error, label);
    assert.equal(typeof r.data.error, "string", label);
    assert.equal(rowOf(id), undefined, `${label}: nothing is recorded, so the id is still good for a corrected retry`);
  }
  for (const event of [undefined, null, "ten", ["x"]]) {
    const r = await as(ann)("POST", "/api/assistant/confirm", { sideEffect: { type: "createEvent", event, confirmId: newId() } });
    assert.equal(r.status, 400, JSON.stringify(event));
  }
  assert.equal(google.calls.length, 0);
  assert.equal(rowCount(), 0);
});

test("createEvent: a refused request leaves its confirmId good: the corrected retry books", async () => {
  const google = useGoogle(booksEverything());
  const id = newId();
  assert.equal((await confirm(ann, id, { title: "bad\ntitle" })).status, 400);
  assert.equal((await confirm(ann, id, { date: "2020-01-02" })).status, 400);
  assert.equal(google.calls.length, 0);
  const r = await confirm(ann, id);
  assert.equal(r.status, 200);
  assert.equal(google.calls.filter(isInsert).length, 1);
});

test("createEvent: a wall time that does not exist (the clocks spring forward) is 400; the minutes either side of the gap are booked", async () => {
  seedConnection(ann, { timeZone: NY });
  const google = useGoogle(booksEverything());
  // America/New_York 2099-03-08 (the second Sunday of March): 02:00 jumps to 03:00, so 02:30 never happens that day
  for (const time of ["02:00", "02:30", "02:59"]) {
    const id = newId();
    const r = await confirm(ann, id, { date: "2099-03-08", time, timeZone: NY });
    assert.equal(r.status, 400, time);
    assert.equal(r.data.error, CLOCKS, time);
    assert.equal(rowOf(id), undefined, time);
  }
  assert.equal(google.calls.length, 0);
  for (const [time, expected] of [["01:59", "2099-03-08T06:59:00Z"], ["03:00", "2099-03-08T07:00:00Z"]]) {
    const r = await confirm(ann, newId(), { date: "2099-03-08", time, timeZone: NY });
    assert.equal(r.status, 200, time);
    assert.equal(google.calls.at(-1).json.start.dateTime, expected, time);
  }
});

// ── Google says no ───────────────────────────────────────────────────────────

test("createEvent: the refresh token Google refuses (invalid_grant) is 409 with the reconnect words, the row is gone, and a retry after reconnecting books under the same confirmId", async () => {
  seedConnection(ann, { expiresAt: Date.now() - 1000 });                   // the access token needs a refresh
  const google = useGoogle(fakeFetch((call) => (call.url === TOKEN_URL ? json({ error: "invalid_grant" }, 400) : json({}, 500))));
  const id = newId();
  const r = await confirm(ann, id);
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { success: false, error: RECONNECT });
  assert.equal(google.calls.filter(isInsert).length, 0);
  assert.equal(rowOf(id), undefined, "the id can be used again");
  assert.equal(statusOf(ann), "reconnect");

  // while it is flagged, a confirm is told the same without any Google call
  const stillOut = await confirm(ann, id);
  assert.equal(stillOut.status, 409);
  assert.equal(stillOut.data.error, RECONNECT);
  assert.equal(google.calls.length, 1, "only the one refresh attempt");

  // the broker signs in again (a new connection), and the same confirmId goes through
  seedConnection(ann);
  const fresh = useGoogle(booksEverything());
  const retry = await confirm(ann, id);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.reply, REPLY);
  assert.equal(fresh.calls.filter(isInsert).length, 1);
  assert.equal(rowOf(id).state, "done");
});

test("createEvent: a Calendar 401 on the insert is the same: 409 reconnect, the row is gone, and the connection is flagged", async () => {
  const google = useGoogle(fakeFetch((call) => json({ error: { code: 401, message: "Invalid Credentials" } }, 401)));
  const id = newId();
  const r = await confirm(ann, id);
  assert.equal(r.status, 409);
  assert.equal(r.data.error, RECONNECT);
  assert.equal(google.calls.filter(isInsert).length, 1);
  assert.equal(rowOf(id), undefined);
  assert.equal(statusOf(ann), "reconnect");
});

test("createEvent: no Google connection is 409 'isn't connected', with no Google call and no row", async () => {
  db.prepare("DELETE FROM google_connections").run();
  const google = useGoogle(noNetwork());
  const id = newId();
  const r = await confirm(ann, id);
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { success: false, error: NOT_CONNECTED });
  assert.equal(google.calls.length, 0);
  assert.equal(rowOf(id), undefined);
  // another user's connection is no help
  seedConnection(lou);
  assert.equal((await confirm(ann, newId())).data.error, NOT_CONNECTED);
});

test("createEvent: Google down is 502 and the row is gone; the token step down is 409 'couldn't reach Google'; a retry books", async () => {
  const id = newId();
  const down = useGoogle(fakeFetch(() => json({ error: { message: "SECRET-BODY " + ACCESS } }, 500)));
  const r = await confirm(ann, id);
  assert.equal(r.status, 502);
  assert.deepEqual(r.data, { success: false, error: UNREACHABLE });
  assert.equal(down.calls.filter(isInsert).length, 1);
  assert.equal(rowOf(id), undefined);
  assert.ok(!JSON.stringify(r.data).includes("SECRET"));

  const network = useGoogle(fakeFetch(() => { throw Object.assign(new Error("offline"), { name: "TypeError" }); }));
  const r2 = await confirm(ann, id);
  assert.equal(r2.status, 502);
  assert.equal(r2.data.error, UNREACHABLE);
  assert.equal(network.calls.length, 1);
  assert.equal(rowOf(id), undefined);

  seedConnection(ann, { expiresAt: Date.now() - 1000 });                   // a refresh is needed, and Google's token endpoint is down
  const tokenDown = useGoogle(fakeFetch(() => json({}, 503)));
  const r3 = await confirm(ann, id);
  assert.equal(r3.status, 409);
  assert.equal(r3.data.error, UNREACHABLE);
  assert.equal(tokenDown.calls.filter(isInsert).length, 0);
  assert.equal(rowOf(id), undefined);
  assert.equal(statusOf(ann), "connected", "an outage does not ask for a new sign-in");

  seedConnection(ann);
  const up = useGoogle(booksEverything());
  assert.equal((await confirm(ann, id)).status, 200);
  assert.equal(up.calls.filter(isInsert).length, 1);
});

test("createEvent: a refresh that works first, then the insert, with the new token", async () => {
  seedConnection(ann, { expiresAt: Date.now() - 1000 });
  const google = useGoogle(fakeFetch((call) => (call.url === TOKEN_URL
    ? json({ access_token: ACCESS_NEW, expires_in: 3599, refresh_token: REFRESH_NEW })
    : json({ id: call.json.id }))));
  const r = await confirm(ann, newId());
  assert.equal(r.status, 200);
  assert.deepEqual(google.calls.map((c) => c.url.split("?")[0]), [TOKEN_URL, EVENTS]);
  assert.equal(google.calls[1].headers.Authorization, `Bearer ${ACCESS_NEW}`);
});

// ── the confirmId rows ───────────────────────────────────────────────────────

test("createEvent: a confirmId is bound to its user and to its booking (409, nothing executed)", async () => {
  const google = useGoogle(booksEverything());
  const id = newId();
  assert.equal((await confirm(ann, id)).status, 200);
  seedConnection(lou);
  const other = await confirm(lou, id);
  assert.equal(other.status, 409);
  assert.equal(other.data.error, "confirmId already used");
  const changed = await confirm(ann, id, { time: "11:00" });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.error, "confirmId was used for a different action");
  const retitled = await confirm(ann, id, { title: "Something else" });
  assert.equal(retitled.status, 409);
  // and a booking cannot reuse the id of another kind of action
  const clientId = newId();
  const added = await as(ann)("POST", "/api/assistant/confirm", {
    sideEffect: { type: "addClient", confirmId: clientId, fields: { name: "Priya Shah", loanType: "30yr_fixed", currentRate: 7, loanBalance: 300000, propertyValue: 420000 } },
  });
  assert.equal(added.status, 200);
  const cross = await confirm(ann, clientId);
  assert.equal(cross.status, 409);
  assert.equal(google.calls.filter(isInsert).length, 1, "none of the refused ones reached Google");
});

test("createEvent: a booking already done stays a duplicate after its start has passed and after Google is disconnected", async () => {
  const id = newId();
  const past = { ...EVENT, date: "2020-01-02" };
  db.prepare("INSERT INTO assistant_confirmations (confirm_id, user_id, result_json, action_type, target, state) VALUES (?, ?, ?, 'createEvent', ?, 'done')")
    .run(id, ann, JSON.stringify({ eventId: eventIdOf(id), title: past.title, date: past.date, time: past.time }),
      JSON.stringify([past.date, past.time, past.durationMinutes, past.title]));
  db.prepare("DELETE FROM google_connections").run();
  const google = useGoogle(noNetwork());
  const r = await confirm(ann, id, { date: "2020-01-02" });
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.reply, 'Done — "Follow-up: Robert & Linda Chen" is on your calendar for Thursday, January 2nd at 10:00 AM.');
  assert.equal(google.calls.length, 0);
});

test("createEvent: a pending row younger than two minutes holds the id; an older one (a crashed request) is taken over", async () => {
  const pending = (id, age, userId = ann) => db.prepare(`
    INSERT INTO assistant_confirmations (confirm_id, user_id, result_json, action_type, target, state, created_at)
    VALUES (?, ?, '{}', 'createEvent', ?, 'pending', datetime('now', ?))
  `).run(id, userId, TARGET, age);
  const young = newId();
  pending(young, "-100 seconds");
  const held = await confirm(ann, young);
  assert.equal(held.status, 409);
  assert.equal(held.data.error, "still working on that one");
  assert.equal(rowOf(young).state, "pending", "a refused request does not touch the row");

  const stale = newId();
  pending(stale, "-130 seconds");
  const google = useGoogle(booksEverything());
  const r = await confirm(ann, stale);
  assert.equal(r.status, 200);
  assert.equal(google.calls.filter(isInsert).length, 1);
  assert.equal(google.calls[0].json.id, eventIdOf(stale));
  assert.equal(rowOf(stale).state, "done");
  assert.deepEqual(JSON.parse(rowOf(stale).result_json), r.data.result);

  // a stale row whose booking Google already has (the crash came after Google answered): Google's 409 is success
  const crashed = newId();
  pending(crashed, "-500 seconds");
  useGoogle(fakeFetch(() => json({}, 409)));
  const again = await confirm(ann, crashed);
  assert.equal(again.status, 200);
  assert.equal(rowOf(crashed).state, "done");

  // someone else's pending row is theirs
  const theirs = newId();
  pending(theirs, "-500 seconds", lou);
  const stolen = await confirm(ann, theirs);
  assert.equal(stolen.status, 409);
  assert.equal(stolen.data.error, "confirmId already used");
});

// ── the existing actions ─────────────────────────────────────────────────────

test("the synchronous actions still write their rows as 'done' (the column default), and keep their behaviour", async () => {
  const columns = db.prepare("PRAGMA table_info(assistant_confirmations)").all();
  const state = columns.find((c) => c.name === "state");
  assert.ok(state, "assistant_confirmations has a state column");
  assert.equal(state.notnull, 1);
  assert.equal(state.dflt_value, "'done'");

  const logId = newId();
  const logged = await as(ann)("POST", "/api/assistant/confirm", { sideEffect: { type: "logContact", clientId: chen, confirmId: logId } });
  assert.equal(logged.status, 200);
  assert.equal(rowOf(logId).state, "done");
  const dup = await as(ann)("POST", "/api/assistant/confirm", { sideEffect: { type: "logContact", clientId: chen, confirmId: logId } });
  assert.equal(dup.data.duplicate, true);
  const stageId = newId();
  const staged = await as(ann)("POST", "/api/assistant/confirm", { sideEffect: { type: "setCareerStage", stage: "established", confirmId: stageId } });
  assert.equal(staged.status, 200);
  assert.equal(rowOf(stageId).state, "done");
  assert.equal((await as(ann)("POST", "/api/assistant/confirm", { sideEffect: { type: "nope" } })).data.error, "unknown action");
});

// ── /turn ────────────────────────────────────────────────────────────────────

test("turn: the Google adapter is wired in, so a booking turn proposes a createEvent that /confirm then books", async () => {
  const google = useGoogle(booksEverything());
  app.set("anthropicClient", fakeClient([useTool("createEventTool", { date: "2099-06-15", time: "10:00", title: "Call the title company" })]));
  const turn = await as(ann)("POST", "/api/assistant/turn", {
    rates: RATES, messages: [{ role: "user", content: "put a call with the title company on my calendar June fifteenth at ten" }],
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.error, undefined, JSON.stringify(turn.data));
  assert.equal(turn.data.reply, 'Just to confirm — put "Call the title company" on your calendar for Monday, June 15th at 10:00 AM Mountain Standard Time, 30 minutes? Nobody gets an invite.');
  const side = turn.data.sideEffect;
  assert.equal(side.type, "createEvent");
  assert.deepEqual(side.event, { title: "Call the title company", date: "2099-06-15", time: "10:00", durationMinutes: 30, timeZone: PHX });
  assert.match(side.confirmId, /^[0-9a-f]{8}-/);
  assert.equal(google.calls.length, 0, "a turn books nothing");
  assert.equal(rowCount(), 0);

  const done = await as(ann)("POST", "/api/assistant/confirm", { sideEffect: side });
  assert.equal(done.status, 200);
  assert.equal(done.data.reply, 'Done — "Call the title company" is on your calendar for Monday, June 15th at 10:00 AM Mountain Standard Time.');
  assert.equal(google.calls.filter(isInsert).length, 1);
  assert.equal(google.calls[0].json.id, eventIdOf(side.confirmId));
});

test("turn: with no Google connection a booking turn is told so in the broker's words, and /confirm is never reached", async () => {
  db.prepare("DELETE FROM google_connections").run();
  const google = useGoogle(noNetwork());
  app.set("anthropicClient", fakeClient([useTool("createEventTool", { date: "2099-06-15", time: "10:00", title: "Call the title company" })]));
  const turn = await as(ann)("POST", "/api/assistant/turn", {
    rates: RATES, messages: [{ role: "user", content: "put a call with the title company on my calendar June fifteenth at ten" }],
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.sideEffect, undefined);
  assert.equal(google.calls.length, 0);
});

test("turn: a draftEmail turn carries `compose` with the client's address from the record, and no sideEffect", async () => {
  app.set("anthropicClient", fakeClient([
    useTool("findClient", { query: "chen" }, "toolu_1"),
    useTool("draftEmailTool", { clientId: chen, purpose: "check_in" }, "toolu_2"),
  ]));
  const turn = await as(ann)("POST", "/api/assistant/turn", {
    rates: RATES, messages: [{ role: "user", content: "Draft the Chens a check-in" }],
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.data.error, undefined, JSON.stringify(turn.data));
  assert.equal(turn.data.sideEffect, undefined);
  assert.equal(turn.data.details, undefined);
  const { compose } = turn.data;
  assert.equal(compose.to, CHEN_EMAIL);
  assert.equal(compose.subject, "How's everything with your home?");
  assert.ok(compose.body.startsWith("Hi Robert & Linda Chen,\n\n"));
  assert.ok(compose.body.includes("NMLS #123456"));
  assert.ok(compose.links.gmail.startsWith("https://mail.google.com/mail/?view=cm"));
  assert.match(turn.data.reply, /ready on your screen/);
});

test("turn: an ordinary answer carries no `compose` key", async () => {
  app.set("anthropicClient", fakeClient([resp([{ type: "text", text: "Hello." }], "end_turn")]));
  const turn = await as(ann)("POST", "/api/assistant/turn", { rates: RATES, messages: [{ role: "user", content: "hello" }] });
  assert.equal(turn.status, 200);
  assert.equal("compose" in turn.data, false);
});

// (keep this the last test of the file: it reads every line the tests above made the code log)
test("Final fix (Ruling 59): no access or refresh token appears in any line the code logged", () => {
  for (const line of logged) {
    for (const token of [ACCESS, REFRESH, ACCESS_NEW, REFRESH_NEW]) assert.ok(!line.includes(token), `a token in a log line: ${line.slice(0, 60)}`);
    assert.ok(!/ya29\.|1\/\/|access_token|refresh_token|SECRET-BODY/.test(line), `token-like text in a log line: ${line.slice(0, 60)}`);
  }
});
