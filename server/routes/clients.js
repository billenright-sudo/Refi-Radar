"use strict";
const express = require("express");
const db      = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireAccess } = require("../middleware/access");
const followups = require("../lib/assistant/followups");   // called as followups.x(): tests can swap one
const { HAND_KEPT, readMarks, writeMarks } = require("../lib/intake/handEdits");
const targets = require("../lib/targets");
const upgradeAlerts = require("../lib/upgradeAlerts");

// An instant as followups.js keeps them: SQLite UTC text, "YYYY-MM-DD HH:MM:SS".
const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const router = express.Router();
router.use(requireAuth, requireAccess);

function toClient(row) {
  return {
    id: row.id, orgId: row.org_id, userId: row.user_id,
    name: row.name, email: row.email, phone: row.phone,
    loanType: row.loan_type, currentRate: row.current_rate,
    loanBalance: row.loan_balance, propertyValue: row.property_value,
    closeDate: row.close_date, creditScore: row.credit_score,
    notes: row.notes, lastContact: row.last_contact, doNotEmail: row.do_not_email === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
    loanProgram: row.loan_program, monthlyMi: row.monthly_mi, originalAmount: row.original_amount,
    originalValue: row.original_value, propertyZip: row.property_zip, occupancy: row.occupancy,
    balanceAsOf: row.balance_as_of, valueAsOf: row.value_as_of, creditScoreKnown: row.credit_score_known === 1,
  };
}

const PROGRAMS = ["conventional", "fha", "va", "usda", "jumbo"];
const OCCUPANCIES = ["primary", "second_home", "investment"];
const blank = (v) => v == null || String(v).trim() === "";
// A new optional number: null when blank, NaN when not a number.
const optNumber = (v) => (blank(v) ? null : Number(String(v).trim()));
// Today as the server's UTC date, "YYYY-MM-DD" (the as-of dates).
const utcToday = () => new Date().toISOString().slice(0, 10);
// The new optional fields of a valid body as column values: '' for blank text, NULL for a blank number.
// With `existing` (a PUT), a key absent from the body keeps the stored value (a page opened before this shipped must not wipe
// imported data); an explicit "" or null clears it.
function upgradeValues(body, existing) {
  const keep = (key, col, make) => (existing && body[key] === undefined ? existing[col] : make(body[key]));
  const text = (v) => (blank(v) ? "" : String(v).trim());
  return {
    loan_program: keep("loanProgram", "loan_program", text),
    monthly_mi: keep("monthlyMi", "monthly_mi", optNumber),
    original_amount: keep("originalAmount", "original_amount", optNumber),
    original_value: keep("originalValue", "original_value", optNumber),
    property_zip: keep("propertyZip", "property_zip", text),
    occupancy: keep("occupancy", "occupancy", text),
  };
}
// credit_score_known: 1 for a typed, parseable score (a 0 is stored as the 700 default, so it is not one).
const creditKnown = (raw) => (parseInt(raw) ? 1 : 0);

// Clients the way the screens get them, from `rows` (raw clients rows, in their order). The check runs first (one FRED
// observation, once; a check that fails is logged and the stored target state is shown), then only the rows it wrote are read
// again (usually none), so a hit it records shows at once (one of them deleted in between is skipped). Each answer carries
// `target` (a View, or null) and `upgrades` (the upgrade View of lib/upgradeAlerts.js).
function presentClients(db, user, rows, nowMs = Date.now()) {
  const check = targets.safeCheck(db, user.org_id, nowMs);
  const upCheck = upgradeAlerts.safeCheckUpgrades(db, user.org_id, nowMs);
  if (!rows.length) return [];
  const given = new Set(rows.map((r) => r.id));
  const stale = new Set((check ? check.patchedIds : []).filter((id) => given.has(id)));
  const reread = new Map();
  if (stale.size) {
    const found = db.prepare("SELECT * FROM clients WHERE id IN (SELECT value FROM json_each(?))").all(targets.idList([...stale]));
    for (const r of found) reread.set(r.id, r);
  }
  const fresh = rows.map((r) => (stale.has(r.id) ? reread.get(r.id) : r)).filter(Boolean);
  const views = targets.viewsFor(db, fresh, user.id);
  const upgrades = upgradeAlerts.safeUpgradeViewsFor(db, fresh, upCheck, nowMs);
  return fresh.map((row) => ({ ...toClient(row), target: views.get(row.id) || null, upgrades: upgrades.get(row.id) || null }));
}

function validateClient(body) {
  const errors = {};
  if (!body.name || !String(body.name).trim()) errors.name = "Name is required";
  const rate = parseFloat(body.currentRate);
  if (isNaN(rate) || rate < 0 || rate > 30) errors.currentRate = "Valid rate required (0–30%)";
  const bal = parseFloat(body.loanBalance);
  if (isNaN(bal) || bal <= 0) errors.loanBalance = "Valid balance required";
  const val = parseFloat(body.propertyValue);
  if (isNaN(val) || val <= 0) errors.propertyValue = "Valid property value required";
  if (!["30yr_fixed","15yr_fixed","5_1_arm"].includes(body.loanType)) errors.loanType = "Invalid loan type";
  if (!blank(body.loanProgram) && !PROGRAMS.includes(body.loanProgram)) errors.loanProgram = "Invalid loan program";
  const mi = optNumber(body.monthlyMi);
  if (mi != null && (isNaN(mi) || mi < 0 || mi > 5000)) errors.monthlyMi = "Mortgage insurance is a monthly amount from 0 to 5,000";
  const oa = optNumber(body.originalAmount);
  if (oa != null && (isNaN(oa) || oa <= 0)) errors.originalAmount = "Valid original loan amount required";
  const ov = optNumber(body.originalValue);
  if (ov != null && (isNaN(ov) || ov <= 0)) errors.originalValue = "Valid original home value required";
  if (!blank(body.propertyZip) && !/^\d{5}$/.test(String(body.propertyZip).trim())) errors.propertyZip = "ZIP is 5 digits";
  if (!blank(body.occupancy) && !OCCUPANCIES.includes(body.occupancy)) errors.occupancy = "Invalid occupancy";
  return errors;
}

// The two writes the REST routes and the assistant's /confirm share. `user` is the authenticated
// req.user row: org_id / user_id come from it and from nothing else (a body's own org_id, user_id or id
// is never read). Neither helper sends a response; they return { errors } | { client } and
// { status, client } | { status, error }.

// Validates `body` and inserts a client owned by `user`. Throws only on a database error.
function createClientForUser(db, user, body) {
  const input = body && typeof body === "object" ? body : {};
  const errors = validateClient(input);
  if (Object.keys(errors).length) return { errors };
  const info = db.prepare(`
    INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes, do_not_email,
      loan_program, monthly_mi, original_amount, original_value, property_zip, occupancy, balance_as_of, value_as_of, credit_score_known)
    VALUES (@org_id, @user_id, @name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes, @do_not_email,
      @loan_program, @monthly_mi, @original_amount, @original_value, @property_zip, @occupancy, @balance_as_of, @value_as_of, @credit_score_known)
  `).run({
    ...upgradeValues(input), balance_as_of: utcToday(), value_as_of: utcToday(), credit_score_known: creditKnown(input.creditScore),
    org_id: user.org_id, user_id: user.id,
    name: input.name.trim(), email: (input.email||"").trim(),
    phone: (input.phone||"").trim(), loan_type: input.loanType,
    current_rate: parseFloat(input.currentRate), loan_balance: parseFloat(input.loanBalance),
    property_value: parseFloat(input.propertyValue), close_date: input.closeDate||"",
    credit_score: parseInt(input.creditScore)||700, notes: (input.notes||"").trim(),
    do_not_email: input.doNotEmail === true ? 1 : 0,
  });
  const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
  return { client: toClient(row) };
}

// Whether `user` may act on client `id`: a broker on any client in their org, a loan officer on their own only. `id` must be a
// positive integer. -> { status: 404 | 403, error } | { status: 200, row } (the raw clients row). Throws only on a database error.
function clientInReach(db, user, id) {
  if (!Number.isInteger(id) || id <= 0) return { status: 404, error: "Client not found" };
  const existing = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!existing) return { status: 404, error: "Client not found" };
  if (user.role === "lo" && existing.user_id !== user.id) return { status: 403, error: "Access denied" };
  if (existing.org_id !== user.org_id) return { status: 403, error: "Access denied" };
  return { status: 200, row: existing };
}

// Sets last_contact = now on client `id`, for a user who may act on it (clientInReach). Throws only on a database error.
function logContactForUser(db, user, id) {
  const reach = clientInReach(db, user, id);
  if (reach.status !== 200) return reach;
  db.prepare("UPDATE clients SET last_contact = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  return { status: 200, client: toClient(db.prepare("SELECT * FROM clients WHERE id = ?").get(id)) };
}

const TARGET_COLUMNS = ["target_rate", "target_set_by", "target_set_at", "target_reached_on", "target_reached_rate",
  "target_reached_at", "target_announced_on", "target_checked_on", "target_checked_rate"];
// The client fields the target check's estimate is priced on (lib/targets estimateRate).
const PRICED_COLUMNS = ["loan_type", "current_rate", "loan_balance", "property_value", "credit_score"];

// Sets (a number), keeps (the same value) or clears (null) client `id`'s target rate, for a user who may act on it (clientInReach).
// `raw` goes through parseTarget, and a target has to be below the client's current rate. A new value starts over: who and when, and
// the hit and the check (its date and estimate) forgotten, so the check re-arms it against the latest observation. Throws only on a
// database error.
// -> { status: 200, client, receipt: { id, name, targetRate } } | { status: 400 | 403 | 404, error }
function setTargetForUser(db, user, id, raw, nowMs = Date.now()) {
  const reach = clientInReach(db, user, id);
  if (reach.status !== 200) return reach;
  const row = reach.row;
  const parsed = targets.parseTarget(raw);
  if (parsed.error) return { status: 400, error: parsed.error };
  const rate = parsed.rate;
  if (rate != null && rate >= targets.round3(row.current_rate)) return { status: 400, error: targets.notBelowError(row.name, row.current_rate) };
  const same = rate != null && row.target_rate != null && targets.round3(rate) === targets.round3(row.target_rate);
  if (!same) {
    if (rate == null) {
      db.prepare(`UPDATE clients SET ${TARGET_COLUMNS.map((c) => `${c} = NULL`).join(", ")} WHERE id = ?`).run(id);
    } else {
      db.prepare(`UPDATE clients SET target_rate = ?, target_set_by = ?, target_set_at = ?, target_reached_on = NULL, target_reached_rate = NULL,
        target_reached_at = NULL, target_announced_on = NULL, target_checked_on = NULL, target_checked_rate = NULL WHERE id = ?`)
        .run(rate, user.id, sqliteUtc(nowMs), id);
    }
  }
  const saved = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  return { status: 200, client: presentClients(db, user, [saved], nowMs)[0], receipt: { id, name: row.name, targetRate: rate } };
}

// GET /api/clients — brokers get all org clients, LOs get their own
router.get("/", (req, res) => {
  try {
    const rows = req.user.role === "broker"
      ? db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(req.user.org_id)
      : db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id);
    res.json({ success: true, clients: presentClients(db, req.user, rows) });
  } catch (err) {
    console.error("GET /api/clients:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// POST /api/clients — create, assigned to calling user
router.post("/", (req, res) => {
  try {
    const result = createClientForUser(db, req.user, req.body);
    if (result.errors) return res.status(400).json({ success: false, errors: result.errors });
    res.status(201).json({ success: true, client: result.client });
  } catch (err) {
    console.error("POST /api/clients:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// PUT /api/clients/:id — brokers can edit any org client; LOs only their own
router.put("/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ success: false, error: "Client not found" });
  if (req.user.role === "lo" && existing.user_id !== req.user.id) return res.status(403).json({ success: false, error: "Access denied" });
  if (existing.org_id !== req.user.org_id) return res.status(403).json({ success: false, error: "Access denied" });

  const errors = validateClient(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });
  try {
    const balanceChanged = parseFloat(req.body.loanBalance) !== existing.loan_balance;
    const valueChanged = parseFloat(req.body.propertyValue) !== existing.property_value;
    const values = {
      id, name: req.body.name.trim(), email: (req.body.email||"").trim(),
      phone: (req.body.phone||"").trim(), loan_type: req.body.loanType,
      current_rate: parseFloat(req.body.currentRate), loan_balance: parseFloat(req.body.loanBalance),
      property_value: parseFloat(req.body.propertyValue), close_date: req.body.closeDate||"",
      credit_score: parseInt(req.body.creditScore)||700, notes: (req.body.notes||"").trim(),
      // A save that doesn't say (an older page) keeps the flag as it was; only true or false changes it.
      do_not_email: typeof req.body.doNotEmail === "boolean" ? (req.body.doNotEmail ? 1 : 0) : existing.do_not_email,
      ...upgradeValues(req.body, existing),
      credit_score_known: creditKnown(req.body.creditScore),
      // The as-of dates move to today only when their figure changed.
      balance_as_of: balanceChanged ? utcToday() : existing.balance_as_of,
      value_as_of: valueChanged ? utcToday() : existing.value_as_of,
    };
    // A rate, property value or credit score this save changes is marked as edited by hand, so the import keeps it.
    const marks = readMarks(existing.edited_by_hand);
    for (const col of HAND_KEPT) if (values[col] !== existing[col]) marks.add(col);
    // A save that changes what the estimate is priced on forgets the target check (its day and estimate), so this answer's check
    // runs again on the same observation and the target line matches the loan as saved. A stored hit stays for the check's own
    // rules to keep, re-arm or clear.
    const repriced = PRICED_COLUMNS.some((col) => values[col] !== existing[col]);
    db.prepare(`
      UPDATE clients SET name=@name, email=@email, phone=@phone, loan_type=@loan_type,
        current_rate=@current_rate, loan_balance=@loan_balance, property_value=@property_value,
        close_date=@close_date, credit_score=@credit_score, credit_score_known=@credit_score_known, notes=@notes,
        loan_program=@loan_program, monthly_mi=@monthly_mi, original_amount=@original_amount, original_value=@original_value,
        property_zip=@property_zip, occupancy=@occupancy, balance_as_of=@balance_as_of, value_as_of=@value_as_of, do_not_email=@do_not_email, edited_by_hand=@edited_by_hand, updated_at=datetime('now')
        ${repriced ? ", target_checked_on=NULL, target_checked_rate=NULL" : ""}
      WHERE id=@id
    `).run({ ...values, edited_by_hand: writeMarks(marks) });
    const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    res.json({ success: true, client: presentClients(db, req.user, [row])[0] });
  } catch (err) {
    console.error("PUT /api/clients/:id:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// PUT /api/clients/:id/target — body { targetRate }: a number sets the client's target rate, null clears it. A body without the key
// is refused, so a missing key can never clear a target. Broker: any org client; LO: own clients only.
router.put("/:id/target", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!Object.prototype.hasOwnProperty.call(body, "targetRate")) return res.status(400).json({ success: false, error: "targetRate required" });
  try {
    const result = setTargetForUser(db, req.user, parseInt(req.params.id), body.targetRate);
    if (result.status !== 200) return res.status(result.status).json({ success: false, error: result.error });
    res.json({ success: true, client: result.client });
  } catch (err) {
    console.error("PUT /api/clients/:id/target:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// DELETE /api/clients/:id
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ success: false, error: "Client not found" });
  if (req.user.role === "lo" && existing.user_id !== req.user.id) return res.status(403).json({ success: false, error: "Access denied" });
  if (existing.org_id !== req.user.org_id) return res.status(403).json({ success: false, error: "Access denied" });
  try {
    db.prepare("DELETE FROM clients WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/clients/:id:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// GET /api/clients/:id/calls — the calls logged for a client (contact_log), newest first, at most CALLS_SHOWN:
// { success, calls: [{ at, outcome, notes }] } (at: SQLite UTC text; outcome: 'reached' | 'not_reached'). Broker: any org client;
// LO: own clients only (clientInReach's 404 / 403). For the client page only (spec 5.4): the notes are the broker's own words about
// a borrower and never reach the model, so no assistant tool reads this route or these rows.
const CALLS_SHOWN = 50;
router.get("/:id/calls", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const reach = clientInReach(db, req.user, id);
    if (reach.status !== 200) return res.status(reach.status).json({ success: false, error: reach.error });
    const calls = db.prepare("SELECT at, outcome, notes FROM contact_log WHERE client_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(id, CALLS_SHOWN);
    res.json({ success: true, calls });
  } catch (err) {
    console.error("GET /api/clients/:id/calls:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// POST /api/clients/:id/contact — log an outreach (the Sweeps page's Log contact button; the broker's own click is the confirmation).
// Broker: any org client; LO: own clients only. One transaction: last_contact = now, the call in contact_log as reached (no notes),
// and the caller's open follow-ups of that client closed as reached, carry included, so Charlie's next briefing neither lists the
// client nor asks whether they were reached.
router.post("/:id/contact", (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = db.transaction(() => {
      const done = logContactForUser(db, req.user, id);
      if (done.status !== 200) return done;
      const nowUtc = sqliteUtc(Date.now());
      followups.logCall(db, { userId: req.user.id, clientId: id, outcome: "reached", notes: "", nowUtc });
      followups.resolveForClient(db, req.user.id, id, "reached", nowUtc, { includeCarry: true });
      return done;
    })();
    if (result.error) return res.status(result.status).json({ success: false, error: result.error });
    res.json({ success: true, client: presentClients(db, req.user, [db.prepare("SELECT * FROM clients WHERE id = ?").get(id)])[0] });
  } catch (err) {
    console.error("POST /api/clients/:id/contact:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

module.exports = Object.assign(router, { PROGRAMS, OCCUPANCIES, validateClient, toClient, createClientForUser, logContactForUser, clientInReach, presentClients, setTargetForUser });
