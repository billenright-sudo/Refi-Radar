import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  EMPTY_PERSONAL, WINDOW_DAYS, occasionsFor, upcomingDates, occasionText, localToday, dayLabel, awayLabel, monthDayLabel, dateLabel,
  personalRows, personalToForm, formToPersonal, daysInMonth,
} from "./personal.mjs";

// The server is the reference: Charlie's briefing and her dates answer are built from it, and the Home list must name the same dates.
const require = createRequire(import.meta.url);
const serverOccasions = require("../../server/lib/occasions.js");
const serverPersonal = require("../../server/lib/personal.js");

const FULL = {
  birthday: "03-09", spouseName: "Daniel", spouseBirthday: "11-25", anniversary: "11-21", anniversaryYear: 2016,
  children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }, { name: "Theo", birthday: "02-29", birthYear: 2020 }, { name: "Noor", birthday: "", birthYear: null }],
  pets: "Biscuit, Olive", purchaseDate: "2019-11-30", referredBy: "Dana at Keystone Realty", preferredContact: "text", retirementYear: 2041,
};
const BOOK = [
  { id: 1, name: "Marisol & Daniel Okafor", closeDate: "2023-11-19", personal: FULL },
  { id: 2, name: "Priya Bhatt", closeDate: "2020-11-17", personal: { ...EMPTY_PERSONAL, birthday: "11-17", purchaseDate: "2020-11-17" } },
  { id: 3, name: "abe lower", closeDate: "2024-12-31", personal: { ...EMPTY_PERSONAL, birthday: "01-01", anniversary: "02-29" } },
  { id: 4, name: "No Personal", closeDate: "2022-03-01" },
  { id: 5, name: "Bad Dates", closeDate: "2023-02-30", personal: { ...EMPTY_PERSONAL, purchaseDate: "nope", birthday: "13-40" } },
];

test("the empty shape and the window are the server's", () => {
  assert.deepEqual(EMPTY_PERSONAL, serverPersonal.EMPTY);
  assert.equal(WINDOW_DAYS, serverOccasions.WINDOW_DAYS);
});

test("mirror: the same dates, in the same order and words, as the server for the same book and day", () => {
  const days = ["2026-11-17", "2026-12-25", "2027-02-20", "2028-02-20", "2026-01-01", "2026-03-09", "not a day"];
  for (const today of days) {
    for (const window of [undefined, 0, 7, 60, 366]) {
      const args = window === undefined ? [today] : [today, window];
      assert.deepEqual(upcomingDates(BOOK, ...args), serverOccasions.upcomingDates(BOOK, ...args), `${today} / ${window}`);
      for (const c of BOOK) assert.deepEqual(occasionsFor(c, ...args), serverOccasions.occasionsFor(c, ...args), `${c.name} ${today} / ${window}`);
    }
    for (const o of upcomingDates(BOOK, today, 366)) assert.equal(occasionText(o), serverOccasions.occasionText(o));
  }
  assert.ok(upcomingDates(BOOK, "2026-11-17").length >= 5, "the sample book has dates in the window");
});

test("the Home list's known answer for the sample book", () => {
  assert.deepEqual(upcomingDates(BOOK, "2026-11-17").map((o) => [o.clientName, occasionText(o), dayLabel(o.date), awayLabel(o.daysAway)]), [
    ["Priya Bhatt", "Birthday", "Tue, Nov 17", "Today"],
    ["Priya Bhatt", "Loan anniversary, 6 years", "Tue, Nov 17", "Today"],
    ["Marisol & Daniel Okafor", "Loan anniversary, 3 years", "Thu, Nov 19", "In 2 days"],
    ["Marisol & Daniel Okafor", "Maya's birthday, turns 10", "Fri, Nov 20", "In 3 days"],
    ["Marisol & Daniel Okafor", "Wedding anniversary, 10 years", "Sat, Nov 21", "In 4 days"],
    ["Marisol & Daniel Okafor", "Daniel's birthday", "Wed, Nov 25", "In 8 days"],
    ["Marisol & Daniel Okafor", "Home anniversary, 7 years", "Mon, Nov 30", "In 13 days"],
  ]);
});

test("labels", () => {
  assert.equal(localToday(new Date(2026, 10, 7, 23, 59)), "2026-11-07");
  assert.equal(localToday(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
  assert.equal(dayLabel("2026-11-19"), "Thu, Nov 19");
  assert.equal(dayLabel("nope"), "");
  assert.deepEqual([0, 1, 2, 14].map(awayLabel), ["Today", "Tomorrow", "In 2 days", "In 14 days"]);
  assert.equal(monthDayLabel("03-09"), "Mar 9");
  assert.equal(monthDayLabel("06-14", 2015), "Jun 14, 2015");
  assert.equal(monthDayLabel(""), "");
  assert.equal(dateLabel("2019-08-02"), "Aug 2, 2019");
  assert.equal(dateLabel("2019-02-30"), "");
  assert.deepEqual([1, 2, 4, 12, "", "x"].map(daysInMonth), [31, 29, 30, 31, 31, 31]);
});

test("the Personal card shows only what is filled in", () => {
  assert.deepEqual(personalRows(EMPTY_PERSONAL), []);
  assert.deepEqual(personalRows(null), []);
  assert.deepEqual(personalRows(FULL), [
    ["Birthday", "Mar 9"],
    ["Spouse / co-borrower", "Daniel, birthday Nov 25"],
    ["Wedding anniversary", "Nov 21, 2016"],
    ["Children", "Maya (Nov 20, 2016), Theo (Feb 29, 2020), Noor"],
    ["Pets", "Biscuit, Olive"],
    ["Home purchased", "Nov 30, 2019"],
    ["Referred by", "Dana at Keystone Realty"],
    ["Prefers", "Text"],
    ["Plans to retire", "2041"],
  ]);
  assert.deepEqual(personalRows({ ...EMPTY_PERSONAL, spouseBirthday: "12-31" }), [["Spouse / co-borrower", "birthday Dec 31"]]);
});

test("the form: a saved set opens in the form and saves back the same, and the server takes it", () => {
  const back = formToPersonal(personalToForm(FULL), 2026);
  assert.deepEqual(back, { value: FULL });
  assert.deepEqual(serverPersonal.cleanPersonal(back.value, 2026), { value: FULL });
  assert.deepEqual(formToPersonal(personalToForm(null)), { value: { ...EMPTY_PERSONAL, children: [] } });
  assert.deepEqual(formToPersonal(personalToForm(EMPTY_PERSONAL)).value, serverPersonal.cleanPersonal({}, 2026).value);
});

test("the form: a half-picked date, a bad year or a nameless child is caught before the save; an empty child row is dropped", () => {
  const form = (over) => ({ ...personalToForm(null), ...over });
  assert.match(formToPersonal(form({ birthday: { m: "3", d: "" } })).error, /Birthday: pick both/);
  assert.match(formToPersonal(form({ spouseBirthday: { m: "", d: "9" } })).error, /Spouse's birthday: pick both/);
  assert.match(formToPersonal(form({ anniversary: { m: "2", d: "30" } })).error, /no day 30/);
  assert.match(formToPersonal(form({ anniversary: { m: "6", d: "14" }, anniversaryYear: "15" })).error, /four digits/);
  assert.match(formToPersonal(form({ retirementYear: "soon" })).error, /Retirement year/);
  assert.match(formToPersonal(form({ children: [{ name: "", birthday: { m: "1", d: "5" }, birthYear: "" }] })).error, /Each child needs a name/);
  assert.deepEqual(formToPersonal(form({ children: [{ name: "", birthday: { m: "", d: "" }, birthYear: "" }, { name: " Ana ", birthday: { m: "1", d: "5" }, birthYear: "2015" }] })).value.children,
    [{ name: "Ana", birthday: "01-05", birthYear: 2015 }]);
  // the server's own ranges, so a save is not refused after the fact
  assert.match(formToPersonal(form({ anniversary: { m: "6", d: "14" }, anniversaryYear: "2027" }), 2026).error, /Anniversary year: a year from 1900 to 2026/);
  assert.match(formToPersonal(form({ children: [{ name: "Ana", birthday: { m: "1", d: "5" }, birthYear: "1899" }] }), 2026).error, /Ana's birth year/);
  assert.match(formToPersonal(form({ retirementYear: "1949" }), 2026).error, /Retirement year: a year from 1950 to 2100/);
  assert.equal(formToPersonal(form({ retirementYear: "2100" }), 2026).value.retirementYear, 2100);
  assert.match(formToPersonal(form({ purchaseDate: "2027-01-01" }), 2026).error, /Home purchase date/);
  assert.match(formToPersonal(form({ purchaseDate: "2019-02-30" }), 2026).error, /Home purchase date/);
  assert.equal(formToPersonal(form({ purchaseDate: "2026-12-31" }), 2026).value.purchaseDate, "2026-12-31");
  for (const bad of [{ anniversary: { m: "6", d: "14" }, anniversaryYear: "2027" }, { retirementYear: "1949" }, { purchaseDate: "2027-01-01" }]) {
    // what the form refuses, the server refuses too
    const raw = { ...bad, anniversary: bad.anniversary ? "06-14" : "" };
    assert.equal(typeof serverPersonal.cleanPersonal(raw, 2026).error, "string", JSON.stringify(bad));
  }
  // a year typed with no anniversary, or a birth year with no birthday, is not kept (as on the server)
  assert.equal(formToPersonal(form({ anniversaryYear: "2015" })).value.anniversaryYear, null);
  assert.equal(formToPersonal(form({ children: [{ name: "Ana", birthday: { m: "", d: "" }, birthYear: "2015" }] })).value.children[0].birthYear, null);
});
