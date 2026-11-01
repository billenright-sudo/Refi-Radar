"use strict";
// The one write both front doors share. The file import and the ARIVE (Zapier) feed hand their rows here, and the import's
// review is this very call with dryRun: it does all the work inside the transaction and then rolls it back. So the review shows
// exactly what the import will do, and the reviewHash it returns lets the confirm prove nothing changed in between (R6).
//
// Each item is { row, fields, skip? }: the row number the broker sees, the row's values keyed by the FIELDS ids, and a reason
// the front door has already turned the row away for (e.g. "not funded"). A row is read into a record (record.js), matched
// against the whole company's clients (match.js) and given a book (owner.js). Then:
//   no match, or a newer purchase (a second property)  a new client in the routed book
//   a loan older than the one we hold                  unchanged ("older loan"); nothing is written
//   the same loan, or a refinance                      the client's loan is refreshed, one changed column at a time
//   several clients matched                            ambiguous; nothing is written
// Rows run oldest closing date first (blank first, then by row), all in one transaction, so a refinance listed beside its
// original lands on the client the original created, and a loan listed twice is created once. Results come back by row.
//
// An update writes a column only when its value changes, and never the name, the notes or the last contact (A3, A9); a new
// client's last contact is left empty. The balance is kept unless the row gives a current balance or the loan itself changed
// (a refinance, another rate, another closing date), so an estimate never overwrites a stored or hand-corrected balance for the
// same loan. Email and phone are only filled where the client has none, and the loan type only when the row said it (R5).
//
// A6a: when a row that names a loan officer brings the same loan or a refinance for a client in somebody else's book, the
// client moves to the named loan officer. The old owner's open follow-ups for the client close as expired, and the old owner
// gets an in-app notification unless they are the one who ran the import (or own the key). A client this same run created is
// only handed over, since nobody had them before the run (no follow-ups close, no one is told). Nothing here sends an email or
// any other message (A1), and the call log is never touched: it is read by client, so it follows the client on its own.

const crypto = require("crypto");
const { toRecord, REASONS, BALANCE_FLAGS } = require("./record");
const { findMatch, createMatchIndex, relation } = require("./match");
const { resolveOwner } = require("./owner");
const { fullName, parseDate } = require("./normalize");
// Called as followups.resolveForClient(...) so a test can stand in for it.
const followups = require("../assistant/followups");

const SOURCES = ["import", "arive"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// Two numbers this close are the same value (a REAL read back from SQLite is not always bit-for-bit what was written).
const EPSILON = 1e-9;
// A new client with no credit score gets the same default the schema and the client form use.
const DEFAULT_CREDIT_SCORE = 700;

const blank = (v) => typeof v !== "string" || v.trim() === "";
const sameNumber = (stored, incoming) => typeof stored === "number" && Math.abs(stored - incoming) <= EPSILON;

// Every result has the same keys, so the review page and the webhook never have to guess.
const result = (row, outcome, fields) => ({
  row, outcome, name: "", reason: null, note: null, flags: [], owner: null, movedFrom: null, ...fields,
});

// The columns an update of a matched client would change, as { column: new value }. `rel` is "same" or "refinance".
function loanChanges(client, record, rel) {
  const changes = {};
  const number = (col, value) => { if (!sameNumber(client[col], value)) changes[col] = value; };
  const text = (col, value) => { if ((client[col] ?? "") !== value) changes[col] = value; };

  number("current_rate", record.rate);
  number("property_value", record.propertyValue);
  if (record.loanTypeGiven) text("loan_type", record.loanType);
  if (record.closeDate) text("close_date", record.closeDate);
  if (record.creditScore !== null) number("credit_score", record.creditScore);
  // A refinance replaces the loan, number and all: an unnumbered new loan clears the old number, which belongs to the loan it
  // paid off (kept, it would match that old loan as "same" on the next import and roll the client back to it). The same loan
  // keeps its number when the row gives none.
  if (record.loanNumber || rel === "refinance") text("loan_number", record.loanNumber);

  // The stored closing date is free text (the old importer kept the cell as typed), so it is read with the same parser as the
  // row's before the two are compared: "3/14/2024" and "2024-03-14" are the same day, not a changed loan.
  const storedDate = parseDate(client.close_date);
  const loanChanged = rel === "refinance" || !sameNumber(client.current_rate, record.rate)
    || Boolean(storedDate && record.closeDate && storedDate !== record.closeDate);
  if (record.balanceBasis === "current" || loanChanged) number("loan_balance", record.balance);

  if (blank(client.email) && record.email) changes.email = record.email;
  if (blank(client.phone) && record.phone) changes.phone = record.phone;
  return changes;
}

function countsOf(results) {
  const counts = { created: 0, updated: 0, unchanged: 0, ambiguous: 0, skipped: 0, moved: 0, byOwner: [] };
  const books = new Map();
  for (const r of results) {
    counts[r.outcome] += 1;
    if (r.movedFrom !== null) counts.moved += 1;
    if (r.owner) {
      const book = books.get(r.owner.id) || { id: r.owner.id, name: r.owner.name, rows: 0 };
      book.rows += 1;
      books.set(r.owner.id, book);
    }
  }
  counts.byOwner = [...books.values()].sort((a, b) => a.name.localeCompare(b.name, "en") || a.id - b.id);
  return counts;
}

// What the review showed, reduced to what the import must repeat exactly (R6).
const hashOf = (results) => crypto.createHash("sha256")
  .update(JSON.stringify(results.map((r) => [r.row, r.outcome, r.reason, r.note, r.owner && r.owner.id, r.movedFrom])))
  .digest("hex");

// `actor` is the users row of whoever ran the import or owns the feed's key. `today` is the UTC date (YYYY-MM-DD) every row is
// checked against, and `nowUtc` (SQLite UTC text) stamps the follow-ups a move closes. Returns { results, counts, reviewHash }.
function ingest(db, { actor, source, items, today, nowUtc, requireClosingDate = false, dryRun = false } = {}) {
  if (!SOURCES.includes(source)) throw new TypeError(`source must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
  if (typeof today !== "string" || !DAY_RE.test(today)) throw new TypeError(`today must be "YYYY-MM-DD", got ${JSON.stringify(today)}`);
  if (typeof nowUtc !== "string" || !UTC_RE.test(nowUtc)) {
    throw new TypeError(`nowUtc must be SQLite UTC text "YYYY-MM-DD HH:MM:SS", got ${JSON.stringify(nowUtc)}`);
  }

  // Rows the front door turned away, or that are not a loan we can import, are settled before the DB is touched.
  const results = [];
  const loans = [];
  for (const item of items || []) {
    const fields = item.fields || {};
    const name = fullName({ name: fields.borrowerName, first: fields.firstName, last: fields.lastName });
    if (item.skip) {
      results.push(result(item.row, "skipped", { name, reason: item.skip }));
      continue;
    }
    const read = toRecord(fields, { today, requireClosingDate });
    if (!read.ok) {
      results.push(result(item.row, "skipped", { name, reason: REASONS[read.code] }));
      continue;
    }
    loans.push({ row: item.row, record: read.record, flags: read.flags });
  }
  loans.sort((a, b) => {
    if (a.record.closeDate !== b.record.closeDate) return a.record.closeDate < b.record.closeDate ? -1 : 1;
    return a.row - b.row;
  });

  const insertClient = db.prepare(`
    INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date,
                         credit_score, notes, loan_number, source)
    VALUES (@org_id, @user_id, @name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date,
            @credit_score, @notes, @loan_number, @source)
  `);
  const notify = db.prepare("INSERT INTO notifications (org_id, from_user, to_user, client_id, message) VALUES (?, ?, ?, ?, ?)");
  const userOf = db.prepare("SELECT first_name, last_name FROM users WHERE id = ?");

  // { id, name, first } for a user, looked up once per run.
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) {
      const u = userOf.get(id) || { first_name: "", last_name: "" };
      people.set(id, { id, name: `${u.first_name} ${u.last_name}`.trim(), first: String(u.first_name).trim() });
    }
    return people.get(id);
  };
  const bookOf = (id) => ({ id, name: person(id).name });

  // The company's clients' match keys, read once when the run starts (match.js's createMatchIndex). Every client the run
  // creates or updates is filed again straight after the write, so each row is matched against the clients exactly as the rows
  // before it left them, the same as asking the DB row by row, without scanning every client for every row.
  let index = null;

  // The clients this run created. One a later row hands to another loan officer was nobody's before the run, so that is not a
  // move: no one loses a client, so no follow-ups close and no one is told.
  const createdThisRun = new Set();
  const create = (record, owner) => {
    const info = insertClient.run({
      org_id: actor.org_id, user_id: owner.id, name: record.name, email: record.email, phone: record.phone,
      loan_type: record.loanType, current_rate: record.rate, loan_balance: record.balance, property_value: record.propertyValue,
      close_date: record.closeDate, credit_score: record.creditScore ?? DEFAULT_CREDIT_SCORE, notes: record.notes,
      loan_number: record.loanNumber, source,
    });
    const id = Number(info.lastInsertRowid);
    createdThisRun.add(id);
    index.refresh(id);
  };

  function ingestOne({ row, record, flags }) {
    const owner = resolveOwner(db, actor, record.loanOfficer);
    // A row's flags say what was done with it. The balance flags (estimated / original amount) only go on a row whose balance
    // was written, and the routing flag ("routed to your book: ...") only on a row that creates a client: a matched row stays
    // in its client's book (or moves to the loan officer it named), so the importer's book is not where it went. A loan type
    // flag is about the row itself, so it stays on every row.
    const balanceKept = flags.filter((f) => !BALANCE_FLAGS.includes(f));
    const base = { name: record.name, flags: balanceKept };
    const createdIn = { owner: bookOf(owner.id), flags: owner.flag ? [...flags, owner.flag] : [...flags] };

    const match = findMatch(db, actor.org_id, record, index);
    if (match.kind === "ambiguous") return result(row, "ambiguous", { ...base, reason: `matched ${match.count} clients` });
    if (match.kind === "none") {
      create(record, owner);
      return result(row, "created", { ...base, ...createdIn });
    }

    const client = match.client;
    const rel = relation(client, record);
    if (rel === "second_property") {
      create(record, owner);
      return result(row, "created", { ...base, ...createdIn, note: "second property" });
    }
    if (rel === "older") return result(row, "unchanged", { ...base, note: "older loan", owner: bookOf(client.user_id) });

    // The same loan or a refinance. A row that named its loan officer takes the client to them (A6a); a row that only fell
    // back to the importer's own book never moves anyone.
    const changes = loanChanges(client, record, rel);
    const reassigns = owner.named && owner.id !== client.user_id;
    if (reassigns) changes.user_id = owner.id;
    const columns = Object.keys(changes);
    if (columns.length === 0) return result(row, "unchanged", { ...base, owner: bookOf(client.user_id) });

    // The column names are this module's own, never the row's.
    db.prepare(`UPDATE clients SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...changes, id: client.id });
    index.refresh(client.id);
    const updated = { ...base, flags: "loan_balance" in changes ? [...flags] : balanceKept };
    if (!reassigns) return result(row, "updated", { ...updated, owner: bookOf(client.user_id) });
    if (createdThisRun.has(client.id)) return result(row, "updated", { ...updated, owner: bookOf(owner.id) });

    const from = person(client.user_id);
    const to = person(owner.id);
    followups.resolveForClient(db, from.id, client.id, "expired", nowUtc);
    if (from.id !== actor.id) {
      notify.run(actor.org_id, actor.id, from.id, client.id,
        `${client.name} moved to ${to.name}'s book: their new loan came in under ${to.first}.`);
    }
    return result(row, "updated", { ...updated, owner: bookOf(owner.id), movedFrom: from.name });
  }

  // A dry run does everything, then throws this (and only this is caught) so the transaction rolls back. Any other error
  // still rolls back and reaches the caller.
  const rollback = new Error("ingest dry run: roll back");
  const write = db.transaction(() => {
    // Read inside the transaction, so the index and the writes see one and the same DB.
    if (loans.length > 0) index = createMatchIndex(db, actor.org_id);
    for (const loan of loans) results.push(ingestOne(loan));
    if (dryRun) throw rollback;
  });
  try {
    write();
  } catch (err) {
    if (err !== rollback) throw err;
  }

  results.sort((a, b) => a.row - b.row);
  return { results, counts: countsOf(results), reviewHash: hashOf(results) };
}

module.exports = { ingest };
