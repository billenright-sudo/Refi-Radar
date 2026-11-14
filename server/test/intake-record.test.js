"use strict";
// One imported row, turned into a client record (lib/intake/record.js): the fields a file row or a webhook body gave, read
// and checked, or the reason the row cannot be imported. Pure, so there is no DB here.
const test = require("node:test");
const assert = require("node:assert");

const { toRecord, REASONS } = require("../lib/intake/record");

const TODAY = "2026-11-01";
const ROW = { firstName: "John", lastName: "Smith", email: "John@X.com", phone: "(555) 123-4567", loanNumber: "a100", noteRate: "6.500%", loanAmount: "$400,000", term: "360", amortization: "Fixed", appraisedValue: "520000", closingDate: "3/14/2024", purpose: "Refinance", creditScore: "742", loanOfficer: "lou@a.test", notes: " met at open house " };

test("a full row becomes a record with today's estimated balance", () => {
  const r = toRecord(ROW, { today: TODAY, requireClosingDate: true });
  assert.deepStrictEqual(r, { ok: true, flags: ["balance estimated from the loan schedule"], record: {
    name: "John Smith", email: "john@x.com", phone: "(555) 123-4567", loanNumber: "A100", rate: 6.5, balance: 387830, balanceBasis: "estimated",
    propertyValue: 520000, loanType: "30yr_fixed", loanTypeGiven: true, closeDate: "2024-03-14", creditScore: 742, purpose: "refinance",
    loanOfficer: "lou@a.test", notes: "met at open house",
    valueBasis: "origination", originalValue: 520000, originalAmount: 400000, balanceAsOf: TODAY, loanProgram: "", monthlyMi: null, propertyZip: "", occupancy: "" } });
});
test("a current balance wins; an amount with no term is the original amount, flagged", () => {
  assert.equal(toRecord({ ...ROW, currentBalance: "391,002.50" }, { today: TODAY }).record.balance, 391002.5);
  const o = toRecord({ ...ROW, term: "", amortization: "" }, { today: TODAY });
  assert.equal(o.record.balance, 400000); assert.equal(o.record.balanceBasis, "original"); assert.equal(o.record.loanTypeGiven, false);
  assert.deepStrictEqual(o.flags, ["balance = original loan amount (no rate/term/date to estimate from)"]);
});
test("a term that is only in the product text ('30 Yr Fixed') still gives an estimated balance", () => {
  const r = toRecord({ ...ROW, term: "", amortization: "30 Yr Fixed" }, { today: TODAY });
  assert.equal(r.record.balanceBasis, "estimated"); assert.equal(r.record.balance, 387830);
  assert.equal(r.record.loanType, "30yr_fixed"); assert.equal(r.record.loanTypeGiven, true);
});
test("a 20-year fixed is flagged after the balance flag; property value falls back to appraised, then purchase price", () => {
  assert.deepStrictEqual(toRecord({ ...ROW, term: "240" }, { today: TODAY }).flags, ["balance estimated from the loan schedule", "20-year fixed priced as a 30-year"]);
  assert.equal(toRecord({ ...ROW, appraisedValue: "N/A", purchasePrice: "500000" }, { today: TODAY }).record.propertyValue, 500000);
  assert.equal(toRecord({ ...ROW, propertyValue: "610000" }, { today: TODAY }).record.propertyValue, 610000);
});
test("each failure has its code, checked in order", () => {
  const code = (patch, opts = {}) => toRecord({ ...ROW, ...patch }, { today: TODAY, ...opts }).code;
  assert.equal(code({ firstName: "", lastName: "" }), "no_name");
  assert.equal(code({ noteRate: "N/A" }), "bad_rate");
  assert.equal(code({ noteRate: "25" }), "bad_rate");
  assert.equal(code({ loanAmount: "" }), "no_balance");
  assert.equal(code({ appraisedValue: "0" }), "no_value");
  assert.equal(code({ closingDate: "" }, { requireClosingDate: true }), "no_closing_date");
  assert.equal(code({ closingDate: "TBD" }, { requireClosingDate: true }), "bad_closing_date");
  assert.equal(code({ closingDate: "2026-11-02" }), "future_closing_date");
  assert.equal(toRecord({ ...ROW, closingDate: "2026-11-01" }, { today: TODAY, requireClosingDate: true }).ok, true);
  assert.equal(toRecord({ ...ROW, closingDate: "TBD" }, { today: TODAY }).record.closeDate, "");
});
test("'Smith, John', a bad credit score and an over-long note", () => {
  const r = toRecord({ ...ROW, firstName: undefined, lastName: undefined, borrowerName: "Smith, John", creditScore: "905", notes: "n".repeat(3000) }, { today: TODAY }).record;
  assert.equal(r.name, "John Smith"); assert.equal(r.creditScore, null); assert.equal(r.notes.length, 2000);
});
test("a failure is only { ok: false, code }, and every code has a reason", () => {
  assert.deepStrictEqual(toRecord({ ...ROW, noteRate: "" }, { today: TODAY }), { ok: false, code: "bad_rate" });
  assert.deepStrictEqual(Object.keys(REASONS).sort(), ["bad_closing_date", "bad_rate", "future_closing_date", "no_balance", "no_closing_date", "no_name", "no_value"]);
  assert.equal(REASONS.bad_rate, "no note rate between 0 and 20");
  assert.equal(REASONS.future_closing_date, "not funded yet");
  assert.equal(REASONS.no_closing_date, "not funded yet");
  // a date that is there but cannot be read is the file's problem, not the loan's
  assert.equal(REASONS.bad_closing_date, "closing date not readable");
});
test("a closing date with a time of day is that day, so the row is funded", () => {
  const r = toRecord({ ...ROW, closingDate: "3/14/2024 0:00" }, { today: TODAY, requireClosingDate: true });
  assert.equal(r.ok, true);
  assert.equal(r.record.closeDate, "2024-03-14");
});
test("the checks run in order: name, rate, balance, value, then the closing date", () => {
  const bad = { firstName: "", lastName: "", noteRate: "", loanAmount: "", appraisedValue: "", closingDate: "2030-01-01" };
  assert.equal(toRecord({ ...ROW, ...bad }, { today: TODAY }).code, "no_name");
  assert.equal(toRecord({ ...ROW, ...bad, firstName: "J" }, { today: TODAY }).code, "bad_rate");
  assert.equal(toRecord({ ...ROW, ...bad, firstName: "J", noteRate: "6" }, { today: TODAY }).code, "no_balance");
  assert.equal(toRecord({ ...ROW, ...bad, firstName: "J", noteRate: "6", loanAmount: "100000" }, { today: TODAY }).code, "no_value");
  assert.equal(toRecord({ ...ROW, ...bad, firstName: "J", noteRate: "6", loanAmount: "100000", appraisedValue: "200000" }, { today: TODAY }).code, "future_closing_date");
});
test("a loan already paid off by the schedule has no balance; a rate of 20 is in, 0 and 20.01 are out", () => {
  assert.equal(toRecord({ ...ROW, closingDate: "1/5/1990", term: "120" }, { today: TODAY }).code, "no_balance");
  assert.equal(toRecord({ ...ROW, noteRate: "0" }, { today: TODAY }).code, "bad_rate");
  assert.equal(toRecord({ ...ROW, noteRate: "20" }, { today: TODAY }).record.rate, 20);
  assert.equal(toRecord({ ...ROW, noteRate: "20.01" }, { today: TODAY }).code, "bad_rate");
});
test("loan number, phone, purpose and credit score are cleaned; absent optional fields read as empty", () => {
  const r = toRecord({ ...ROW, loanNumber: "  ab-12 ", phone: ` ${"5".repeat(60)} `, purpose: "Purchase", creditScore: "300" }, { today: TODAY }).record;
  assert.equal(r.loanNumber, "AB-12"); assert.equal(r.phone, "5".repeat(40)); assert.equal(r.purpose, "purchase"); assert.equal(r.creditScore, 300);
  const min = toRecord({ firstName: "A", noteRate: "6", loanAmount: "100000", appraisedValue: "200000" }, { today: TODAY });
  assert.equal(min.ok, true);
  assert.deepStrictEqual(min.record, { name: "A", email: "", phone: "", loanNumber: "", rate: 6, balance: 100000, balanceBasis: "original", propertyValue: 200000,
    loanType: "30yr_fixed", loanTypeGiven: false, closeDate: "", creditScore: null, purpose: "", loanOfficer: "", notes: "",
    valueBasis: "origination", originalValue: 200000, originalAmount: 100000, balanceAsOf: TODAY, loanProgram: "", monthlyMi: null, propertyZip: "", occupancy: "" });
  for (const creditScore of ["299", "851", "742.5", "", "n/a"]) assert.equal(toRecord({ ...ROW, creditScore }, { today: TODAY }).record.creditScore, null);
  assert.equal(toRecord({ ...ROW, purpose: "Cash-out" }, { today: TODAY }).record.purpose, "");
});
test("with no requireClosingDate, a blank or unreadable date reads as '' and a future one still fails", () => {
  assert.equal(toRecord({ ...ROW, closingDate: "" }, { today: TODAY }).record.closeDate, "");
  assert.equal(toRecord({ ...ROW, closingDate: undefined }, { today: TODAY }).record.closeDate, "");
  assert.equal(toRecord({ ...ROW, closingDate: "2026-12-25" }, { today: TODAY, requireClosingDate: false }).code, "future_closing_date");
});

// ── loan program, MI, ZIP, occupancy and the original figures (spec 4.5) ──────────────────────────────────────────────
const rec = (patch, opts = {}) => toRecord({ ...ROW, ...patch }, { today: TODAY, ...opts }).record;

test("the loan program is read as a whole word from the program column, else the amortization text", () => {
  const table = [["Conv 30 Fixed", "conventional"], ["FHA 30YR", "fha"], ["VA IRRRL", "va"], ["USDA RD 30", "usda"], ["Rural Housing", "usda"],
    ["Non-QM", ""], ["Fannie Mae", "conventional"], ["Conforming", "conventional"], ["Evans Special", ""], ["Nevada Special", ""], ["", ""]];
  for (const [text, program] of table) {
    assert.equal(rec({ loanProgram: text, amortization: "" }).loanProgram, program, text);
    assert.equal(rec({ amortization: text }).loanProgram, program, `amortization: ${text}`);
  }
  assert.equal(rec({ loanProgram: "FHA", amortization: "Conventional" }).loanProgram, "fha");
  const jumbo = rec({ loanProgram: "Jumbo ARM 7/1", amortization: "", term: "" });
  assert.equal(jumbo.loanProgram, "jumbo"); assert.equal(jumbo.loanType, "5_1_arm"); assert.equal(jumbo.loanTypeGiven, true);
});
test("an ARM named only in the program column still sets the loan type", () => {
  const r = rec({ loanProgram: "5/1 ARM", amortization: "", term: "" });
  assert.equal(r.loanType, "5_1_arm");
  assert.equal(rec({ loanProgram: "30 Yr Fixed", amortization: "", term: "" }).balanceBasis, "estimated");
});
test("the original value: the lesser for a purchase (or unknown purpose), the appraisal for a refinance", () => {
  const vals = { appraisedValue: "355000", purchasePrice: "350000", propertyValue: "" };
  assert.equal(rec({ ...vals, purpose: "Purchase" }).originalValue, 350000);
  assert.equal(rec({ ...vals, purpose: "" }).originalValue, 350000);
  assert.equal(rec({ ...vals, purpose: "Refinance" }).originalValue, 355000);
  assert.equal(rec({ appraisedValue: "", purchasePrice: "350000", purpose: "Refinance" }).originalValue, 350000);
  assert.equal(rec({ appraisedValue: "355000", purchasePrice: "", purpose: "Purchase" }).originalValue, 355000);
  assert.equal(rec({ appraisedValue: "", purchasePrice: "", propertyValue: "610000" }).originalValue, null);
  assert.equal(rec({ loanAmount: "" , currentBalance: "300000" }).originalAmount, null);
});
test("valueBasis: current when the value came from the property value column", () => {
  assert.equal(rec({ propertyValue: "610000" }).valueBasis, "current");
  assert.equal(rec({ propertyValue: "" }).valueBasis, "origination");
  assert.equal(rec({ propertyValue: "0" }).valueBasis, "origination");
});
test("balanceAsOf: the close date for an original-amount balance, else the import date", () => {
  assert.equal(rec({ term: "", amortization: "" }).balanceAsOf, "2024-03-14");
  assert.equal(rec({ term: "", amortization: "", closingDate: "" }).balanceAsOf, TODAY);
  assert.equal(rec({}).balanceAsOf, TODAY);
  assert.equal(rec({ currentBalance: "391002" }).balanceAsOf, TODAY);
});
test("occupancy, ZIP and monthly MI are cleaned", () => {
  const occ = [["Investment Property", "investment"], ["Non-Owner Occupied", "investment"], ["Rental", "investment"], ["Second Home", "second_home"],
    ["Vacation", "second_home"], ["Primary Residence", "primary"], ["Owner Occupied", "primary"], ["Principal", "primary"], ["Other", ""], ["", ""]];
  for (const [text, value] of occ) assert.equal(rec({ occupancy: text }).occupancy, value, text);
  const zips = [["85016", "85016"], ["85016-1234", "85016"], [" 850161234 ", "85016"], [85016, "85016"], ["8501", ""], ["ABC12", ""], ["850161", ""], ["", ""]];
  for (const [text, value] of zips) assert.equal(rec({ propertyZip: text }).propertyZip, value, String(text));
  const mi = [["$212.50", 212.5], ["0", 0], ["5000", 5000], ["6000", null], ["-5", null], ["n/a", null], ["", null]];
  for (const [text, value] of mi) assert.equal(rec({ monthlyMi: text }).monthlyMi, value, text);
});
test("M12: a monthly MI under $10 is not a monthly amount (a rate such as 0.55, or a stray figure); 0 still means none", () => {
  const mi = [["0.55", null], ["0.85%", null], ["1", null], ["9.99", null], ["10", 10], ["$10.00", 10], ["0", 0], ["0.00", 0]];
  for (const [text, value] of mi) assert.equal(rec({ monthlyMi: text }).monthlyMi, value, text);
});
