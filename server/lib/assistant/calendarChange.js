"use strict";
// Cancelling and moving an event on the broker's own calendar: the finding and the code-written words (design:
// docs/superpowers/specs/2026-11-25-calendar-cancel-move-design.md). Pure: no Google, no clock, no database.
//
// Everything Charlie says about such a change is built here from the event as code read it from Google (never from the model), so
// the model never says an event was cancelled or moved: the read-back, the reasons she won't, and the Done line after the yes are
// all these. A title is somebody's text: it is cut at TITLE_SHOWN characters wherever it is spoken. The fixed lines with nothing
// to fill in (CHANGE_CHANGED, ALREADY_OFF, COULD_NOT_CHANGE, EVENT_CHANGE_UNSUPPORTED) live in prompt.js with the others.
const { spokenDay, spokenTime, zoneName, parseTime } = require("../google/time");

const TITLE_SHOWN = 80;
const WHICH_ONE_MAX = 4;

// One line, at most TITLE_SHOWN characters (the last one an ellipsis when it was cut).
const cut = (title) => {
  const t = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
  return t.length > TITLE_SHOWN ? `${t.slice(0, TITLE_SHOWN - 1).trimEnd()}…` : t;
};
const quoted = (title) => `"${cut(title)}"`;
const zoneOf = (timeZone) => {
  const zone = zoneName(timeZone);
  return zone ? ` ${zone}` : "";
};
const clock = (hhmm) => spokenTime(parseTime(hhmm));

// ── finding the event ────────────────────────────────────────────────────────

// A title as it is compared: case, punctuation and a possessive 's ignored; the words, in order.
const words = (text) => String(text == null ? "" : text)
  .toLowerCase().replace(/[’']s\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

// The words of what the broker said that are matched against a title, in two passes (fix wave F4): first without these function
// words; then, only when that fit nothing, also without these generic ones. Ignoring words never leaves none: then the words are
// kept as given.
const FUNCTION_WORDS = new Set(["the", "a", "an", "my", "our", "your", "with", "for", "to", "on", "at", "and", "of"]);
const GENERIC_WORDS = new Set(["call", "meeting", "appointment", "appt", "event", "followup", "follow", "up"]);
const without = (list, drop) => {
  const kept = list.filter((w) => !drop.has(w));
  return kept.length > 0 ? kept : list;
};

// The events of one day that fit what the broker said: { time?: { hour, minute }, title?: string }. A timed event starting at that
// time and no other is the event, whatever title was said (the read-back shows its real title). Otherwise the events at that time
// (or all of them, with no time) whose title has every word of pass 1 (the words given, function words ignored), or, when none
// does, every word of pass 2 (generic words ignored too). An all-day event fits a title, never a time.
// -> the matching events, in the order given.
function findMatches(events, { time, title } = {}) {
  const startsAt = (e) => !e.allDay && e.start === spokenTime(time);
  let pool = Array.isArray(events) ? events : [];
  if (time) {
    pool = pool.filter(startsAt);
    if (pool.length === 1) return pool;
  }
  const given = words(title);
  if (given.length === 0) return pool;
  const fit = (wanted) => pool.filter((e) => {
    const has = new Set(words(e.title));
    return wanted.every((w) => has.has(w));
  });
  const first = without(given, FUNCTION_WORDS);
  const found = fit(first);
  if (found.length > 0) return found;
  const second = without(first, GENERIC_WORDS);
  return second.length === first.length ? found : fit(second);
}

// ── the words ────────────────────────────────────────────────────────────────

const notFoundLine = (date) => `I don't see that on your calendar for ${spokenDay(date)}.`;
const whichOneLine = (date, matches) => {
  const shown = matches.slice(0, WHICH_ONE_MAX).map((e) => (e.allDay ? `${quoted(e.title)}, all day` : `${quoted(e.title)} at ${e.start}`));
  return `I see more than one that fits on ${spokenDay(date)}: ${shown.join(", ")}. Which one?`;
};
const hasGuestsLine = (title) => `${quoted(title)} has guests, and I never email guests. Open Google Calendar to change it so they're told.`;
const repeatsLine = (title) => `${quoted(title)} is a repeating event. I can't change those yet. Open Google Calendar.`;
const notMineLine = (title) => `${quoted(title)} was set up by someone else, so I can't change it. Open Google Calendar.`;
const multiDayLine = (title) => `${quoted(title)} runs over more than one day. I can't change those yet. Open Google Calendar.`;
const alreadyStartedLine = (title) => `${quoted(title)} has already started, so I'll leave it alone.`;
const allDayMoveLine = (title) => `${quoted(title)} is an all-day event. I can cancel it, but I can't move those yet.`;
const sameTimeLine = (title) => `${quoted(title)} is already at that time.`;

// The read-backs. `event` is what the tool packaged (title, date, time "HH:MM" or null, timeZone, newDate, newTime). Every read-back
// opens with `prefix` (the orchestrator's READ_BACK_PREFIX, which a spoken yes keys on).
const cancelReadBack = (prefix, event) => (event.allDay
  ? `${prefix} cancel ${quoted(event.title)}, all day on ${spokenDay(event.date)}?`
  : `${prefix} cancel ${quoted(event.title)} on ${spokenDay(event.date)} at ${clock(event.time)}${zoneOf(event.timeZone)}?`);
const moveReadBack = (prefix, event, overlap) =>
  `${prefix} move ${quoted(event.title)} from ${spokenDay(event.date)} at ${clock(event.time)} to ${spokenDay(event.newDate)} at ${clock(event.newTime)}${zoneOf(event.timeZone)}?` +
  (overlap ? ` Heads up: that overlaps ${quoted(overlap.title)} at ${overlap.time}.` : "");

// After the yes.
const doneCancelLine = (event) => `Done — ${quoted(event.title)} on ${spokenDay(event.date)} is off your calendar.`;
const doneMoveLine = (event) => `Done — ${quoted(event.title)} is now ${spokenDay(event.newDate)} at ${clock(event.newTime)}${zoneOf(event.timeZone)}.`;

module.exports = {
  TITLE_SHOWN, cut, words, findMatches,
  notFoundLine, whichOneLine, hasGuestsLine, repeatsLine, notMineLine, multiDayLine, alreadyStartedLine, allDayMoveLine, sameTimeLine,
  cancelReadBack, moveReadBack, doneCancelLine, doneMoveLine,
};
