"use strict";
// lib/personal.js: the optional personal details on a client (typed by hand, never imported, never priced).
const test = require("node:test");
const assert = require("node:assert");
const { EMPTY, cleanPersonal, parsePersonal, storePersonal } = require("../lib/personal");

const ok = (input, year = 2026) => {
  const r = cleanPersonal(input, year);
  assert.equal(r.error, undefined, r.error);
  return r.value;
};
const bad = (input, year = 2026) => {
  const r = cleanPersonal(input, year);
  assert.equal(r.value, undefined);
  assert.equal(typeof r.error, "string");
  return r.error;
};

test("personal: nothing given is the empty shape, and the empty shape stores as ''", () => {
  assert.deepStrictEqual(ok(undefined), EMPTY);
  assert.deepStrictEqual(ok(null), EMPTY);
  assert.deepStrictEqual(ok({}), EMPTY);
  assert.deepStrictEqual(EMPTY, {
    birthday: "", spouseName: "", spouseBirthday: "", anniversary: "", anniversaryYear: null, children: [],
    pets: "", purchaseDate: "", referredBy: "", preferredContact: "", retirementYear: null,
  });
  assert.equal(storePersonal(EMPTY), "");
  assert.deepStrictEqual(parsePersonal(""), EMPTY);
  assert.deepStrictEqual(parsePersonal(null), EMPTY);
  assert.deepStrictEqual(parsePersonal("not json"), EMPTY);
  assert.deepStrictEqual(parsePersonal("[1,2]"), EMPTY);
});

test("personal: a full set is cleaned, stored and read back the same", () => {
  const value = ok({
    birthday: "03-09", spouseName: "  Daniel   Okafor ", spouseBirthday: "12-31", anniversary: "06-14", anniversaryYear: "2015",
    children: [{ name: " Maya ", birthday: "11-20", birthYear: 2016 }, { name: "Theo", birthday: "", birthYear: null }],
    pets: " Biscuit, Olive ", purchaseDate: "2019-08-02", referredBy: "Dana at Keystone Realty", preferredContact: "text",
    retirementYear: "2041",
  });
  assert.deepStrictEqual(value, {
    birthday: "03-09", spouseName: "Daniel Okafor", spouseBirthday: "12-31", anniversary: "06-14", anniversaryYear: 2015,
    children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }, { name: "Theo", birthday: "", birthYear: null }],
    pets: "Biscuit, Olive", purchaseDate: "2019-08-02", referredBy: "Dana at Keystone Realty", preferredContact: "text",
    retirementYear: 2041,
  });
  assert.deepStrictEqual(parsePersonal(storePersonal(value)), value);
});

test("personal: a birthday is a month and a day, never a year", () => {
  assert.equal(ok({ birthday: "02-29" }).birthday, "02-29");   // a leap-day birthday is real
  assert.equal(ok({ birthday: "2-9" }).birthday, "02-09");
  for (const b of ["13-01", "00-10", "02-30", "04-31", "1990-03-09", "03/09", "March 9", 309]) {
    assert.match(bad({ birthday: b }), /birthday/i, String(b));
  }
  assert.match(bad({ spouseBirthday: "06-31" }), /spouse/i);
  assert.match(bad({ anniversary: "02-30" }), /anniversary/i);
});

test("personal: years are whole and in range, and a year with no date is dropped", () => {
  assert.equal(ok({ anniversary: "06-14", anniversaryYear: 1999 }).anniversaryYear, 1999);
  assert.equal(ok({ anniversary: "06-14", anniversaryYear: "" }).anniversaryYear, null);
  assert.equal(ok({ anniversaryYear: 2015 }).anniversaryYear, null);
  assert.match(bad({ anniversary: "06-14", anniversaryYear: 2027 }), /anniversary year/i);
  assert.match(bad({ anniversary: "06-14", anniversaryYear: 1899 }), /anniversary year/i);
  assert.match(bad({ anniversary: "06-14", anniversaryYear: 2015.5 }), /anniversary year/i);
  assert.equal(ok({ retirementYear: 2100 }).retirementYear, 2100);
  assert.match(bad({ retirementYear: 1949 }), /retirement/i);
  assert.match(bad({ retirementYear: "soon" }), /retirement/i);
});

test("personal: children need a name; blank rows are dropped; a birth year needs a birthday; twelve at most", () => {
  assert.deepStrictEqual(ok({ children: [{ name: "", birthday: "", birthYear: "" }, { name: "Ana", birthday: "01-05" }] }).children,
    [{ name: "Ana", birthday: "01-05", birthYear: null }]);
  assert.deepStrictEqual(ok({ children: [{ name: "Ana", birthYear: 2015 }] }).children, [{ name: "Ana", birthday: "", birthYear: null }]);
  assert.match(bad({ children: [{ name: "", birthday: "01-05" }] }), /child/i);
  assert.match(bad({ children: [{ name: "Ana", birthday: "01-32" }] }), /child/i);
  assert.match(bad({ children: [{ name: "Ana", birthday: "01-05", birthYear: 2030 }] }), /child/i);
  assert.match(bad({ children: "Ana" }), /child/i);
  assert.match(bad({ children: Array.from({ length: 13 }, (_, i) => ({ name: `Kid ${i}` })) }), /twelve/i);
  // a gender, or anything else sent with a child, is never kept
  assert.deepStrictEqual(ok({ children: [{ name: "Ana", gender: "f", ssn: "1" }] }).children, [{ name: "Ana", birthday: "", birthYear: null }]);
});

test("personal: the purchase date is a real past or present day; contact is call, text or email", () => {
  assert.equal(ok({ purchaseDate: "2019-08-02" }).purchaseDate, "2019-08-02");
  for (const d of ["2019-02-30", "08/02/2019", "2019-8-2", "1899-01-01", "2028-01-01"]) assert.match(bad({ purchaseDate: d }), /purchase/i, d);
  for (const c of ["call", "text", "email", ""]) assert.equal(ok({ preferredContact: c }).preferredContact, c);
  assert.match(bad({ preferredContact: "fax" }), /contact/i);
});

test("personal: text is trimmed to one line and capped; unknown keys are never kept; a non-object is refused", () => {
  assert.equal(ok({ pets: "Biscuit\n\tOlive" }).pets, "Biscuit Olive");
  assert.match(bad({ spouseName: "x".repeat(121) }), /spouse/i);
  assert.match(bad({ pets: "x".repeat(201) }), /pets/i);
  assert.match(bad({ referredBy: "x".repeat(121) }), /referred/i);
  assert.match(bad({ spouseName: 42 }), /spouse/i);
  assert.deepStrictEqual(ok({ gender: "f", ssn: "123", income: 5 }), EMPTY);
  assert.match(bad("03-09"), /personal/i);
  assert.match(bad([1]), /personal/i);
});

test("personal: what is stored is read back cleaned, whatever the text holds", () => {
  const stored = JSON.stringify({ birthday: "03-09", children: [{ name: "Maya", birthday: "11-20", birthYear: 2016, gender: "f" }], extra: 1,
    anniversary: "99-99" });
  assert.deepStrictEqual(parsePersonal(stored), { ...EMPTY, birthday: "03-09", children: [{ name: "Maya", birthday: "11-20", birthYear: 2016 }] });
});
