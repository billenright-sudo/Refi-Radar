"use strict";
// Calls on the broker's calendar, matched to the broker's OWN clients so Charlie can later ask "How did the call with <name> go?".
//
// collectCalendarFollowUps reads yesterday's and today's events through ctx.google (the per-user adapter getCalendarTool uses;
// the model is not involved and works out no date), matches each event title against the user's own clients only
// (clientsInText: a colleague's client is never matched, so a match is always one the user can log), and records one 'calendar'
// recommendation per client per day, due when the event ends. lib/assistant/followups.js asks about it once that moment has passed.
//
// Nothing here throws. Not connected, a Google failure on either day, or any other error returns 0 and records nothing: the
// briefing calls this on each open, a recording is an upsert, so the next open simply tries again.
const { addDays } = require("../google/time");
const { clientsInText } = require("./tools");
const { recordRecommendations } = require("./followups");

const REASON_CODE = "calendar";

// An instant (epoch ms) as SQLite UTC text, "YYYY-MM-DD HH:MM:SS": the one format followups.js stores and compares.
const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

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

    // Read both days before recording any: a day that cannot be read is not guessed at, and the other is left for the next try.
    const days = [addDays(localDate, -1), localDate];
    const read = [];
    for (const day of days) {
      const listed = await google.listDay({ date: day });
      if (!listed || listed.code || listed.error || !Array.isArray(listed.events)) return 0;
      read.push([day, listed.events]);
    }

    const recorded = new Set();   // "client|due": an event that runs past midnight is listed on both days, but it is one call
    let count = 0;
    for (const [day, events] of read) {
      const latest = new Map();   // client id -> the latest end among that day's events that name them
      for (const event of events) {
        if (!event || typeof event.title !== "string" || !Number.isFinite(event.endAt)) continue;   // an all-day event is not a call
        for (const client of clientsInText(event.title, own)) {
          if (!latest.has(client.id) || event.endAt > latest.get(client.id)) latest.set(client.id, event.endAt);
        }
      }
      const items = [];
      for (const [clientId, endAt] of latest) {
        const dueAt = sqliteUtc(endAt);
        const key = `${clientId}|${dueAt}`;
        if (recorded.has(key)) continue;
        recorded.add(key);
        items.push({ clientId, source: "calendar", reasonCode: REASON_CODE, dueAt });
      }
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

module.exports = { collectCalendarFollowUps };
