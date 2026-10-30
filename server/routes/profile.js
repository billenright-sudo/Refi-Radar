"use strict";
// The signed-in user's own profile: name, login email, tenure, and NMLS ID (and, for a broker, their company's). Every client
// email Charli sets up is signed with both NMLS IDs (lib/assistant/outreach.js), as mortgage advertising rules expect.
//   GET  /api/profile                       -> { firstName, lastName, email, pendingEmail, careerStage, nmlsId, orgNmlsId, canEditOrg }
//   PUT  /api/profile/name        { firstName, lastName }  letters, spaces, ' and - only (a curly ' is stored as '); firstName 1-50, lastName 0-50 -> the profile
//   PUT  /api/profile/career-stage { stage }               new / developing / established / veteran                     -> the profile
//   POST /api/profile/email       { email }   mails a confirmation link to the NEW address -> { pendingEmail }; 400, 409 (taken), 429 (5 an hour), 503 (mail not set up)
//   GET  /api/profile/email/confirm/:token    the emailed link: NO session needed; sets the login email, then 302s to /?emailChanged=1 (or =0)
//   GET  /api/profile/nmls      -> { nmlsId, orgNmlsId, canEditOrg }   (canEditOrg: only a broker can set the company's)
//   PUT  /api/profile/nmls      { nmlsId }  sets the caller's OWN ID      -> the same shape as GET /nmls
//   PUT  /api/profile/org-nmls  { nmlsId }  sets the company's (broker)   -> the same shape as GET /nmls; 403 for a loan officer
// An NMLS ID is 1 to 12 digits after trimming; an empty string clears it; anything else is a 400.
// Every route but the confirm link acts only on req.user (the session), never on an id from the request.
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const email = require("../email");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { parseNmls } = require("../lib/assistant/outreach");
const { stageById } = require("../lib/assistant/coaching");
const { setCareerStageForUser } = require("../lib/careerStage");

const router = express.Router();

const BAD_NMLS = "An NMLS ID is digits only";
const BAD_NAME = "Use letters only in your name";
const NAME_MAX = 50;
const EMAIL_MAX = 254;
// A basic x@y.z: no whitespace, no empty label, and none of <>(),;:"\[] anywhere. Those are what make nodemailer read a display
// name (Name<x@y.co>), a quoted local part ("a"@y.co) or a list (a,b@c.co, x@y.co;z@y.co) as a different or an extra recipient.
const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@.<>(),;:"\\[\]]+(\.[^\s@.<>(),;:"\\[\]]+)+$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;                    // what crypto.randomBytes(32).toString("hex") makes
const EMAIL_CHANGE_TTL_MS = 48 * 60 * 60 * 1000;
const EMAIL_CHANGE_LIMIT = 5;   // requests per signed-in user per hour; app.set("emailChangeLimit", n) overrides it (tests)

// Each accepted request makes the app's own mail account send a message to an address the caller chose, and anyone can register,
// so this route is limited, counted per signed-in user (an office shares one IP address). A refused request counts too.
const emailChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req) => req.app.get("emailChangeLimit") || EMAIL_CHANGE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: "Too many email-change requests — please try again in an hour" },
});

// The emailed link is opened from an inbox, with no session, so it is registered before requireAuth. The token IS the
// credential: it is single-use, and the change is applied to the account it was issued to. Any failure (a malformed or unknown
// token, an expired one, a taken address) is the same redirect, and a token that has been tried is spent.
function confirmEmailChange(token) {
  return db.transaction(() => {
    const row = db.prepare("SELECT user_id, new_email, expires_at FROM email_changes WHERE token = ?").get(token);
    if (!row) return false;
    db.prepare("DELETE FROM email_changes WHERE user_id = ?").run(row.user_id);
    if (row.expires_at <= Date.now()) return false;
    if (db.prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?").get(row.new_email, row.user_id)) return false;
    return db.prepare("UPDATE users SET email = ? WHERE id = ?").run(row.new_email, row.user_id).changes === 1;
  })();
}

router.get("/email/confirm/:token", (req, res) => {
  let confirmed = false;
  if (TOKEN_RE.test(req.params.token)) {
    try {
      confirmed = confirmEmailChange(req.params.token);
    } catch (err) {
      console.error("GET /api/profile/email/confirm:", err.message);
    }
  }
  res.set("Cache-Control", "no-store");
  res.redirect(302, confirmed ? "/?emailChanged=1" : "/?emailChanged=0");
});

router.use(requireAuth);

// requireAuth's user row has no nmls_id, so both IDs are read here, fresh.
function nmlsOf(user) {
  const own = db.prepare("SELECT nmls_id FROM users WHERE id = ?").get(user.id);
  const org = db.prepare("SELECT nmls_id FROM organizations WHERE id = ?").get(user.org_id);
  return { nmlsId: (own && own.nmls_id) || null, orgNmlsId: (org && org.nmls_id) || null, canEditOrg: user.role === "broker" };
}

// The whole profile, read fresh (a PUT answers with it). pendingEmail is a change whose link has not been used or expired.
function profileOf(user) {
  const me = db.prepare("SELECT first_name, last_name, email, career_stage FROM users WHERE id = ?").get(user.id);
  const pending = db.prepare("SELECT new_email FROM email_changes WHERE user_id = ? AND expires_at > ?").get(user.id, Date.now());
  return {
    firstName: me.first_name,
    lastName: me.last_name,
    email: me.email,
    pendingEmail: pending ? pending.new_email : null,
    careerStage: stageById(me.career_stage)?.id ?? null,   // null until set, and for a stored value that is not a stage id
    ...nmlsOf(user),
  };
}

// A trimmed name part, or null when it is not 1-50 (0-50 when `required` is false) letters, spaces, apostrophes and hyphens.
// Anything non-empty needs a letter in it, so "-" and "'" are not names.
function parseNamePart(value, required) {
  if (typeof value !== "string") return null;
  // iOS smart punctuation types a curly apostrophe (U+2018, U+2019) for ': store the plain one
  const name = value.trim().normalize("NFC").replace(/[\u2018\u2019]/g, "'");
  if (name.length > NAME_MAX || (required && name.length < 1)) return null;
  if (name.length > 0 && !(/^[\p{L} '-]+$/u.test(name) && /\p{L}/u.test(name))) return null;
  return name;
}

function failed(res, label, err) {
  console.error(`${label}:`, err.message);
  res.status(500).json({ success: false, error: "Database error" });
}

router.get("/", (req, res) => {
  try {
    res.json(profileOf(req.user));
  } catch (err) {
    failed(res, "GET /api/profile", err);
  }
});

router.put("/name", (req, res) => {
  const body = req.body || {};
  const firstName = parseNamePart(body.firstName, true);
  const lastName = parseNamePart(body.lastName, false);
  if (firstName === null || lastName === null) return res.status(400).json({ success: false, error: BAD_NAME });
  try {
    db.prepare("UPDATE users SET first_name = ?, last_name = ? WHERE id = ?").run(firstName, lastName, req.user.id);
    res.json(profileOf(req.user));
  } catch (err) {
    failed(res, "PUT /api/profile/name", err);
  }
});

router.put("/career-stage", (req, res) => {
  const stage = stageById((req.body || {}).stage);
  if (!stage) return res.status(400).json({ success: false, error: "A valid career stage is required" });
  try {
    const done = setCareerStageForUser(req.user, stage);
    if (done.error) return res.status(done.status).json({ success: false, error: done.error });
    res.json(profileOf(req.user));
  } catch (err) {
    failed(res, "PUT /api/profile/career-stage", err);
  }
});

// Asking to change the login email does not change it: a one-time link goes to the NEW address, and users.email changes only
// when that link is opened. One pending change per user (a second request replaces the first, and the old link dies).
router.post("/email", emailChangeLimiter, async (req, res) => {
  const given = (req.body || {}).email;
  const newEmail = typeof given === "string" ? given.trim().toLowerCase() : "";
  if (newEmail.length > EMAIL_MAX || !EMAIL_RE.test(newEmail)) {
    return res.status(400).json({ success: false, error: "Enter a valid email address" });
  }
  if (newEmail === String(req.user.email).toLowerCase()) {
    return res.status(400).json({ success: false, error: "That is already your email address" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  try {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(newEmail)) {
      return res.status(409).json({ success: false, error: "That email is already in use" });
    }
    db.prepare(`
      INSERT INTO email_changes (user_id, new_email, token, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET new_email = excluded.new_email, token = excluded.token, expires_at = excluded.expires_at
    `).run(req.user.id, newEmail, token, Date.now() + EMAIL_CHANGE_TTL_MS);
  } catch (err) {
    return failed(res, "POST /api/profile/email", err);
  }

  // The mailer is a seam so a test can inject a fake; the link and the token are never logged.
  const send = req.app.get("sendEmailChange") || email.sendEmailChange;
  let sent = false;
  try {
    sent = Boolean(await send(newEmail, `${email.APP_URL}/api/profile/email/confirm/${token}`));
  } catch (err) {
    console.error("POST /api/profile/email: send failed:", err.message);
  }
  if (!sent) {
    // no mail went out, so no link may stay live
    try { db.prepare("DELETE FROM email_changes WHERE user_id = ? AND token = ?").run(req.user.id, token); } catch (err) { console.error("POST /api/profile/email:", err.message); }
    return res.status(503).json({ success: false, error: "Email isn't set up yet" });
  }
  res.json({ pendingEmail: newEmail });
});

function setNmls(table, idOf) {
  return (req, res) => {
    const parsed = parseNmls(req.body && req.body.nmlsId);
    if (parsed.invalid) return res.status(400).json({ success: false, error: BAD_NMLS });
    try {
      db.prepare(`UPDATE ${table} SET nmls_id = ? WHERE id = ?`).run(parsed.value, idOf(req.user));
      res.json(nmlsOf(req.user));
    } catch (err) {
      console.error(`PUT /api/profile (${table}):`, err.message);
      res.status(500).json({ success: false, error: "Database error" });
    }
  };
}

router.get("/nmls", (req, res) => {
  try {
    res.json(nmlsOf(req.user));
  } catch (err) {
    console.error("GET /api/profile/nmls:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

router.put("/nmls", setNmls("users", (user) => user.id));
router.put("/org-nmls", requireBroker, setNmls("organizations", (user) => user.org_id));

module.exports = router;
