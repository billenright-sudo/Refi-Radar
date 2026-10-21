"use strict";
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const refi = require("../lib/refi");

const router = express.Router();
router.use(requireAuth);

// POST /api/sweeps — run the deterministic opportunity sweep over the caller's book.
// Body: { rates } — the current rates the client already fetched for the dashboard.
// Brokers sweep the whole org; LOs sweep their own clients.
router.post("/", (req, res) => {
  const rates = req.body && req.body.rates;
  if (!rates || typeof rates.rate_30yr_fixed !== "number") {
    return res.status(400).json({ success: false, error: "current rates required" });
  }
  try {
    const rows = req.user.role === "broker"
      ? db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(req.user.org_id)
      : db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id);
    res.json({ success: true, ...refi.runSweep(rows, rates) });
  } catch (err) {
    console.error("POST /api/sweeps:", err.message);
    res.status(500).json({ success: false, error: "Sweep failed" });
  }
});

module.exports = router;
