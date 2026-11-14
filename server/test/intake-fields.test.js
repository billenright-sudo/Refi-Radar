"use strict";
// The import whitelist and header mapping (lib/intake/fields.js). Pure, so there is no DB here. The four fixtures below are
// the header rows of an ARIVE funded-loans export, a LendingPad funded-loans export and a Calyx Point export (all best guesses until a
// real file is seen), and of a plain CRM spreadsheet. Each must map with no picks from the broker, and a column that looks like SSN or date of birth
// must never be used.
const test = require("node:test");
const assert = require("node:assert");

const { FIELDS, SYNONYMS, detectMapping, offeredHeaders, cleanMapping, readFields } = require("../lib/intake/fields");
const { headerKey, isProtectedHeader } = require("../lib/intake/normalize");

const ARIVE = ["Loan Number", "Borrower First Name", "Borrower Last Name", "Borrower Email", "Borrower Cell Phone", "Note Rate", "Loan Amount", "Loan Term", "Amortization Type", "Appraised Value", "Purchase Price", "Funded Date", "Loan Status", "Loan Purpose", "First Payment Date", "Credit Score", "Loan Officer Email", "Borrower SSN"];
const CALYX = ["Loan #", "Borr First Name", "Borr Last Name", "Borr Email", "Borr Home Phone", "Interest Rate", "Loan Amt", "Term", "Amort Type", "Appraised Value", "Sales Price", "Closing Date", "Loan Status", "Purpose of Loan", "1st Pmt Date", "FICO", "Loan Officer", "Date of Birth"];
const LENDINGPAD = ["Loan Number", "Borrower First Name", "Borrower Last Name", "Borrower Email", "Borrower Mobile Phone", "Interest Rate", "Total Loan Amount", "Loan Term", "Loan Program", "Appraised Value", "Purchase Price", "Funded Date", "Loan Status", "Loan Purpose", "First Payment Date", "Qualifying FICO", "Loan Officer", "Borrower SSN", "Est. Closing Date", "Base Loan Amount"];
const GENERIC = ["Name", "Email", "Phone", "Rate", "Balance", "Property Value", "Loan Type", "Close Date", "Credit Score", "Notes"];
const pick = (m, ids) => Object.fromEntries(ids.map((id) => [id, m[id]]));
const LOAN_IDS = ["loanNumber", "firstName", "lastName", "email", "phone", "noteRate", "loanAmount", "term", "amortization", "appraisedValue", "purchasePrice", "closingDate", "status", "purpose", "firstPaymentDate", "creditScore", "loanOfficer"];
const LOAN_COLUMNS = { loanNumber: 0, firstName: 1, lastName: 2, email: 3, phone: 4, noteRate: 5, loanAmount: 6, term: 7, amortization: 8, appraisedValue: 9, purchasePrice: 10, closingDate: 11, status: 12, purpose: 13, firstPaymentDate: 14, creditScore: 15, loanOfficer: 16 };

test("FIELDS is the whole whitelist, in order", () => {
  assert.deepStrictEqual(FIELDS.map((f) => [f.id, f.label]), [
    ["borrowerName", "Borrower name"], ["firstName", "First name"], ["lastName", "Last name"], ["email", "Email"], ["phone", "Phone"],
    ["loanNumber", "Loan number"], ["noteRate", "Note rate"], ["currentBalance", "Current balance"], ["loanAmount", "Original loan amount"],
    ["term", "Loan term"], ["amortization", "Amortization / product"], ["loanProgram", "Loan program"], ["propertyValue", "Property value"], ["appraisedValue", "Appraised value"],
    ["purchasePrice", "Purchase price"], ["closingDate", "Closing / funding date"], ["status", "Loan status"], ["purpose", "Loan purpose"],
    ["firstPaymentDate", "First payment date"], ["creditScore", "Credit score"], ["monthlyMi", "Monthly mortgage insurance"], ["propertyZip", "Property ZIP"], ["occupancy", "Occupancy"], ["loanOfficer", "Loan officer (email or name)"], ["notes", "Notes"],
  ]);
});
test("every synonym is in headerKey form, belongs to one field only, and is not a protected header", () => {
  const owner = new Map();
  for (const { id } of FIELDS) {
    assert.ok(SYNONYMS[id].length > 0, `${id} has synonyms`);
    for (const syn of SYNONYMS[id]) {
      assert.equal(headerKey(syn), syn, `${syn} is already a header key`);
      assert.ok(!isProtectedHeader(syn), `${syn} is not a protected header`);
      assert.ok(!owner.has(syn), `${syn} is claimed by ${owner.get(syn)} and ${id}`);
      owner.set(syn, id);
    }
  }
});

test("an ARIVE funded-loans export maps with no picks, and the SSN column is not used", () => {
  const m = detectMapping(ARIVE);
  assert.deepStrictEqual(pick(m, LOAN_IDS), LOAN_COLUMNS);
  assert.deepStrictEqual(pick(m, ["borrowerName","currentBalance","propertyValue","notes"]), { borrowerName: -1, currentBalance: -1, propertyValue: -1, notes: -1 });
  assert.ok(!Object.values(m).includes(17));
});
test("a Calyx Point export maps with no picks, and the date-of-birth column is not used", () => {
  const m = detectMapping(CALYX);
  assert.deepStrictEqual(pick(m, LOAN_IDS), LOAN_COLUMNS);
  assert.ok(!Object.values(m).includes(17));
});
test("a LendingPad funded-loans export maps with no picks; the SSN and the estimated closing date are never used", () => {
  const m = detectMapping(LENDINGPAD);
  // "Loan Program" is the program now, not the amortization (LendingPad has no separate amortization column).
  assert.deepStrictEqual(pick(m, LOAN_IDS), { ...LOAN_COLUMNS, amortization: -1 });
  assert.equal(m.loanProgram, 8);
  assert.equal(m.closingDate, 11);
  for (const i of [17, 18, 19]) assert.ok(!Object.values(m).includes(i));
});
test("a generic CRM file still maps as today; 'Loan Amount' is the original amount, never the balance", () => {
  assert.deepStrictEqual(pick(detectMapping(GENERIC), ["borrowerName","email","phone","noteRate","currentBalance","propertyValue","loanProgram","closingDate","creditScore","notes"]),
    { borrowerName: 0, email: 1, phone: 2, noteRate: 3, currentBalance: 4, propertyValue: 5, loanProgram: 6, closingDate: 7, creditScore: 8, notes: 9 });
  const m = detectMapping(["Name", "Loan Amount", "Rate"]);
  assert.equal(m.loanAmount, 1); assert.equal(m.currentBalance, -1);
});
test("the program, product, ZIP, MI and occupancy headers map to their own fields", () => {
  const both = detectMapping(["Loan Type", "Amortization Type"]);
  assert.equal(both.loanProgram, 0); assert.equal(both.amortization, 1);
  const product = detectMapping(["Product"]);
  assert.equal(product.amortization, 0); assert.equal(product.loanProgram, -1);
  assert.equal(detectMapping(["Property Zip", "Zip"]).propertyZip, 0);
  const rest = detectMapping(["Monthly MI", "Occupancy Type"]);
  assert.equal(rest.monthlyMi, 0); assert.equal(rest.occupancy, 1);
});
test("a column goes to one field only, and every field id is always present", () => {
  for (const headers of [ARIVE, CALYX, LENDINGPAD, GENERIC, [], ["Balance", "Balance"]]) {
    const m = detectMapping(headers);
    assert.deepStrictEqual(Object.keys(m), FIELDS.map((f) => f.id));
    const used = Object.values(m).filter((i) => i >= 0);
    assert.equal(new Set(used).size, used.length);
  }
  assert.deepStrictEqual(Object.values(detectMapping(undefined)), FIELDS.map(() => -1));
});
test("a BOM on the first header, duplicate headers and blank headers", () => {
  assert.equal(detectMapping(["﻿Name", "Rate"]).borrowerName, 0);
  assert.equal(detectMapping(["Phone", "Phone"]).phone, 0);
  assert.deepStrictEqual(offeredHeaders(["Name", "", "  ", "Borrower SSN", "Rate"]), [{ index: 0, header: "Name" }, { index: 4, header: "Rate" }]);
});
test("a protected or blank header is never used, even when its name is a synonym elsewhere", () => {
  const m = detectMapping(["", "  ", "Employer Name", "Account #", "Name", "Annual Income"]);
  assert.equal(m.borrowerName, 4);
  assert.deepStrictEqual(Object.values(m).filter((i) => i >= 0), [4]);
});

test("cleanMapping refuses protected, out-of-range, non-integer and doubled picks", () => {
  const headers = ["Name", "Account Number", "Rate"];
  const m = cleanMapping({ borrowerName: 0, loanNumber: 1, noteRate: "2", email: 9, phone: 0, bogus: 2 }, headers);
  assert.equal(m.borrowerName, 0); assert.equal(m.loanNumber, -1); assert.equal(m.noteRate, -1);
  assert.equal(m.email, -1); assert.equal(m.phone, -1); assert.ok(!("bogus" in m));
  assert.deepStrictEqual(Object.keys(m).sort(), FIELDS.map((f) => f.id).sort());
});
test("cleanMapping keeps good picks, drops blank columns, fractions and negatives, and survives junk", () => {
  const headers = ["Name", "", "Rate", "Email"];
  const m = cleanMapping({ borrowerName: 0, noteRate: 1, email: 2.5, phone: -3, notes: 3, term: null, status: undefined }, headers);
  assert.deepStrictEqual(pick(m, ["borrowerName", "noteRate", "email", "phone", "notes", "term", "status"]),
    { borrowerName: 0, noteRate: -1, email: -1, phone: -1, notes: 3, term: -1, status: -1 });
  for (const junk of [null, undefined, "x", 7, []]) assert.deepStrictEqual(Object.values(cleanMapping(junk, headers)), FIELDS.map(() => -1));
  assert.deepStrictEqual(Object.values(cleanMapping({ borrowerName: 0 }, null)), FIELDS.map(() => -1));
});
test("cleanMapping gives a doubled column to the first field in FIELDS order", () => {
  const m = cleanMapping({ notes: 0, email: 0, borrowerName: 0 }, ["Name"]);
  assert.equal(m.borrowerName, 0); assert.equal(m.email, -1); assert.equal(m.notes, -1);
});
test("cleanMapping reads a mapping that detectMapping made, unchanged", () => {
  for (const headers of [ARIVE, CALYX, LENDINGPAD, GENERIC]) assert.deepStrictEqual(cleanMapping(detectMapping(headers), headers), detectMapping(headers));
});

test("readFields reads only mapped cells", () => {
  const out = readFields(["Ann Lee", "123-45-6789", "6.5"], { ...cleanMapping({}, ["a","b","c"]), borrowerName: 0, noteRate: 2 });
  assert.deepStrictEqual(out, { borrowerName: "Ann Lee", noteRate: "6.5" });
});
test("readFields returns the raw cell, and skips a column the row is too short to have", () => {
  const out = readFields([412500, "", null], { ...cleanMapping({}, []), currentBalance: 0, notes: 1, phone: 2, email: 5, term: -1 });
  assert.deepStrictEqual(out, { currentBalance: 412500, phone: null, notes: "" });
  assert.deepStrictEqual(readFields("not a row", { notes: 0 }), {});
  assert.deepStrictEqual(readFields(["a"], null), {});
});
