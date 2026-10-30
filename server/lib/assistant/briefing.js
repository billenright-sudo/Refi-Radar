"use strict";
// Charlie's morning briefing (spec 5.2), built in code from tool data like the greeting it replaces: no model call, so every
// figure is grounded by construction. The model takes over only when the broker replies.
//
// buildBriefing({ user, ctx, db, localHour, localDate, nowMs }) -> { reply, sources, kind, strip, followUp }
//
// The reply, in order:
//   1. the opener (openerFor, with the user's first name);
//   2. the market line: the 30-year, its move between the latest two FRED observation dates and "as of" the latest, then one
//      clause each for a 15-year, FHA or jumbo move of 0.05 or more. A 30-year drop of DROP_THRESHOLD or more leads with
//      "Rates dropped:" in the first briefing after that observation only. An estimated set says so and claims no move;
//   3. the call list (callList.js) over the user's OWN clients, recorded as today's 'briefing' recommendations, and
//      "Plus N more check-ins due." when more are due than it names;
//   4. a broker's one count-only team line: their loan officers' open opportunities;
//   5. today's calendar: the count and the first one or two events still ahead, a title that could hold contact details (a run of
//      seven or more digits, an "@", or a "?") read as "an event";
//   6. open follow-ups (followups.js), at most two, after the calendar's calls have been matched (calendarFollowUps.js);
//   7. exactly one question: the first follow-up's, else the career question for a user with no stage, else CLOSE_QUESTION.
//
// Every section is computed on its own and a section that fails (no rates, no Google, an empty book, a sweep that throws) is
// left out silently: the briefing still renders and still ends in its one question. Figures are digits from tool data; there are
// no figure words, no contact details and no "?" before the last sentence.
//
// Google is only ever called one request at a time (two token refreshes racing can flag the connection 'reconnect'): today's
// events first, then the calendar follow-ups, and neither is waited on past CALENDAR_WAIT_MS in total. A read given up on is
// left to finish on its own (the follow-ups' upsert simply lands for the next open), and nothing else is started beside it.
const refi = require("../refi");   // called as refi.runSweep(): tests can swap it
const assistantTools = require("./tools");   // called as assistantTools.x(): tests can swap a tool
const followups = require("./followups");
const { pickCallList } = require("./callList");
const { collectCalendarFollowUps } = require("./calendarFollowUps");
const { isCitation } = require("./orchestrator");
const { stageById, CAREER_QUESTION } = require("./coaching");
const { openerFor, hourOf } = require("./openers");
const { localToday, addDays } = require("../google/time");
const { MONTHS, ordinal } = require("../dateLabels");

// Phase 1: a 30-year fall of this much or more between two observations leads the market line. Phase 2 makes it per user.
const DROP_THRESHOLD = 0.125;
// A 15-year, FHA or jumbo move smaller than this is left out, and a 30-year one is "little changed".
const MOVE_WORTH_SAYING = 0.05;
// The longest the briefing waits on Google in all (today's events, then the calendar follow-ups).
const CALENDAR_WAIT_MS = 4000;
const CALL_LIST_LIMIT = 3;
const MAX_FOLLOW_UPS = 2;
const REACHED_WINDOW_MS = 7 * 86_400_000;   // a client reached in the last 7 days is left off the list
const RECENT_DAYS = 3;                      // and one recommended in the last 3 days whose item is open or not reached

const CLOSE_QUESTION = "Want a full sweep, an update on a client, or should I get those calls on your calendar?";
const COUPLE_OF_CALLS = "I've also got a couple of calls to check on with you.";
const AN_EVENT = "an event";
const NO_TITLE = "(no title)";   // what lib/google/calendar.js calls an untitled event

// The other products whose moves are worth a clause, as the market line names them.
const OTHER_PRODUCTS = [["rate_15yr_fixed", "the 15-year"], ["rate_30yr_fha", "FHA"], ["rate_30yr_jumbo", "jumbo"]];

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Seven or more digits, however they are spaced or punctuated ("555-201-0103", "(555) 201 0103"): what a phone number looks like.
const DIGIT_RUN_RE = /\d(?:[\s().+-]*\d){6,}/;

const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");
// A failed section is logged by its name and the error's name only: never a message, which could carry client data.
const skip = (section, err) => console.error(`briefing ${section} skipped:`, errName(err));
const noQuestion = (text) => String(text).replace(/\?/g, "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);
const hasRates = (rates) => !!rates && Number.isFinite(rates.rate_30yr_fixed);
const isEstimated = (rates) => /^estimated/i.test(String(rates.source || ""));

// "2026-10-29" -> "October 29th" (with the year when it is not `localDate`'s year). The ordinal is how toSpeech reads a day.
function spokenDate(date, localDate) {
  const [, y, m, d] = DAY_RE.exec(date);
  const ref = typeof localDate === "string" ? DAY_RE.exec(localDate) : null;
  return `${MONTHS[Number(m) - 1]} ${ordinal(Number(d))}${ref && ref[1] !== y ? `, ${y}` : ""}`;
}
const realDay = (date) => {
  const m = typeof date === "string" ? DAY_RE.exec(date) : null;
  if (!m) return false;
  const at = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === date;
};

// "down 0.15" / "up 0.1": a move as getMarketUpdate gives it (two decimals), said as the number it is.
const moveText = (delta) => `${delta < 0 ? "down" : "up"} ${Number(Math.abs(delta).toFixed(2))}`;

// The time a promise is given before the briefing goes on without it. `work` never rejects (see attempt).
const TIMED_OUT = Symbol("timed out");
function within(work, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), TIMED_OUT); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
const attempt = (section, fn) => Promise.resolve().then(fn).catch((err) => { skip(section, err); return null; });

// ── the sections ─────────────────────────────────────────────────────────────

// -> { line, source, strip: { rate30, move30, asOf } } or null when there are no usable rates.
function marketSection({ ctx, db, userId, localDate }) {
  const market = assistantTools.getMarketUpdate({}, ctx);
  const data = market && isCitation(market.source) && market.data;
  const rates = data && data.rates;
  const rate30 = rates && rates.rate_30yr_fixed;
  if (!Number.isFinite(rate30)) return null;
  if (data.estimated) {
    return { line: `The 30-year is at an estimated ${rate30}%.`, source: market.source, strip: { rate30, move30: null, asOf: null } };
  }
  const asOf = realDay(rates.date) ? rates.date : null;
  const asOfText = asOf ? `, as of ${spokenDate(asOf, localDate)}` : "";
  const deltas = data.hasHistory && data.deltas && typeof data.since === "string" && data.since ? data.deltas : null;
  const move30 = deltas && Number.isFinite(deltas.rate_30yr_fixed) ? deltas.rate_30yr_fixed : null;
  const strip = { rate30, move30, asOf };
  if (move30 === null) return { line: `The 30-year is at ${rate30}%${asOfText}.`, source: market.source, strip };

  const moved = Math.abs(move30) >= MOVE_WORTH_SAYING ? moveText(move30) : "little changed";
  let line = `the 30-year is at ${rate30}%, ${moved} since ${data.since}${asOfText}.`;
  // The drop leads once per observation: the first briefing after it arrives, never again as news.
  if (move30 <= -DROP_THRESHOLD && asOf && !followups.dropAlreadyLed(db, userId, asOf)) {
    line = `Rates dropped: ${line}`;
    followups.markDropLed(db, userId, asOf);
  } else {
    line = capitalize(line);
  }
  const clauses = OTHER_PRODUCTS
    .filter(([key]) => Number.isFinite(deltas[key]) && Math.abs(deltas[key]) >= MOVE_WORTH_SAYING)
    .map(([key, label]) => `${label} is ${moveText(deltas[key])}`);
  if (clauses.length) {
    const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
    line += ` ${capitalize(joined)}.`;
  }
  return { line, source: market.source, strip };
}

// The sweep of `rows` at the briefing's own clock, with the label runSweepTool gives the same sweep.
function sweepOf(rows, rates, nowMs) {
  const result = refi.runSweep(rows, rates, new Date(nowMs));
  const source = !isEstimated(rates) ? "sweep engine" : rates.date ? `sweep engine (estimated rates ${rates.date})` : "sweep engine (estimated rates)";
  return { result, source };
}

// A broker's team line: their loan officers' clients (the org's, not their own) with an opportunity, as a count only.
function teamSection({ user, ctx, db, nowMs }) {
  if (user.role !== "broker" || !hasRates(ctx.rates)) return null;
  const rows = db.prepare("SELECT * FROM clients WHERE org_id = ? AND user_id != ? ORDER BY name ASC").all(user.org_id, user.id);
  if (rows.length === 0) return null;
  const { result, source } = sweepOf(rows, ctx.rates, nowMs);
  const n = result && result.counts && result.counts.withOpportunity;
  if (!Number.isInteger(n) || n <= 0) return null;
  return { line: `Your loan officers have ${plural(n, "opportunity", "opportunities")} open.`, source };
}

// What a calendar title may be read as: the title, or "an event" when it could carry a phone number or an email (or a "?",
// since the briefing's one question is its last sentence).
function spokenTitle(title) {
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!text || text === NO_TITLE || text.includes("@") || text.includes("?") || DIGIT_RUN_RE.test(text)) return AN_EVENT;
  return text;
}

// Today's events as the briefing reads them: { line, source, nextEvent }. The ones still ahead (not yet ended, or all day) are
// named, the first one or two of them.
function calendarSection({ date, events, nowMs }) {
  const n = events.length;
  const source = `google calendar ${date}`;
  if (n === 0) return { line: "Your calendar is clear today.", source, nextEvent: null };
  const ahead = events.filter((e) => e && (e.allDay || !Number.isFinite(e.endAt) || e.endAt > nowMs));
  const shown = ahead.slice(0, 2).map((e) => ({ title: spokenTitle(e.title), start: e.allDay ? null : e.start || null }));
  const said = shown.map((e) => (e.start ? `${e.title} at ${e.start}` : `${e.title}, all day`)).join(", then ");
  const count = `You have ${plural(n, "event")} on your calendar today`;
  let line;
  if (shown.length === 0) line = `${count}.`;
  else if (ahead.length < n) line = `${count}; next up, ${said}.`;
  else if (shown.length < n) line = `${count}, starting with ${said}.`;
  else line = `${count}: ${said}.`;
  return { line, source, nextEvent: shown[0] || null };
}

// The client ids already on today's briefing list (an earlier open today): they stay on it rather than being left off as
// "recently recommended", so re-opening Charlie shows the same list and records no new rows.
const listedToday = (db, userId, localDate) => new Set(db.prepare(
  "SELECT client_id FROM charlie_recommendations WHERE user_id = ? AND day = ? AND source = 'briefing'"
).all(userId, localDate).map((r) => r.client_id));

// -> { picks, line, moreLine }
function callListSection({ db, userId, localDate, nowMs, ownRows, sweep, estimated }) {
  const carried = followups.carriedIds(db, userId, localDate);
  const reached = followups.reachedSince(db, userId, sqliteUtc(nowMs - REACHED_WINDOW_MS));
  const recent = followups.recentlyRecommended(db, userId, addDays(localDate, -RECENT_DAYS));
  const today = listedToday(db, userId, localDate);
  // Ruling R3: (reached ∪ recently recommended) − carried, so a carried client is never left off.
  const excludeIds = new Set([...reached, ...[...recent].filter((id) => !today.has(id))]);
  for (const id of carried) excludeIds.delete(id);

  const picks = pickCallList({
    sweep,
    ownClientIds: ownRows.map((r) => r.id),
    carriedIds: carried,
    excludeIds,
    clientNames: new Map(ownRows.map((r) => [r.id, r.name])),   // Ruling R7: a carried client with no sweep row is still named
    limit: CALL_LIST_LIMIT,
  });

  let line = null;
  if (picks.length) {
    const reasons = picks.map((p) => p.reason);
    const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join("; ")}; and ${reasons[reasons.length - 1]}`;
    line = `Today's call${picks.length === 1 ? "" : "s"}${estimated ? ", on estimated rates" : ""}: ${list}.`;
  }
  let moreLine = null;
  const due = sweep && sweep.counts && sweep.counts.checkInsDue;
  if (Number.isInteger(due) && due > 0) {
    const dueIds = new Set((sweep.checkIns || []).map((r) => String(r.clientId)));
    const more = due - picks.filter((p) => dueIds.has(String(p.clientId))).length;
    if (more > 0) moreLine = picks.length ? `Plus ${more} more check-in${more === 1 ? "" : "s"} due.` : `You have ${plural(more, "check-in")} due.`;
  }
  return { picks, line, moreLine };
}

// The one question about a follow-up row.
function followUpQuestion(row, localDate) {
  const name = noQuestion(row.name);
  if (row.source === "calendar") return `How did the call with ${name} go?`;
  const when = row.day === localDate ? "This morning" : row.day === addDays(localDate, -1) ? "Yesterday" : "Earlier";
  return `${when} I suggested calling ${name}. Were you able to reach them?`;
}

// ── the briefing ─────────────────────────────────────────────────────────────

async function buildBriefing({ user, ctx, db, localHour, localDate, nowMs = Date.now(), calendarWaitMs = CALENDAR_WAIT_MS }) {
  const hour = hourOf(localHour);
  const kind = hour >= 4 && hour <= 11 ? "morning" : "catch_up";
  const userId = user.id;
  const nowUtc = sqliteUtc(nowMs);
  const rates = ctx && ctx.rates;
  const sources = [];
  const cite = (source) => { if (isCitation(source) && !sources.includes(source)) sources.push(source); };
  const strip = { rate30: null, move30: null, asOf: null, opportunities: null, checkInsDue: null, nextEvent: null };

  // 2. the market
  let market = null;
  try {
    market = marketSection({ ctx, db, userId, localDate });
    if (market) Object.assign(strip, market.strip);
  } catch (err) { skip("market", err); }

  // the user's OWN book and its sweep (for a broker too: the call list is never the team's)
  let ownRows = [];
  let sweep = null;
  let sweepSource = null;
  try {
    ownRows = db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(userId);
    if (hasRates(rates)) {
      const swept = sweepOf(ownRows, rates, nowMs);
      sweep = swept.result;
      sweepSource = swept.source;
      strip.opportunities = sweep.counts.withOpportunity;
      strip.checkInsDue = sweep.counts.checkInsDue;
    }
  } catch (err) { skip("sweep", err); sweep = null; sweepSource = null; }

  // 4. the team line
  let team = null;
  try { team = teamSection({ user, ctx, db, nowMs }); } catch (err) { skip("team", err); }

  // 5. today's calendar, then 6. the calendar's calls matched to follow-ups: one Google call at a time, within the wait
  let calendar = null;
  const deadline = Date.now() + calendarWaitMs;
  const google = ctx && ctx.google;
  if (google) {
    const read = await within(attempt("calendar", async () => {
      const connection = google.connection();
      if (!connection || connection.code) return null;
      const date = localToday(connection.timeZone, nowMs);
      const listed = await google.listDay({ date });
      return listed && Array.isArray(listed.events) ? { date, events: listed.events } : null;
    }), deadline - Date.now());
    if (read && read !== TIMED_OUT) {
      try { calendar = calendarSection({ ...read, nowMs }); } catch (err) { skip("calendar", err); }
      // only once today's read has answered, so the two never run side by side
      await within(attempt("calendar follow-ups", () => collectCalendarFollowUps(ctx, { localDate, db, userId })), deadline - Date.now());
    }
  }
  if (calendar) strip.nextEvent = calendar.nextEvent;

  // 6. open follow-ups, read before today's list is recorded (a list made now is not yet something to ask about)
  let shownFollowUps = [];
  try {
    shownFollowUps = followups.openFollowUps(db, userId, { localDate, localHour: hour, nowUtc }).slice(0, MAX_FOLLOW_UPS);
  } catch (err) { skip("follow-ups", err); }

  // 3. the call list, recorded as today's briefing recommendations
  let calls = null;
  try {
    calls = callListSection({ db, userId, localDate, nowMs, ownRows, sweep, estimated: hasRates(rates) && isEstimated(rates) });
  } catch (err) { skip("call list", err); }
  if (calls && calls.picks.length) {
    try {
      followups.recordRecommendations(db, userId, localDate,
        calls.picks.map((p) => ({ clientId: p.clientId, source: "briefing", reasonCode: p.reasonCode })));
    } catch (err) { skip("recording the call list", err); }
  }

  if (shownFollowUps.length) {
    try { followups.markAsked(db, shownFollowUps.map((f) => f.id), nowUtc); } catch (err) { skip("marking follow-ups", err); }
  }

  // sources, in reply order
  if (market) cite(market.source);
  if ((calls && calls.picks.length) || strip.opportunities !== null) cite(sweepSource);
  if (team) cite(team.source);
  if (calendar) cite(calendar.source);

  // 7. the one question
  const first = shownFollowUps[0] || null;
  const question = first
    ? followUpQuestion(first, localDate)
    : stageById(user.career_stage) ? CLOSE_QUESTION : CAREER_QUESTION;

  const name = typeof user.first_name === "string" ? user.first_name.trim() : "";
  const body = [
    openerFor({ localHour, localDate, name }),
    market && market.line,
    calls && calls.line,
    calls && calls.moreLine,
    team && team.line,
    calendar && calendar.line,
    shownFollowUps.length >= 2 ? COUPLE_OF_CALLS : null,
  ].filter(Boolean).join(" ");

  return {
    reply: `${noQuestion(body)} ${question}`,
    sources,
    kind,
    strip,
    followUp: first ? { recId: first.id, clientId: first.clientId, name: first.name, source: first.source } : null,
  };
}

module.exports = { buildBriefing, DROP_THRESHOLD, CALENDAR_WAIT_MS, CLOSE_QUESTION, COUPLE_OF_CALLS };
