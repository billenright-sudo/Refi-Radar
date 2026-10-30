"use strict";
// The greeting's and the briefing's first sentence: openerFor and the openers it picks from. Moved unchanged out of
// routes/assistant.js (which still re-exports GREETING_OPENERS and openerFor) so lib/assistant/briefing.js can use them too.
// Pure: no I/O, no clock but hourOf's fallback.

const hourOf = (localHour) =>
  Number.isInteger(localHour) && localHour >= 0 && localHour <= 23 ? localHour : new Date().getHours();
const partOfDay = (hour) => (hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening");

// The opening words only. Each opener is a function of the first name ("" when there is none) that returns a short spoken
// sentence: no digits, no number words, no question (the greeting asks exactly one thing, and that is its close). The plain
// "Good morning, Ann." stays first in its list, so it is still one of the choices.
const said = (lead, after = "") => (name) => `${lead}${name ? `, ${name}` : ""}.${after}`;
const GREETING_OPENERS = {
  partOfDay: {
    morning: [
      said("Good morning"), said("Morning"), said("Bright and early"),
      said("Good morning", " Hope the coffee is strong."), said("Morning", " Let's see where things stand."),
    ],
    afternoon: [
      said("Good afternoon"), said("Afternoon"), said("Good to see you"),
      said("Good afternoon", " Hope the day has been kind."),
    ],
    evening: [
      said("Good evening"), said("Evening"),
      said("Good evening", " Still at it, I see."), said("Evening", " Let's wrap up the day right."),
    ],
  },
  weekday: {
    sunday: [said("Happy Sunday"), said("Working on a Sunday", " Respect.")],
    monday: [said("Happy Monday"), said("Monday again", " Let's make it count.")],
    tuesday: [said("Happy Tuesday"), said("Tuesday", " The week is finding its feet.")],
    wednesday: [said("Happy Wednesday"), said("Midweek", " Keep the momentum going.")],
    thursday: [said("Happy Thursday"), said("Thursday", " Nearly the weekend.")],
    friday: [said("Happy Friday"), said("Friday", " Let's finish the week strong.")],
    saturday: [said("Happy Saturday"), said("Saturday shift", " That is dedication.")],
  },
};
const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// 0 (Sunday) to 6 for a real calendar day written YYYY-MM-DD, else null. Date.UTC rolls 2026-13-40 over into a real date, so
// only a day that reads back as it was written counts.
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function weekdayOf(localDate) {
  const m = typeof localDate === "string" ? DAY_RE.exec(localDate) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day ? at.getUTCDay() : null;
}

// FNV-1a: the same date text always lands on the same number
function stableHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// The greeting's first sentence. The client sends its own date (Cloud Run's clock is UTC, not the user's): the weekday is read
// from it, and the pick among that part of day's openers and that weekday's is a stable hash of the date, so a given day always
// opens the same way. A missing or malformed localDate gives the plain "Good morning/afternoon/evening, Name."
function openerFor({ localHour, localDate, name = "" } = {}) {
  const part = partOfDay(hourOf(localHour));
  const day = weekdayOf(localDate);
  if (day === null) return `Good ${part}${name ? `, ${name}` : ""}.`;
  const choices = [...GREETING_OPENERS.partOfDay[part], ...GREETING_OPENERS.weekday[WEEKDAY_KEYS[day]]];
  return choices[stableHash(localDate) % choices.length](name);
}

module.exports = { GREETING_OPENERS, WEEKDAY_KEYS, openerFor, stableHash, weekdayOf, partOfDay, hourOf };
