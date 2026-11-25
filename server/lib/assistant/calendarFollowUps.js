"use strict";
// Calls on the broker's calendar, matched to the broker's OWN clients so Charlie can later ask "How did the call with <name> go?".
//
// collectCalendarFollowUps reads yesterday's and today's events through ctx.google (the per-user adapter getCalendarTool uses;
// the model is not involved and works out no date), matches each event title against the user's own clients only
// (a colleague's client is never matched, so a match is always one the user can log), and records one 'calendar'
// recommendation per client per day, due when the event ends. lib/assistant/followups.js asks about it once that moment has passed.
//
// Two rules decide what is recorded (Ruling R9, and the day a call belongs to):
//   - A title must name exactly ONE of the user's clients. "Smith closing" with two Smiths in the book records nothing: "How did the
//     call with John Smith go?" about the wrong Smith would state a wrong client fact.
//   - A call belongs to the calendar day its LAST moment falls on, in the calendar's own zone. Google lists a call that runs past
//     midnight under both days; it is taken from the day it ends on and skipped on the other, so a later run (which lists that
//     day again, and the next) finds the same row and never makes a second.
//
// Nothing here throws. Not connected, a Google failure on either day, or any other error returns 0 and records nothing: the
// briefing calls this on each open, a recording is an upsert, so the next open simply tries again.
const { addDays, localToday } = require("../google/time");
const { buildOwnerIndex, clientsInIndex } = require("./tools");
const { recordRecommendations } = require("./followups");

const REASON_CODE = "calendar";

// An instant (epoch ms) as SQLite UTC text, "YYYY-MM-DD HH:MM:SS": the one format followups.js stores and compares.
const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// The calls of one listed day that name exactly one of the user's clients: client id -> the latest end (epoch ms) among them.
// `index` is buildOwnerIndex(the user's own clients). An all-day event is no call; a call belongs to the day its last moment falls
// on (see the top of this file).
function callsOfDay(events, day, timeZone, index) {
  const latest = new Map();
  for (const event of events) {
    if (!event || typeof event.title !== "string" || !Number.isFinite(event.endAt)) continue;   // an all-day event is not a call
    // The day of the event's last moment (a call that ends exactly at midnight ends on the day before): any other day it is
    // listed under is not its day.
    if (localToday(timeZone, event.endAt - 1) !== day) continue;
    const named = clientsInIndex(event.title, index);
    if (named.length !== 1) continue;   // nobody, or more than one client: not a call to ask about
    const clientId = named[0].id;
    if (!latest.has(clientId) || event.endAt > latest.get(clientId)) latest.set(clientId, event.endAt);
  }
  return latest;
}

// Returns the number of recommendations recorded (a client already recorded for that day counts again: the row is refreshed, not
// duplicated). `localDate` is today on the user's calendar (YYYY-MM-DD); yesterday is worked out from it here.
async function collectCalendarFollowUps(ctx, { localDate, db, userId } = {}) {
  try {
    const google = ctx && ctx.google;
    if (!google) return 0;
    const connection = google.connection();
    if (!connection || connection.code) return 0;
    const own = db.prepare("SELECT id, name FROM clients WHERE user_id = ?").all(userId);
    if (own.length === 0) return 0;

    // The days are read one at a time, yesterday first, and both before any recording: a day that cannot be read is not guessed
    // at, and the other is left for the next try. Not in parallel: one Calendar request at a time per user (a token refresh is
    // single-flight in lib/google/oauth.js either way).
    const days = [addDays(localDate, -1), localDate];
    const listed = [];
    for (const date of days) {
      const result = await google.listDay({ date });
      if (!result || result.code || result.error || !Array.isArray(result.events)) return 0;
      listed.push(result);
    }

    const index = buildOwnerIndex(own);   // the book is read once for every title
    let count = 0;
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const latest = callsOfDay(listed[i].events, day, connection.timeZone, index);   // client id -> the latest end that day
      const items = [...latest].map(([clientId, endAt]) => ({ clientId, source: "calendar", reasonCode: REASON_CODE, dueAt: sqliteUtc(endAt) }));
      if (items.length === 0) continue;
      recordRecommendations(db, userId, day, items);
      count += items.length;
    }
    return count;
  } catch (err) {
    console.error("calendar follow-ups failed:", err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");
    return 0;
  }
}

// After Charlie cancels or moves an event (routes/assistant.js), the follow-ups already recorded for yesterday and today are brought
// in line with the live calendar, so she never asks "How did the call with <client> go?" about a call that was cancelled, and asks
// about a moved one when it now ends. `days` are the days the change touched (the event's day, and a move's new day); only those that
// are yesterday or today in the calendar's zone are looked at (no other day has been recorded: collectCalendarFollowUps only reads
// those two). Each such day is read once, live, and: an OPEN calendar row whose client no longer has a call that day is expired; one
// that does is made due when the latest of those calls ends; a client with a call that day and no row yet (a call moved into today)
// is recorded. A row the broker has already answered, dismissed or been asked about twice is left as it is. -> true when at least one
// day was reconciled, false when nothing was (Google not connected, a day that could not be read, no day in range, any error). Never
// throws: the change has been made, and the next briefing's collectCalendarFollowUps would catch up anyway.
async function reconcileCalendarFollowUps(ctx, { localDate, days, db, userId } = {}) {
  try {
    const google = ctx && ctx.google;
    if (!google) return false;
    const connection = google.connection();
    if (!connection || connection.code) return false;
    const window = [addDays(localDate, -1), localDate];
    const touched = window.filter((day) => (days || []).includes(day));
    if (touched.length === 0) return false;
    const own = db.prepare("SELECT id, name FROM clients WHERE user_id = ?").all(userId);
    const index = buildOwnerIndex(own);
    let reconciled = false;
    for (const day of touched) {
      const result = await google.listDay({ date: day });
      if (!result || result.code || result.error || !Array.isArray(result.events)) continue;   // not guessed at: left as it is
      const latest = callsOfDay(result.events, day, connection.timeZone, index);
      const existing = db.prepare("SELECT id, client_id AS clientId, status FROM charlie_recommendations WHERE user_id = ? AND day = ? AND source = 'calendar'")
        .all(userId, day);
      const expire = db.prepare("UPDATE charlie_recommendations SET status = 'expired' WHERE id = ? AND status = 'open'");
      const reschedule = db.prepare("UPDATE charlie_recommendations SET due_at = ? WHERE id = ? AND status = 'open'");
      db.transaction(() => {
        for (const row of existing) {
          if (row.status !== "open") continue;
          if (latest.has(row.clientId)) reschedule.run(sqliteUtc(latest.get(row.clientId)), row.id);
          else expire.run(row.id);
        }
      })();
      const recorded = new Set(existing.map((row) => row.clientId));
      const added = [...latest].filter(([clientId]) => !recorded.has(clientId))
        .map(([clientId, endAt]) => ({ clientId, source: "calendar", reasonCode: REASON_CODE, dueAt: sqliteUtc(endAt) }));
      if (added.length > 0) recordRecommendations(db, userId, day, added);
      reconciled = true;
    }
    return reconciled;
  } catch (err) {
    console.error("calendar follow-ups reconcile failed:", err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");
    return false;
  }
}

module.exports = { collectCalendarFollowUps, reconcileCalendarFollowUps };
