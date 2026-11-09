"use strict";
// Value parsers for imported loans. These read what a spreadsheet or CSV cell, or a Zapier webhook field, actually holds:
// "$412,500.00 ", "6.500%", "0.065", an Excel date serial, "30 Years", "Smith, John". Nothing here touches the DB or the
// network, so every function is pure and safe to call on anything.
//
// One rule runs through all of them: missing is always null (or "" for text), never 0. A blank cell, "N/A", "-", a value
// that is not wholly a number, or a type we do not read (an object, an array, a boolean) all come back as missing, so a
// loan with no rate never looks like a loan at 0%. Only a string or a finite number is ever read; anything else is missing.
//
// Two helpers (headerKey, isProtectedHeader) are the import's privacy guard: a column that looks like SSN, date of birth,
// income, assets, employer or an account number is never offered to the broker and never read. The last two (isDeadStatus,
// looksFunded) read a loan status the same way for the file import and the LOS feed.

const MS_PER_DAY = 86400000;
// Excel counts days from 1899-12-30 (it treats 1900 as a leap year, so this epoch makes every date after Feb 1900 line up).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
// A bare number between these is an Excel date serial (1954-10-03 to 2119-01-11), not a year or an amount.
const SERIAL_MIN = 20000;
const SERIAL_MAX = 80000;
// A bare term of this many or fewer is years ("30"); more is months ("360"). A 50-year loan is the longest anyone writes in years.
const MAX_TERM_YEARS = 50;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
// No amount, rate or score needs more characters than this once "$", "," and spaces are gone; a longer cell is not a number.
const NUMBER_MAX = 32;

// The fraction part is one optional group, so a long run of digits that ends in junk fails in one pass, not one per digit.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
// M/D/Y, then optionally a time of day: H:MM, H:MM:SS or H:MM:SS.fff, with or without AM/PM ("3/14/2024 0:00" is how Excel saves
// a datetime cell to CSV). Each part after the date starts with a character the part before it cannot hold, so nothing backtracks.
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[ap]m)?)?$/i;
// YYYY-MM-DD, then optionally anything after a "T" or a space (an ISO or SQL timestamp: "2024-03-14 00:00:00.000").
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
// A number, spaces, one optional dash with its own trailing spaces, then the unit word. It reads the same strings as
// "\s*-?\s*" would, but cannot backtrack quadratically on a long run of spaces (a cell of 30,000 blanks after a number).
const TERM_UNIT_RE = /^(\d+(?:\.\d+)?)\s*(?:-\s*)?([a-z]+)/;
const MONTH_WORDS = new Set(["mo", "mos", "month", "months"]);
const YEAR_WORDS = new Set(["y", "yr", "yrs", "year", "years"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// What can follow the comma in a name that is not "Last, First": a person's suffix, or the end of an entity's name.
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v", "md"]);
const NAME_TAILS = new Set([...NAME_SUFFIXES, "llc", "inc", "trust", "ltd", "lp", "llp", "corp", "co"]);
// Checked against headerKey(), so spacing, case and punctuation cannot hide a column ("S.S.N.", "Date of Birth", "Gross_Income").
const PROTECTED_HEADER_RE = /ssn|social|dob|birth|income|salary|asset|employ|account/;
// A loan status that means the loan will never fund.
const DEAD_STATUS_RE = /denied|withdrawn|cancel|adverse|archiv/i;
// A status that sounds funded, and the words that turn one around ("Not Funded", "Unfunded", "Closed - Not Funded").
const FUNDED_STATUS_RE = /funded|closed|completed|purchased/i;
const NEGATED_STATUS_RE = /\b(?:not|non|never)\b|\b(?:un|non)(?:funded|closed)/i;

// The text of a value we read: a string as it is, a finite number as its digits, anything else as nothing.
function text(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();

// "$412,500.00 " -> 412500, "6.5 %" -> 6.5. Blank, "N/A", "none", "-" and "(1,000)" are not numbers, so they are null, and
// so is anything over NUMBER_MAX characters once cleaned (a million "1"s is a pasted mistake, not a loan amount).
function parseNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$,%\s]/g, "");
  return s.length <= NUMBER_MAX && NUMBER_RE.test(s) ? Number(s) : null;
}

// An interest rate as a percent. A sheet may hold 6.5, "6.500%" or the fraction 0.065 (a percent-formatted Excel cell); an
// unsigned value strictly between 0 and 1 is the fraction, so it is scaled up. Rounded to 4 decimals to shed float noise.
// A value written with a "%" sign is already a percent, so "0.5%" stays 0.5.
function parseRate(v) {
  const n = parseNumber(v);
  if (n === null) return null;
  if (typeof v === "string" && v.includes("%")) return n;
  return n > 0 && n < 1 ? Math.round(n * 100 * 1e4) / 1e4 : n;
}

function parseMoney(v) {
  return parseNumber(v);
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

// A calendar date, or null if it is not a real day (Feb 30, month 13). Year, month and day are read back from a UTC date, so
// anything the Date constructor would roll over (Feb 30 -> Mar 2) no longer matches and is refused.
function ymd(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function fromSerial(n) {
  if (!(n >= SERIAL_MIN && n <= SERIAL_MAX)) return null;
  // The part after the point is the time of day; the date is the whole days.
  return new Date(EXCEL_EPOCH_MS + Math.floor(n) * MS_PER_DAY).toISOString().slice(0, 10);
}

// A date as "YYYY-MM-DD": an Excel serial (number or digit string), M/D/YYYY, M/D/YY (YY under 70 is 20YY, else 19YY), or
// YYYY-MM-DD, each with an optional time of day after it. The date is the one written: the time is dropped and no timezone
// shift is applied.
function parseDate(v) {
  if (typeof v === "number") return Number.isFinite(v) ? fromSerial(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return fromSerial(Number(s));
  let m = SLASH_DATE_RE.exec(s);
  if (m) {
    let year = Number(m[3]);
    if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
    return ymd(year, Number(m[1]), Number(m[2]));
  }
  m = ISO_DATE_RE.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

// A loan term in months. "30 yr" / "30 Years" are years, "180 months" / "360 mo" are months, and a bare number is read by
// size: 50 or under is years (30 -> 360), over 50 is months (360 -> 360). Zero, negative and unreadable are null.
function parseTermMonths(v) {
  let months = null;
  const bare = parseNumber(v);
  if (bare !== null) {
    months = bare <= MAX_TERM_YEARS ? bare * 12 : bare;
  } else if (typeof v === "string") {
    const m = TERM_UNIT_RE.exec(v.trim().toLowerCase());
    if (m && MONTH_WORDS.has(m[2])) months = Number(m[1]);
    else if (m && YEAR_WORDS.has(m[2])) months = Number(m[1]) * 12;
  }
  if (months === null) return null;
  months = Math.round(months);
  return months > 0 ? months : null;
}

// A word as the suffix and tail sets hold it: case and periods do not matter ("L.L.C." is "llc", "Jr." is "jr").
const tailWord = (s) => s.toLowerCase().replace(/\./g, "").trim();

// True when the text after a comma is a name suffix or an entity word on its own ("John Smith, Jr", "Acme Realty, LLC"), so
// the comma is not "Last, First".
function isNameTail(s) {
  return NAME_TAILS.has(tailWord(s));
}

// "Last, First" with the first part turned around: "Smith", "John" -> "John Smith". A person's suffix at the end of the first
// part stays at the end of the name: "Smith", "John A. Jr." -> "John A. Smith Jr.", never "John A. Jr. Smith".
function flipped(last, first) {
  const words = collapse(first).split(" ");
  const end = words[words.length - 1];
  if (words.length > 1 && NAME_SUFFIXES.has(tailWord(end))) return collapse(`${words.slice(0, -1).join(" ")} ${last} ${end}`);
  return collapse(`${first} ${last}`);
}

// A borrower's display name from a whole-name cell, or from first + last cells when there is no whole name. Exactly one
// comma with text on both sides is "Last, First" and is flipped, unless what follows the comma is a suffix or an entity word;
// more commas ("Smith, John, Jr") are left as written.
function fullName({ name, first, last } = {}) {
  let out = collapse(text(name));
  if (out) {
    const parts = out.split(",");
    if (parts.length === 2 && parts[0].trim() && parts[1].trim() && !isNameTail(parts[1])) out = flipped(parts[0], parts[1]);
  } else {
    out = collapse(`${text(first)} ${text(last)}`);
  }
  return out.slice(0, NAME_MAX).trimEnd();
}

// The comparison form of a name: lowercase, one space between words.
function nameKey(name) {
  return collapse(text(name)).toLowerCase();
}

// Digits only, so "(555) 123-4567" and "+1 555 123 4567" compare equal. A leading US country code on 11 digits is dropped.
function phoneDigits(v) {
  const digits = text(v).replace(/\D/g, "");
  return digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
}

// A lowercase email, or "" if it does not look like x@y.z. Too long is refused, not cut: half an address is a wrong address.
function cleanEmail(v) {
  const s = text(v).trim().toLowerCase();
  return s.length <= EMAIL_MAX && EMAIL_RE.test(s) ? s : "";
}

function cleanText(v, max) {
  return text(v).trim().slice(0, max);
}

// A column header reduced to what identifies it: lowercase letters, digits and "#" only ("﻿Loan #" -> "loan#"). The
// character filter also drops the byte-order mark Excel puts in front of the first header of a CSV.
function headerKey(h) {
  return text(h).toLowerCase().replace(/[^a-z0-9#]/g, "");
}

function isProtectedHeader(h) {
  return PROTECTED_HEADER_RE.test(headerKey(h));
}

// True for a status that means the loan will never fund: denied, withdrawn, cancelled, adverse action, archived. The LOS feed
// ignores such a loan, and the file import never ticks one as funded.
function isDeadStatus(v) {
  return DEAD_STATUS_RE.test(text(v));
}

// True for a status the file import ticks as funded until the broker ticks their own (A4: funded only): it says funded, closed,
// completed or purchased, nothing turns that around ("Not Funded", "Unfunded", "Never Closed"), and it is not a dead status
// ("Closed (Cancelled)").
function looksFunded(v) {
  const s = text(v);
  return FUNDED_STATUS_RE.test(s) && !NEGATED_STATUS_RE.test(s) && !isDeadStatus(s);
}

module.exports = {
  parseNumber, parseRate, parseMoney, parseDate, parseTermMonths,
  fullName, nameKey, phoneDigits, cleanEmail, cleanText, headerKey, isProtectedHeader, isDeadStatus, looksFunded,
};
