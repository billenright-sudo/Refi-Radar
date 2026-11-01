"use strict";
// /api/import (routes/import.js) against a throwaway DB, behind a signed rr_token cookie: a broker uploads a CSV or Excel file,
// sees a review of exactly what will be created, updated or skipped (with the column picks and the "counts as funded" statuses),
// and confirms it. The real router is mounted; uploads are real multipart posts. No model call and no network but the local test
// server.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-import-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");
const XLSX = require("xlsx");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { FIELDS } = require("../lib/intake/fields");
const importRoutes = require("../routes/import");

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first, last) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)"
).run(orgId, role, first, last, email).lastInsertRowid);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.test", "Ann", "Lee");
const lou = addUser(orgA, "lo", "lou@a.test", "Lou", "Park");
const lia = addUser(orgA, "lo", "lia@a.test", "Lia", "Chen");

let server, base;
before(async () => {
  const app = express();
  app.use(cookieParser());
  app.use("/api/import", importRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});
beforeEach(() => {
  for (const table of ["notifications", "charlie_recommendations", "contact_log", "clients"]) db.prepare(`DELETE FROM ${table}`).run();
});

// `as(userId)(method, path, body)`: a JSON body, or a FormData for an upload. `as(null)` is anonymous.
const as = (userId) => async (method, p, body) => {
  const headers = {};
  if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
};
const uploadAs = (userId, bytes, { name = "loans.csv", type = "text/csv" } = {}) => {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return as(userId)("POST", "/api/import/preview", form);
};
const clientCount = () => db.prepare("SELECT COUNT(*) AS n FROM clients").get().n;
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// Silences console.error for the duration of fn and returns what it was called with.
async function logged(fn) {
  const saved = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try { await fn(); } finally { console.error = saved; }
  return calls;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const ARIVE = ["Loan Number", "Borrower First Name", "Borrower Last Name", "Borrower Email", "Borrower Cell Phone", "Note Rate", "Loan Amount", "Loan Term", "Amortization Type", "Appraised Value", "Purchase Price", "Funded Date", "Loan Status", "Loan Purpose", "First Payment Date", "Credit Score", "Loan Officer Email", "Borrower SSN"];
const SSN_COLUMN = 17;
const JOHN = ["A100", "John", "Smith", "john@smith.test", "(555) 123-4567", "6.500%", "400000", "360", "Fixed", "520000", "", "3/14/2024", "Funded", "Refinance", "5/1/2024", "742", "lou@a.test", "123-45-6789"];
const MARY = ["A200", "Mary", "Jones", "mary@jones.test", "(555) 222-3333", "6.25", "300000", "360", "Fixed", "400000", "", "6/20/2024", "In Process", "Purchase", "8/1/2024", "701", "", "987-65-4321"];
const PAT = ["000123", "Pat", "Kim", "pat@kim.test", "(555) 444-5555", "7.0", "250000", "360", "Fixed", "350000", "", "9/5/2024", "Funded", "Refinance", "11/1/2024", "688", "", "111-22-3333"];

const csvCell = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvOf = (headers, rows) => [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const ARIVE_CSV = Buffer.from(csvOf(ARIVE, [JOHN, MARY, PAT]));

const reviewBody = (review, patch = {}) => ({ fileData: review.fileData, mimetype: review.mimetype, mapping: review.mapping, ...patch });

// ── access ──────────────────────────────────────────────────────────────────

test("a loan officer cannot use the import routes", async () => {
  const up = await uploadAs(lou, ARIVE_CSV);
  assert.equal(up.status, 403);
  for (const route of ["review", "confirm"]) {
    const res = await as(lou)("POST", `/api/import/${route}`, { fileData: ARIVE_CSV.toString("base64"), mapping: {}, reviewHash: "x" });
    assert.equal(res.status, 403, route);
  }
  assert.equal((await as(null)("POST", "/api/import/review", {})).status, 401);
  assert.equal(clientCount(), 0);
});

// ── preview ─────────────────────────────────────────────────────────────────

test("preview of an ARIVE export: detected mapping, statuses with defaults, a review, nothing written", async () => {
  const { status, data } = await uploadAs(ann, ARIVE_CSV);
  assert.equal(status, 200);
  assert.equal(data.success, true);
  assert.equal(data.mapping.loanNumber, 0);
  assert.equal(data.mapping.status, 12);
  assert.equal(data.mapping.closingDate, 11);
  assert.deepStrictEqual(data.fields, JSON.parse(JSON.stringify(FIELDS)));
  assert.deepStrictEqual(data.headers.map((h) => h.index), Array.from({ length: 17 }, (_, i) => i));
  assert.ok(!data.headers.some((h) => h.header === "Borrower SSN"));
  assert.deepStrictEqual(data.statuses, [
    { value: "funded", label: "Funded", count: 2, funded: true },
    { value: "in process", label: "In Process", count: 1, funded: false },
  ]);
  assert.deepStrictEqual(data.results.map((r) => [r.row, r.outcome]), [[2, "created"], [3, "skipped"], [4, "created"]]);
  assert.deepStrictEqual(pick(data.results[1], ["outcome", "reason"]), { outcome: "skipped", reason: "not funded" });
  assert.equal(data.counts.created, 2);
  assert.equal(data.counts.skipped, 1);
  assert.equal(data.everyRowFunded, false);
  assert.equal(data.totalRows, 3);
  assert.match(data.reviewHash, /^[0-9a-f]{64}$/);
  assert.equal(data.mimetype, "text/csv");
  assert.equal(Buffer.from(data.fileData, "base64").toString("utf8"), ARIVE_CSV.toString("utf8"));
  assert.equal(clientCount(), 0);
});

test("the SSN never comes back and is never stored", async () => {
  const { data } = await uploadAs(ann, ARIVE_CSV);
  const ssns = ["123-45-6789", "987-65-4321", "111-22-3333"];
  const bare = JSON.stringify({ ...data, fileData: undefined });
  for (const ssn of ssns) assert.ok(!bare.includes(ssn), ssn);

  // A browser mapping that points fields at the SSN column is cleaned before anything is read, on /review and on /confirm.
  const pointed = { ...data.mapping, notes: SSN_COLUMN, creditScore: -1 };
  const review = await as(ann)("POST", "/api/import/review", reviewBody(data, { mapping: pointed }));
  assert.equal(review.status, 200);
  assert.equal(review.data.mapping.notes, -1);
  const reviewed = JSON.stringify({ ...review.data, fileData: undefined });
  for (const ssn of ssns) assert.ok(!reviewed.includes(ssn), ssn);

  const noRate = await as(ann)("POST", "/api/import/review", reviewBody(data, { mapping: { ...data.mapping, noteRate: SSN_COLUMN } }));
  assert.equal(noRate.data.mapping.noteRate, -1);
  assert.equal(noRate.data.counts.created, 0, "with no rate column nothing can be created, and the SSN was not read as a rate");
  for (const ssn of ssns) assert.ok(!JSON.stringify({ ...noRate.data, fileData: undefined }).includes(ssn), ssn);

  const confirm = await as(ann)("POST", "/api/import/confirm", reviewBody(data, { mapping: pointed, reviewHash: review.data.reviewHash }));
  assert.equal(confirm.status, 200);
  assert.equal(confirm.data.counts.created, 2);
  const stored = JSON.stringify(db.prepare("SELECT * FROM clients").all());
  for (const ssn of ssns) assert.ok(!stored.includes(ssn), ssn);
  assert.ok(!JSON.stringify({ ...confirm.data, fileData: undefined }).includes("123-45-6789"));
});

// ── review ──────────────────────────────────────────────────────────────────

test("review re-runs with the broker's picks and ticked statuses", async () => {
  const { data: first } = await uploadAs(ann, ARIVE_CSV);

  const ticked = await as(ann)("POST", "/api/import/review", reviewBody(first, { fundedStatuses: ["funded", "in process"] }));
  assert.equal(ticked.status, 200);
  assert.deepStrictEqual(ticked.data.statuses.map((s) => [s.value, s.funded]), [["funded", true], ["in process", true]]);
  assert.equal(ticked.data.results[1].outcome, "created");
  assert.equal(ticked.data.counts.created, 3);
  assert.notEqual(ticked.data.reviewHash, first.reviewHash);

  const none = await as(ann)("POST", "/api/import/review", reviewBody(first, { fundedStatuses: [] }));
  assert.equal(none.data.counts.created, 0);
  assert.equal(none.data.counts.skipped, 3);

  const dropped = await as(ann)("POST", "/api/import/review", reviewBody(first, { mapping: { ...first.mapping, status: -1, closingDate: -1 } }));
  assert.equal(dropped.data.everyRowFunded, true);
  assert.equal(dropped.data.statuses, null);
  assert.equal(dropped.data.counts.created, 3);

  const onlyStatus = await as(ann)("POST", "/api/import/review", reviewBody(first, { mapping: { ...first.mapping, closingDate: -1 } }));
  assert.equal(onlyStatus.data.everyRowFunded, false);
  assert.equal(clientCount(), 0);
});

test("a mapped closing date is required of every row; unmapped, none is", async () => {
  const noDate = [...PAT];
  noDate[11] = "";
  const csv = Buffer.from(csvOf(ARIVE, [JOHN, noDate]));
  const { data } = await uploadAs(ann, csv);
  assert.deepStrictEqual(data.results.map((r) => [r.row, r.outcome, r.reason]), [[2, "created", null], [3, "skipped", "not funded yet"]]);

  const unmapped = await as(ann)("POST", "/api/import/review", reviewBody(data, { mapping: { ...data.mapping, closingDate: -1 } }));
  assert.equal(unmapped.data.counts.created, 2);
});

test("a closing date with a time of day is read as that day; one that cannot be read says so", async () => {
  const withTime = [...JOHN];
  withTime[11] = "3/14/2024 0:00";
  const tbd = [...PAT];
  tbd[11] = "TBD";
  const { data } = await uploadAs(ann, Buffer.from(csvOf(ARIVE, [withTime, tbd])));
  assert.deepStrictEqual(data.results.map((r) => [r.row, r.outcome, r.reason]), [[2, "created", null], [3, "skipped", "closing date not readable"]]);
});

// ── confirm ─────────────────────────────────────────────────────────────────

test("confirm writes what the review showed; the same confirm again is all unchanged", async () => {
  const { data: review } = await uploadAs(ann, ARIVE_CSV);
  const body = reviewBody(review, { reviewHash: review.reviewHash });

  const first = await as(ann)("POST", "/api/import/confirm", body);
  assert.equal(first.status, 200);
  assert.equal(first.data.success, true);
  assert.deepStrictEqual(first.data.counts, review.counts);
  assert.deepStrictEqual(first.data.results, review.results);
  assert.equal(clientCount(), 2);
  // John's row named lou@a.test, so he lands in Lou's book; Pat's row named nobody, so hers is the broker's.
  assert.equal(db.prepare("SELECT user_id FROM clients WHERE name = 'John Smith'").get().user_id, lou);
  assert.equal(db.prepare("SELECT user_id FROM clients WHERE name = 'Pat Kim'").get().user_id, ann);

  // The review is stale now (those rows are no longer new), so the old hash is refused and the fresh review says "unchanged".
  const stale = await as(ann)("POST", "/api/import/confirm", body);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.review.counts.unchanged, 2);
  const second = await as(ann)("POST", "/api/import/confirm", { ...body, reviewHash: stale.data.review.reviewHash });
  assert.equal(second.status, 200);
  assert.equal(second.data.counts.unchanged, 2);
  assert.equal(second.data.counts.created, 0);
  assert.equal(clientCount(), 2);
});

test("confirm answers 409 with a fresh review when something changed, and writes nothing", async () => {
  const { data: review } = await uploadAs(ann, ARIVE_CSV);
  // Someone adds John Smith by hand after the review was shown.
  db.prepare("INSERT INTO clients (org_id, user_id, name, email, current_rate, loan_balance, property_value) VALUES (?, ?, 'John Smith', 'john@smith.test', 7.1, 300000, 500000)")
    .run(orgA, lia);

  const res = await as(ann)("POST", "/api/import/confirm", reviewBody(review, { reviewHash: review.reviewHash }));
  assert.equal(res.status, 409);
  assert.equal(res.data.success, false);
  assert.equal(res.data.error, "Something changed since the review. Check it again.");
  assert.equal(res.data.review.success, true);
  assert.notEqual(res.data.review.reviewHash, review.reviewHash);
  assert.notEqual(res.data.review.results[0].outcome, "created", "John now matches the hand-added client");
  assert.ok(res.data.review.fileData, "the fresh review carries the file so the page can swap it in");
  // Pat would have been created by the run that was rolled back, and John's client updated: neither stuck.
  assert.equal(clientCount(), 1);
  assert.equal(db.prepare("SELECT current_rate, user_id FROM clients").get().current_rate, 7.1);
  assert.equal(db.prepare("SELECT user_id FROM clients").get().user_id, lia);

  // The fresh review's own hash is accepted.
  const retry = await as(ann)("POST", "/api/import/confirm", reviewBody(res.data.review, { reviewHash: res.data.review.reviewHash }));
  assert.equal(retry.status, 200);
  assert.equal(clientCount(), 2);
});

// ── parsing ─────────────────────────────────────────────────────────────────

test("a CSV keeps a loan number's leading zeros; an .xlsx with serial dates and fraction rates reads the same", async () => {
  const { data } = await uploadAs(ann, ARIVE_CSV);
  await as(ann)("POST", "/api/import/confirm", reviewBody(data, { reviewHash: data.reviewHash }));
  assert.equal(db.prepare("SELECT loan_number FROM clients WHERE name = 'Pat Kim'").get().loan_number, "000123");

  db.prepare("DELETE FROM clients").run();
  const sheet = XLSX.utils.aoa_to_sheet([ARIVE.slice(0, 17), [
    "X900", "Xena", "Quinn", "xena@quinn.test", "5551230000", 0.065, 400000, 360, "Fixed", 520000, "", 45365, "Funded", "Refinance", 45400, 742, "",
  ]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Loans");
  const xlsx = XLSX.write(book, { type: "buffer", bookType: "xlsx" });

  const up = await uploadAs(ann, xlsx, { name: "loans.xlsx", type: "application/octet-stream" });
  assert.equal(up.status, 200);
  assert.equal(up.data.mapping.closingDate, 11);
  assert.equal(up.data.counts.created, 1);
  const confirm = await as(ann)("POST", "/api/import/confirm", reviewBody(up.data, { reviewHash: up.data.reviewHash }));
  assert.equal(confirm.status, 200);
  const stored = db.prepare("SELECT close_date, current_rate FROM clients WHERE name = 'Xena Quinn'").get();
  assert.deepStrictEqual(stored, { close_date: "2024-03-14", current_rate: 6.5 });
});

test("a CSV in UTF-8 keeps its accents, and blank lines are dropped but the row numbers stay the file's lines", async () => {
  const joseRow = [...JOHN];
  joseRow.splice(0, 4, "A101", "José", "Álvarez", "jose@alvarez.test");
  const line = (cells) => cells.map(csvCell).join(",");
  const csv = "\uFEFF" + [line(ARIVE), line(JOHN), "", ",,,,,,,,,,,,,,,,,", line(joseRow)].join("\r\n") + "\r\n";
  const { data } = await uploadAs(ann, Buffer.from(csv));
  assert.equal(data.totalRows, 2);
  assert.deepStrictEqual(data.results.map((r) => [r.row, r.name]), [[2, "John Smith"], [5, "José Álvarez"]]);
});

test("a UTF-8 CSV with no byte-order mark keeps its accents and its leading zeros; a Windows-1252 one still imports", async () => {
  const pena = [...PAT];
  pena.splice(1, 2, "José", "Peña");
  const csv = Buffer.from(csvOf(ARIVE, [pena]), "utf8");
  assert.notEqual(csv[0], 0xef, "no BOM");
  const { data } = await uploadAs(ann, csv);
  assert.deepStrictEqual(data.results.map((r) => [r.row, r.outcome, r.name]), [[2, "created", "José Peña"]]);
  const confirm = await as(ann)("POST", "/api/import/confirm", reviewBody(data, { reviewHash: data.reviewHash }));
  assert.equal(confirm.status, 200);
  assert.deepStrictEqual(db.prepare("SELECT name, loan_number FROM clients").all(), [{ name: "José Peña", loan_number: "000123" }]);

  // é saved by an older Excel as the single byte 0xE9 is not UTF-8, so the file is read the way it was before
  db.prepare("DELETE FROM clients").run();
  const legacy = Buffer.from(csvOf(ARIVE, [pena]), "latin1");
  assert.ok(legacy.includes(0xe9) && !legacy.includes(Buffer.from("é", "utf8")));
  const old = await uploadAs(ann, legacy);
  assert.equal(old.status, 200);
  assert.deepStrictEqual(old.data.results.map((r) => [r.row, r.outcome, r.name]), [[2, "created", "José Peña"]]);
  const oldConfirm = await as(ann)("POST", "/api/import/confirm", reviewBody(old.data, { reviewHash: old.data.reviewHash }));
  assert.equal(oldConfirm.status, 200);
  assert.equal(db.prepare("SELECT loan_number FROM clients").get().loan_number, "000123");
});

// ── limits and bad requests ─────────────────────────────────────────────────

test("limits: empty, over 5,000 rows, over 10 MB, unreadable", async () => {
  const expectError = (res, message) => {
    assert.equal(res.status, 400);
    assert.deepStrictEqual(res.data, { success: false, error: message });
  };

  expectError(await uploadAs(ann, Buffer.alloc(0)), "File appears to be empty");
  expectError(await uploadAs(ann, Buffer.from(csvOf(ARIVE, []))), "File appears to be empty");
  expectError(await uploadAs(ann, Buffer.from(csvOf(ARIVE, [Array(18).fill("")]))), "File appears to be empty");

  const names = (n) => Buffer.from("Name\r\n" + Array.from({ length: n }, (_, i) => `Person ${i}`).join("\r\n") + "\r\n");
  expectError(await uploadAs(ann, names(5001)), "This file has more than 5,000 rows. Split it and import each part.");
  const atLimit = await uploadAs(ann, names(5000));
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.data.totalRows, 5000);

  expectError(await uploadAs(ann, Buffer.alloc(10 * 1024 * 1024 + 1, "a")), "The file is over 10 MB.");
  const big = await as(ann)("POST", "/api/import/review", { fileData: Buffer.alloc(10 * 1024 * 1024 + 1, "a").toString("base64"), mapping: {} });
  expectError(big, "The file is over 10 MB.");

  const unreadable = "Could not read that file. Save it as .csv or .xlsx and try again.";
  expectError(await uploadAs(ann, Buffer.from("PK\x03\x04 this is not really a workbook, just bytes")), unreadable);
  expectError(await as(ann)("POST", "/api/import/review", { fileData: Buffer.from("PK\x03\x04 nope").toString("base64"), mapping: {} }), unreadable);
  assert.equal(clientCount(), 0);
});

test("bad requests: no file, no file data, no mapping, no review hash", async () => {
  const nothing = await as(ann)("POST", "/api/import/preview", new FormData());
  assert.deepStrictEqual([nothing.status, nothing.data], [400, { success: false, error: "No file uploaded" }]);

  const fileData = ARIVE_CSV.toString("base64");
  const missing = { success: false, error: "Missing import data" };
  for (const [route, body] of [
    ["review", {}],
    ["review", { fileData }],
    ["review", { fileData, mapping: [] }],
    ["review", { fileData: 12, mapping: {} }],
    ["confirm", { fileData, mapping: {} }],
    ["confirm", { fileData, mapping: {}, reviewHash: 5 }],
    ["confirm", { mapping: {}, reviewHash: "abc" }],
  ]) {
    const res = await as(ann)("POST", `/api/import/${route}`, body);
    assert.deepStrictEqual([res.status, res.data], [400, missing], `${route} ${JSON.stringify(Object.keys(body))}`);
  }
});

test("a database error answers 500 and logs only the error's name, never a row or the message", async () => {
  const realPrepare = db.prepare;
  const boom = new Error("John Smith 123-45-6789 secret message");
  boom.name = "SqliteBoom";
  let res;
  const calls = await logged(async () => {
    db.prepare = function (sql) {
      if (/INSERT INTO clients/.test(sql)) throw boom;
      return realPrepare.call(this, sql);
    };
    try { res = await uploadAs(ann, ARIVE_CSV); } finally { delete db.prepare; }
  });
  assert.deepStrictEqual([res.status, res.data], [500, { success: false, error: "Import failed" }]);
  const text = JSON.stringify(calls);
  assert.ok(text.includes("SqliteBoom"));
  assert.ok(!/John|secret|123-45/.test(text));
  assert.equal(db.prepare, realPrepare);
});
