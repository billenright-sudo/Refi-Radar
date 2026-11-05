"use strict";
const express    = require("express");
const bcrypt     = require("bcryptjs");
const crypto     = require("crypto");
const rateLimit  = require("express-rate-limit");
const db         = require("../db");
const { sessionTokenFor, requireAuth } = require("../middleware/auth");
const email = require("../email");
const { sendInvite } = email;
const { userForReset, issueReset, completeReset, createSendCounter, hashToken } = require("../lib/passwordReset");
const { issueSignup, signupFor, completeSignup, purgeExpiredSignups } = require("../lib/signup");
const { stageById } = require("../lib/assistant/coaching");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many login attempts — please try again in 15 minutes" },
});

// Each accepted /forgot makes the app's own mail account send to an address the caller chose, so it is limited per IP. A refused or
// invalid request counts too, because this runs before any check.
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many reset requests — please try again in an hour" },
});

// Each accepted sign-up request makes the app's own mail account send to an address the caller chose (email A or B), so it is
// limited per IP like /forgot. A refused or invalid request counts too, because this runs before any check.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many sign-up attempts — please try again in an hour" },
});

// Finishing sign-up is a guess at a secret, so it gets the reset limit, with its own count (not resetLimiter's or
// acceptInviteLimiter's): the pages don't eat each other's tries.
const signupCompleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts — please try again in 15 minutes" },
});

// Saving a new password is a bcrypt hash and a guess at a secret, so it gets the same limit as signing in.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts — please try again in 15 minutes" },
});

// Accepting an invitation is a guess at a secret and a bcrypt hash, so it has its own count (not resetLimiter's): the two pages don't
// eat each other's tries.
const acceptInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts — please try again in 15 minutes" },
});

// An invitation makes the app's own mail account write to an address the broker typed, and anyone can register as a broker, so
// invitations are limited per IP. A refused request counts too. Placed after requireAuth, so a stranger can't use up an office's tries.
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many invitations — please try again in an hour" },
});

// At most 3 emails an hour to one address, however many IPs ask: reset emails and the two sign-up emails counted together, so
// neither page can be used to flood an inbox. In memory (one instance runs, and a restart that forgets the count is harmless).
// app.set("resetSendCounter", ...) swaps in a fresh one (tests).
const moduleCounter = createSendCounter();
// And at most 60 an hour in all, reset and sign-up emails together, so that a crowd of different addresses (or a crowd of IPs) can't
// use up the mailbox's daily sending quota and stop the invite and password-changed emails. Same kind of counter, one shared key.
// app.set("resetSiteSendCounter", ...) swaps in a fresh one (tests).
const SITE_RESET_EMAILS_PER_HOUR = 60;
const moduleSiteCounter = createSendCounter({ max: SITE_RESET_EMAILS_PER_HOUR });

const EMAIL_MAX = 254;
// No real password is this long; refusing a huge one keeps absurd input out of the hash (the page says so, rather than cutting it).
const PASSWORD_MAX = 256;
// Sign-up's names and brokerage name come from an anonymous visitor and go into email A, so they are capped (after trimming).
const NAME_MAX = 100;
// What /login compares against when there is no password to compare: a hash of the same cost (12) as a real one, made once when
// the module loads. Every failed sign-in then costs one bcrypt check, so its speed can't tell whether the account exists.
const DUMMY_HASH = bcrypt.hashSync("broker-radar: no account has this password", 12);
// Every refusal of a reset or sign-up link (malformed, unknown, expired, used, replaced) says exactly this, so the answer tells
// nothing about which of them it was.
const LINK_GONE = { success: false, error: "This link has expired or was already used." };
// The same for an invitation link: malformed, unknown, expired or used.
const INVITE_GONE = { success: false, error: "This invitation has expired or was already used." };

// The person an invitation link is for: an unaccepted invitation whose stored SHA-256 matches and which has not expired. Anything that
// is not a 64-character lower-case hex string is null without a lookup.
function inviteeFor(token, nowMs) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const user = db.prepare("SELECT * FROM users WHERE invite_token_hash = ? AND invite_accepted = 0").get(hashToken(token));
  if (!user || !(new Date(user.invite_expires).getTime() > nowMs)) return null;
  return user;
}

// Helper: safe user object (no password hash)
function safeUser(u) {
  return {
    id: u.id, orgId: u.org_id, role: u.role, firstName: u.first_name, lastName: u.last_name, email: u.email,
    careerStage: stageById(u.career_stage)?.id ?? null,   // null until set, and for a stored value that is not a stage id
  };
}

// Log the user in: set the session cookie, carrying their current session version so a later bump ends this session.
function setSession(res, user) {
  res.cookie("rr_token", sessionTokenFor(user), { httpOnly: true, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === "production" });
}

// Sends one of the two password emails once the answer has already gone out, and never lets a failure reach the page (a failure on
// /forgot would tell the caller the account exists). A failure is a rejection or the sender answering false. What gets logged is
// the kind of email and the error's own message: never the link, the token or the address, because the link is the
// credential.
async function sendAfterAnswer(kind, send, args) {
  try {
    if ((await send(args)) === false) console.error(`[auth] ${kind} email not sent`);
  } catch (err) {
    console.error(`[auth] ${kind} email not sent`, err?.message);
  }
}

// POST /api/auth/register — a broker asks to sign up their shop. Nothing is created here: the account exists only once the link
// emailed to the address is used (/register/complete). The answer is 200 { success: true } for every request that passes the checks
// below, whether the address is new, already has an account or an invitation, or is over its hourly limit, so this page can't be
// used to find out who has an account. Everything that depends on the address (the lookup, the password hash, storing the request,
// the email) happens after the answer, the /forgot pattern: a slow or failing step that only one kind of address takes would show.
router.post("/register", registerLimiter, (req, res) => {
  const body = req.body ?? {};
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const firstName = text(body.firstName);
  const lastName = text(body.lastName);
  const orgName = text(body.orgName);
  const mail = text(body.email);
  const { password } = body;   // never trimmed
  if (!firstName || !lastName || !orgName || !mail || typeof password !== "string" || !password) {
    return res.status(400).json({ success: false, error: "All fields required" });
  }
  if (password.length < 8) return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
  if (password.length > PASSWORD_MAX) {
    return res.status(400).json({ success: false, error: `Password must be at most ${PASSWORD_MAX} characters` });
  }
  // The mail goes to exactly this address: a "," or ";" would make the mail library send it to several people, and whitespace is
  // never in an address (the invite form's rule).
  if (mail.length > EMAIL_MAX || !mail.includes("@") || /[,;\s]/.test(mail)) {
    return res.status(400).json({ success: false, error: "Enter a valid email address" });
  }
  if (firstName.length > NAME_MAX || lastName.length > NAME_MAX || orgName.length > NAME_MAX) {
    return res.status(400).json({ success: false, error: "Names and the brokerage name can be at most 100 characters" });
  }
  // Same answer for every address, so it reveals nothing; nothing is stored when no email could go out.
  if (!email.mailReady(req.app.get("authEnv") || process.env)) {
    return res.status(503).json({ success: false, error: "Sign-up isn't available right now. Please try again later." });
  }

  const key = mail.toLowerCase();
  const counter = req.app.get("resetSendCounter") || moduleCounter;
  const siteCounter = req.app.get("resetSiteSendCounter") || moduleSiteCounter;
  const sendNew = req.app.get("sendSignup") || email.sendSignup;
  const sendTaken = req.app.get("sendAlreadyRegistered") || email.sendAlreadyRegistered;

  res.json({ success: true });

  // After the answer, and in one try so that nothing here can ever reach the caller (the response is already gone) or crash the
  // process: whatever goes wrong is logged by its message only, which never holds the token or the link.
  setImmediate(() => {
    try {
      // The (slow, cost 12) hash comes first, for every address, even one that will get email B or nothing: the work after the
      // answer then has the same shape in every case, so a request sent straight after this one can't time the difference.
      const passwordHash = bcrypt.hashSync(password, 12);
      const now = Date.now();
      purgeExpiredSignups(db, now);
      // Both counters count emails, and one goes out (A or B) for every request they let through. The per-address count is the
      // one /forgot uses, so an inbox gets at most 3 of the reset and sign-up emails together; it is asked first, so one address
      // asked for over and over can't use up the whole site's allowance. It forgets an address an hour after its last send, so
      // asking it about addresses with no account can't grow it without end. Past either limit nothing is stored or sent.
      if (!counter.take(key, now) || !siteCounter.take("all", now)) return;
      // Any user at all, an unused invitation included: email B, addressed with the name stored on that account, never the one
      // typed into the form (anyone can type anything there).
      const existing = db.prepare("SELECT email, first_name FROM users WHERE email = ?").get(key);
      if (existing) {
        sendAfterAnswer("already-registered", sendTaken, { to: existing.email, firstName: existing.first_name });
        return;
      }
      const token = issueSignup(db, { email: key, firstName, lastName, orgName, passwordHash }, now);
      // The token goes in the URL fragment (#), which a browser never sends to a server, so the link can't land in a request log.
      sendAfterAnswer("sign-up", sendNew, { to: key, firstName, orgName, link: `${email.APP_URL}/#signup=${token}` });
    } catch (err) {
      console.error("[auth] sign-up not issued", err?.message);
    }
  });
});

// POST /api/auth/register/check { token } — is this sign-up link still good? (for the "finish creating your account" page, which
// reads the token from the #signup= fragment of the address). The token is in the body, not the URL, because request URLs end up in
// the host's request log. Opening it does not use it up: mail scanners open links before the person does. No rate limit, for the
// same reasons as /reset/check: it answers nothing without a valid 256-bit token, and a limit would let page loads eat the tries a
// person needs on a shared address.
router.post("/register/check", (req, res) => {
  const request = signupFor(db, (req.body ?? {}).token, Date.now());
  if (!request) return res.status(410).json(LINK_GONE);
  res.json({ success: true, email: request.email, orgName: request.org_name });
});

// POST /api/auth/register/complete { token } — "Create my account". completeSignup is the one place the link is used up: in one
// transaction it checks the request again (still unexpired, and the address still has no user, since an invitation could have
// arrived in the meantime), creates the organization on its 14-day trial and the broker with the password hashed at sign-up, and
// deletes the request. Every refusal is the same 410. Then the new broker is signed in, as /login does.
router.post("/register/complete", signupCompleteLimiter, (req, res) => {
  const user = completeSignup(db, (req.body ?? {}).token, Date.now());
  if (!user) return res.status(410).json(LINK_GONE);
  setSession(res, user);
  res.json({ success: true, user: safeUser(user) });
});

// POST /api/auth/login
router.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email and password required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ? AND invite_accepted = 1").get(email.toLowerCase().trim());
  // Exactly one bcrypt check whatever is found: with no account that can sign in (no row, an unused invite, no password) the
  // password is checked against DUMMY_HASH, so a failed sign-in takes the same time whether or not the account exists.
  const hash = user && user.password_hash ? user.password_hash : DUMMY_HASH;
  const matches = bcrypt.compareSync(password, hash);
  if (!user || !user.password_hash || !matches) {
    return res.status(401).json({ success: false, error: "Invalid email or password" });
  }

  setSession(res, user);
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
router.post("/invite", requireAuth, inviteLimiter, async (req, res) => {
  if (req.user.role !== "broker") return res.status(403).json({ success: false, error: "Only brokers can invite LOs" });

  const { firstName, lastName, email: rawEmail } = req.body ?? {};
  if (!firstName || !lastName) return res.status(400).json({ success: false, error: "First name, last name, and email required" });

  // The mail goes to exactly the address that is stored. A "," or ";" would make the mail library send it to several people, and
  // whitespace is never in an address, so any of them is refused (the same message /forgot gives).
  const to = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!to || to.length > EMAIL_MAX || !to.includes("@") || /[,;\s]/.test(to)) {
    return res.status(400).json({ success: false, error: "Enter a valid email address" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(to);
  if (existing) return res.status(409).json({ success: false, error: "Email already registered" });

  const token   = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  try {
    db.prepare(`
      INSERT INTO users (org_id, role, first_name, last_name, email, invite_token_hash, invite_expires, invite_accepted)
      VALUES (?, 'lo', ?, ?, ?, ?, ?, 0)
    `).run(req.user.org_id, firstName.trim(), lastName.trim(), to, hashToken(token), expires);

    const org = db.prepare("SELECT name FROM organizations WHERE id = ?").get(req.user.org_id);
    const send = req.app.get("sendInvite") || sendInvite;   // the seam lets tests send nothing
    await send({
      toEmail:  to,
      toName:   firstName,
      fromName: `${req.user.first_name} ${req.user.last_name}`,
      orgName:  org.name,
      token,
    });

    res.status(201).json({ success: true, message: `Invitation sent to ${to}` });
  } catch (err) {
    console.error("Invite error:", err.message);
    res.status(500).json({ success: false, error: "Failed to send invitation" });
  }
});

// POST /api/auth/invite/check { token } — is this invitation still good? (for the accept-invite page, which reads the token from the
// #invite= fragment of the address). The token is in the body, not the URL, because request URLs end up in the host's request log.
// Opening it does not use it up: mail scanners open links before the person does. No rate limit, for the same reasons as /reset/check:
// it answers nothing without a valid 256-bit token, and a limit would let page loads eat the tries a person needs on a shared address.
router.post("/invite/check", (req, res) => {
  const user = inviteeFor((req.body ?? {}).token, Date.now());
  if (!user) return res.status(410).json(INVITE_GONE);
  const org = db.prepare("SELECT name FROM organizations WHERE id = ?").get(user.org_id);
  res.json({ success: true, firstName: user.first_name, lastName: user.last_name, email: user.email, orgName: org.name });
});

// POST /api/auth/accept-invite { token, password } — the password is checked first (it costs nothing), then the invitation, and only
// then the (slow, cost 12) hash, so a made-up token costs a lookup, not a hash. The UPDATE only matches an unaccepted invitation, so
// two requests with the same token can't both win: the loser changes no row and gets the same 410.
router.post("/accept-invite", acceptInviteLimiter, (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
  }
  if (password.length > PASSWORD_MAX) {
    return res.status(400).json({ success: false, error: `Password must be at most ${PASSWORD_MAX} characters` });
  }

  const user = inviteeFor(token, Date.now());
  if (!user) return res.status(410).json(INVITE_GONE);

  const hash = bcrypt.hashSync(password, 12);
  const changed = db.prepare(
    "UPDATE users SET password_hash = ?, invite_token_hash = NULL, invite_expires = NULL, invite_accepted = 1 WHERE id = ? AND invite_accepted = 0"
  ).run(hash, user.id).changes;
  if (!changed) return res.status(410).json(INVITE_GONE);

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  setSession(res, updated);
  res.json({ success: true, user: safeUser(updated) });
});

// POST /api/auth/forgot — ask for a password-reset link. The answer is 200 { success: true } for every address that is a valid email,
// whether or not it has an account, so this page can't be used to find out who has one. Nothing that only a real account does
// (the lookup, the database write for the link, the email) happens before the answer: a write can be slow on the live disk and a
// failure of it would be an error only real accounts could cause, and either would tell the caller the account exists.
router.post("/forgot", forgotLimiter, (req, res) => {
  const raw = (req.body ?? {}).email;
  const mail = typeof raw === "string" ? raw.trim() : "";
  if (!mail || mail.length > EMAIL_MAX || !mail.includes("@")) {
    return res.status(400).json({ success: false, error: "Enter a valid email address" });
  }
  // Same answer for every address, so it reveals nothing; nothing is stored when no email could go out.
  if (!email.mailReady(req.app.get("authEnv") || process.env)) {
    return res.status(503).json({ success: false, error: "Password reset isn't available right now. Please try again later." });
  }

  const key = mail.toLowerCase();
  const counter = req.app.get("resetSendCounter") || moduleCounter;
  const siteCounter = req.app.get("resetSiteSendCounter") || moduleSiteCounter;
  const send = req.app.get("sendPasswordReset") || email.sendPasswordReset;

  res.json({ success: true });

  // After the answer, and in one try so that nothing here can ever reach the caller (the response is already gone) or crash the
  // process: whatever goes wrong is logged by its message only, which never holds the token or the link.
  setImmediate(() => {
    try {
      // Only an account that can sign in counts (an unused invite should use its invite link). The send counter counts emails,
      // so it is asked only for an account that was found, the one case where a reset email goes out: a made-up address gets no
      // email and uses up none of the 3 an hour that its reset and sign-up emails share. (The counter forgets an address an hour
      // after its last send, so it can't grow without end either way.) The site-wide count is asked last, only once this account
      // has passed its own limit, so one account being asked for over and over can't use up the whole site's allowance. Past
      // either limit nothing is stored and nothing is sent.
      const user = db.prepare("SELECT id, email, first_name FROM users WHERE email = ? AND invite_accepted = 1").get(key);
      if (!user || !counter.take(key, Date.now()) || !siteCounter.take("all", Date.now())) return;
      const token = issueReset(db, user.id, Date.now());
      // The token goes in the URL fragment (#), which a browser never sends to a server, so the link can't land in a request log.
      sendAfterAnswer("reset", send, { to: user.email, firstName: user.first_name, link: `${email.APP_URL}/#reset=${token}` });
    } catch (err) {
      console.error("[auth] reset not issued", err?.message);
    }
  });
});

// POST /api/auth/reset/check { token } — is this link still good? (for the "choose a new password" page, which reads the token from
// the #reset= fragment of the address). The token is in the body, not the URL, because request URLs end up in the host's request log.
// Opening it does not use it up: mail scanners open links before the person does. No rate limit: it answers nothing without a valid
// 256-bit token, and sharing the reset limiter would let a few page loads eat the tries a person needs on an office's shared address.
router.post("/reset/check", (req, res) => {
  const user = userForReset(db, (req.body ?? {}).token, Date.now());
  if (!user) return res.status(410).json(LINK_GONE);
  res.json({ success: true, email: user.email });
});

// POST /api/auth/reset — choose the new password. completeReset is the one place the link is used up: it changes the password, ends
// every older session and deletes the link in one transaction. The person resetting is signed in from the row it returns, which was
// read after the session version went up (a cookie signed from any earlier copy of the row would be signed out at once).
router.post("/reset", resetLimiter, (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
  }
  if (password.length > PASSWORD_MAX) {
    return res.status(400).json({ success: false, error: `Password must be at most ${PASSWORD_MAX} characters` });
  }

  // The link is looked at before the (slow, cost 12) hash, so a made-up or used-up link costs a lookup, not a hash. completeReset
  // looks again inside its transaction, because the link could be used or expire between the two.
  if (!userForReset(db, token, Date.now())) return res.status(410).json(LINK_GONE);
  const updated = completeReset(db, token, bcrypt.hashSync(password, 12), Date.now());
  if (!updated) return res.status(410).json(LINK_GONE);

  setSession(res, updated);
  res.json({ success: true, user: safeUser(updated) });

  const send = req.app.get("sendPasswordChanged") || email.sendPasswordChanged;
  sendAfterAnswer("password-changed", send, { to: updated.email, firstName: updated.first_name });
});

module.exports = router;
