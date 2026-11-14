"use strict";
const express = require("express");
const db      = require("../db");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { requireAccess } = require("../middleware/access");
const { sendRefiAlert } = require("../email");
const { CAREER_STAGES, stageById } = require("../lib/assistant/coaching");
const { syncSeats } = require("../lib/billing/seats");
const { pushBeforeAnswer } = require("../lib/billing/bounded");

const router = express.Router();
router.use(requireAuth, requireAccess, requireBroker);

function toUser(u) {
  return { id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email, role: u.role, inviteAccepted: !!u.invite_accepted, createdAt: u.created_at, careerStage: stageById(u.career_stage)?.id ?? null };
}

// GET /api/org/los — list all LOs in this org
router.get("/los", (req, res) => {
  const los = db.prepare("SELECT * FROM users WHERE org_id = ? AND role = 'lo' AND removed_at IS NULL ORDER BY first_name ASC").all(req.user.org_id);
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
  const lo = db.prepare("SELECT id FROM users WHERE id = ? AND org_id = ? AND role = 'lo' AND removed_at IS NULL").get(loId, req.user.org_id);
  if (!lo) return res.status(404).json({ success: false, error: "LO not found in your org" });

  const clients = db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(loId);
  res.json({ success: true, clients: clients.map(row => ({
    id: row.id, orgId: row.org_id, userId: row.user_id,
    name: row.name, email: row.email, phone: row.phone,
    loanType: row.loan_type, currentRate: row.current_rate,
    loanBalance: row.loan_balance, propertyValue: row.property_value,
    closeDate: row.close_date, creditScore: row.credit_score,
    notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
    loanProgram: row.loan_program,   // the page's conventional analysis leaves FHA, VA and USDA loans out
  })) });
});

// PATCH /api/org/los/:id/stage — broker sets how Charli coaches one of their LOs (their career stage)
// Body: { stage } — one of the CAREER_STAGES ids (lib/assistant/coaching.js).
// -> { success: true, stage, label }. 400 for any other stage; 404 unless the target is an LO in the caller's org.
router.patch("/los/:id/stage", (req, res) => {
  const stage = stageById(req.body && req.body.stage);
  if (!stage) {
    return res.status(400).json({ success: false, error: `stage must be one of: ${CAREER_STAGES.map((s) => s.id).join(", ")}` });
  }

  const loId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  const lo = Number.isSafeInteger(loId)
    ? db.prepare("SELECT id FROM users WHERE id = ? AND org_id = ? AND role = 'lo' AND removed_at IS NULL").get(loId, req.user.org_id)
    : undefined;
  if (!lo) return res.status(404).json({ success: false, error: "LO not found in your org" });

  try {
    db.prepare("UPDATE users SET career_stage = ? WHERE id = ? AND org_id = ? AND role = 'lo'").run(stage.id, lo.id, req.user.org_id);
    res.json({ success: true, stage: stage.id, label: stage.label });
  } catch (err) {
    console.error("PATCH /api/org/los/:id/stage:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// DELETE /api/org/los/:id — a broker removes an accepted loan officer, or cancels a pending invitation (spec §6.3).
// A pending invite is simply deleted (no seat was ever counted). An accepted LO is kept as a row, so history (Charli's
// recommendations, the contact log, assistant usage) stays whole, but every way in is closed in ONE transaction: their clients move
// to the broker, the login is blanked and their session version raised, the address is freed, and their LOS feed key, Google
// connection, a Google sign-in begun but not finished, reset link and email change are deleted. The placeholder email has no "@",
// so no address validator (invite, sign-up, forgot-password, email change) can ever accept it: it cannot be squatted. Then, BEFORE the
// answer (Cloud Run throttles work left after it), the new user count goes to Stripe, waiting 8 seconds at most: a failure or a
// timeout still answers 200 and is logged by its message with our org id (and retried at the next sync). 404 for anything that is
// not an LO of the caller's org that is not removed.
router.delete("/los/:id", (req, res) => {
  const loId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  const lo = Number.isSafeInteger(loId)
    ? db.prepare("SELECT id, invite_accepted FROM users WHERE id = ? AND org_id = ? AND role = 'lo' AND removed_at IS NULL").get(loId, req.user.org_id)
    : undefined;
  if (!lo) return res.status(404).json({ success: false, error: "LO not found in your org" });

  const orgId = req.user.org_id;
  try {
    db.transaction(() => {
      if (!lo.invite_accepted) {
        // An import or the LOS feed can already have routed clients to a pending invitee (lib/intake/owner.js), and clients
        // cascade-delete with their user: they move to the broker first, so cancelling an invite never loses a client.
        db.prepare("UPDATE clients SET user_id = ? WHERE user_id = ?").run(req.user.id, lo.id);
        db.prepare("DELETE FROM users WHERE id = ? AND org_id = ? AND invite_accepted = 0").run(lo.id, orgId);
        return;
      }
      db.prepare("UPDATE clients SET user_id = ? WHERE user_id = ?").run(req.user.id, lo.id);
      db.prepare(`
        UPDATE users SET removed_at = ?, removed_email = email, email = 'removed:' || id,
                         password_hash = NULL, session_version = session_version + 1
        WHERE id = ?
      `).run(Date.now(), lo.id);
      for (const table of ["integration_keys", "google_connections", "password_resets", "email_changes", "google_oauth_states"]) {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(lo.id);
      }
    })();
  } catch (err) {
    console.error("DELETE /api/org/los/:id:", err.message);
    return res.status(500).json({ success: false, error: "Database error" });
  }

  const answer = () => res.json({ success: true });
  const gateway = req.app.get("billingGateway");
  if (!lo.invite_accepted || !req.app.get("billingConfig")?.enabled || !gateway) return answer();
  pushBeforeAnswer(req.app, "sync_seats", orgId, () => syncSeats(db, gateway, orgId))
    .then(answer)
    .catch((err) => console.error("DELETE /api/org/los/:id:", err?.message));
});

// POST /api/org/alert — broker sends refi alert to LO for a specific client
// Body: { loId, clientId, message?, monthlySavings? }
router.post("/alert", async (req, res) => {
  const { loId, clientId, message, monthlySavings } = req.body;
  if (!loId || !clientId) return res.status(400).json({ success: false, error: "loId and clientId required" });

  const lo = db.prepare("SELECT * FROM users WHERE id = ? AND org_id = ? AND role = 'lo' AND removed_at IS NULL").get(parseInt(loId), req.user.org_id);
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

// The Overview chip with billing on (H12): the billing status word ("exempt" for an exempt brokerage) instead of the old sign-up
// plan, and the end of the running free trial or test month (ISO) instead of the old sign-up trial date. A paid subscription keeps
// Stripe's old trial end, which is not shown.
function billingChip(org, nowMs) {
  if (org.billing_exempt) return { plan: "exempt", trialEnds: null };
  const endMs = org.billing_status === "trialing" && org.billing_trial_end ? org.billing_trial_end
    : org.billing_tester_until > nowMs ? org.billing_tester_until : null;
  return { plan: org.billing_status ?? "none", trialEnds: endMs ? new Date(endMs).toISOString() : null };
}

// GET /api/org/stats — broker dashboard summary
router.get("/stats", (req, res) => {
  const orgId = req.user.org_id;
  const los          = db.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id=? AND role='lo' AND removed_at IS NULL").get(orgId).n;
  const totalClients = db.prepare("SELECT COUNT(*) AS n FROM clients WHERE org_id=?").get(orgId).n;
  const org          = db.prepare("SELECT * FROM organizations WHERE id=?").get(orgId);
  const { plan, trialEnds } = req.app.get("billingConfig")?.enabled ? billingChip(org, Date.now()) : { plan: org.plan, trialEnds: org.trial_ends };
  res.json({ success: true, stats: { loCount: los, totalClients, orgName: org.name, plan, trialEnds } });
});

module.exports = router;
