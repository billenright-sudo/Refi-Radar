"use strict";
const express = require("express");
const db      = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function toClient(row) {
  return {
    id: row.id, orgId: row.org_id, userId: row.user_id,
    name: row.name, email: row.email, phone: row.phone,
    loanType: row.loan_type, currentRate: row.current_rate,
    loanBalance: row.loan_balance, propertyValue: row.property_value,
    closeDate: row.close_date, creditScore: row.credit_score,
    notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
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
  const errors = validateClient(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });
  try {
    const info = db.prepare(`
      INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes)
      VALUES (@org_id, @user_id, @name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes)
    `).run({
      org_id: req.user.org_id, user_id: req.user.id,
      name: req.body.name.trim(), email: (req.body.email||"").trim(),
      phone: (req.body.phone||"").trim(), loan_type: req.body.loanType,
      current_rate: parseFloat(req.body.currentRate), loan_balance: parseFloat(req.body.loanBalance),
      property_value: parseFloat(req.body.propertyValue), close_date: req.body.closeDate||"",
      credit_score: parseInt(req.body.creditScore)||700, notes: (req.body.notes||"").trim(),
    });
    const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ success: true, client: toClient(row) });
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

module.exports = router;
