"use strict";
// Date and time resolution for Charli's calendar. The broker says "Friday at 10"; CODE works out which Friday, in the
// CALENDAR's own IANA time zone (never the server's, never the browser's), and CODE authors the spoken labels
// ("Friday, October 30th", "10:00 AM"), so the model never does date arithmetic or invents a day name. Pure and
// deterministic: every function that needs "now" takes it as an argument, nothing reads the network, and the only
// dependency is the built-in Intl (no date library).
//
// Dates are "YYYY-MM-DD" strings and clock times are { hour, minute } (24-hour); an instant is epoch milliseconds.
//
// Failure rules, one per kind of input:
//   * An unknown TIME ZONE (anything Intl rejects, or not a non-empty string) throws Error("Invalid time zone: ...") from
//     every function that takes one - including resolveDate, even for a phrase that needs no zone - so a bad calendar
//     setting fails loudly and the same way everywhere instead of resolving a wrong day.
//   * A PHRASE or TIME TEXT the broker said (resolveDate, parseTime) that does not parse returns null: that is a normal
//     "I didn't catch that", not a fault.
//   * Everything else that must already be validated - a date or clock time handed to toInstant / dayBounds / spokenDay /
//     spokenTime, an event time handed to localTimeOf - throws a clear Error when it is not real (code bug or bad Google data).
const { ordinal, MONTHS, WEEKDAYS } = require("../rateHistory");

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
// RFC 3339 date-time WITH an offset (Google sends these). A string with no offset is refused, because Date.parse would
// read it in the server's zone and silently give the wrong wall time.
const RFC3339_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const DAY_MS = 86_400_000;

// ---- time zone plumbing -----------------------------------------------------------------------------------------------

const zones = new Map();    // timeZone -> { wall, offset } formatters (building an Intl formatter is the slow part)

function zoneFormatters(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) throw new Error(`Invalid time zone: ${JSON.stringify(timeZone)}`);
  let entry = zones.get(timeZone);
  if (!entry) {
    try {
      entry = {
        wall: new Intl.DateTimeFormat("en-US", {
          timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        }),
        offset: new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }),
      };
    } catch (_err) {
      throw new Error(`Invalid time zone: ${JSON.stringify(timeZone)}`);
    }
    zones.set(timeZone, entry);
  }
  return entry;
}

// The wall clock in `timeZone` at the instant `ms`: { year, month, day, hour, minute, second } as numbers.
function wallParts(timeZone, ms) {
  const out = {};
  for (const p of zoneFormatters(timeZone).wall.formatToParts(ms)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

// The UTC offset in force in `timeZone` at the instant `ms`, in milliseconds (-25_200_000 for Phoenix, 19_800_000 for Kolkata).
// "longOffset" renders "GMT-07:00", "GMT+05:30", or bare "GMT" for UTC.
function offsetMs(timeZone, ms) {
  const part = zoneFormatters(timeZone).offset.formatToParts(ms).find((p) => p.type === "timeZoneName");
  const m = part && /^GMT(?:([+\-−])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/.exec(part.value);
  if (!m) throw new Error(`Invalid time zone: ${JSON.stringify(timeZone)}`);
  if (!m[1]) return 0;
  const total = (Number(m[2]) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0)) * 1000;
  return m[1] === "+" ? total : -total;
}

const pad2 = (n) => String(n).padStart(2, "0");

// "-07:00", "+05:30", "+00:00" (RFC 3339 numeric offset, to the minute).
function formatOffset(ms) {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  return `${ms < 0 ? "-" : "+"}${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

// ---- calendar-date plumbing (pure arithmetic on YYYY-MM-DD, no zone involved) -----------------------------------------

// { year, month, day } when `date` is a REAL calendar date in YYYY-MM-DD form, else null.
function parseDate(date) {
  const m = typeof date === "string" ? DATE_RE.exec(date) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);          // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

function requireDate(date) {
  const parts = parseDate(date);
  if (!parts) throw new Error(`Invalid date: ${JSON.stringify(date)} (expected a real YYYY-MM-DD)`);
  return parts;
}

const dateKey = (d) => `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

function utcDay({ year, month, day }) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d;
}

// `date` plus `days` calendar days (negative goes back).
function addDays(date, days) {
  return dateKey(new Date(utcDay(requireDate(date)).getTime() + days * DAY_MS));
}

const weekdayOf = (date) => utcDay(requireDate(date)).getUTCDay();   // 0 = Sunday

// { hour, minute } when it is a real 24-hour clock time (integers, 0-23 and 0-59), else null.
function validTime(time) {
  const ok = time && typeof time === "object" && Number.isInteger(time.hour) && Number.isInteger(time.minute)
    && time.hour >= 0 && time.hour <= 23 && time.minute >= 0 && time.minute <= 59;
  return ok ? { hour: time.hour, minute: time.minute } : null;
}

function requireTime(time) {
  const t = validTime(time);
  if (!t) throw new Error(`Invalid time: ${JSON.stringify(time)} (expected { hour: 0-23, minute: 0-59 })`);
  return t;
}

// ---- the public helpers ------------------------------------------------------------------------------------------------

// Today's date on the calendar's own wall clock. `now` is epoch ms (or a Date); it defaults to the real clock.
function localToday(timeZone, now = Date.now()) {
  const p = wallParts(timeZone, Number(now));
  return `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}`;
}

// The broker's date phrase as a YYYY-MM-DD in the calendar's zone, or null when it is not one we understand. Understood:
// "today", "tomorrow", a weekday name with or without "next" (always the next occurrence STRICTLY AFTER today, so on a
// Tuesday both "tuesday" and "next tuesday" are a week away), or a real YYYY-MM-DD. Case-insensitive, trimmed. No past/future
// rule here: the "already passed" check belongs to the caller, which also has the time of day.
function resolveDate(phrase, timeZone, now = Date.now()) {
  const today = localToday(timeZone, now);        // first, so a bad time zone throws whatever the phrase is
  if (typeof phrase !== "string") return null;
  const text = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  if (DATE_RE.test(text)) return parseDate(text) ? text : null;
  if (text === "today") return today;
  if (text === "tomorrow") return addDays(today, 1);
  const named = /^(?:next )?([a-z]+)$/.exec(text);
  const target = named ? WEEKDAYS.findIndex((w) => w.toLowerCase() === named[1]) : -1;
  if (target < 0) return null;
  return addDays(today, ((target - weekdayOf(today) + 6) % 7) + 1);   // 1..7 days ahead, never 0
}

// "HH:MM" or "H:MM", 24-hour, minute always two digits -> { hour, minute }, else null ("10am", "24:00", "13:60" are null).
function parseTime(text) {
  const m = typeof text === "string" ? TIME_RE.exec(text.trim()) : null;
  if (!m) return null;
  return validTime({ hour: Number(m[1]), minute: Number(m[2]) });
}

// The instant (epoch ms) at which the wall clock in `timeZone` reads `date` + `time`. Around a clock change: a time that is
// SKIPPED (spring forward, 02:30) moves forward by the gap, to where the clock reads 03:30; a time that REPEATS (fall back,
// 01:30) is the first of the two.
function toInstant(date, time, timeZone) {
  const { year, month, day } = requireDate(date);
  const { hour, minute } = requireTime(time);
  zoneFormatters(timeZone);
  const wall = Date.UTC(year, month - 1, day, hour, minute);       // the wall clock read as if it were UTC
  const before = offsetMs(timeZone, wall - DAY_MS);                // the offset a day earlier and a day later bracket any one change
  const after = offsetMs(timeZone, wall + DAY_MS);
  const candidates = [before, after]
    .map((off) => wall - off)
    .filter((ms, i, all) => all.indexOf(ms) === i && wall - ms === offsetMs(timeZone, ms));   // keep an instant only if its own offset matches
  if (candidates.length) return Math.min(...candidates);           // two survivors = the repeated hour: earliest
  return wall - before;                                            // none survive = the skipped hour: apply the pre-change offset
}

// The [midnight, next midnight) window of a calendar day as RFC 3339 strings with the offset in force at each end (a
// clock change inside the day makes the two offsets differ). If a zone skips midnight itself, the day starts at the first
// instant that exists, written as the wall clock reads there (e.g. 01:00).
function dayBounds(date, timeZone) {
  requireDate(date);
  const edge = (day) => {
    const ms = toInstant(day, { hour: 0, minute: 0 }, timeZone);
    const p = wallParts(timeZone, ms);
    return `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${formatOffset(offsetMs(timeZone, ms))}`;
  };
  return { timeMin: edge(date), timeMax: edge(addDays(date, 1)) };
}

// An RFC 3339 date-time with an offset (a Google event's start/end dateTime) as the calendar zone's wall clock:
// { date, hour, minute } (seconds are dropped).
function localTimeOf(isoString, timeZone) {
  zoneFormatters(timeZone);
  const m = typeof isoString === "string" ? RFC3339_RE.exec(isoString) : null;
  // Date.parse rolls "2026-02-30" over to March 2nd, so the date and clock fields are checked here first.
  const ms = m && parseDate(m[1]) && Number(m[2]) <= 23 && Number(m[3]) <= 59 && Number(m[4] || 0) <= 59 ? Date.parse(isoString) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`Invalid date-time: ${JSON.stringify(isoString)} (expected RFC 3339 with an offset)`);
  const p = wallParts(timeZone, ms);
  return { date: `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}`, hour: p.hour, minute: p.minute };
}

// "2026-10-30" -> "Friday, October 30th". Code-authored so the model never works out or invents a day name.
function spokenDay(date) {
  const { month, day } = requireDate(date);
  return `${WEEKDAYS[weekdayOf(date)]}, ${MONTHS[month - 1]} ${ordinal(day)}`;
}

// { hour: 15, minute: 5 } -> "3:05 PM"; { 0, 30 } -> "12:30 AM"; { 12, 0 } -> "12:00 PM".
function spokenTime(time) {
  const { hour, minute } = requireTime(time);
  return `${hour % 12 || 12}:${pad2(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

module.exports = { localToday, resolveDate, parseTime, toInstant, dayBounds, localTimeOf, spokenDay, spokenTime };
