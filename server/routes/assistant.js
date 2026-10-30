"use strict";
// Charli over HTTP.
//   POST /api/assistant/turn     one conversational turn (or the code-authored morning greeting)
//   POST /api/assistant/confirm  the ONLY path that writes from a voice action
//   GET  /api/assistant/usage    org-wide cost totals (broker only)
//
// /turn never writes and never 500s: a model or tool failure is a 200 error turn, and so is a turn that runs past its
// deadline (CHARLI_TURN_DEADLINE_MS, see turnDeadlineMs). A change Charli
// proposes comes back as `sideEffect` with a code-authored read-back; the browser echoes it to
// /confirm only after the user says yes. That body is UNTRUSTED browser input, so /confirm accepts
// five action types, takes org/user from the session alone, and runs the same validation and checks
// as the REST routes (createClientForUser / logContactForUser in routes/clients.js). Four of them write synchronously, in one
// transaction; the fifth, createEvent, books on the user's own Google calendar, which a transaction cannot wait for.
// A broker who declines the briefing's follow-up question ("skip it", with its followUpRecId) is answered by code: see skipFollowUp.
// An email Charli sets up for the broker (draftEmailTool) comes back from /turn as `compose` and is never confirmed or sent.
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("../db");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { runTurn, DEFAULT_TURN_DEADLINE_MS, isDecline } = require("../lib/assistant/orchestrator");
const followups = require("../lib/assistant/followups");
const { makeJudge, makeAdviceJudge } = require("../lib/assistant/judge");
const { makeLive, userLocalDate } = require("../lib/assistant/live");
const assistantTools = require("../lib/assistant/tools");   // called as assistantTools.x(): tests can swap a tool
const assistantBriefing = require("../lib/assistant/briefing");   // called as assistantBriefing.buildBriefing(): tests can swap it
const { ERROR_TURN } = require("../lib/assistant/prompt");
const { stageById, spokenStageLabel } = require("../lib/assistant/coaching");
const { GREETING_OPENERS, openerFor, hourOf } = require("../lib/assistant/openers");   // the opening words (GREETING_OPENERS and openerFor re-exported below)
const {
  normalizeHistory, hasOversizedMessage, hasOversizedNormalizedMessage, SESSION_STARTED, MAX_MESSAGE_CHARS, MAX_RAW_MESSAGES,
} = require("../lib/assistant/history");
const { recordUsage, getOrgUsage } = require("../lib/assistant/metering");
const { createClientForUser, logContactForUser, toClient } = require("./clients");
const { googleFor } = require("../lib/google");
const { parseTime, toInstant, wallTimeExists, spokenDay, spokenTime, zoneName } = require("../lib/google/time");

const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 365;

// ── The Anthropic client ─────────────────────────────────────────────────────

// `app.set("anthropicClient", fake)` is the test seam. Otherwise one real client is built on first use
// (like routes/rates.js) and cached. A missing key throws here, inside the turn's try block, so it
// becomes the error turn rather than a crash.
let realClient = null;
function getClient(req) {
  const injected = req.app.get("anthropicClient");
  if (injected) return injected;
  if (!realClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
    // A voice turn can't wait out the SDK's 10-minute default. This is the per-request cap; runTurn's deadline bounds the whole turn.
    realClient = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  }
  return realClient;
}

// How long one /turn may take, in ms: CHARLI_TURN_DEADLINE_MS, read on each request. The default is 25 s. A value is used only if it is a
// whole number of ms from 2 s (less leaves no time for a model call) to 30 s (the browser gives up on a turn at 35 s, so a longer
// deadline would never be heard); anything else (unset, empty, text, out of range) falls back to the default.
const MIN_TURN_DEADLINE_MS = 2_000;
const MAX_TURN_DEADLINE_MS = 30_000;
function turnDeadlineMs() {
  const raw = process.env.CHARLI_TURN_DEADLINE_MS;
  const ms = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return ms >= MIN_TURN_DEADLINE_MS && ms <= MAX_TURN_DEADLINE_MS ? ms : DEFAULT_TURN_DEADLINE_MS;
}

// What gets logged for a failure: the message only (never the stack or the request, which hold client data).
const errText = (err) => (err && err.message) || String(err);

// ── Request shaping ──────────────────────────────────────────────────────────

// The browser's rates are the ones it already fetched for the dashboard (as for /api/sweeps). Only the
// numeric rate_* fields, a YYYY-MM-DD date and a short source label go on to the tools and the model.
// null when there is no usable 30-year rate.
function cleanRates(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Number.isFinite(raw.rate_30yr_fixed)) return null;
  const rates = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/^rate_[a-z0-9_]{1,40}$/.test(key) && Number.isFinite(value)) rates[key] = value;
  }
  if (typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) rates.date = raw.date;
  if (typeof raw.source === "string") rates.source = raw.source.slice(0, 200);
  return rates;
}

// A confirmId is a UUID (case-insensitive; stored lowercase).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── The greeting: the morning briefing (no model call) ───────────────────────

// Ruling R13: one briefing at a time per user. Two greetings from the same user (two tabs, a double-fired effect) must not build
// side by side, because two Google token refreshes racing can flag the connection 'reconnect'. The second awaits the first's
// promise and gets the same briefing. The service runs a single instance, so a map in memory is enough. The entry goes when
// the promise settles, whether it resolved or rejected.
const briefingsInFlight = new Map();   // user id -> the briefing being built
function briefingFor(userId, build) {
  const building = briefingsInFlight.get(userId);
  if (building) return building;
  const promise = (async () => build())();   // a throw before the first await becomes a rejection too
  briefingsInFlight.set(userId, promise);
  const done = () => { if (briefingsInFlight.get(userId) === promise) briefingsInFlight.delete(userId); };
  promise.then(done, done);
  return promise;
}

// ── The /confirm action bodies ───────────────────────────────────────────────

const CLIENT_TEXT_FIELDS = ["name", "email", "phone", "loanType", "closeDate", "notes"];
const CLIENT_NUMBER_FIELDS = ["currentRate", "loanBalance", "propertyValue", "creditScore"];

// A client the browser asks to add, reduced to the fields POST /api/clients reads. Text fields must be
// strings (a number there would throw inside the shared helper, not validate). -> { body } | { errors }
function clientFromFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return { errors: { name: "Name is required" } };
  const body = {};
  const errors = {};
  for (const key of CLIENT_TEXT_FIELDS) {
    if (fields[key] == null) continue;
    if (typeof fields[key] === "string") body[key] = fields[key];
    else errors[key] = "Must be text";
  }
  for (const key of CLIENT_NUMBER_FIELDS) {
    if (fields[key] != null) body[key] = fields[key];
  }
  return Object.keys(errors).length ? { errors } : { body };
}

// What is kept per confirmId, and all the reply is built from: the client's id and name, nothing else.
const receiptOf = (client) => ({ id: client.id, name: client.name });
// A client write from the shared helpers, in the shape the transaction below works with: `result` is what the
// response carries, `receipt` what is kept per confirmId and what the reply is built from. Errors pass through.
const clientOutcome = (done) => (done.client ? { ...done, result: done.client, receipt: receiptOf(done.client) } : done);
// The addClient fingerprint: the name, trimmed, with runs of whitespace collapsed, lower-cased.
const fingerprintName = (name) => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").toLowerCase() : "");

// The code-authored sentence after a confirmed change; the browser speaks it and appends it to the
// conversation as the assistant's turn (so the read-back is no longer the last thing Charli said). The stage is said as the
// read-back says it ("Veteran, ten or more years"): the screen label's "(10+ years)" reads aloud as "ten+".
function confirmReply(type, receipt) {
  if (type === "createEvent") {
    // the zone as the read-back said it (a receipt kept before the zone was stored has none, and is read without it)
    const zone = zoneName(receipt.timeZone);
    return `Done — "${receipt.title}" is on your calendar for ${spokenDay(receipt.date)} at ${spokenTime(parseTime(receipt.time))}${zone ? ` ${zone}` : ""}.`;
  }
  if (type === "setCareerStage") return `Done — your career stage is set to ${spokenStageLabel(receipt.stage) || receipt.label}.`;
  if (type === "addToCallList") return `Done — ${receipt.name} is on tomorrow's call list.`;
  if (type === "logContact" && receipt.outcome === "not_reached") return `Done — I noted that you couldn't reach ${receipt.name}.`;
  return type === "logContact" ? `Done — I logged a contact for ${receipt.name}.` : `Done — I added ${receipt.name} as a new client.`;
}

// ── Calls and tomorrow's list (logContact, addToCallList) ───────────────────

// An instant as followups.js keeps them: SQLite UTC text, "YYYY-MM-DD HH:MM:SS".
const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// logContactForUser's reach check without its write: 404 for no such client, 403 for another org's client and, for an LO, for
// another LO's. -> { status, error } | { status: 200, client }
function clientInReach(user, id) {
  const existing = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!existing) return { status: 404, error: "Client not found" };
  if (user.role === "lo" && existing.user_id !== user.id) return { status: 403, error: "Access denied" };
  if (existing.org_id !== user.org_id) return { status: 403, error: "Access denied" };
  return { status: 200, client: toClient(existing) };
}

// The logContact write, run inside /confirm's transaction. A reached call is logContactForUser's write first (its reach check,
// then last_contact = now); a call that did not connect gets the same reach check and no write to the client (it is no contact,
// so their six-month check-in date stays as it was). Only then is the call logged with the broker's notes, and the caller's open
// recommendations of that client closed with the outcome, so Charlie does not ask about them again. The receipt kept per
// confirmId is { id, name }, plus the outcome when it was not reached: never the notes.
function logCallForUser(user, id, outcome, notes) {
  const reach = outcome === "reached" ? logContactForUser(db, user, id) : clientInReach(user, id);
  if (reach.status !== 200) return reach;
  const nowUtc = sqliteUtc(Date.now());
  followups.logCall(db, { userId: user.id, clientId: id, outcome, notes, nowUtc });
  followups.resolveForClient(db, user.id, id, outcome, nowUtc);
  const receipt = outcome === "reached" ? receiptOf(reach.client) : { ...receiptOf(reach.client), outcome };
  return { result: reach.client, receipt };
}

// The addToCallList write: a carry dated `day` for one of the caller's OWN clients (the call list is never the team's, so a broker
// cannot carry an LO's client either): 404 for no such client, 403 for anyone else's. The receipt is { id, name, day }.
function addToCallListForUser(user, id, day) {
  const client = db.prepare("SELECT id, name, user_id FROM clients WHERE id = ?").get(id);
  if (!client) return { status: 404, error: "Client not found" };
  if (client.user_id !== user.id) return { status: 403, error: "Access denied" };
  followups.addCarry(db, user.id, id, day);
  const receipt = { id: client.id, name: client.name, day };
  return { result: receipt, receipt };
}

// "Skip it": the broker's answer to the briefing's follow-up question (its briefing.followUp.recId, sent back as followUpRecId) is
// a decline (isDecline). The line code says after dismissing it, or null when this turn is no skip. The row must be a positive
// integer id of the caller's own, about a client who is still theirs; the name is read from the client record (never from the
// body), and only when it may be spoken (briefing.js speakable, which every name the briefing asks about passed). Every open row
// of that client the briefing could ask about goes with it, since one question asks about all of a client's rows (briefing.js
// pickFollowUps) and the line says it won't be asked again; a carry is no question, and stays as the broker asked. A row already
// closed is left as it is.
function skipFollowUp(user, recId, text) {
  if (!Number.isInteger(recId) || recId <= 0 || !isDecline(text)) return null;
  const rec = db.prepare(`
    SELECT r.client_id AS clientId, c.name AS name FROM charlie_recommendations r
    JOIN clients c ON c.id = r.client_id AND c.user_id = r.user_id
    WHERE r.id = ? AND r.user_id = ?
  `).get(recId, user.id);
  const name = rec ? assistantBriefing.speakable(rec.name) : null;
  if (!name) return null;
  db.transaction(() => {
    const open = db.prepare(
      "SELECT id FROM charlie_recommendations WHERE user_id = ? AND client_id = ? AND status = 'open' AND source <> 'carry'"
    ).all(user.id, rec.clientId);
    for (const row of open) followups.dismiss(db, user.id, row.id);
  })();
  return `No problem — I won't ask about ${name} again.`;
}

// The setCareerStage write: ONLY the signed-in user's own row (never an id from the body), and the receipt kept per
// confirmId is the stage and its label. It is idempotent, so a confirmId is optional here.
function setCareerStageForUser(user, stage) {
  const info = db.prepare("UPDATE users SET career_stage = ? WHERE id = ?").run(stage.id, user.id);
  if (info.changes !== 1) return { status: 404, error: "User not found" };
  const receipt = { stage: stage.id, label: stage.label };
  return { result: receipt, receipt };
}

// ── Booking a calendar event (createEvent) ───────────────────────────────────

// The one /confirm action that waits on another service. A Google Calendar insert cannot run inside a better-sqlite3 transaction,
// so its confirmId row has two states: 'pending' (claimed in a transaction, then Google is called outside it) and 'done' (the
// receipt is kept). The other actions are written synchronously and are always 'done'.
const PENDING_SECONDS = 120;              // a pending row this young is a request still at work; an older one is a dead request's
const EVENT_TITLE_MAX = 120;
const EVENT_MINUTES_MIN = 15;
const EVENT_MINUTES_MAX = 240;

// What the broker is told when Google cannot book, by the { code } the adapter gives (lib/google).
const GOOGLE_REASONS = {
  not_connected: "your Google calendar isn't connected",
  reconnect: "your Google connection has expired — reconnect it in the Charlie panel",
  unavailable: "couldn't reach Google — try again",
};
const GOOGLE_UNREACHABLE = GOOGLE_REASONS.unavailable;

// The Google event id a confirmId books under: "br" + the id's hex (a lower-case UUID's digits are a subset of the base32hex
// alphabet Google takes), so the same confirmId can only ever make the one event.
const bookingEventId = (confirmId) => `br${confirmId.replace(/-/g, "")}`;

// What is wrong with a booking's fields, or null. The tool checked all of this when it packaged the booking, but the body is
// untrusted browser input. (Whether the start has passed and whether the zone is the connection's depend on the moment and
// on the connection, so they are checked later, once a duplicate has been ruled out.)
function eventProblem({ date, time, durationMinutes, title }) {
  let realDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  if (realDate) {
    try { spokenDay(date); } catch (_err) { realDate = false; }
  }
  if (!realDate) return "a valid date is required";
  if (!/^\d{2}:\d{2}$/.test(time) || !parseTime(time)) return "a valid time is required (HH:MM)";
  if (!Number.isInteger(durationMinutes) || durationMinutes < EVENT_MINUTES_MIN || durationMinutes > EVENT_MINUTES_MAX) {
    return `the length must be a whole number of minutes from ${EVENT_MINUTES_MIN} to ${EVENT_MINUTES_MAX}`;
  }
  if (!title.trim() || title.length > EVENT_TITLE_MAX || /[\r\n\u2028\u2029]/.test(title)) {
    return `the title must be one line of at most ${EVENT_TITLE_MAX} characters`;
  }
  return null;
}

// POST /api/assistant/confirm for { type: "createEvent", event: { title, date, time, durationMinutes, timeZone }, confirmId }.
//   1. The shape and the fields are checked (400, nothing recorded). The confirmId is required.
//   2. One transaction: a 'done' row for this id is a duplicate (answered from the receipt, whatever has changed since: the start
//      may have passed, Google may be disconnected); a 'pending' row younger than PENDING_SECONDS is 409 "still working on
//      that one" with `pending: true` (the only refusal that is not final); anything else is claimed by writing (or taking over) a
//      'pending' row.
//   3. Outside it: the connection and the clock decide (409 / 400), then Google books under the id "br" + the confirmId's hex.
//   4. Booked (Google's own 409, "that id exists", counts: it is the same booking) -> the row becomes 'done' with the receipt
//      { eventId, title, date, time }. Not booked -> the row is deleted, so the id is good for a retry, and the broker is told
//      why: 409 for a Google { code } (not connected / expired / unreachable), 502 for any other Google failure.
// Never rejects: Express 4 would not catch it.
async function confirmCreateEvent(req, res, sideEffect) {
  const refuse = (status, error) => res.status(status).json({ success: false, error });
  const type = "createEvent";

  const event = sideEffect.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return refuse(400, "a valid event is required");
  const { title, date, time, durationMinutes, timeZone } = event;
  if ([title, date, time, timeZone].some((value) => typeof value !== "string")) return refuse(400, "a valid event is required");
  if (sideEffect.confirmId == null) return refuse(400, "confirmId required");
  if (typeof sideEffect.confirmId !== "string" || !UUID_RE.test(sideEffect.confirmId)) return refuse(400, "confirmId must be a UUID");
  const confirmId = sideEffect.confirmId.toLowerCase();
  const problem = eventProblem(event);
  if (problem) return refuse(400, problem);
  const target = JSON.stringify([date, time, durationMinutes, title]);

  let claim;
  try {
    claim = db.transaction(() => {
      const prior = db.prepare(
        "SELECT user_id, result_json, action_type, target, state, created_at > datetime('now', ?) AS fresh " +
        "FROM assistant_confirmations WHERE confirm_id = ?"
      ).get(`-${PENDING_SECONDS} seconds`, confirmId);
      if (prior) {
        if (prior.user_id !== req.user.id) return { conflict: "confirmId already used" };
        if (prior.action_type !== type || prior.target !== target) return { conflict: "confirmId was used for a different action" };
        if (prior.state === "done") return { duplicate: JSON.parse(prior.result_json) };
        if (prior.fresh) return { working: true };
        // a pending row this old belongs to a request that died (the process went down mid-call): take it over and restart its clock
        db.prepare("UPDATE assistant_confirmations SET created_at = datetime('now') WHERE confirm_id = ?").run(confirmId);
        return { claimed: true };
      }
      db.prepare(
        "INSERT INTO assistant_confirmations (confirm_id, user_id, result_json, action_type, target, state) VALUES (?, ?, '{}', ?, ?, 'pending')"
      ).run(confirmId, req.user.id, type, target);
      return { claimed: true };
    })();
  } catch (err) {
    console.error("POST /api/assistant/confirm:", errText(err));
    return refuse(500, "Database error");
  }
  if (claim.conflict) return refuse(409, claim.conflict);
  // (Ruling 53: `pending: true` says the first request may still book, so the client keeps the card and the user can say yes again,
  // which then meets the done receipt as a duplicate)
  if (claim.working) return res.status(409).json({ success: false, error: "still working on that one", pending: true });
  if (claim.duplicate) return res.json({ success: true, result: claim.duplicate, reply: confirmReply(type, claim.duplicate), duplicate: true });

  // Ours from here: whatever stops the booking gives the claim back, so the same confirmId can be tried again.
  const release = () => {
    try {
      db.prepare("DELETE FROM assistant_confirmations WHERE confirm_id = ? AND user_id = ? AND state = 'pending'").run(confirmId, req.user.id);
    } catch (err) {
      console.error("POST /api/assistant/confirm (release):", errText(err));
    }
  };
  const eventId = bookingEventId(confirmId);
  let booked;
  try {
    const google = googleFor({ db, userId: req.user.id, fetchFn: req.app.get("googleFetch") || globalThis.fetch });
    const connection = google.connection();
    if (connection.code) { release(); return refuse(409, GOOGLE_REASONS[connection.code] || GOOGLE_UNREACHABLE); }
    if (timeZone !== connection.timeZone) { release(); return refuse(400, "that event isn't for the calendar you connected"); }
    const clock = parseTime(time);
    if (!wallTimeExists(date, clock, timeZone)) { release(); return refuse(400, assistantTools.NO_SUCH_TIME); }
    if (toInstant(date, clock, timeZone) < Date.now()) { release(); return refuse(400, assistantTools.PAST_TIME); }

    booked = await google.insertEvent({ id: eventId, title, date, time, durationMinutes, timeZone });
    if (booked && booked.code) { release(); return refuse(409, GOOGLE_REASONS[booked.code] || GOOGLE_UNREACHABLE); }
    if (!booked || !(booked.eventId || booked.duplicate)) { release(); return refuse(502, GOOGLE_UNREACHABLE); }
  } catch (err) {
    console.error("POST /api/assistant/confirm:", errText(err));
    release();
    return refuse(500, "Something went wrong — try again");
  }

  // The event is on the calendar. If keeping the receipt fails, the row stays pending and a retry meets Google's own 409.
  const receipt = { eventId: booked.eventId || eventId, title, date, time, timeZone };
  try {
    db.prepare("UPDATE assistant_confirmations SET result_json = ?, state = 'done' WHERE confirm_id = ? AND user_id = ?")
      .run(JSON.stringify(receipt), confirmId, req.user.id);
  } catch (err) {
    console.error("POST /api/assistant/confirm (receipt):", errText(err));
  }
  return res.json({ success: true, result: receipt, reply: confirmReply(type, receipt) });
}

// ── The router ───────────────────────────────────────────────────────────────

// createAssistantRouter({ limiter }) builds a router with its own rate-limit counter; `limiter` overrides
// the express-rate-limit options (tests use a bigger or smaller `max`). The default export is the one
// index.js mounts.
function createAssistantRouter({ limiter = {} } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  // 60 requests per 15 minutes, counted per signed-in user (an office shares one IP address).
  router.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { success: false, error: "Too many requests to the assistant — please try again in a few minutes" },
    ...limiter,
  }));

  // Metering must never break a turn.
  const meter = (userId, turnId, usage) => {
    try {
      recordUsage({ userId, kind: "turn", turnId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ttsChars: 0 });
    } catch (err) {
      console.error("assistant usage:", errText(err));
    }
  };

  // POST /api/assistant/turn
  // Body: { rates, messages, localDate?, followUpRecId? } or { rates, greeting: true, localHour?, localDate? } (localDate: the
  // browser's YYYY-MM-DD; on a turn it is the lookup's "today", and the day callListTool dates a carry, when it is a real date within
  // a day of the UTC date, and ignored otherwise: M-6; followUpRecId: the briefing's followUp.recId, on the answer to its question).
  // -> { reply, sources, sideEffect?, details?, turnId }; a failed turn, or one that outran its deadline,
  //    -> 200 { reply, error: true, sources: [], turnId }
  // The greeting is the morning briefing (lib/assistant/briefing.js): -> { reply, sources, turnId, briefing: { kind, strip, followUp } }.
  router.post("/turn", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rates = cleanRates(body.rates);
    if (!rates) return res.status(400).json({ success: false, error: "current rates required" });
    const turnId = crypto.randomUUID();
    // ctx.google is bound to the signed-in user: a tool can only ever reach that user's own calendar. Building it makes no call.
    const google = googleFor({ db, userId: req.user.id, fetchFn: req.app.get("googleFetch") || globalThis.fetch });
    const ctx = { user: req.user, rates, db, google };

    if (body.greeting === true) {
      try {
        // the browser's date counts only within a day of the UTC date (M-6), else the UTC date; its hour only when it is a real hour
        const localDate = userLocalDate(body.localDate) || new Date().toISOString().slice(0, 10);
        const localHour = hourOf(body.localHour);
        const made = await briefingFor(req.user.id, () => assistantBriefing.buildBriefing({
          user: req.user, ctx: assistantTools.withTurnClientNames(ctx), db, localHour, localDate,
        }));
        meter(req.user.id, turnId, {});
        return res.json({
          reply: made.reply, sources: made.sources, turnId, briefing: { kind: made.kind, strip: made.strip, followUp: made.followUp },
        });
      } catch (err) {
        console.error("POST /api/assistant/turn (greeting):", errText(err));
        meter(req.user.id, turnId, {});
        return res.json({ reply: ERROR_TURN, error: true, sources: [], turnId });
      }
    }

    const tooLong = () => res.status(400).json({
      success: false, error: `a message is longer than ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters`,
    });
    if (Array.isArray(body.messages) && body.messages.length > MAX_RAW_MESSAGES) {
      return res.status(400).json({ success: false, error: `a history can't have more than ${MAX_RAW_MESSAGES} messages` });
    }
    if (hasOversizedMessage(body.messages)) return tooLong();
    const messages = normalizeHistory(body.messages);
    if (!messages) return res.status(400).json({ success: false, error: "messages must be a history ending with the user's message" });
    // normalizeHistory joins consecutive same-role messages, so the cap is checked again on what would be sent
    if (hasOversizedNormalizedMessage(messages)) return tooLong();

    // A decline of the briefing's follow-up question is answered by code (skipFollowUp): no model call, nothing to confirm, metered
    // like the greeting. A followUpRecId that is not a positive integer or not the caller's, or an answer that is no decline, is
    // ignored, and the turn goes to the model as usual.
    let skipped;
    try {
      skipped = skipFollowUp(req.user, body.followUpRecId, messages[messages.length - 1].content);
    } catch (err) {
      console.error("POST /api/assistant/turn (skip):", errText(err));
      meter(req.user.id, turnId, {});
      return res.json({ reply: ERROR_TURN, error: true, sources: [], turnId });
    }
    if (skipped) {
      meter(req.user.id, turnId, {});
      return res.json({ reply: skipped, sources: [], turnId });
    }

    let out;
    try {
      const client = getClient(req);
      // The second check on a reply only a topic rule blocked: `app.set("assistantJudge", fake)` is the test seam, otherwise the
      // Haiku judge on the same client. Its tokens come back in out.usage.
      const judge = req.app.get("assistantJudge") || makeJudge(client);
      // Round 4, V2: the advice check on a cited turn with a tax or legal word: `app.set("assistantAdviceJudge", fake)` is the test
      // seam, otherwise the Haiku advice judge on the same client. Its tokens come back in out.usage too.
      const adviceJudge = req.app.get("assistantAdviceJudge") || makeAdviceJudge(client);
      // lookUpLive's web search: `app.set("liveLookup", fake)` is the test seam, otherwise a search on the same client, each one
      // metered as a 'live' row of its own under this turn's id (and counted toward the user's daily cap). Its "today" is the
      // user's own date when the browser sent a valid one (M-6: a real date within a day of the UTC date), else the UTC date.
      const localDate = userLocalDate(body.localDate) || undefined;
      // callListTool dates a carry by it too (the UTC date when there is none)
      if (localDate) ctx.localDate = localDate;
      ctx.live = req.app.get("liveLookup") || makeLive({ client, db, userId: req.user.id, turnId, localDate });
      out = await runTurn({ messages, ctx, client, judge, adviceJudge, deadlineMs: turnDeadlineMs() });
    } catch (err) {
      console.error("POST /api/assistant/turn:", errText(err));
      meter(req.user.id, turnId, {});
      return res.json({ reply: ERROR_TURN, error: true, sources: [], turnId });
    }
    meter(req.user.id, turnId, out.usage || {});
    const payload = { reply: out.reply, sources: out.sources, turnId };
    // a turn that ran out of time, or that the model refused, comes back like a failed one (200, error:true), with the usage of the
    // calls that did finish; the warning (no content) is there to count how often each happens in production (M-2: a refusal is
    // logged as a refusal, not as a deadline)
    if (out.error) {
      payload.error = true;
      console.warn(out.reason === "refusal"
        ? "POST /api/assistant/turn: the model refused the turn"
        : "POST /api/assistant/turn: turn deadline reached");
    }
    // Each proposed change gets its own id; /confirm uses it so a double tap cannot write twice. `details` are the rows the
    // pending card shows under the read-back (display only: /confirm never reads them).
    if (out.sideEffect) payload.sideEffect = { ...out.sideEffect, confirmId: crypto.randomUUID() };
    if (out.sideEffect && Array.isArray(out.details)) payload.details = out.details;
    // An email Charli set up (draftEmailTool): the compose links for the browser to open. Nothing to confirm and nothing is sent;
    // the broker sends it from their own mail app.
    if (out.compose) payload.compose = out.compose;
    res.json(payload);
  });

  // POST /api/assistant/confirm — Body: { sideEffect } as /turn returned it (confirmId included), after the
  // user said yes. -> { success: true, result: <client>, reply }, where `reply` is the code-authored sentence
  // for the browser to speak and append to the conversation as the assistant's turn ("Done — I logged a
  // contact for <name>."). A confirmId already confirmed by the same user for the same action comes back as
  // { success: true, result: { id, name }, reply, duplicate: true } and nothing is executed again.
  //   * setCareerStage ({ type, stage, confirmId? }, stage one of the CAREER_STAGES ids, else 400) sets
  //     users.career_stage for the signed-in user ONLY and replies "Done — your career stage is set to <label>."
  //     (result { stage, label }); its confirmId is optional (the update is idempotent) and its target is the stage id.
  //   * logContact ({ type, clientId, outcome?, notes?, confirmId? }): outcome "reached" (the default) or "not_reached", else 400;
  //     notes text (else 400), cleaned and capped as logContactTool does. One transaction: for reached, logContactForUser (its
  //     404 / 403, then last_contact = now); for not_reached the same reach check and no write to the client; then the call goes
  //     in contact_log with the notes and the caller's open recommendations of that client are closed with the outcome. Replies
  //     "Done — I logged a contact for <name>." or, not reached, "Done — I noted that you couldn't reach <name>."
  //   * addToCallList ({ type, clientId, day, confirmId }, day a real YYYY-MM-DD within a day of the UTC date, else 400) carries one
  //     of the caller's OWN clients to the next day's call list (404 unknown, 403 anyone else's, a broker's LO's included) and
  //     replies "Done — <name> is on tomorrow's call list." (result { id, name, day }).
  //   * addClient and addToCallList require a confirmId; logContact may send one. A malformed one is 400.
  //   * a confirmId is bound to the user AND to the action it was recorded for (type + target); the same id
  //     from another user, or for another type or target, is 409 and nothing is executed.
  //   * the confirmId only dedupes: every validation and authorization check still applies, and a request
  //     that fails (400 / 403 / 404) records nothing, so the id is still good for a corrected retry.
  //   * what is kept per confirmId is { id, name } only (no email, phone or notes; a not-reached log adds its outcome, a carry its
  //     day), or { stage, label }.
  //   * createEvent ({ type, event: { title, date, time, durationMinutes, timeZone }, confirmId }, the confirmId required) books the
  //     event on the signed-in user's own Google calendar: asynchronous, see confirmCreateEvent. What is kept is
  //     { eventId, title, date, time }; the reply is `Done — "<title>" is on your calendar for <day> at <time>.`
  router.post("/confirm", (req, res) => {
    const sideEffect = req.body && req.body.sideEffect;
    if (!sideEffect || typeof sideEffect !== "object" || Array.isArray(sideEffect)) {
      return res.status(400).json({ success: false, error: "sideEffect required" });
    }
    const bad = (error) => res.status(400).json({ success: false, error });

    // A booking waits on Google, so it has its own (asynchronous) path; the rest are written synchronously, below.
    if (sideEffect.type === "createEvent") {
      return confirmCreateEvent(req, res, sideEffect).catch((err) => {
        console.error("POST /api/assistant/confirm:", errText(err));
        if (!res.headersSent) res.status(500).json({ success: false, error: "Something went wrong — try again" });
      });
    }

    // Shape checks first; they leave `execute`, the write to run if this is not a duplicate, and `target`,
    // the fingerprint of what it acts on.
    let execute;
    let target;
    if (sideEffect.type === "addClient") {
      const parsed = clientFromFields(sideEffect.fields);
      if (parsed.errors) return res.status(400).json({ success: false, errors: parsed.errors });
      target = fingerprintName(parsed.body.name);
      execute = () => clientOutcome(createClientForUser(db, req.user, parsed.body));
    } else if (sideEffect.type === "logContact") {
      const id = sideEffect.clientId;
      if (!Number.isInteger(id) || id <= 0) return bad("a valid clientId is required");
      // the outcome and the notes are checked and cleaned as logContactTool does (tools.js callOutcome, callNotes)
      const how = assistantTools.callOutcome(sideEffect.outcome);
      if (how.error) return bad(how.error);
      const said = assistantTools.callNotes(sideEffect.notes);
      if (said.error) return bad(said.error);
      // a reached log keeps the target a logContact always had, so a confirmId kept before outcomes existed still dedupes; the
      // notes are never part of it (they are not kept)
      target = how.outcome === "reached" ? String(id) : `${id}:${how.outcome}`;
      execute = () => logCallForUser(req.user, id, how.outcome, said.notes);
    } else if (sideEffect.type === "addToCallList") {
      const id = sideEffect.clientId;
      if (!Number.isInteger(id) || id <= 0) return bad("a valid clientId is required");
      // the day it was asked for: the browser's own date, so a real date within a day of the UTC date (as /turn takes it)
      const day = userLocalDate(sideEffect.day);
      if (!day) return bad("a valid day is required");
      target = `${id}:${day}`;
      execute = () => addToCallListForUser(req.user, id, day);
    } else if (sideEffect.type === "setCareerStage") {
      const stage = stageById(sideEffect.stage);
      if (!stage) return bad("a valid career stage is required");
      target = stage.id;
      execute = () => setCareerStageForUser(req.user, stage);
    } else {
      return bad("unknown action");
    }
    const type = sideEffect.type;
    let confirmId = null;
    if (sideEffect.confirmId != null) {
      if (typeof sideEffect.confirmId !== "string" || !UUID_RE.test(sideEffect.confirmId)) return bad("confirmId must be a UUID");
      confirmId = sideEffect.confirmId.toLowerCase();
    } else if (sideEffect.type === "addClient" || sideEffect.type === "addToCallList") {
      return bad("confirmId required");
    }

    try {
      // One transaction: the duplicate check, the write and its record commit (or roll back) together.
      const outcome = db.transaction(() => {
        if (confirmId) {
          const prior = db.prepare(
            "SELECT user_id, result_json, action_type, target FROM assistant_confirmations WHERE confirm_id = ?"
          ).get(confirmId);
          if (prior) {
            if (prior.user_id !== req.user.id) return { conflict: "confirmId already used" };
            if (prior.action_type !== type || prior.target !== target) return { conflict: "confirmId was used for a different action" };
            return { duplicate: JSON.parse(prior.result_json) };
          }
        }
        const done = execute();
        if (done.receipt && confirmId) {
          db.prepare("INSERT INTO assistant_confirmations (confirm_id, user_id, result_json, action_type, target, state) VALUES (?, ?, ?, ?, ?, 'done')")
            .run(confirmId, req.user.id, JSON.stringify(done.receipt), type, target);
        }
        return done;
      })();
      if (outcome.conflict) return res.status(409).json({ success: false, error: outcome.conflict });
      if (outcome.duplicate) {
        return res.json({ success: true, result: outcome.duplicate, reply: confirmReply(type, outcome.duplicate), duplicate: true });
      }
      if (outcome.errors) return res.status(400).json({ success: false, errors: outcome.errors });
      if (outcome.error) return res.status(outcome.status).json({ success: false, error: outcome.error });
      res.json({ success: true, result: outcome.result, reply: confirmReply(type, outcome.receipt) });
    } catch (err) {
      console.error("POST /api/assistant/confirm:", errText(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  // GET /api/assistant/usage?days=30 — broker only; totals over every user in the caller's org.
  router.get("/usage", requireBroker, (req, res) => {
    const asked = parseInt(req.query.days, 10);
    const days = Number.isFinite(asked) ? Math.min(MAX_USAGE_DAYS, Math.max(1, asked)) : DEFAULT_USAGE_DAYS;
    try {
      res.json({ success: true, ...getOrgUsage(req.user.org_id, days) });
    } catch (err) {
      console.error("GET /api/assistant/usage:", errText(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  return router;
}

module.exports = Object.assign(createAssistantRouter(), {
  createAssistantRouter, normalizeHistory, SESSION_STARTED, turnDeadlineMs, GREETING_OPENERS, openerFor,
});
