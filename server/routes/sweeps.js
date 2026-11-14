"use strict";
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireAccess } = require("../middleware/access");
const refi = require("../lib/refi");
const { safeCheck } = require("../lib/targets");
const upgradeAlerts = require("../lib/upgradeAlerts");

const router = express.Router();
router.use(requireAuth, requireAccess);

// POST /api/sweeps — run the deterministic opportunity sweep over the caller's book.
// Body: { rates } — the current rates the client already fetched for the dashboard.
// Brokers sweep the whole org; LOs sweep their own clients.
router.post("/", (req, res) => {
  const rates = req.body && req.body.rates;
  if (!rates || typeof rates.rate_30yr_fixed !== "number") {
    return res.status(400).json({ success: false, error: "current rates required" });
  }
  try {
    safeCheck(db, req.user.org_id);   // spec 4.4: a sweep checks the targets too, so a hit it finds is stored (a failed check: logged)
    upgradeAlerts.safeCheckUpgrades(db, req.user.org_id);   // spec 4.7: and the upgrades, so a lens that newly qualifies is recorded
    const rows = req.user.role === "broker"
      ? db.prepare("SELECT * FROM clients WHERE org_id = ? ORDER BY name ASC").all(req.user.org_id)
      : db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id);
    const sweep = refi.runSweep(rows, rates);
    res.json({ success: true, ...sweep, upgrades: upgradeAlerts.markSweepUpgrades(db, sweep.upgrades) });
  } catch (err) {
    console.error("POST /api/sweeps:", err.message);
    res.status(500).json({ success: false, error: "Sweep failed" });
  }
});

module.exports = router;
