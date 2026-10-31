"use strict";
const express = require("express");
const db      = require("../db");
const { requireAuth } = require("../middleware/auth");
const followups = require("../lib/assistant/followups");   // called as followups.x(): tests can swap one

const router = express.Router();
router.use(requireAuth);

function toClient(row) {
  return {
    id: row.id, orgId: row.org_id, userId: row.user_id,
    name: row.name, email: row.email, phone: row.phone,
    loanType: row.loan_type, currentRate: row.current_rate,
    loanBalance: row.loan_balance, propertyValue: row.property_value,
    closeDate: row.close_date, creditScore: row.credit_score,
    notes: row.notes, lastContact: row.last_contact,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
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
    INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes)
    VALUES (@org_id, @user_id, @name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes)
  `).run({
    org_id: user.org_id, user_id: user.id,
    name: input.name.trim(), email: (input.email||"").trim(),
    phone: (input.phone||"").trim(), loan_type: input.loanType,
    current_rate: parseFloat(input.currentRate), loan_balance: parseFloat(input.loanBalance),
    property_value: parseFloat(input.propertyValue), close_date: input.closeDate||"",
    credit_score: parseInt(input.creditScore)||700, notes: (input.notes||"").trim(),
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

// GET /api/clients — brokers get all org clients, LOs get their own
router.get("/", (req, res) => {
  try {
    const rows = req.user.role === "broker"
      ? db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(req.user.org_id)
      : db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id);
    res.json({ success: true, clients: rows.map(toClient) });
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
    db.prepare(`
      UPDATE clients SET name=@name, email=@email, phone=@phone, loan_type=@loan_type,
        current_rate=@current_rate, loan_balance=@loan_balance, property_value=@property_value,
        close_date=@close_date, credit_score=@credit_score, notes=@notes, updated_at=datetime('now')
      WHERE id=@id
    `).run({
      id, name: req.body.name.trim(), email: (req.body.email||"").trim(),
      phone: (req.body.phone||"").trim(), loan_type: req.body.loanType,
      current_rate: parseFloat(req.body.currentRate), loan_balance: parseFloat(req.body.loanBalance),
      property_value: parseFloat(req.body.propertyValue), close_date: req.body.closeDate||"",
      credit_score: parseInt(req.body.creditScore)||700, notes: (req.body.notes||"").trim(),
    });
    const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    res.json({ success: true, client: toClient(row) });
  } catch (err) {
    console.error("PUT /api/clients/:id:", err.message);
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

// An instant as followups.js keeps them: SQLite UTC text, "YYYY-MM-DD HH:MM:SS".
const sqliteUtc = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

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
    res.json({ success: true, client: result.client });
  } catch (err) {
    console.error("POST /api/clients/:id/contact:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

module.exports = Object.assign(router, { validateClient, toClient, createClientForUser, logContactForUser, clientInReach });
