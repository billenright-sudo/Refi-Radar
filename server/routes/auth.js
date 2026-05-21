"use strict";
const express    = require("express");
const bcrypt     = require("bcryptjs");
const crypto     = require("crypto");
const rateLimit  = require("express-rate-limit");
const db         = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");
const { sendInvite } = require("../email");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many login attempts — please try again in 15 minutes" },
});

// Helper: safe user object (no password hash)
function safeUser(u) {
  return { id: u.id, orgId: u.org_id, role: u.role, firstName: u.first_name, lastName: u.last_name, email: u.email };
}

// POST /api/auth/register — broker registers their shop
router.post("/register", (req, res) => {
  const { firstName, lastName, email, password, orgName } = req.body;
  if (!firstName || !lastName || !email || !password || !orgName) {
    return res.status(400).json({ success: false, error: "All fields required" });
  }
  if (password.length < 8) return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ success: false, error: "Email already registered" });

  const hash = bcrypt.hashSync(password, 12);
  const trialEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const register = db.transaction(() => {
    const org = db.prepare("INSERT INTO organizations (name, plan, trial_ends) VALUES (?, 'trial', ?)").run(orgName.trim(), trialEnds);
    const user = db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted)
      VALUES (?, 'broker', ?, ?, ?, ?, 1)
    `).run(org.lastInsertRowid, firstName.trim(), lastName.trim(), email.toLowerCase().trim(), hash);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(user.lastInsertRowid);
  });

  try {
    const user = register();
    const token = signToken({ userId: user.id });
    res.cookie("rr_token", token, { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === "production" });
    res.status(201).json({ success: true, user: safeUser(user) });
  } catch (err) {
    console.error("Register error:", err.message);
    res.status(500).json({ success: false, error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email and password required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ? AND invite_accepted = 1").get(email.toLowerCase().trim());
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ success: false, error: "Invalid email or password" });
  }

  const token = signToken({ userId: user.id });
  res.cookie("rr_token", token, { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === "production" });
  res.json({ success: true, user: safeUser(user) });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  res.clearCookie("rr_token");
  res.json({ success: true });
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: safeUser(req.user) });
});

// POST /api/auth/invite — broker invites an LO
router.post("/invite", requireAuth, async (req, res) => {
  if (req.user.role !== "broker") return res.status(403).json({ success: false, error: "Only brokers can invite LOs" });

  const { firstName, lastName, email } = req.body;
  if (!firstName || !lastName || !email) return res.status(400).json({ success: false, error: "First name, last name, and email required" });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ success: false, error: "Email already registered" });

  const token   = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  try {
    db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, invite_token, invite_expires, invite_accepted)
      VALUES (?, 'lo', ?, ?, ?, ?, ?, 0)
    `).run(req.user.org_id, firstName.trim(), lastName.trim(), email.toLowerCase().trim(), token, expires);

    const org = db.prepare("SELECT name FROM organizations WHERE id = ?").get(req.user.org_id);
    await sendInvite({
      toEmail:  email,
      toName:   firstName,
      fromName: `${req.user.first_name} ${req.user.last_name}`,
      orgName:  org.name,
      token,
    });

    res.status(201).json({ success: true, message: `Invitation sent to ${email}` });
  } catch (err) {
    console.error("Invite error:", err.message);
    res.status(500).json({ success: false, error: "Failed to send invitation" });
  }
});

// GET /api/auth/invite/:token — validate invite token (for the accept-invite page)
router.get("/invite/:token", (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(req.params.token)) return res.status(400).json({ success: false, error: "Invalid token format" });
  const user = db.prepare("SELECT id, first_name, last_name, email, org_id, invite_expires FROM users WHERE invite_token = ? AND invite_accepted = 0").get(req.params.token);
  if (!user) return res.status(404).json({ success: false, error: "Invalid or expired invitation" });
  if (new Date(user.invite_expires) < new Date()) return res.status(410).json({ success: false, error: "Invitation has expired" });
  const org = db.prepare("SELECT name FROM organizations WHERE id = ?").get(user.org_id);
  res.json({ success: true, firstName: user.first_name, lastName: user.last_name, email: user.email, orgName: org.name });
});

// POST /api/auth/accept-invite
router.post("/accept-invite", (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ success: false, error: "Token and password required" });
  if (!/^[0-9a-f]{64}$/.test(token)) return res.status(400).json({ success: false, error: "Invalid token format" });
  if (password.length < 8) return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });

  const user = db.prepare("SELECT * FROM users WHERE invite_token = ? AND invite_accepted = 0").get(token);
  if (!user) return res.status(404).json({ success: false, error: "Invalid or already used token" });
  if (new Date(user.invite_expires) < new Date()) return res.status(410).json({ success: false, error: "Invitation has expired" });

  const hash = bcrypt.hashSync(password, 12);
  db.prepare("UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL, invite_accepted = 1 WHERE id = ?").run(hash, user.id);

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  const jwtToken = signToken({ userId: updated.id });
  res.cookie("rr_token", jwtToken, { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === "production" });
  res.json({ success: true, user: { id: updated.id, orgId: updated.org_id, role: updated.role, firstName: updated.first_name, lastName: updated.last_name, email: updated.email } });
});

module.exports = router;
