"use strict";
// The broker's client-file import: upload a CSV or Excel export (ARIVE, Calyx Point, a CRM), look at exactly what it will do, then
// confirm. Broker only (R1): the import matches against the whole company's clients and sends loans to loan officers, so a loan
// officer is refused with a 403. Importing never contacts anyone (A1).
//   POST /api/import/preview  multipart "file"   -> a Review of the file with the column mapping this server guessed
//   POST /api/import/review   { fileData, mimetype, mapping, fundedStatuses }
//                                                -> a Review with the broker's column picks and ticked statuses
//   POST /api/import/confirm  { fileData, mimetype, mapping, fundedStatuses, reviewHash }
//                                                -> 200 { success, results, counts } once written; 409 { success: false, error,
//                                                   review } when the rows now come out differently from the review, and then
//                                                   nothing is written
// A Review is { success, fields, headers, mapping, statuses, everyRowFunded, totalRows, results, counts, reviewHash, fileData,
// mimetype }: `headers` are the columns a broker may pick (never a protected one), `statuses` the loan statuses in the file with
// whether each counts as funded (null when no status column is picked), and `fileData` the file in base64 so the page can send
// it back with each change instead of uploading it again. Nothing is stored between calls.
// Review = import (R6): both run ingest(); the review rolls back, the confirm does not, and confirm checks the review's hash
// inside its own transaction, so what is written is exactly what the broker saw.
// Errors are { success: false, error }: 400 (empty file, over 5,000 rows, over 10 MB, unreadable, missing data), 403, 409, 500
// ("Import failed"). A failure logs only the error's name, never a row or the message.
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../db");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { FIELDS, detectMapping, offeredHeaders, cleanMapping, readFields } = require("../lib/intake/fields");
const { ingest } = require("../lib/intake/ingest");
// What counts as funded until the broker ticks their own statuses (shared with the ARIVE feed's dead statuses).
const { looksFunded } = require("../lib/intake/normalize");

const router = express.Router();
router.use(requireAuth, requireBroker);

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const BLANK_STATUS = "(blank)";

const MSG = Object.freeze({
  noFile: "No file uploaded",
  missing: "Missing import data",
  empty: "File appears to be empty",
  tooMany: "This file has more than 5,000 rows. Split it and import each part.",
  tooBig: "The file is over 10 MB.",
  unreadable: "Could not read that file. Save it as .csv or .xlsx and try again.",
  changed: "Something changed since the review. Check it again.",
  failed: "Import failed",
});

const uploadOne = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } }).single("file");
// The browser sends the file's base64 back inside the JSON body, so the body can be a third bigger than the file.
const jsonBody = express.json({ limit: "20mb" });

// An answer the broker should see, as opposed to a bug: it carries the status to send.
class Refusal extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function fail(res, err) {
  if (err instanceof Refusal) return res.status(err.status).json({ success: false, error: err.message });
  console.error("Import failed:", err && err.name);
  return res.status(500).json({ success: false, error: MSG.failed });
}

// "today" is the UTC date and "nowUtc" is SQLite's UTC text, both read from one instant so a whole request agrees (A4).
function clock() {
  const iso = new Date().toISOString();
  return { today: iso.slice(0, 10), nowUtc: `${iso.slice(0, 10)} ${iso.slice(11, 19)}` };
}

// A cell as text: a string as it is, a finite number as its digits, anything else as nothing.
const cellText = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

// A workbook is told by its first bytes (an .xlsx is a zip, an old .xls an OLE file), never by the browser's mimetype.
function isWorkbook(b) {
  return (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) || (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0);
}

// A CSV's text when its bytes are valid UTF-8 (a byte-order mark, if any, is dropped), else null. Without a BOM the xlsx reader
// takes the bytes for Windows-1252, so "José" would come out "JosÃ©" and never match the client again.
function utf8Text(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

// The first sheet as { headers, rows: [{ row, cells }] }. `row` is the file's own line number (the header is 1), kept when blank
// lines are dropped. A CSV is read as plain text (R8), so a loan number like 000123 keeps its zeros and a date stays as typed:
// as UTF-8 when it is valid UTF-8, else as the bytes they were (an older Excel's Windows-1252 file).
function readSheet(buffer) {
  if (buffer.length === 0) throw new Refusal(MSG.empty);
  if (buffer.length > MAX_BYTES) throw new Refusal(MSG.tooBig);
  let table;
  try {
    let wb;
    if (isWorkbook(buffer)) {
      wb = XLSX.read(buffer, { type: "buffer" });
    } else {
      const text = utf8Text(buffer);
      wb = text === null ? XLSX.read(buffer, { type: "buffer", raw: true }) : XLSX.read(text, { type: "string", raw: true });
    }
    table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  } catch {
    throw new Refusal(MSG.unreadable);
  }
  const rows = [];
  table.slice(1).forEach((cells, i) => {
    if (cells.some((c) => String(c ?? "").trim() !== "")) rows.push({ row: i + 2, cells });
  });
  if (rows.length === 0) throw new Refusal(MSG.empty);
  if (rows.length > MAX_ROWS) throw new Refusal(MSG.tooMany);
  return { headers: (table[0] || []).map(cellText), rows };
}

// The rows as ingest() items, and the statuses they showed. With a status column picked, a row whose status is not ticked as
// funded is turned away ("not funded") before it is read (A4). `fundedStatuses` is the ticked values; omitted, the defaults apply.
function planRows(sheet, mapping, fundedStatuses) {
  const ticked = Array.isArray(fundedStatuses)
    ? new Set(fundedStatuses.filter((s) => typeof s === "string").map((s) => s.trim().toLowerCase()))
    : null;
  const countsAsFunded = (value) => (ticked ? ticked.has(value) : looksFunded(value));

  const seen = new Map();
  const items = sheet.rows.map(({ row, cells }) => {
    const fields = readFields(cells, mapping);
    if (mapping.status < 0) return { row, fields };
    const spelling = cellText(cells[mapping.status]).trim();
    const value = spelling.toLowerCase();
    if (!seen.has(value)) seen.set(value, { value, label: spelling || BLANK_STATUS, count: 0, funded: countsAsFunded(value) });
    const status = seen.get(value);
    status.count += 1;
    return status.funded ? { row, fields } : { row, fields, skip: "not funded" };
  });
  return { items, statuses: mapping.status >= 0 ? [...seen.values()] : null };
}

// Everything one request works on. `mapping` is the detected one for a preview, and the broker's, cleaned, otherwise: readFields
// trusts its mapping, so cleanMapping is what keeps a protected column (an SSN) unreadable whatever the browser sends.
function jobOf({ actor, buffer, mimetype, mapping, fundedStatuses }) {
  const sheet = readSheet(buffer);
  return {
    actor, buffer, sheet, fundedStatuses, ...clock(),
    mimetype: typeof mimetype === "string" ? mimetype : "",
    mapping: mapping === undefined ? detectMapping(sheet.headers) : cleanMapping(mapping, sheet.headers),
  };
}

// The job from a /review or /confirm body.
function jobFromBody(req, { needsHash = false } = {}) {
  const { fileData, mimetype, mapping, fundedStatuses, reviewHash } = req.body || {};
  const mappingOk = mapping !== null && typeof mapping === "object" && !Array.isArray(mapping);
  if (typeof fileData !== "string" || fileData === "" || !mappingOk || (needsHash && typeof reviewHash !== "string")) {
    throw new Refusal(MSG.missing);
  }
  return jobOf({ actor: req.user, buffer: Buffer.from(fileData, "base64"), mimetype, mapping, fundedStatuses });
}

const runOf = (job, plan, dryRun) => ingest(db, {
  actor: job.actor, source: "import", items: plan.items, today: job.today, nowUtc: job.nowUtc,
  // A mapped closing date is asked of every row; the oldest-first order in ingest() relies on it (undated rows are skipped).
  requireClosingDate: job.mapping.closingDate >= 0, dryRun,
});

// The review: a dry run of the import, which writes nothing.
function reviewOf(job, plan) {
  const run = runOf(job, plan, true);
  return {
    success: true,
    fields: FIELDS,
    headers: offeredHeaders(job.sheet.headers),
    mapping: job.mapping,
    statuses: plan.statuses,
    everyRowFunded: job.mapping.status < 0 && job.mapping.closingDate < 0,
    totalRows: job.sheet.rows.length,
    results: run.results,
    counts: run.counts,
    reviewHash: run.reviewHash,
    fileData: job.buffer.toString("base64"),
    mimetype: job.mimetype,
  };
}

const review = (job) => reviewOf(job, planRows(job.sheet, job.mapping, job.fundedStatuses));

router.post("/preview", (req, res) => {
  uploadOne(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ success: false, error: MSG.tooBig });
      console.error("Import upload failed:", err.name);
      return res.status(400).json({ success: false, error: MSG.unreadable });
    }
    if (!req.file) return res.status(400).json({ success: false, error: MSG.noFile });
    try {
      res.json(review(jobOf({ actor: req.user, buffer: req.file.buffer, mimetype: req.file.mimetype })));
    } catch (e) {
      fail(res, e);
    }
  });
});

router.post("/review", jsonBody, (req, res) => {
  try {
    res.json(review(jobFromBody(req)));
  } catch (e) {
    fail(res, e);
  }
});

router.post("/confirm", jsonBody, (req, res) => {
  try {
    const job = jobFromBody(req, { needsHash: true });
    const plan = planRows(job.sheet, job.mapping, job.fundedStatuses);

    // R6, atomically: the real run happens inside this transaction and is thrown away (rolled back) if its hash is not the
    // one the broker was shown. ingest()'s own transaction nests inside this one as a savepoint. Checking first and writing
    // after would leave a gap for something to change in.
    const changed = new Error("the review no longer matches");
    const apply = db.transaction(() => {
      const run = runOf(job, plan, false);
      if (run.reviewHash !== req.body.reviewHash) throw changed;
      return run;
    });
    let run;
    try {
      run = apply.immediate();
    } catch (e) {
      if (e !== changed) throw e;
      return res.status(409).json({ success: false, error: MSG.changed, review: reviewOf(job, plan) });
    }
    res.json({ success: true, results: run.results, counts: run.counts });
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
