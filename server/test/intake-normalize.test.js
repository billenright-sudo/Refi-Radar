"use strict";
// The value parsers behind the client import and the ARIVE feed (lib/intake/normalize.js). They are pure, so there is no DB
// here. Missing is always null (never 0), and a header that looks like SSN / DOB / income / assets / employer / account is
// flagged so it is never offered or read.
const test = require("node:test");
const assert = require("node:assert");

const {
  parseNumber, parseRate, parseMoney, parseDate, parseTermMonths,
  fullName, nameKey, phoneDigits, cleanEmail, cleanText, headerKey, isProtectedHeader, isDeadStatus, looksFunded,
} = require("../lib/intake/normalize");

test("parseRate reads 6.5, '6.500%', '0.065' and 0.065 as 6.5; blanks, N/A and junk are null", () => {
  for (const v of [6.5, "6.5", "6.500%", " 6.5 % ", "0.065", 0.065]) assert.equal(parseRate(v), 6.5);
  for (const v of ["", "N/A", "n/a", "-", null, undefined, {}, [], "abc"]) assert.equal(parseRate(v), null);
});
test("parseMoney strips $ and commas; N/A, blanks and (negatives) are null", () => {
  assert.equal(parseMoney("$412,500.00 "), 412500);
  assert.equal(parseMoney(412500), 412500);
  for (const v of ["N/A", "", "  ", "(1,000)", "none"]) assert.equal(parseMoney(v), null);
});
test("parseDate: Excel serials, M/D/YYYY, M/D/YY, ISO dates and timestamps; impossible dates are null", () => {
  assert.equal(parseDate(45365), "2024-03-14");
  assert.equal(parseDate("45365"), "2024-03-14");
  assert.equal(parseDate("3/14/2024"), "2024-03-14");
  assert.equal(parseDate("03/14/24"), "2024-03-14");
  assert.equal(parseDate("2024-03-14"), "2024-03-14");
  assert.equal(parseDate("2024-03-14T00:00:00Z"), "2024-03-14");
  assert.equal(parseDate("2024-03-14 00:00:00"), "2024-03-14");
  assert.equal(parseDate(" 2024-03-14 17:45:09 "), "2024-03-14");
  for (const v of ["", "TBD", "2/30/2024", "13/01/2024", "2024-02-30", "2024-02-30 00:00:00", "2024-13-01 12:00:00", 12, null]) {
    assert.equal(parseDate(v), null);
  }
});
test("parseTermMonths: 360, '30', '30 yr', '30 Years', '180 months', '15'", () => {
  for (const [v, m] of [[360, 360], ["360", 360], ["30", 360], ["30 yr", 360], ["30 Years", 360], ["180 months", 180], ["15", 180]]) assert.equal(parseTermMonths(v), m);
  for (const v of ["", "0", "N/A", null]) assert.equal(parseTermMonths(v), null);
});
test("fullName joins first + last, flips 'Last, First', collapses spaces", () => {
  assert.equal(fullName({ name: "Smith, John" }), "John Smith");
  assert.equal(fullName({ name: "  John   Smith " }), "John Smith");
  assert.equal(fullName({ first: "John", last: "Smith" }), "John Smith");
  assert.equal(fullName({ first: "Cher" }), "Cher");
  assert.equal(fullName({ name: "Smith, John, Jr" }), "Smith, John, Jr");
  assert.equal(fullName({}), "");
  assert.equal(fullName({ name: "x".repeat(200) }).length, 120);
});
test("phoneDigits, cleanEmail, nameKey", () => {
  assert.equal(phoneDigits("(555) 123-4567"), "5551234567");
  assert.equal(phoneDigits("+1 555 123 4567"), "5551234567");
  assert.equal(phoneDigits(5551234567), "5551234567");
  assert.equal(cleanEmail(" Ann@Example.COM "), "ann@example.com");
  assert.equal(cleanEmail("not an email"), "");
  assert.equal(nameKey("  John   SMITH "), "john smith");
});
test("headerKey strips a BOM and punctuation; isProtectedHeader catches SSN/DOB/income/assets/employer/account headers", () => {
  assert.equal(headerKey("﻿Borrower Name"), "borrowername");
  assert.equal(headerKey("Loan #"), "loan#");
  for (const h of ["Borrower SSN", "Social Security #", "DOB", "Date of Birth", "Monthly Income", "Base Salary", "Total Assets", "Employer Name", "Account Number"]) assert.equal(isProtectedHeader(h), true, h);
  for (const h of ["Loan Number", "Borrower Name", "Note Rate", "Closing Date", "Loan Status"]) assert.equal(isProtectedHeader(h), false, h);
});

// Edges beyond the brief's table: the boundaries each rule draws.
test("parseNumber: a plain number passes, anything that is not wholly a number is null, never 0", () => {
  assert.equal(parseNumber("1,234.50"), 1234.5);
  assert.equal(parseNumber("0"), 0);
  assert.equal(parseNumber(0), 0);
  assert.equal(parseNumber("-5"), -5);
  for (const v of ["12abc", "0x10", "1e5", "NULL", "None", "(5)", NaN, Infinity, true, false]) assert.equal(parseNumber(v), null, String(v));
});
test("parseRate: only a value strictly between 0 and 1 is a fraction", () => {
  assert.equal(parseRate("0.0625"), 6.25);
  assert.equal(parseRate(0.06875), 6.875);
  assert.equal(parseRate(0), 0);
  assert.equal(parseRate(1), 1);
  assert.equal(parseRate("7.125"), 7.125);
});
test("parseDate: two-digit years pivot at 70, a serial may carry a time of day, out-of-range numbers are not dates", () => {
  assert.equal(parseDate("1/2/69"), "2069-01-02");
  assert.equal(parseDate("1/2/70"), "1970-01-02");
  assert.equal(parseDate("12/31/2025"), "2025-12-31");
  assert.equal(parseDate("2/29/2024"), "2024-02-29");
  assert.equal(parseDate("2/29/2023"), null);
  assert.equal(parseDate(45365.75), "2024-03-14");
  assert.equal(parseDate(20000), "1954-10-03");
  for (const v of [19999, 80001, "19999", "20240314", "3/14", "3-14-2024", "2024-3-14", true, {}, []]) assert.equal(parseDate(v), null, String(v));
});
test("parseDate: a date with a time of day after it reads as that day (Excel's CSV datetimes, SQL timestamps)", () => {
  for (const v of ["3/14/2024 0:00", "3/14/2024 12:00:00 AM", "2024-03-14 00:00", "2024-03-14 00:00:00.000"]) {
    assert.equal(parseDate(v), "2024-03-14", v);
  }
  for (const v of ["3/14/24 0:00", "03/14/2024 17:45", "3/14/2024 5:45 pm", "3/14/2024 05:45:09.123 PM", "3/14/2024  0:00:00"]) {
    assert.equal(parseDate(v), "2024-03-14", v);
  }
  // the date part still has to be a real day, and the time has to look like one
  for (const v of ["2/30/2024 0:00", "13/1/2024 0:00", "2024-02-30 00:00", "3/14/2024 noon", "3/14/2024 0", "3/14/2024 0:0", "3/14/20240:00"]) {
    assert.equal(parseDate(v), null, v);
  }
  // a long run of spaces or digits after a date is read quickly
  for (const v of [`3/14/2024${" ".repeat(30000)}x`, `3/14/2024 1:00${"0".repeat(30000)}x`, `2024-03-14${" ".repeat(30000)}`]) {
    const start = process.hrtime.bigint();
    parseDate(v);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 50, `took ${ms} ms`);
  }
});
test("parseTermMonths: units win over the size rule; unknown words and shapes are null", () => {
  assert.equal(parseTermMonths("30yr"), 360);
  assert.equal(parseTermMonths("30-year fixed"), 360);
  assert.equal(parseTermMonths("20 Yrs"), 240);
  assert.equal(parseTermMonths("360 mo"), 360);
  assert.equal(parseTermMonths("12 Months"), 12);
  assert.equal(parseTermMonths(30), 360);
  assert.equal(parseTermMonths(50), 600);
  assert.equal(parseTermMonths(51), 51);
  for (const v of ["-30", "0 yr", "30 days", "30/15", "yr", {}, false]) assert.equal(parseTermMonths(v), null, String(v));
});
test("fullName: a comma only flips when there is exactly one with text on both sides", () => {
  assert.equal(fullName({ name: "Smith,John" }), "John Smith");
  assert.equal(fullName({ name: "Smith," }), "Smith,");
  assert.equal(fullName({ name: ",John" }), ",John");
  assert.equal(fullName({ name: "  ", first: "Ann", last: "Lee" }), "Ann Lee");
  assert.equal(fullName({ name: "Ann Lee", first: "Zed", last: "Zorn" }), "Ann Lee");
  assert.equal(fullName({ last: "Lee" }), "Lee");
  assert.equal(fullName({ first: " Ann ", last: " Lee " }), "Ann Lee");
  assert.equal(fullName(), "");
});
test("fullName: a name suffix or an entity word after the comma is part of the name, not a first name", () => {
  assert.equal(fullName({ name: "John Smith, Jr" }), "John Smith, Jr");
  assert.equal(fullName({ name: "Acme Realty, LLC" }), "Acme Realty, LLC");
  assert.equal(fullName({ name: "Smith, John" }), "John Smith");
  for (const word of ["Jr", "Jr.", "Sr", "Sr.", "II", "III", "IV", "V", "MD", "LLC", "L.L.C.", "Inc", "Inc.", "Trust", "Ltd", "LP", "LLP", "Corp", "Co"]) {
    for (const w of [word, word.toLowerCase(), word.toUpperCase()]) assert.equal(fullName({ name: `Jones Holdings, ${w}` }), `Jones Holdings, ${w}`, w);
  }
  // Only the whole part after the comma counts: a real first name that merely starts with or contains such a word still flips.
  assert.equal(fullName({ name: "Smith, Trustee" }), "Trustee Smith");
  assert.equal(fullName({ name: "Smith, Vincent" }), "Vincent Smith");
  assert.equal(fullName({ name: "Lee, Cory" }), "Cory Lee");
});
test("fullName: 'Last, First Suffix' keeps the suffix at the end", () => {
  assert.equal(fullName({ name: "Smith, John Jr" }), "John Smith Jr");
  assert.equal(fullName({ name: "Smith, John A. Jr." }), "John A. Smith Jr.");
  assert.equal(fullName({ name: "Smith,  John   III " }), "John Smith III");
  for (const w of ["Jr", "jr.", "SR", "Sr.", "II", "iii", "IV", "V", "MD", "M.D."]) assert.equal(fullName({ name: `Smith, John ${w}` }), `John Smith ${w}`, w);
  // a suffix that is the whole part after the comma, and an entity word, are still left as written
  assert.equal(fullName({ name: "John Smith, Jr" }), "John Smith, Jr");
  assert.equal(fullName({ name: "Acme Realty, LLC" }), "Acme Realty, LLC");
  // only a person's suffix moves; an entity word at the end, or a first name that merely ends in such letters, flips as before
  assert.equal(fullName({ name: "Realty, Acme LLC" }), "Acme LLC Realty");
  assert.equal(fullName({ name: "Smith, Junior" }), "Junior Smith");
  assert.equal(fullName({ name: "Smith, Mary Kay" }), "Mary Kay Smith");
});
test("parseRate: a value written with a % sign is already a percent, never a fraction", () => {
  assert.equal(parseRate("0.5%"), 0.5);
  assert.equal(parseRate(" 0.065 % "), 0.065);
  assert.equal(parseRate("6.500%"), 6.5);
  assert.equal(parseRate("0.065"), 6.5);
  assert.equal(parseRate(0.065), 6.5);
});
test("phoneDigits and cleanEmail: only a leading country-code 1 on 11 digits drops; an email must look like x@y.z", () => {
  assert.equal(phoneDigits("1-555-123-4567"), "5551234567");
  assert.equal(phoneDigits("25551234567"), "25551234567");
  assert.equal(phoneDigits("555-1234"), "5551234");
  assert.equal(phoneDigits(null), "");
  for (const v of ["ann@", "@example.com", "ann@example", "ann @example.com", "", null, {}]) assert.equal(cleanEmail(v), "", String(v));
  assert.equal(cleanEmail("a@" + "b".repeat(250) + ".co"), "");
});
test("cleanText trims and cuts; a non-text value is empty", () => {
  assert.equal(cleanText("  hello  ", 3), "hel");
  assert.equal(cleanText("  hello  ", 50), "hello");
  assert.equal(cleanText(42, 50), "42");
  for (const v of [null, undefined, {}, [], true]) assert.equal(cleanText(v, 10), "");
});
test("isProtectedHeader reads the header key, so spacing, case and punctuation do not hide a protected column", () => {
  for (const h of ["S.S.N.", "ssn", "Co-Borrower DOB", "Gross_Income", "Emp loyer", "Acct. Account #", "﻿Social"]) assert.equal(isProtectedHeader(h), true, h);
  assert.equal(isProtectedHeader(null), false);
});
test("parseTermMonths: a long run of spaces after a number is read quickly and is not a term", () => {
  const spaces = " ".repeat(30000);
  for (const v of [`5${spaces}!`, `30${spaces}-${spaces}!`]) {
    const start = process.hrtime.bigint();
    const got = parseTermMonths(v);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(got, null);
    assert.ok(ms < 50, `took ${ms} ms`);
  }
  // The spacing that was read before is still read: spaces, one optional dash, spaces.
  assert.equal(parseTermMonths("15    years"), 180);
  assert.equal(parseTermMonths("30 - year"), 360);
  assert.equal(parseTermMonths("30-  yr"), 360);
});
test("parseNumber, parseRate, parseMoney: a million-digit cell is read quickly and is not a number", () => {
  const digits = "1".repeat(1_000_000);
  for (const parse of [parseNumber, parseRate, parseMoney]) {
    for (const v of [digits + "x", digits]) {
      const start = process.hrtime.bigint();
      const got = parse(v);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.equal(got, null, `${parse.name} on ${v.length} chars`);
      assert.ok(ms < 50, `${parse.name} on ${v.length} chars took ${ms} ms`);
    }
  }
  // The shapes read before are still read, and the ones refused are still refused.
  for (const [v, n] of [["6.5", 6.5], ["6.", 6], [".5", 0.5], ["-1", -1], ["+2.25", 2.25], ["$1,234,567,890.12", 1234567890.12]]) {
    assert.equal(parseNumber(v), n, v);
  }
  for (const v of ["1.2.3", ".", "+", "-.", "1..2"]) assert.equal(parseNumber(v), null, v);
});
test("isDeadStatus and looksFunded: the status words both front doors share", () => {
  for (const v of ["Denied", "Withdrawn", "Cancelled", "Canceled", "Adverse Action", "Archived", "application denied"]) {
    assert.equal(isDeadStatus(v), true, v);
    assert.equal(looksFunded(v), false, v);
  }
  for (const v of ["Funded", "funded", "Closed", "Completed", "Purchased", "Loan Funded", "Closed/Funded"]) assert.equal(looksFunded(v), true, v);
  for (const v of ["Not Funded", "Unfunded", "Closed - Not Funded", "Withdrawn - not closed", "Non-Funded", "Nonfunded", "Never Closed", "Unclosed", "Closed (Cancelled)", "In Process", "", null, 7]) {
    assert.equal(looksFunded(v), false, String(v));
  }
  for (const v of ["Funded", "In Process", "", null, {}]) assert.equal(isDeadStatus(v), false, String(v));
});
