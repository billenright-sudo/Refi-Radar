"use strict";
// Finds the client an imported loan belongs to, and says how the loan relates to that client. Both read the record that
// lib/intake/record.js builds (name, email, phone, loanNumber, closeDate, purpose, ...), so an import never duplicates a client
// who is already in the company's book.
//
// Matching is company-wide (every loan officer's book, not only the one importing) but never crosses companies: every query is
// pinned to org_id. The steps run in a fixed order and the first step that finds any client decides, so a loan number that
// finds one client is never second-guessed by an email that would have found another:
//   1. loan number   2. email   3. name and phone together   4. the name alone
// The name alone is the weakest evidence, so it only counts for a client who is bare (no email, phone or loan number to
// disagree with). Two or more clients at a step is `ambiguous`: the caller skips the row rather than guess or add a duplicate.
//
// Stored text is compared the way it is read: names through normalize's nameKey on both sides (so "ÁLVAREZ  ORTIZ" and
// "Álvarez Ortiz" are one name; SQLite's own lower() only folds ASCII), phones through phoneDigits on both sides
// ("(555) 123-4567" is "5551234567"), emails lower-cased. The only thing put on the DB handle is the name-key function below,
// which lives on that connection and changes no data.

const { nameKey, phoneDigits, parseDate } = require("./normalize");

const NONE = Object.freeze({ kind: "none" });

// The SQL function that gives a stored name its nameKey, registered once on each connection we are handed.
const NAME_KEY_FN = "intake_name_key";
const withNameKey = new WeakSet();
function ensureNameKey(db) {
  if (withNameKey.has(db)) return;
  // nameKey reads anything that is not a string or a finite number as "", so a NULL name is safe.
  db.function(NAME_KEY_FN, { deterministic: true }, (name) => nameKey(name));
  withNameKey.add(db);
}

const trimmed = (v) => (typeof v === "string" ? v.trim() : "");

// A stored client with nothing but a name: no email, phone or loan number that could say it is a different person.
const isBare = (c) => !trimmed(c.email) && !trimmed(c.phone) && !trimmed(c.loan_number);

// What a step found: nothing (null, so the next step runs), one client, or several.
function verdict(rows) {
  if (rows.length === 0) return null;
  if (rows.length === 1) return { kind: "one", client: rows[0] };
  return { kind: "ambiguous", count: rows.length };
}

function findMatch(db, orgId, record) {
  const loan = trimmed(record.loanNumber).toUpperCase();
  if (loan) {
    const found = verdict(db.prepare("SELECT * FROM clients WHERE org_id = ? AND loan_number = ? ORDER BY id").all(orgId, loan));
    if (found) return found;
  }

  const email = trimmed(record.email).toLowerCase();
  if (email) {
    const found = verdict(db.prepare("SELECT * FROM clients WHERE org_id = ? AND lower(trim(email)) = ? ORDER BY id").all(orgId, email));
    if (found) return found;
  }

  const key = nameKey(record.name);
  if (!key) return NONE;
  ensureNameKey(db);
  const named = db.prepare(`SELECT * FROM clients WHERE org_id = ? AND ${NAME_KEY_FN}(name) = ? ORDER BY id`).all(orgId, key);

  const phone = phoneDigits(record.phone);
  if (phone) {
    const found = verdict(named.filter((c) => phoneDigits(c.phone) === phone));
    if (found) return found;
  }

  // The name alone: one candidate who is bare is the client; several with any one of them bare cannot be told apart (R4).
  // A candidate who has an email, phone or loan number of their own that did not match above is somebody else.
  if (named.length === 1) return isBare(named[0]) ? { kind: "one", client: named[0] } : NONE;
  if (named.length > 1 && named.some(isBare)) return { kind: "ambiguous", count: named.length };
  return NONE;
}

// How an incoming loan relates to the stored client it matched:
//   same            the very same loan (an update of what we hold)
//   refinance       a newer loan on the same client
//   second_property a newer purchase, so a different property
//   older           a loan that closed before the one we hold (history; the stored loan stays current)
// The loan numbers decide first. Both equal, or neither given, is the same loan. With only one side numbered it is still the
// same loan unless both closing dates are known and differ (R3); then, like two different numbers, the dates say which is newer.
// A date missing on either side can't say the incoming loan is older, so it counts as a refinance (or a second property).
// The stored close_date is free text (the old importer kept the cell as typed: "3/14/2024", an Excel serial "45365"), so it is
// read with the same parser as an imported row; a hand-typed "last spring", "2021-13-45" or "2021-02-30" is no date at all.
// The record's closeDate is already "YYYY-MM-DD" or "" (record.js read it).
function relation(client, record) {
  const stored = trimmed(client.loan_number).toUpperCase();
  const incoming = trimmed(record.loanNumber).toUpperCase();
  const storedDate = parseDate(client.close_date) || "";
  const incomingDate = trimmed(record.closeDate);

  if (stored === incoming) return "same";
  if ((!stored || !incoming) && (!storedDate || !incomingDate || storedDate === incomingDate)) return "same";

  if (storedDate && incomingDate && incomingDate < storedDate) return "older";
  return record.purpose === "purchase" ? "second_property" : "refinance";
}

module.exports = { findMatch, relation };
