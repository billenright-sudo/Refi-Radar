"use strict";
const jwt = require("jsonwebtoken");
const db  = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET is not set in production. Set a strong random secret.");
  process.exit(1);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

// The login token for a user: their id plus the session version they are on right now (see users.session_version in db.js).
function sessionTokenFor(user) {
  return signToken({ userId: user.id, sv: user.session_version || 0 });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.rr_token;
  if (!token) return res.status(401).json({ success: false, error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Reload user from DB to get latest role/org
    const user = db.prepare("SELECT id, org_id, role, first_name, last_name, email, career_stage, session_version FROM users WHERE id = ?").get(payload.userId);
    if (!user) return res.status(401).json({ success: false, error: "User not found" });
    // A token from before the account's session version was raised is finished. Tokens signed before versions existed have
    // no sv, which counts as 0, so they keep working until the first reset.
    if ((payload.sv ?? 0) !== user.session_version) {
      return res.status(401).json({ success: false, error: "Invalid or expired session" });
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired session" });
  }
}

function requireBroker(req, res, next) {
  if (req.user?.role !== "broker") return res.status(403).json({ success: false, error: "Broker access required" });
  next();
}

module.exports = { signToken, sessionTokenFor, requireAuth, requireBroker };
