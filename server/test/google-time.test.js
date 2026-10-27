"use strict";
// Date and time resolution for Charli's calendar (lib/google/time.js): the broker says "Friday at 10", CODE works out the
// date in the calendar's own IANA time zone, and the spoken labels ("Friday, October 30th", "10:00 AM") are code-authored.
// Pure: no network, no clock (every function takes `now`) and no database (the label tables come from lib/dateLabels.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  localToday, resolveDate, parseTime, toInstant, dayBounds, localTimeOf, spokenDay, spokenTime,
} = require("../lib/google/time");

const PHX = "America/Phoenix";
const NY = "America/New_York";
const TUE = Date.UTC(2026, 9, 27, 15, 0);      // Tuesday 2026-10-27, 15:00Z = 08:00 in Phoenix, 11:00 in New York
const LATE = Date.UTC(2026, 9, 28, 6, 30);     // 06:30Z on the 28th: still the 27th in Phoenix (23:30), already the 28th in New York (02:30)

test("localToday: the date on the calendar's own wall clock, not the server's", () => {
  assert.equal(localToday(PHX, TUE), "2026-10-27");
  assert.equal(localToday(PHX, LATE), "2026-10-27");
  assert.equal(localToday(NY, LATE), "2026-10-28");
  assert.equal(localToday("UTC", LATE), "2026-10-28");
  assert.equal(localToday("Asia/Kolkata", Date.UTC(2026, 9, 27, 20, 0)), "2026-10-28");    // +05:30 pushes 20:00Z past midnight
  assert.equal(localToday(PHX, new Date(TUE)), "2026-10-27");                               // a Date works as `now` too
  assert.match(localToday(PHX), /^\d{4}-\d{2}-\d{2}$/);                                     // `now` defaults to the clock
});

test("resolveDate: today, tomorrow, weekday names (strictly after today), real YYYY-MM-DD", () => {
  assert.equal(resolveDate("today", PHX, TUE), "2026-10-27");
  assert.equal(resolveDate("tomorrow", PHX, TUE), "2026-10-28");
  assert.equal(resolveDate("friday", PHX, TUE), "2026-10-30");
  assert.equal(resolveDate("next friday", PHX, TUE), "2026-10-30");
  assert.equal(resolveDate("Tuesday", PHX, TUE), "2026-11-03");                // today is Tuesday: the NEXT Tuesday, never today
  assert.equal(resolveDate("next tuesday", PHX, TUE), "2026-11-03");
  assert.equal(resolveDate("monday", PHX, TUE), "2026-11-02");
  assert.equal(resolveDate("wednesday", PHX, TUE), "2026-10-28");
  assert.equal(resolveDate("sunday", PHX, TUE), "2026-11-01");
  assert.equal(resolveDate("2026-12-25", PHX, TUE), "2026-12-25");
  assert.equal(resolveDate("2024-02-29", PHX, TUE), "2024-02-29");             // a real leap day; no past/future rule in this helper
  assert.equal(resolveDate("2026-02-28", PHX, TUE), "2026-02-28");
});

test("resolveDate: case-insensitive, trimmed, whitespace-tolerant", () => {
  assert.equal(resolveDate("  TOMORROW ", PHX, TUE), "2026-10-28");
  assert.equal(resolveDate(" Next   Friday\n", PHX, TUE), "2026-10-30");
  assert.equal(resolveDate("FRIDAY", PHX, TUE), "2026-10-30");
});

test("resolveDate: anything else is null", () => {
  for (const phrase of ["someday", "yesterday", "next", "next next friday", "friday next", "fri", "tomorrow morning", "",
    "2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2026-10-5", "26-10-05", "2026/10/05", "10/30/2026",
    null, undefined, 42, {}, ["friday"]]) {
    assert.equal(resolveDate(phrase, PHX, TUE), null, `${JSON.stringify(phrase)} should not resolve`);
  }
});

test("resolveDate: relative words follow the calendar's zone, and roll over months and years", () => {
  assert.equal(resolveDate("today", PHX, LATE), "2026-10-27");
  assert.equal(resolveDate("tomorrow", PHX, LATE), "2026-10-28");
  assert.equal(resolveDate("today", NY, LATE), "2026-10-28");
  assert.equal(resolveDate("tomorrow", NY, LATE), "2026-10-29");
  assert.equal(resolveDate("tomorrow", NY, Date.UTC(2026, 9, 31, 15, 0)), "2026-11-01");   // month end
  assert.equal(resolveDate("tomorrow", NY, Date.UTC(2026, 11, 31, 15, 0)), "2027-01-01");  // year end
  assert.equal(resolveDate("friday", NY, Date.UTC(2026, 11, 30, 15, 0)), "2027-01-01");    // Wednesday 12/30 -> Friday 1/1
  // 06:30Z Wednesday is still TUESDAY night in Phoenix, so "wednesday" there is tomorrow; in New York (already Wednesday) it is next week.
  assert.equal(resolveDate("wednesday", PHX, LATE), "2026-10-28");
  assert.equal(resolveDate("wednesday", NY, LATE), "2026-11-04");
});

test("parseTime: HH:MM or H:MM, 24-hour only", () => {
  assert.deepEqual(parseTime("10:00"), { hour: 10, minute: 0 });
  assert.deepEqual(parseTime("9:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseTime("23:59"), { hour: 23, minute: 59 });
  assert.deepEqual(parseTime(" 14:30 "), { hour: 14, minute: 30 });
  for (const text of ["24:00", "13:60", "10am", "10:00 AM", "10", "1000", "10:5", "10:005", "010:00", "-1:00", "10:00:00", "ten", "",
    null, undefined, 10, {}]) {
    assert.equal(parseTime(text), null, `${JSON.stringify(text)} should not parse`);
  }
});

test("toInstant: local wall time in the calendar's zone to an epoch instant", () => {
  assert.equal(toInstant("2026-11-02", { hour: 10, minute: 0 }, NY), Date.UTC(2026, 10, 2, 15, 0));   // EST (-05:00) after the fall back
  assert.equal(toInstant("2026-10-30", { hour: 10, minute: 0 }, NY), Date.UTC(2026, 9, 30, 14, 0));   // EDT (-04:00)
  assert.equal(toInstant("2026-10-30", { hour: 10, minute: 0 }, PHX), Date.UTC(2026, 9, 30, 17, 0));  // no DST, -07:00
  assert.equal(toInstant("2026-10-30", { hour: 10, minute: 0 }, "UTC"), Date.UTC(2026, 9, 30, 10, 0));
  assert.equal(toInstant("2026-10-30", { hour: 10, minute: 0 }, "Asia/Kolkata"), Date.UTC(2026, 9, 30, 4, 30));   // +05:30
  assert.equal(toInstant("2026-10-30", { hour: 0, minute: 0 }, "Australia/Sydney"), Date.UTC(2026, 9, 29, 13, 0)); // +11:00, previous UTC day
  assert.equal(toInstant("2026-12-31", { hour: 23, minute: 59 }, PHX), Date.UTC(2027, 0, 1, 6, 59));
});

test("toInstant: clock changes - a skipped time moves forward, a repeated time takes the first one", () => {
  // 2026-03-08, New York: 02:00 -> 03:00 (02:30 does not exist). It lands where the clock reads 03:30 EDT.
  assert.equal(toInstant("2026-03-08", { hour: 2, minute: 30 }, NY), Date.UTC(2026, 2, 8, 7, 30));
  assert.equal(toInstant("2026-03-08", { hour: 1, minute: 59 }, NY), Date.UTC(2026, 2, 8, 6, 59));    // still EST
  assert.equal(toInstant("2026-03-08", { hour: 3, minute: 0 }, NY), Date.UTC(2026, 2, 8, 7, 0));      // first instant of EDT
  // 2026-11-01, New York: 02:00 EDT -> 01:00 EST (01:30 happens twice). The first (EDT) one wins.
  assert.equal(toInstant("2026-11-01", { hour: 1, minute: 30 }, NY), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(toInstant("2026-11-01", { hour: 2, minute: 30 }, NY), Date.UTC(2026, 10, 1, 7, 30));   // after the repeat: EST
});

test("toInstant: a date or time that is not real throws", () => {
  assert.throws(() => toInstant("2026-02-30", { hour: 10, minute: 0 }, NY), /date/i);
  assert.throws(() => toInstant("friday", { hour: 10, minute: 0 }, NY), /date/i);
  assert.throws(() => toInstant("2026-10-30", { hour: 24, minute: 0 }, NY), /time/i);
  assert.throws(() => toInstant("2026-10-30", { hour: 10, minute: 60 }, NY), /time/i);
  assert.throws(() => toInstant("2026-10-30", { hour: 10.5, minute: 0 }, NY), /time/i);
  assert.throws(() => toInstant("2026-10-30", null, NY), /time/i);
});

test("dayBounds: RFC 3339 midnight-to-midnight with the offset in force at each end", () => {
  assert.deepEqual(dayBounds("2026-11-01", NY), { timeMin: "2026-11-01T00:00:00-04:00", timeMax: "2026-11-02T00:00:00-05:00" });  // fall back
  assert.deepEqual(dayBounds("2026-03-08", NY), { timeMin: "2026-03-08T00:00:00-05:00", timeMax: "2026-03-09T00:00:00-04:00" });  // spring forward
  assert.deepEqual(dayBounds("2026-10-30", PHX), { timeMin: "2026-10-30T00:00:00-07:00", timeMax: "2026-10-31T00:00:00-07:00" });
  assert.deepEqual(dayBounds("2026-10-30", "UTC"), { timeMin: "2026-10-30T00:00:00+00:00", timeMax: "2026-10-31T00:00:00+00:00" });
  assert.deepEqual(dayBounds("2026-10-30", "Asia/Kolkata"), { timeMin: "2026-10-30T00:00:00+05:30", timeMax: "2026-10-31T00:00:00+05:30" });
  assert.deepEqual(dayBounds("2026-12-31", NY), { timeMin: "2026-12-31T00:00:00-05:00", timeMax: "2027-01-01T00:00:00-05:00" });   // year end
  assert.deepEqual(dayBounds("2028-02-28", PHX), { timeMin: "2028-02-28T00:00:00-07:00", timeMax: "2028-02-29T00:00:00-07:00" });   // into a leap day
  // The strings are real instants: the bounds of a 25-hour day are 25 hours apart.
  const fall = dayBounds("2026-11-01", NY);
  assert.equal(Date.parse(fall.timeMax) - Date.parse(fall.timeMin), 25 * 3_600_000);
  assert.equal(Date.parse(fall.timeMin), toInstant("2026-11-01", { hour: 0, minute: 0 }, NY));
});

test("dayBounds: where midnight itself is skipped, the day starts at the first real instant", () => {
  // Havana moves 00:00 -> 01:00 on 2026-03-08 (-05:00 -> -04:00): the day begins at 01:00-04:00, an instant that exists.
  const gap = dayBounds("2026-03-08", "America/Havana");
  assert.deepEqual(gap, { timeMin: "2026-03-08T01:00:00-04:00", timeMax: "2026-03-09T00:00:00-04:00" });
});

test("dayBounds: a date that is not real throws", () => {
  assert.throws(() => dayBounds("2026-02-30", NY), /date/i);
  assert.throws(() => dayBounds("tomorrow", NY), /date/i);
  assert.throws(() => dayBounds(undefined, NY), /date/i);
});

test("localTimeOf: an RFC 3339 instant as the wall clock reads in the calendar's zone", () => {
  assert.deepEqual(localTimeOf("2026-10-30T10:00:00-07:00", PHX), { date: "2026-10-30", hour: 10, minute: 0 });
  assert.deepEqual(localTimeOf("2026-10-30T10:00:00-07:00", NY), { date: "2026-10-30", hour: 13, minute: 0 });
  assert.deepEqual(localTimeOf("2026-10-30T10:00:00-07:00", "UTC"), { date: "2026-10-30", hour: 17, minute: 0 });
  assert.deepEqual(localTimeOf("2026-10-31T02:00:00Z", PHX), { date: "2026-10-30", hour: 19, minute: 0 });         // the date changes with the zone
  assert.deepEqual(localTimeOf("2026-10-31T02:00:00z", PHX), { date: "2026-10-30", hour: 19, minute: 0 });
  assert.deepEqual(localTimeOf("2026-10-30T10:15:30.250+00:00", "Asia/Kolkata"), { date: "2026-10-30", hour: 15, minute: 45 });  // seconds dropped
  assert.deepEqual(localTimeOf("2026-11-01T05:30:00Z", NY), { date: "2026-11-01", hour: 1, minute: 30 });            // first 01:30 (EDT)
  assert.deepEqual(localTimeOf("2026-11-01T06:30:00Z", NY), { date: "2026-11-01", hour: 1, minute: 30 });            // second 01:30 (EST)
  assert.deepEqual(localTimeOf("2026-10-30T00:00:00-07:00", PHX), { date: "2026-10-30", hour: 0, minute: 0 });       // midnight is hour 0, never 24
  assert.deepEqual(localTimeOf("2026-10-30T10:00-07:00", PHX), { date: "2026-10-30", hour: 10, minute: 0 });         // seconds optional
});

test("localTimeOf: text that is not an RFC 3339 date-time with an offset throws (never read in the server's zone)", () => {
  for (const bad of ["2026-10-30", "2026-10-30T10:00:00", "tomorrow", "", "2026-02-30T10:00:00Z", "2026-10-30T25:00:00Z", null, undefined, 1793000000000]) {
    assert.throws(() => localTimeOf(bad, PHX), /date-time|RFC 3339/i, `${JSON.stringify(bad)} should throw`);
  }
});

test("toInstant and localTimeOf round-trip through every zone", () => {
  for (const zone of [PHX, NY, "UTC", "Asia/Kolkata", "Australia/Sydney", "Europe/London", "Pacific/Auckland"]) {
    for (const date of ["2026-01-15", "2026-03-29", "2026-07-04", "2026-10-30", "2026-11-01"]) {
      const ms = toInstant(date, { hour: 10, minute: 0 }, zone);
      assert.deepEqual(localTimeOf(new Date(ms).toISOString(), zone), { date, hour: 10, minute: 0 }, `${zone} ${date}`);
    }
  }
});

test("spokenTime: 12-hour clock with AM/PM, two-digit minutes", () => {
  assert.equal(spokenTime({ hour: 10, minute: 0 }), "10:00 AM");
  assert.equal(spokenTime({ hour: 0, minute: 30 }), "12:30 AM");
  assert.equal(spokenTime({ hour: 12, minute: 0 }), "12:00 PM");
  assert.equal(spokenTime({ hour: 15, minute: 5 }), "3:05 PM");
  assert.equal(spokenTime({ hour: 0, minute: 0 }), "12:00 AM");
  assert.equal(spokenTime({ hour: 23, minute: 59 }), "11:59 PM");
  assert.equal(spokenTime({ hour: 9, minute: 5 }), "9:05 AM");
  assert.equal(spokenTime({ hour: 12, minute: 59 }), "12:59 PM");
  assert.equal(spokenTime({ hour: 11, minute: 59 }), "11:59 AM");
  assert.throws(() => spokenTime({ hour: 24, minute: 0 }), /time/i);
  assert.throws(() => spokenTime({ hour: 10, minute: 60 }), /time/i);
  assert.throws(() => spokenTime(null), /time/i);
  assert.throws(() => spokenTime("10:00"), /time/i);
});

test("spokenDay: weekday, month and an ordinal day", () => {
  assert.equal(spokenDay("2026-10-30"), "Friday, October 30th");
  assert.equal(spokenDay("2026-11-01"), "Sunday, November 1st");
  assert.equal(spokenDay("2026-11-22"), "Sunday, November 22nd");
  assert.equal(spokenDay("2026-11-03"), "Tuesday, November 3rd");
  assert.equal(spokenDay("2026-11-11"), "Wednesday, November 11th");
  assert.equal(spokenDay("2026-11-12"), "Thursday, November 12th");
  assert.equal(spokenDay("2026-11-13"), "Friday, November 13th");
  assert.equal(spokenDay("2026-12-31"), "Thursday, December 31st");
  assert.equal(spokenDay("2028-02-29"), "Tuesday, February 29th");
  assert.throws(() => spokenDay("2026-02-30"), /date/i);
  assert.throws(() => spokenDay("friday"), /date/i);
  assert.throws(() => spokenDay(null), /date/i);
});

test("an invalid time zone throws the same clear error from every function that takes one", () => {
  const BAD = "Mars/Olympus_Mons";
  const clear = /Invalid time zone/;
  assert.throws(() => localToday(BAD, TUE), clear);
  assert.throws(() => resolveDate("tomorrow", BAD, TUE), clear);
  assert.throws(() => resolveDate("2026-10-30", BAD, TUE), clear);     // even a phrase that needs no zone: one rule, no surprises
  assert.throws(() => resolveDate("someday", BAD, TUE), clear);
  assert.throws(() => toInstant("2026-10-30", { hour: 10, minute: 0 }, BAD), clear);
  assert.throws(() => dayBounds("2026-10-30", BAD), clear);
  assert.throws(() => localTimeOf("2026-10-30T10:00:00-07:00", BAD), clear);
  for (const missing of [undefined, null, "", 7]) {
    assert.throws(() => localToday(missing, TUE), clear, `${JSON.stringify(missing)}`);
  }
});
