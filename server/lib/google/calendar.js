"use strict";
// The two Google Calendar calls Charli makes, both on the signed-in user's OWN primary calendar:
//   listDay      events.list for one calendar day  -> titles and spoken times, nothing else
//   insertEvent  events.insert for one booking     -> no attendees, no invitations, no email
//
// Only a day's titles and times are ever kept: the request asks Google for just those fields, and the mapping below copies
// five keys out of each event (the model is shown four of them; the fifth is the end instant for code), so a description,
// attendees, a location or a link cannot reach the model whatever Google sends. The spoken labels ("10:00 AM") are code-authored
// in the CALENDAR's own time zone (./time.js).
//
// `token` comes from oauth.accessToken (through ./index.js); `fetchFn` is injected so tests script Google. Neither function
// throws: a failure is { error: <fixed message> } and never carries Google's reply or the token. A failure is logged as an
// HTTP status or an error name only. The one exception is a call Google refuses as unauthorised (a 401, or a 403 whose reason
// is an auth problem): that is { code: "reconnect" }, the code the token step gives too, and ./index.js flags the connection.
const { dayBounds, toInstant, parseTime, localTimeOf, spokenTime } = require("./time");

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const REQUEST_TIMEOUT_MS = 10_000;       // a call to Google that goes quiet is given up on
const MAX_EVENTS = 50;
const EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;   // what events.insert takes as a caller-chosen id: base32hex, 5 to 1024 characters
const NO_TITLE = "(no title)";
const MSG_NOT_READ = "Google Calendar could not be read";
const MSG_NOT_BOOKED = "Google Calendar could not create the event";

// The reasons a 403 can give that mean "this token is no good" (as opposed to a quota, a rate limit or a calendar the user may not
// write to): Google's error-detail `reason`, an OAuth `error` string, or the `status` of the error. Lower-cased to compare.
const AUTH_REASONS = new Set([
  "autherror", "invalid_grant", "invalid_token", "unauthorized", "unauthenticated",
  "insufficientpermissions", "insufficient_scope", "access_token_scope_insufficient",
]);

// Whether Google refused this call because of the token: any 401, or a 403 that says so. Reads the body of a failed call only, and
// keeps none of it.
async function refusedAsUnauthorised(res) {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  let body = null;
  try { body = await res.json(); } catch { return false; }
  const err = body && typeof body === "object" ? body.error : null;
  const reasons = [];
  if (typeof err === "string") reasons.push(err);
  else if (err && typeof err === "object") {
    if (typeof err.status === "string") reasons.push(err.status);
    for (const list of [err.errors, err.details]) {
      if (Array.isArray(list)) for (const item of list) if (item && typeof item.reason === "string") reasons.push(item.reason);
    }
  }
  return reasons.some((reason) => AUTH_REASONS.has(reason.toLowerCase()));
}

const authorize = (token, extra) => ({ Authorization: `Bearer ${token}`, ...extra });
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");

// ---- reading a day --------------------------------------------------------------------------------------------------------

// One event of events.list as { title, start, end, allDay, endAt }, or null for a cancelled one. `endAt` is the instant the event
// ends (epoch ms), null for an all-day one: code-side callers use it (lib/assistant/calendarFollowUps.js); the model-facing mapping
// (getCalendarTool) copies the other four keys only. Throws on an event whose times cannot be read (no start, a dateTime without
// an offset, a zone Intl rejects): the caller turns that into { error }, so a meeting is never silently left off a day.
function toEvent(item, timeZone) {
  if (!item || typeof item !== "object") throw new Error("event is not an object");
  if (item.status === "cancelled") return null;
  const title = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : NO_TITLE;
  const start = item.start || {};
  const end = item.end || {};
  if (typeof start.date === "string") return { title, start: null, end: null, allDay: true, endAt: null };
  if (typeof start.dateTime !== "string" || typeof end.dateTime !== "string") throw new Error("event has no readable start and end");
  const label = (iso) => {
    const { hour, minute } = localTimeOf(iso, timeZone);
    return spokenTime({ hour, minute });
  };
  return { title, start: label(start.dateTime), end: label(end.dateTime), allDay: false, endAt: Date.parse(end.dateTime) };
}

// The events on `date` (YYYY-MM-DD) in `timeZone`, in start order: { events: [{ title, start, end, allDay, endAt }] } or { error }.
// `start` / `end` are spoken labels ("10:00 AM") in that zone, null for an all-day event; `endAt` is the end as epoch ms.
async function listDay(token, { date, timeZone } = {}, fetchFn = globalThis.fetch) {
  let params;
  try {
    const { timeMin, timeMax } = dayBounds(date, timeZone);
    params = new URLSearchParams({
      timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: String(MAX_EVENTS),
      fields: "items(summary,status,start,end)",
    });
  } catch {
    console.error("google calendar listDay: unusable date or time zone");
    return { error: MSG_NOT_READ };
  }
  let res;
  try {
    res = await fetchFn(`${EVENTS_URL}?${params}`, { method: "GET", headers: authorize(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    console.error("google calendar listDay failed:", errName(err));
    return { error: MSG_NOT_READ };
  }
  if (!res.ok) {
    console.error("google calendar listDay failed: HTTP", res.status);
    if (await refusedAsUnauthorised(res)) return { code: "reconnect" };
    return { error: MSG_NOT_READ };
  }
  try {
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("reply is not an object");
    if (body.items !== undefined && !Array.isArray(body.items)) throw new Error("items is not a list");
    return { events: (body.items || []).map((item) => toEvent(item, timeZone)).filter(Boolean) };
  } catch (err) {
    console.error("google calendar listDay unreadable:", errName(err));
    return { error: MSG_NOT_READ };
  }
}

// ---- booking --------------------------------------------------------------------------------------------------------------

// RFC 3339 in UTC without the fractional seconds: "2026-10-30T17:00:00Z".
const utcIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// Books `title` at `date` + `time` ("HH:MM" or { hour, minute }) in `timeZone` for `durationMinutes`. `id` is the event id the
// caller chose (Google wants 5-1024 characters of a-v and 0-9; the confirm step derives it from its confirmId), so booking
// the same id twice is HTTP 409 from Google, which is { duplicate: true }: the repeat of a confirm is harmless.
//   { eventId }        booked
//   { duplicate: true } that id already exists
//   { code: "reconnect" } Google refused the token (see the top of this file)
//   { error }          anything else, including a booking that is not well formed (nothing is sent): an id Google would refuse,
//                      or a title that is not text, is caught here rather than by a 400 from Google
// No attendees and sendUpdates=none: nobody is invited or emailed.
async function insertEvent(token, { id, title, date, time, durationMinutes, timeZone } = {}, fetchFn = globalThis.fetch) {
  let body;
  try {
    if (typeof id !== "string" || !EVENT_ID_RE.test(id)) throw new Error("bad event id");
    if (typeof title !== "string" || !title.trim()) throw new Error("bad title");
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) throw new Error("bad duration");
    const clock = typeof time === "string" ? parseTime(time) : time;
    const startMs = toInstant(date, clock, timeZone);
    body = {
      id,
      summary: title,
      start: { dateTime: utcIso(startMs), timeZone },
      end: { dateTime: utcIso(startMs + durationMinutes * 60_000), timeZone },
    };
  } catch {
    console.error("google calendar insertEvent: malformed booking");
    return { error: MSG_NOT_BOOKED };
  }
  let res;
  try {
    res = await fetchFn(`${EVENTS_URL}?sendUpdates=none`, {
      method: "POST",
      headers: authorize(token, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("google calendar insertEvent failed:", errName(err));
    return { error: MSG_NOT_BOOKED };
  }
  if (res.status === 409) return { duplicate: true };
  if (!res.ok) {
    console.error("google calendar insertEvent failed: HTTP", res.status);
    if (await refusedAsUnauthorised(res)) return { code: "reconnect" };
    return { error: MSG_NOT_BOOKED };
  }
  let made = null;
  try { made = await res.json(); } catch { /* booked either way: the id is the one that was sent */ }
  return { eventId: made && typeof made.id === "string" && made.id ? made.id : id };
}

module.exports = { listDay, insertEvent };
