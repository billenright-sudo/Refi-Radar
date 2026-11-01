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

const { nameKey, phoneDigits } = require("./normalize");

const NONE = Object.freeze({ kind: "none" });
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

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

// A closing date as YYYY-MM-DD, or "" when there is none or it is not a real day. A stored close_date is free text, so a
// hand-typed "last spring" is no date, and neither is "2021-13-45" or "2021-02-30": the date is read back from a UTC date and
// must come out the same (the Date constructor would roll Feb 30 over to Mar 2).
const dateOf = (v) => {
  const m = ISO_DATE_RE.exec(trimmed(v));
  if (!m) return "";
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const day = Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
  return day === m[0] ? day : "";
};

// How an incoming loan relates to the stored client it matched:
//   same            the very same loan (an update of what we hold)
//   refinance       a newer loan on the same client
//   second_property a newer purchase, so a different property
//   older           a loan that closed before the one we hold (history; the stored loan stays current)
// The loan numbers decide first. Both equal, or neither given, is the same loan. With only one side numbered it is still the
// same loan unless both closing dates are known and differ (R3); then, like two different numbers, the dates say which is newer.
// A date missing on either side can't say the incoming loan is older, so it counts as a refinance (or a second property).
function relation(client, record) {
  const stored = trimmed(client.loan_number).toUpperCase();
  const incoming = trimmed(record.loanNumber).toUpperCase();
  const storedDate = dateOf(client.close_date);
  const incomingDate = dateOf(record.closeDate);

  if (stored === incoming) return "same";
  if ((!stored || !incoming) && (!storedDate || !incomingDate || storedDate === incomingDate)) return "same";

  if (storedDate && incomingDate && incomingDate < storedDate) return "older";
  return record.purpose === "purchase" ? "second_property" : "refinance";
}

module.exports = { findMatch, relation };
