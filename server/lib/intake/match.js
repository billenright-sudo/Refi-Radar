"use strict";
// Finds the client an imported loan belongs to, and says how the loan relates to that client. Both read the record that
// lib/intake/record.js builds (name, email, phone, loanNumber, closeDate, purpose, ...), so an import never duplicates a client
// who is already in the company's book.
//
// Matching is company-wide (every loan officer's book, not only the one importing) but never crosses companies: every query is
// pinned to org_id. The steps run in a fixed order and the first step that finds any client decides, so a loan number that
// finds one client is never second-guessed by an email that would have found another:
//   1. loan number   2. email   3. name and phone together   4. the name alone
// The name alone is the weakest evidence, so it only counts for a client whose own email or phone does not disagree with the
// record's (Bill, 2026-11-03); a loan number never disagrees, since a refinance brings a new one. A match by the name alone
// says so (`by: "name"`), so the import can flag it. Two or more clients at a step is `ambiguous`: the caller skips the row
// rather than guess or add a duplicate.
//
// Stored text is compared the way it is read: names through normalize's nameKey on both sides (so "ÁLVAREZ  ORTIZ" and
// "Álvarez Ortiz" are one name; SQLite's own lower() only folds ASCII), phones through phoneDigits on both sides
// ("(555) 123-4567" is "5551234567"), emails lower-cased. The only thing put on the DB handle is the name-key function below,
// which lives on that connection and changes no data.
//
// findMatch(db, orgId, record) asks the DB at each step. A run over a whole file passes a match index instead
// (createMatchIndex): the company's clients read once, held by the very keys those queries compare, and kept current by the run
// as it writes. Asking it gives the same answer as asking the DB, without a scan of every client for every row.

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

// What a step found: nothing (null, so the next step runs), one client, or several.
function verdict(rows) {
  if (rows.length === 0) return null;
  if (rows.length === 1) return { kind: "one", client: rows[0] };
  return { kind: "ambiguous", count: rows.length };
}

// The three lookups the steps make, straight from the DB: the company's clients (by id) whose stored loan number, trimmed
// lower-case email, or name key is the one given.
function dbLookups(db, orgId) {
  return {
    byLoanNumber: (loan) => db.prepare("SELECT * FROM clients WHERE org_id = ? AND loan_number = ? ORDER BY id").all(orgId, loan),
    byEmail: (email) => db.prepare("SELECT * FROM clients WHERE org_id = ? AND lower(trim(email)) = ? ORDER BY id").all(orgId, email),
    byName: (key) => {
      ensureNameKey(db);
      return db.prepare(`SELECT * FROM clients WHERE org_id = ? AND ${NAME_KEY_FN}(name) = ? ORDER BY id`).all(orgId, key);
    },
  };
}

// The same three lookups from memory, for one company over one run. The index holds only each client's id under its three
// keys, worked out by SQLite with the very expressions dbLookups compares (the loan number as stored, lower(trim(email)), the
// name key), so the two can never disagree: SQLite's lower() folds only ASCII and trim() drops only spaces, and so does this.
// A client found is read from the DB by its id, so it is always the row as it stands. An empty key is never asked for
// (findMatch skips a blank field), so none is held. The run calls refresh(id) after each client it creates or updates, which
// files the client again under the keys it now has.
const KEYS = `SELECT id, loan_number AS loan, lower(trim(email)) AS email, ${NAME_KEY_FN}(name) AS name FROM clients`;

function createMatchIndex(db, orgId) {
  ensureNameKey(db);
  const everyone = db.prepare(`${KEYS} WHERE org_id = ?`);
  const oneKeys = db.prepare(`${KEYS} WHERE org_id = ? AND id = ?`);
  const clientRow = db.prepare("SELECT * FROM clients WHERE org_id = ? AND id = ?");
  const buckets = { loan: new Map(), email: new Map(), name: new Map() };   // key -> client ids, ascending
  const held = new Map();   // client id -> the keys it is filed under

  // Each bucket stays in id order, as the queries' ORDER BY id would give it.
  const file = (bucket, key, id) => {
    if (typeof key !== "string" || key === "") return;
    const ids = bucket.get(key) || [];
    let at = ids.length;
    while (at > 0 && ids[at - 1] > id) at -= 1;
    ids.splice(at, 0, id);
    bucket.set(key, ids);
  };
  const unfile = (bucket, key, id) => {
    const ids = bucket.get(key);
    if (!ids) return;
    const at = ids.indexOf(id);
    if (at >= 0) ids.splice(at, 1);
    if (ids.length === 0) bucket.delete(key);
  };

  const add = (keys) => {
    file(buckets.loan, keys.loan, keys.id);
    file(buckets.email, keys.email, keys.id);
    file(buckets.name, keys.name, keys.id);
    held.set(keys.id, keys);
  };
  const remove = (id) => {
    const keys = held.get(id);
    if (!keys) return;
    unfile(buckets.loan, keys.loan, id);
    unfile(buckets.email, keys.email, id);
    unfile(buckets.name, keys.name, id);
    held.delete(id);
  };

  for (const keys of everyone.all(orgId)) add(keys);
  const found = (bucket, key) => (bucket.get(key) || []).map((id) => clientRow.get(orgId, id)).filter(Boolean);
  return {
    orgId,
    byLoanNumber: (loan) => found(buckets.loan, loan),
    byEmail: (email) => found(buckets.email, email),
    byName: (key) => found(buckets.name, key),
    refresh(id) {
      remove(id);
      const keys = oneKeys.get(orgId, id);
      if (keys) add(keys);
    },
  };
}

// `index` (optional) is a createMatchIndex for the same company; without one each step asks the DB.
function findMatch(db, orgId, record, index = null) {
  if (index && index.orgId !== orgId) throw new TypeError("findMatch: the match index is for another company");
  const look = index || dbLookups(db, orgId);

  const loan = trimmed(record.loanNumber).toUpperCase();
  if (loan) {
    const found = verdict(look.byLoanNumber(loan));
    if (found) return found;
  }

  const email = trimmed(record.email).toLowerCase();
  if (email) {
    const found = verdict(look.byEmail(email));
    if (found) return found;
  }

  const key = nameKey(record.name);
  if (!key) return NONE;
  const named = look.byName(key);

  const phone = phoneDigits(record.phone);
  if (phone) {
    const found = verdict(named.filter((c) => phoneDigits(c.phone) === phone));
    if (found) return found;
  }

  // The name alone: a candidate is somebody else only when they and the record both have an email, or both a phone, that
  // differ. One candidate left is the client; several cannot be told apart.
  const agrees = (c) => {
    const theirEmail = trimmed(c.email).toLowerCase();
    const theirPhone = phoneDigits(c.phone);
    return (!email || !theirEmail || theirEmail === email) && (!phone || !theirPhone || theirPhone === phone);
  };
  const left = named.filter(agrees);
  if (left.length === 1) return { kind: "one", client: left[0], by: "name" };
  if (left.length > 1) return { kind: "ambiguous", count: left.length };
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

module.exports = { findMatch, createMatchIndex, relation };
