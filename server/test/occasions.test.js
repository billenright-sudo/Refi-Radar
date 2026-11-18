"use strict";
// lib/occasions.js: the dates coming up for a client (birthdays, anniversaries), from the personal details and the close date.
const test = require("node:test");
const assert = require("node:assert");
const { EMPTY } = require("../lib/personal");
const { occasionsFor, upcomingDates, occasionText, whenText, fromRow, WINDOW_DAYS } = require("../lib/occasions");

const client = (over = {}, personal = {}) => ({ id: 7, name: "Marisol & Daniel Okafor", closeDate: "", ...over, personal: { ...EMPTY, ...personal } });
const kinds = (list) => list.map((o) => `${o.kind}:${o.date}:${o.daysAway}:${o.years}`);

test("occasions: the window is fourteen days, today included", () => {
  assert.equal(WINDOW_DAYS, 14);
  const c = (md) => client({}, { birthday: md });
  assert.deepStrictEqual(kinds(occasionsFor(c("11-17"), "2026-11-17")), ["birthday:2026-11-17:0:null"]);
  assert.deepStrictEqual(kinds(occasionsFor(c("12-01"), "2026-11-17")), ["birthday:2026-12-01:14:null"]);
  assert.deepStrictEqual(occasionsFor(c("12-02"), "2026-11-17"), []);
  assert.deepStrictEqual(occasionsFor(c("11-16"), "2026-11-17"), []);   // yesterday's is next year's
  assert.deepStrictEqual(kinds(occasionsFor(c("11-16"), "2026-11-17", 365)), ["birthday:2027-11-16:364:null"]);
});

test("occasions: the window runs over a new year, and a leap-day birthday is kept on February 28th in a short year", () => {
  assert.deepStrictEqual(kinds(occasionsFor(client({}, { birthday: "01-03" }), "2026-12-28")), ["birthday:2027-01-03:6:null"]);
  assert.deepStrictEqual(kinds(occasionsFor(client({}, { birthday: "02-29" }), "2027-02-20")), ["birthday:2027-02-28:8:null"]);
  assert.deepStrictEqual(kinds(occasionsFor(client({}, { birthday: "02-29" }), "2028-02-20")), ["birthday:2028-02-29:9:null"]);
});

test("occasions: every kind, with its years, in date order", () => {
  const c = client({ closeDate: "2023-11-19" }, {
    birthday: "11-18", spouseName: "Daniel", spouseBirthday: "11-25", anniversary: "11-21", anniversaryYear: 2016,
    children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }, { name: "Theo", birthday: "11-20", birthYear: null },
      { name: "Noor", birthday: "", birthYear: null }],
    purchaseDate: "2019-11-30",
  });
  const list = occasionsFor(c, "2026-11-17");
  assert.deepStrictEqual(list.map((o) => [o.kind, o.who, o.date, o.daysAway, o.years]), [
    ["birthday", null, "2026-11-18", 1, null],
    ["loan", null, "2026-11-19", 2, 3],
    ["child_birthday", "Maya", "2026-11-20", 3, 10],
    ["child_birthday", "Theo", "2026-11-20", 3, null],
    ["wedding", null, "2026-11-21", 4, 10],
    ["spouse_birthday", "Daniel", "2026-11-25", 8, null],
    ["home", null, "2026-11-30", 13, 7],
  ]);
  assert.ok(list.every((o) => o.clientId === 7 && o.clientName === "Marisol & Daniel Okafor"));
  assert.deepStrictEqual(list.map(occasionText), [
    "Birthday", "Loan anniversary, 3 years", "Maya's birthday, turns 10", "Theo's birthday", "Wedding anniversary, 10 years",
    "Daniel's birthday", "Home anniversary, 7 years",
  ]);
});

test("occasions: an anniversary needs a full year behind it; a purchase on the closing day is one anniversary, the loan's", () => {
  // closed this year: no anniversary yet; closed today a year ago: the first
  assert.deepStrictEqual(occasionsFor(client({ closeDate: "2026-11-20" }), "2026-11-17"), []);
  assert.deepStrictEqual(kinds(occasionsFor(client({ closeDate: "2025-11-17" }), "2026-11-17")), ["loan:2026-11-17:0:1"]);
  assert.equal(occasionText(occasionsFor(client({ closeDate: "2025-11-17" }), "2026-11-17")[0]), "Loan anniversary, 1 year");
  assert.deepStrictEqual(kinds(occasionsFor(client({ closeDate: "2020-11-20" }, { purchaseDate: "2020-11-20" }), "2026-11-17")), ["loan:2026-11-20:3:6"]);
  // a refinance: the home was bought earlier, on the same day of the year
  assert.deepStrictEqual(kinds(occasionsFor(client({ closeDate: "2023-11-20" }, { purchaseDate: "2018-11-20" }), "2026-11-17")),
    ["loan:2026-11-20:3:3", "home:2026-11-20:3:8"]);
  // a close date that is not a real day, or blank, gives nothing
  for (const d of ["", "2023-02-30", "11/20/2023", null]) assert.deepStrictEqual(occasionsFor(client({ closeDate: d }), "2026-11-17"), []);
  // a wedding with no year, a child born this year, a spouse with no name
  assert.equal(occasionText(occasionsFor(client({}, { anniversary: "11-18" }), "2026-11-17")[0]), "Wedding anniversary");
  assert.equal(occasionText(occasionsFor(client({}, { children: [{ name: "Ivy", birthday: "11-18", birthYear: 2026 }] }), "2026-11-17")[0]), "Ivy's birthday");
  assert.equal(occasionText(occasionsFor(client({}, { spouseBirthday: "11-18" }), "2026-11-17")[0]), "Spouse's birthday");
});

test("occasions: a day or a window that is not usable gives nothing; a client with no personal details is fine", () => {
  const c = client({ closeDate: "2023-11-19" }, { birthday: "11-18" });
  for (const today of ["", null, "2026-13-01", "11/17/2026"]) assert.deepStrictEqual(occasionsFor(c, today), []);
  assert.deepStrictEqual(occasionsFor(c, "2026-11-17", 0).length, 0);
  assert.deepStrictEqual(occasionsFor(c, "2026-11-17", -3), []);
  assert.deepStrictEqual(occasionsFor(null, "2026-11-17"), []);
  assert.deepStrictEqual(kinds(occasionsFor({ id: 1, name: "A", closeDate: "2023-11-19" }, "2026-11-17")), ["loan:2026-11-19:2:3"]);
});

test("occasions: a book's dates are in date order, then by client name", () => {
  const book = [
    client({ id: 2, name: "Zed" }, { birthday: "11-18" }),
    client({ id: 1, name: "Abe" }, { birthday: "11-18", anniversary: "11-17" }),
    client({ id: 3, name: "Mid", closeDate: "2020-11-25" }),
  ];
  assert.deepStrictEqual(upcomingDates(book, "2026-11-17").map((o) => `${o.clientName}:${o.kind}`),
    ["Abe:wedding", "Abe:birthday", "Zed:birthday", "Mid:loan"]);
  assert.deepStrictEqual(upcomingDates(book, "2026-11-17", 1).map((o) => o.clientName), ["Abe", "Abe", "Zed"]);
  assert.deepStrictEqual(upcomingDates(null, "2026-11-17"), []);
});

test("occasions: when a date is, in words", () => {
  assert.equal(whenText("2026-11-17", "2026-11-17"), "today");
  assert.equal(whenText("2026-11-18", "2026-11-17"), "tomorrow");
  assert.equal(whenText("2026-11-19", "2026-11-17"), "Thursday");
  assert.equal(whenText("2026-11-23", "2026-11-17"), "Monday");
  assert.equal(whenText("2026-11-24", "2026-11-17"), "Tuesday, November 24th");
  assert.equal(whenText("2026-12-01", "2026-11-17"), "Tuesday, December 1st");
  assert.equal(whenText("2027-01-03", "2026-12-28"), "Sunday");
});

test("occasions: a clients row reads as a client (close_date, the stored personal text)", () => {
  const row = { id: 9, name: "Row Client", close_date: "2022-11-18", personal: JSON.stringify({ birthday: "11-19" }) };
  assert.deepStrictEqual(kinds(occasionsFor(fromRow(row), "2026-11-17")), ["loan:2026-11-18:1:4", "birthday:2026-11-19:2:null"]);
  assert.deepStrictEqual(fromRow({ id: 1, name: "X", close_date: null, personal: null }), { id: 1, name: "X", closeDate: "", personal: EMPTY });
});
