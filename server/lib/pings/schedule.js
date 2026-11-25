"use strict";
// When a rate-drop ping may go: the user's quiet hours and weekdays in THEIR time zone, and whether the drop is still news. Pure:
// every decision reads only the wall clock at the instant it is given. "Allowed now" is never a stored "next allowed" instant, so a
// clock change (DST) needs no special case.
const { wallClock, toInstant, addDays } = require("../google/time");
const { isDrop } = require("../rateDrop");

// A drop whose observation is older than this many days (UTC) is no longer news.
const STALE_DAYS = 4;
const DAY_MS = 86_400_000;
const TTL_MIN = 60;
const TTL_MAX = 43_200;   // 12 hours

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Whether `minutes` (since local midnight) falls in quiet hours: start inclusive, end exclusive, a window that wraps midnight, and
// start === end meaning no quiet hours at all.
function inQuiet(settings, minutes) {
  const start = toMinutes(settings.quietStart);
  const end = toMinutes(settings.quietEnd);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// -> true when a ping may go at `nowMs` for a user in `zone`: not in quiet hours, and not a Saturday or Sunday there when weekdaysOnly.
function allowedNow(settings, zone, nowMs) {
  const wall = wallClock(zone, nowMs);
  if (settings.weekdaysOnly && (wall.weekday === 0 || wall.weekday === 6)) return false;
  return !inQuiet(settings, wall.minutes);
}

// -> the push message's time to live, in seconds: the time to the user's next not-allowed moment, clamped to 60..43200, so a phone that
// is offline cannot show the ping in the night or on a weekend. That moment is the sooner of the next quiet-hours start and, with
// weekdays only on, the local midnight that ends Friday; both are read off the user's wall clock (toInstant), so the night the clocks
// change is right. Twelve hours when neither applies.
function ttlSeconds(settings, zone, nowMs) {
  const wall = wallClock(zone, nowMs);
  const tomorrow = addDays(wall.date, 1);
  let endMs = nowMs + TTL_MAX * 1000;
  const start = toMinutes(settings.quietStart);
  if (start !== toMinutes(settings.quietEnd)) {
    const day = start > wall.minutes ? wall.date : tomorrow;
    endMs = Math.min(endMs, toInstant(day, { hour: Math.floor(start / 60), minute: start % 60 }, zone));
  }
  if (settings.weekdaysOnly && wall.weekday === 5) endMs = Math.min(endMs, toInstant(tomorrow, { hour: 0, minute: 0 }, zone));
  const seconds = Math.round((endMs - nowMs) / 1000);
  return Math.min(TTL_MAX, Math.max(TTL_MIN, seconds));
}

// -> "off" | "locked" | "below" | "stale" | "hold" | "send", in that order: pings off; the brokerage is locked or the terms not accepted
// (`accessOk`); the drop is under this user's size; the observation is too old; a quiet hour or weekend (hold: the next run may send
// it); else send. `drop` is rateDrop.marketMove's.
function pingDecision({ settings, zone, drop, accessOk, nowMs }) {
  if (!settings.enabled) return "off";
  if (!accessOk) return "locked";
  if (!isDrop(drop.move30, settings.threshold)) return "below";
  const age = (Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${drop.obsDate}T00:00:00Z`)) / DAY_MS;
  if (!(age <= STALE_DAYS)) return "stale";
  if (!allowedNow(settings, zone, nowMs)) return "hold";
  return "send";
}

module.exports = { STALE_DAYS, allowedNow, ttlSeconds, pingDecision };
