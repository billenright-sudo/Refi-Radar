"use strict";
// One imported row, turned into a client record. The row's values (from a file row or an ARIVE or LendingPad Zapier webhook body, keyed by the
// FIELDS ids in lib/intake/fields.js) are read with the parsers in normalize.js and loan.js and checked. The answer is either
// { ok: true, record, flags } or { ok: false, code }, where code says why the row cannot be imported (REASONS has the words).
// Nothing here touches the DB or the network, so it is pure.
//
// A loan must have a name, a note rate, a balance and a property value, and it must already be funded (A4): a closing date after
// today is never imported, and a front door that needs the date (the LOS feed) can insist on one. No figure is made up (A5):
// the balance is the one the row gave, else worked out from the loan's schedule, else the original loan amount, and that last
// stand-in always comes back with a flag so the broker can see it. `status` is not part of the record; the front doors decide
// from it before they get here.
//
// The checks run in a fixed order (name, rate, balance, value, closing date) and the first one that fails is the answer.

const { parseRate, parseMoney, parseNumber, parseDate, parseTermMonths, fullName, cleanEmail, cleanText } = require("./normalize");
const { estimateBalance, termOf, mapLoanType } = require("./loan");

// A note rate above this (or at or below 0) is a typo or the wrong column, not a loan.
const MAX_RATE = 20;
const MIN_CREDIT_SCORE = 300;
const MAX_CREDIT_SCORE = 850;

// What a failed row is called on the review page. A closing date that is missing or in the future means the loan has not funded;
// one that is there but cannot be read is said plainly, so the broker fixes the column rather than wait on the loan.
const REASONS = Object.freeze({
  no_name: "no name",
  bad_rate: "no note rate between 0 and 20",
  no_balance: "no balance or loan amount",
  no_value: "no property value",
  no_closing_date: "not funded yet",
  bad_closing_date: "closing date not readable",
  future_closing_date: "not funded yet",
});

const FLAG_ESTIMATED = "balance estimated from the loan schedule";
const FLAG_ORIGINAL = "balance = original loan amount (no rate/term/date to estimate from)";
// The flags that are about the balance; the import only shows them on a row whose balance it wrote.
const BALANCE_FLAGS = Object.freeze([FLAG_ESTIMATED, FLAG_ORIGINAL]);

const utcToday = () => new Date().toISOString().slice(0, 10);

// The first value that is above 0, else null: property value, then the appraisal, then the purchase price.
function firstPositive(...values) {
  for (const v of values) if (v !== null && v > 0) return v;
  return null;
}

// 300 to 850 as a whole number, else null.
function creditScoreOf(v) {
  const n = parseNumber(v);
  return n !== null && Number.isInteger(n) && n >= MIN_CREDIT_SCORE && n <= MAX_CREDIT_SCORE ? n : null;
}

// "purchase" or "refinance" if the text says so, else "". "Cash-Out Refinance" and "Rate/Term Refi" are refinances.
function purposeOf(v) {
  const s = cleanText(v, 100);
  if (/purchase/i.test(s)) return "purchase";
  if (/refi/i.test(s)) return "refinance";
  return "";
}

// `today` is the UTC date "YYYY-MM-DD"; the front doors pass it so a whole run (and every test) shares one day. It falls back to
// the clock's UTC date only so that a caller who forgets it cannot silently turn off the future-date check.
function toRecord(fields, { today = utcToday(), requireClosingDate = false } = {}) {
  const f = fields || {};

  const name = fullName({ name: f.borrowerName, first: f.firstName, last: f.lastName });
  if (!name) return { ok: false, code: "no_name" };

  const rate = parseRate(f.noteRate);
  if (rate === null || rate <= 0 || rate > MAX_RATE) return { ok: false, code: "bad_rate" };

  // The closing date is read first because the balance estimate counts payments from it.
  const closeDateRead = parseDate(f.closingDate);
  const term = { termMonths: parseTermMonths(f.term), amortization: f.amortization };
  const found = estimateBalance({
    currentBalance: parseMoney(f.currentBalance),
    loanAmount: parseMoney(f.loanAmount),
    rate,
    termMonths: termOf(term),
    firstPaymentDate: parseDate(f.firstPaymentDate),
    closeDate: closeDateRead,
    today,
  });
  if (!found || !(found.balance > 0)) return { ok: false, code: "no_balance" };

  const propertyValue = firstPositive(parseMoney(f.propertyValue), parseMoney(f.appraisedValue), parseMoney(f.purchasePrice));
  if (propertyValue === null) return { ok: false, code: "no_value" };

  // A date after today is never funded. A blank or unreadable one only matters to a caller that requires the date.
  if (closeDateRead !== null && closeDateRead > today) return { ok: false, code: "future_closing_date" };
  if (requireClosingDate && closeDateRead === null) {
    return { ok: false, code: cleanText(f.closingDate, 100) === "" ? "no_closing_date" : "bad_closing_date" };
  }

  const type = mapLoanType(term);
  const flags = [];
  if (found.basis === "estimated") flags.push(FLAG_ESTIMATED);
  else if (found.basis === "original") flags.push(FLAG_ORIGINAL);
  if (type.flag) flags.push(type.flag);

  return {
    ok: true,
    flags,
    record: {
      name,
      email: cleanEmail(f.email),
      phone: cleanText(f.phone, 40),
      loanNumber: cleanText(f.loanNumber, 64).toUpperCase(),
      rate,
      balance: found.balance,
      balanceBasis: found.basis,
      propertyValue,
      loanType: type.loanType,
      loanTypeGiven: type.given,
      closeDate: closeDateRead || "",
      creditScore: creditScoreOf(f.creditScore),
      purpose: purposeOf(f.purpose),
      loanOfficer: cleanText(f.loanOfficer, 254),
      notes: cleanText(f.notes, 2000),
    },
  };
}

module.exports = { toRecord, REASONS, BALANCE_FLAGS };
