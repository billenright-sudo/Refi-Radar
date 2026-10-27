"use strict";
// The signed-in user's NMLS ID, and their company's. Every client email Charli sets up is signed with both
// (lib/assistant/outreach.js), as mortgage advertising rules expect.
//   GET /api/profile/nmls      -> { nmlsId, orgNmlsId, canEditOrg }   (canEditOrg: only a broker can set the company's)
//   PUT /api/profile/nmls      { nmlsId }  sets the caller's OWN ID      -> the same shape as GET
//   PUT /api/profile/org-nmls  { nmlsId }  sets the company's (broker)   -> the same shape as GET; 403 for a loan officer
// An ID is 1 to 12 digits after trimming; an empty string clears it; anything else is a 400.
const express = require("express");
const db = require("../db");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { parseNmls } = require("../lib/assistant/outreach");

const router = express.Router();
router.use(requireAuth);

const BAD_NMLS = "An NMLS ID is digits only";

// requireAuth's user row has no nmls_id, so both IDs are read here, fresh.
function profileOf(user) {
  const own = db.prepare("SELECT nmls_id FROM users WHERE id = ?").get(user.id);
  const org = db.prepare("SELECT nmls_id FROM organizations WHERE id = ?").get(user.org_id);
  return { nmlsId: (own && own.nmls_id) || null, orgNmlsId: (org && org.nmls_id) || null, canEditOrg: user.role === "broker" };
}

function setNmls(table, idOf) {
  return (req, res) => {
    const parsed = parseNmls(req.body && req.body.nmlsId);
    if (parsed.invalid) return res.status(400).json({ success: false, error: BAD_NMLS });
    try {
      db.prepare(`UPDATE ${table} SET nmls_id = ? WHERE id = ?`).run(parsed.value, idOf(req.user));
      res.json(profileOf(req.user));
    } catch (err) {
      console.error(`PUT /api/profile (${table}):`, err.message);
      res.status(500).json({ success: false, error: "Database error" });
    }
  };
}

router.get("/nmls", (req, res) => {
  try {
    res.json(profileOf(req.user));
  } catch (err) {
    console.error("GET /api/profile/nmls:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

router.put("/nmls", setNmls("users", (user) => user.id));
router.put("/org-nmls", requireBroker, setNmls("organizations", (user) => user.org_id));

module.exports = router;
