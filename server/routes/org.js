"use strict";
const express = require("express");
const db      = require("../db");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { sendRefiAlert } = require("../email");

const router = express.Router();
router.use(requireAuth, requireBroker);

function toUser(u) {
  return { id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email, role: u.role, inviteAccepted: !!u.invite_accepted, createdAt: u.created_at };
}

// GET /api/org/los — list all LOs in this org
router.get("/los", (req, res) => {
  const los = db.prepare("SELECT * FROM users WHERE org_id = ? AND role = 'lo' ORDER BY first_name ASC").all(req.user.org_id);
  // For each LO, include client count
  const result = los.map(lo => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE user_id = ?").get(lo.id);
    return { ...toUser(lo), clientCount: n };
  });
  res.json({ success: true, los: result });
});

// GET /api/org/los/:id/clients — broker views one LO's clients
router.get("/los/:id/clients", (req, res) => {
  const loId = parseInt(req.params.id);
  const lo = db.prepare("SELECT id FROM users WHERE id = ? AND org_id = ? AND role = 'lo'").get(loId, req.user.org_id);
  if (!lo) return res.status(404).json({ success: false, error: "LO not found in your org" });

  const clients = db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(loId);
  res.json({ success: true, clients: clients.map(row => ({
    id: row.id, orgId: row.org_id, userId: row.user_id,
    name: row.name, email: row.email, phone: row.phone,
    loanType: row.loan_type, currentRate: row.current_rate,
    loanBalance: row.loan_balance, propertyValue: row.property_value,
    closeDate: row.close_date, creditScore: row.credit_score,
    notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
  })) });
});

// POST /api/org/alert — broker sends refi alert to LO for a specific client
// Body: { loId, clientId, message?, monthlySavings? }
router.post("/alert", async (req, res) => {
  const { loId, clientId, message, monthlySavings } = req.body;
  if (!loId || !clientId) return res.status(400).json({ success: false, error: "loId and clientId required" });

  const lo = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role = 'lo'").get(parseInt(loId), req.user.org_id);
  if (!lo) return res.status(404).json({ success: false, error: "LO not found in your org" });

  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND org_id = ?").get(parseInt(clientId), req.user.org_id);
  if (!client) return res.status(404).json({ success: false, error: "Client not found in your org" });

  const defaultMsg = `Your broker flagged ${client.name} as a high-priority refi opportunity. Please follow up soon.`;
  const finalMsg = message || defaultMsg;

  try {
    db.prepare(`
      INSERT INTO notifications (org_id, from_user, to_user, client_id, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.org_id, req.user.id, lo.id, client.id, finalMsg);

    // Send email alert (non-blocking — don't fail the request if email fails)
    sendRefiAlert({
      toEmail: lo.email,
      toName: lo.first_name,
      clientName: client.name,
      brokerName: `${req.user.first_name} ${req.user.last_name}`,
      monthlySavings: monthlySavings || 0,
    }).catch(err => console.error("Alert email failed:", err.message));

    res.json({ success: true, message: `Alert sent to ${lo.first_name} ${lo.last_name}` });
  } catch (err) {
    console.error("Alert error:", err.message);
    res.status(500).json({ success: false, error: "Failed to send alert" });
  }
});

// GET /api/org/stats — broker dashboard summary
router.get("/stats", (req, res) => {
  const orgId = req.user.org_id;
  const los          = db.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id=? AND role='lo'").get(orgId).n;
  const totalClients = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE org_id=?").get(orgId).n;
  const org          = db.prepare("SELECT * FROM organizations WHERE id=?").get(orgId);
  res.json({ success: true, stats: { loCount: los, totalClients, orgName: org.name, plan: org.plan, trialEnds: org.trial_ends } });
});

module.exports = router;
