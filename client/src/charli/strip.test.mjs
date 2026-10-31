import test from "node:test";
import assert from "node:assert/strict";
import { stripItems, CALENDAR_URL } from "./strip.mjs";
import { navItems } from "../nav.mjs";

const full = {
  rate30: 6.37,
  move30: -0.14,
  asOf: "2026-10-29",
  opportunities: 3,
  checkInsDue: 5,
  nextEvent: { title: "Team huddle", start: "9:30 AM" },
};
const byKey = (items, key) => items.find((i) => i.key === key);

test("a full strip is the rate, the opportunities, the check-ins and the next event, in that order", () => {
  assert.deepEqual(stripItems(full).map((i) => i.key), ["rate", "opportunities", "checkIns", "event"]);
});

test("the rate shows the 30-year with its move and its as-of date, and opens Rate Watch", () => {
  const rate = byKey(stripItems(full), "rate");
  assert.equal(rate.label, "30-year fixed");
  assert.equal(rate.value, "6.37%");
  assert.equal(rate.detail, "down 0.14, as of Oct 29");
  assert.equal(rate.view, "rates");
});

test("a rise says up; no change says unchanged; an unknown move says nothing about the move", () => {
  assert.equal(byKey(stripItems({ ...full, move30: 0.08 }), "rate").detail, "up 0.08, as of Oct 29");
  assert.equal(byKey(stripItems({ ...full, move30: 0 }), "rate").detail, "unchanged, as of Oct 29");
  assert.equal(byKey(stripItems({ ...full, move30: null }), "rate").detail, "as of Oct 29");
});

test("a live rate with no move and no date known shows the rate alone", () => {
  const rate = byKey(stripItems({ ...full, rate30: 6.5, move30: null, asOf: null }), "rate");
  assert.equal(rate.value, "6.50%");
  assert.equal(rate.detail, "");
});

test("an estimated rate set is labelled estimated, as the spoken briefing says it, and claims no move or date", () => {
  const rate = byKey(stripItems({ ...full, rate30: 6.87, move30: null, asOf: null, estimated: true }), "rate");
  assert.equal(rate.value, "6.87%");
  assert.equal(rate.detail, "estimated");
  assert.equal(rate.view, "rates");
  // even if a move or a date came along with it, an estimate never shows one
  assert.equal(byKey(stripItems({ ...full, estimated: true }), "rate").detail, "estimated");
});

test("only an estimated flag that is exactly true labels the rate", () => {
  for (const estimated of [false, undefined, null, "true", 1, "yes"]) {
    assert.equal(byKey(stripItems({ ...full, estimated }), "rate").detail, "down 0.14, as of Oct 29", String(estimated));
  }
});

test("no rate, no rate item, and a move or date alone never stands in for it", () => {
  assert.equal(byKey(stripItems({ ...full, rate30: null }), "rate"), undefined);
});

test("an as-of date that is not a real day is left out, not guessed at", () => {
  assert.equal(byKey(stripItems({ ...full, asOf: "yesterday" }), "rate").detail, "down 0.14");
  assert.equal(byKey(stripItems({ ...full, asOf: "2026-13-40" }), "rate").detail, "down 0.14");
});

test("opportunities and check-ins are counts that open Sweeps, and zero is a count", () => {
  const items = stripItems({ ...full, opportunities: 0, checkInsDue: 12 });
  assert.deepEqual(
    [byKey(items, "opportunities").value, byKey(items, "opportunities").view],
    ["0", "sweeps"]
  );
  assert.deepEqual([byKey(items, "checkIns").value, byKey(items, "checkIns").view], ["12", "sweeps"]);
  assert.equal(byKey(items, "opportunities").label, "Opportunities");
  assert.equal(byKey(items, "checkIns").label, "Check-ins due");
});

test("an unknown count is left out", () => {
  const items = stripItems({ ...full, opportunities: null, checkInsDue: null });
  assert.deepEqual(items.map((i) => i.key), ["rate", "event"]);
});

test("the next event shows its title and time, and opens the calendar", () => {
  const event = byKey(stripItems(full), "event");
  assert.equal(event.label, "Next on your calendar");
  assert.equal(event.value, "Team huddle");
  assert.equal(event.detail, "9:30 AM");
  assert.equal(event.href, CALENDAR_URL);
  assert.equal(event.view, undefined);
});

test("an all-day event says so, and none at all leaves the item out", () => {
  assert.equal(byKey(stripItems({ ...full, nextEvent: { title: "Conference", start: null } }), "event").detail, "all day");
  assert.equal(byKey(stripItems({ ...full, nextEvent: null }), "event"), undefined);
});

test("every item that opens a page opens one the nav has", () => {
  const pages = new Set(navItems("lo").map((i) => i.id));
  for (const item of stripItems(full)) {
    assert.ok(item.view ? pages.has(item.view) : typeof item.href === "string", item.key);
  }
});

test("the calendar link is a fixed https address", () => {
  assert.match(CALENDAR_URL, /^https:\/\/calendar\.google\.com\//);
});

test("nothing known, or no strip, is no items", () => {
  const none = { rate30: null, move30: null, asOf: null, opportunities: null, checkInsDue: null, nextEvent: null };
  assert.deepEqual(stripItems(none), []);
  assert.deepEqual(stripItems(null), []);
  assert.deepEqual(stripItems(undefined), []);
  assert.deepEqual(stripItems({}), []);
});

test("a value of the wrong type is not shown", () => {
  const odd = { rate30: "6.37", move30: "x", asOf: 5, opportunities: "3", checkInsDue: NaN, nextEvent: { title: 7, start: "9" } };
  assert.deepEqual(stripItems(odd), []);
});
