"use strict";
// When a rate-drop ping may go (lib/pings/schedule.js) and its words (lib/pings/text.js). Pure over a fake clock: every function takes
// the instant it decides at. (The words come from lib/rateHistory.js, which opens a database on load, so a throwaway one is set up.)
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-ping-schedule-"));
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const { wallClock } = require("../lib/google/time");
const { allowedNow, ttlSeconds, pingDecision, STALE_DAYS } = require("../lib/pings/schedule");
const { pingText, TEST_TEXT } = require("../lib/pings/text");
const { DEFAULTS } = require("../lib/pings/settings");

test.after(() => {
  try { require("../db").close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const NY = "America/New_York";
const D = { ...DEFAULTS, enabled: true };
const drop = { rate30: 6.4, move30: -0.15, obsDate: "2026-11-24", sinceDate: "2026-11-21" };
const at = (iso) => Date.parse(iso);

test("wallClock: the date, the minute of the day and the weekday in the zone at that instant", () => {
  assert.deepEqual(wallClock(NY, at("2026-11-25T01:00:00Z")), { date: "2026-11-24", minutes: 20 * 60, weekday: 2 });
  assert.deepEqual(wallClock("UTC", at("2026-11-29T00:05:00Z")), { date: "2026-11-29", minutes: 5, weekday: 0 });
  assert.deepEqual(wallClock("Asia/Kolkata", at("2026-11-27T20:00:00Z")), { date: "2026-11-28", minutes: 60 + 30, weekday: 6 });
  assert.throws(() => wallClock("Not/AZone", 0), /Invalid time zone/);
});

test("quiet hours in the user's zone", () => {
  assert.equal(allowedNow(D, NY, at("2026-11-24T23:30:00Z")), true);    // Tue 18:30 EST
  assert.equal(allowedNow(D, NY, at("2026-11-25T01:00:00Z")), false);   // 20:00, start inclusive
  assert.equal(allowedNow(D, NY, at("2026-11-25T00:59:00Z")), true);    // 19:59
  assert.equal(allowedNow(D, NY, at("2026-11-25T11:59:00Z")), false);   // 06:59
  assert.equal(allowedNow(D, NY, at("2026-11-25T12:00:00Z")), true);    // 07:00, end exclusive
  assert.equal(allowedNow(D, "America/Los_Angeles", at("2026-11-25T12:00:00Z")), false);  // 04:00 PST
  assert.equal(allowedNow({ ...D, quietStart: "12:00", quietEnd: "13:00" }, NY, at("2026-11-24T17:30:00Z")), false);   // a window inside the day
  assert.equal(allowedNow({ ...D, quietStart: "12:00", quietEnd: "13:00" }, NY, at("2026-11-24T18:30:00Z")), true);
  assert.equal(allowedNow({ ...D, quietStart: "00:00", quietEnd: "00:00" }, NY, at("2026-11-25T08:00:00Z")), true);    // equal = no quiet hours
});

test("DST: the same UTC instant is quiet before the change and allowed after", () => {
  assert.equal(allowedNow(D, NY, at("2027-03-12T11:30:00Z")), false);   // Fri 06:30 EST
  assert.equal(allowedNow(D, NY, at("2027-03-15T11:30:00Z")), true);    // Mon 07:30 EDT
  assert.equal(allowedNow(D, NY, at("2026-10-30T11:30:00Z")), true);    // Fri 07:30 EDT
  assert.equal(allowedNow(D, NY, at("2026-11-02T11:30:00Z")), false);   // Mon 06:30 EST
  // the changeover days themselves: Sun 2026-11-01 and Sun 2027-03-14 are weekend, so turn weekdays off to see the clock alone
  const any = { ...D, weekdaysOnly: false };
  assert.equal(allowedNow(any, NY, at("2026-11-01T11:30:00Z")), false);   // Sun 06:30 EST (the clock went back at 06:00Z; on EDT this instant would read 07:30)
  assert.equal(allowedNow(any, NY, at("2026-11-01T12:30:00Z")), true);    // Sun 07:30 EST
  assert.equal(allowedNow(any, NY, at("2027-03-14T11:30:00Z")), true);    // Sun 07:30 EDT (the clock went forward at 07:00Z)
  assert.equal(allowedNow(any, NY, at("2027-03-14T10:30:00Z")), false);   // Sun 06:30 EDT
});

test("weekends", () => {
  assert.equal(allowedNow(D, NY, at("2026-11-28T15:00:00Z")), false);                          // Sat 10:00
  assert.equal(allowedNow(D, NY, at("2026-11-29T15:00:00Z")), false);                          // Sun 10:00
  assert.equal(allowedNow({ ...D, weekdaysOnly: false }, NY, at("2026-11-28T15:00:00Z")), true);
  // the weekday is the user's, not the server's: Sat 03:00Z is still Friday evening in New York
  assert.equal(allowedNow(D, NY, at("2026-11-28T03:00:00Z")), false);                          // Fri 22:00: quiet, not weekend
  assert.equal(allowedNow({ ...D, quietStart: "23:00" }, NY, at("2026-11-28T03:00:00Z")), true);   // Fri 22:00 with a late start: a weekday
});

test("ttlSeconds runs to the quiet start", () => {
  assert.equal(ttlSeconds(D, NY, at("2026-11-24T23:30:00Z")), 5400);
  assert.equal(ttlSeconds(D, NY, at("2026-11-24T23:30:30Z")), 5370);
  assert.equal(ttlSeconds(D, NY, at("2026-11-24T15:00:00Z")), 36000, "10:00 to 20:00");
  assert.equal(ttlSeconds(D, NY, at("2026-11-24T12:00:00Z")), 43200, "clamped to 12 hours (the start is 13 hours away)");
  assert.equal(ttlSeconds(D, NY, at("2026-11-25T00:59:50Z")), 60, "clamped to a minute");
  assert.equal(ttlSeconds({ ...D, quietStart: "12:00", quietEnd: "12:00" }, NY, at("2026-11-24T15:00:00Z")), 43200, "no quiet hours");
});

test("ttlSeconds ends at the end of Friday when weekdays only is on", () => {
  const none = { ...D, quietStart: "12:00", quietEnd: "12:00", weekdaysOnly: true };
  assert.equal(ttlSeconds(none, NY, at("2026-11-28T04:00:00Z")), 3600, "Friday 23:00 Eastern: one hour to the local midnight");
  assert.equal(ttlSeconds(none, NY, at("2026-11-27T15:00:00Z")), 43200, "Friday 10:00: the midnight is 14 hours away, the 12-hour cap wins");
  assert.equal(ttlSeconds({ ...none, weekdaysOnly: false }, NY, at("2026-11-28T04:00:00Z")), 43200, "weekdays only off: no end of Friday");
  const quietFirst = { ...D, quietStart: "23:30", quietEnd: "07:00", weekdaysOnly: true };
  assert.equal(ttlSeconds(quietFirst, NY, at("2026-11-28T04:00:00Z")), 1800, "quiet start at 23:30 comes before the midnight");
});

test("ttlSeconds: quiet hours that start inside the skipped spring hour end at the moment the clocks change", () => {
  const s = { ...D, quietStart: "02:30", quietEnd: "07:00" };
  assert.equal(ttlSeconds(s, NY, at("2027-03-14T06:30:00Z")), 1800, "01:30 EST: the clocks jump at 02:00, which is quiet time from 03:00 on the wall");
  assert.equal(ttlSeconds(s, NY, at("2027-03-13T06:30:00Z")), 3600, "the night before: 02:30 is one hour away");
});

test("ttlSeconds on the night the clocks change reads the real wall clock", () => {
  const s = { ...D, quietStart: "03:00", quietEnd: "07:00" };
  assert.equal(ttlSeconds(s, NY, at("2027-03-14T06:30:00Z")), 1800, "01:30 EST, 03:00 is 03:00 EDT: thirty minutes");
  assert.equal(ttlSeconds(s, NY, at("2027-03-13T06:30:00Z")), 5400, "the night before: ninety minutes");
});

test("pingDecision order", () => {
  const now = at("2026-11-24T15:00:00Z");
  assert.equal(STALE_DAYS, 4);
  assert.equal(pingDecision({ settings: { ...D, enabled: false }, zone: NY, drop, accessOk: true, nowMs: now }), "off");
  assert.equal(pingDecision({ settings: { ...D, enabled: false }, zone: NY, drop, accessOk: false, nowMs: now }), "off");
  assert.equal(pingDecision({ settings: D, zone: NY, drop, accessOk: false, nowMs: now }), "locked");
  assert.equal(pingDecision({ settings: { ...D, threshold: 0.25 }, zone: NY, drop, accessOk: true, nowMs: now }), "below");
  assert.equal(pingDecision({ settings: D, zone: NY, drop: { ...drop, obsDate: "2026-11-19" }, accessOk: true, nowMs: now }), "stale");
  assert.equal(pingDecision({ settings: D, zone: NY, drop: { ...drop, obsDate: "2026-11-20" }, accessOk: true, nowMs: now }), "send");
  assert.equal(pingDecision({ settings: D, zone: NY, drop, accessOk: true, nowMs: at("2026-11-25T02:00:00Z") }), "hold");
  // below beats stale and hold; stale beats hold
  assert.equal(pingDecision({ settings: { ...D, threshold: 0.5 }, zone: NY, drop: { ...drop, obsDate: "2026-11-01" }, accessOk: true, nowMs: now }), "below");
  assert.equal(pingDecision({ settings: D, zone: NY, drop: { ...drop, obsDate: "2026-11-19" }, accessOk: true, nowMs: at("2026-11-25T02:00:00Z") }), "stale");
});

test("pingText: the briefing's numbers and dates, market news only", () => {
  assert.deepEqual(pingText(drop, "2026-11-25"), {
    title: "Rates dropped", url: "/", tag: "rate-drop",
    body: "The national average 30-year is 6.4%, down 0.15 since November 21st (as of November 24th). Open Charlie for a sweep.",
  });
  assert.ok(JSON.stringify(pingText(drop, "2026-11-25")).length < 300);
  // a year apart names the year, as the briefing does
  assert.match(pingText({ ...drop, sinceDate: "2026-12-30", obsDate: "2027-01-02" }, "2027-01-03").body, /since December 30th, 2026 \(as of January 2nd\)/);
});

test("the test notification text is fixed", () => {
  assert.deepEqual(TEST_TEXT, {
    title: "Broker Radar", body: "Test notification: rate-drop pings will arrive on this device.", url: "/", tag: "rate-drop-test",
  });
});
