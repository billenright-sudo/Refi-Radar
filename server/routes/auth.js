"use strict";
const express    = require("express");
const bcrypt     = require("bcryptjs");
const crypto     = require("crypto");
const rateLimit  = require("express-rate-limit");
const db         = require("../db");
const { sessionTokenFor, requireAuth } = require("../middleware/auth");
const { requireAccess } = require("../middleware/access");
const email = require("../email");
const { sendInvite } = email;
const { userForReset, issueReset, completeReset, createSendCounter, hashToken } = require("../lib/passwordReset");
const { issueSignup, signupFor, completeSignup, purgeExpiredSignups } = require("../lib/signup");
const { stageById } = require("../lib/assistant/coaching");
const { syncSeats, testerCodeUsable } = require("../lib/billing/seats");
const { storeSubscription } = require("../lib/billing/events");
const { runFollowUps } = require("../lib/billing/followUps");
const { CURRENT_VERSIONS, recordAcceptance } = require("../lib/terms");

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

// At most 3 reset emails an hour to one address, however many IPs ask, and apart from them at most 3 sign-up emails (A and B
// together), so neither page can be used to flood an inbox. One counter, two kinds of key: a reset counts under the address,
// a sign-up under "signup:" + the address. Kept apart because anyone can ask for sign-up emails to someone else's address, and if
// the two shared a count, three of those would block that person's password reset for an hour. In memory (one instance runs, and
// a restart that forgets the count is harmless). app.set("resetSendCounter", ...) swaps in a fresh one (tests).
const moduleCounter = createSendCounter();
// And at most 60 reset emails an hour in all, so that a crowd of different accounts (or a crowd of IPs) can't use up the mailbox's
// daily sending quota and stop the invite and password-changed emails. Same kind of counter, one shared key.
// app.set("resetSiteSendCounter", ...) swaps in a fresh one (tests).
const SITE_RESET_EMAILS_PER_HOUR = 60;
const moduleSiteCounter = createSendCounter({ max: SITE_RESET_EMAILS_PER_HOUR });
// Sign-up emails (A and B together) have their own site-wide cap, apart from the reset one. Anyone can ask for sign-up emails to
// made-up addresses (a reset email only ever goes to a real account), so if the two shared one cap a dozen IPs could use it up and
// silently stop every password-reset email for the rest of the hour. Kept lower than the reset cap because anyone can ask for
// sign-up emails to made-up addresses. app.set("signupSiteSendCounter", ...) swaps in a fresh one (tests).
const SITE_SIGNUP_EMAILS_PER_HOUR = 20;
const moduleSignupSiteCounter = createSendCounter({ max: SITE_SIGNUP_EMAILS_PER_HOUR });

// A full site cap means the mailbox's hourly allowance is used up (perhaps by someone asking for made-up addresses), so it is
// logged, but at most once an hour per cap, so a flood of requests can't flood the log as well. The line names the cap only: never
// an address, a token or a link. Remembered per counter object, so a fresh counter (tests) starts with no warning given.
const CAP_WARN_EVERY_MS = 60 * 60 * 1000;
const capWarnedAt = new WeakMap();
function warnCapFull(siteCounter, line, nowMs) {
  const last = capWarnedAt.get(siteCounter);
  if (last !== undefined && nowMs - last < CAP_WARN_EVERY_MS) return;
  capWarnedAt.set(siteCounter, nowMs);
  console.warn(line);
}

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
// With billing on (spec §6.1, §6.6): the sign-up and accept-invite pages' terms tick, and a tester code that can't be used (wrong,
// switched off, past its day or its limit: all the same words).
const TERMS_REQUIRED = { success: false, error: "Please agree to the Terms of Service and Privacy Policy." };
const TESTER_INVALID = { success: false, error: "That tester code isn't valid." };

// Billing is on for sign-up when start-up switched it on (lib/billing/startup.js). Creating the tester month's Stripe subscription
// also needs the gateway, which the routes read separately.
const billingConfigOn = (req) => {
  const config = req.app.get("billingConfig");
  return config && config.enabled ? config : null;
};
// A subscription read from Stripe counts as of its whole second, like the billing status call's re-read: Stripe's event times are
// whole seconds, and the webhook's event for the same subscription, from the same second, must still apply.
const wholeSecond = (ms) => Math.floor(ms / 1000) * 1000;

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
// With billing on, the form also carries `acceptTerms` (the tick, required) and an optional `testerCode`; with billing off both are
// ignored completely.
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
  // The terms tick and the tester code depend only on the request, never on the address, so they are 400s like the ones above,
  // given before the answer. Only the boolean true is a tick. A blank or missing code is no code; anything else must be usable
  // (the right code in any case, switched on, not past its day or its limit). The limit is asked again when the link is used.
  const billing = billingConfigOn(req);
  let tester = false;
  if (billing) {
    if (body.acceptTerms !== true) return res.status(400).json(TERMS_REQUIRED);
    const code = body.testerCode;
    const noCode = code === undefined || code === null || (typeof code === "string" && !code.trim());
    if (!noCode) {
      if (!testerCodeUsable(db, billing, code, Date.now())) return res.status(400).json(TESTER_INVALID);
      tester = true;
    }
  }
  // Same answer for every address, so it reveals nothing; nothing is stored when no email could go out.
  if (!email.mailReady(req.app.get("authEnv") || process.env)) {
    return res.status(503).json({ success: false, error: "Sign-up isn't available right now. Please try again later." });
  }
  // What the person was shown and agreed to (billing on), stored with the request and recorded when the account is created.
  const agreed = billing ? CURRENT_VERSIONS : { termsVersion: null, privacyVersion: null };

  const key = mail.toLowerCase();
  const counter = req.app.get("resetSendCounter") || moduleCounter;
  const siteCounter = req.app.get("signupSiteSendCounter") || moduleSignupSiteCounter;
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
      // Both counters count emails, and one goes out (A or B) for every request they let through. The per-address count is
      // sign-up's own key ("signup:" + the address), never the one /forgot uses, so sign-up requests, whoever sends them, can't
      // use up an address's reset emails (nor resets its sign-up emails); it is asked first, so one address asked for over and over
      // can't use up the whole site's allowance. It forgets an address an hour after its last send, so asking it about addresses
      // with no account can't grow it without end. The site-wide count is sign-up's own too, never the reset emails' (anyone can
      // ask for these emails to made-up addresses, so sharing it would let them stop password resets). Past either limit nothing
      // is stored or sent; a full site cap is logged (once an hour, no address).
      if (!counter.take("signup:" + key, now)) return;
      if (!siteCounter.take("all", now)) {
        warnCapFull(siteCounter, "[auth] sign-up email limit reached for this hour", now);
        return;
      }
      // Any user at all, an unused invitation included: email B, addressed with the name stored on that account, never the one
      // typed into the form (anyone can type anything there).
      const existing = db.prepare("SELECT email, first_name FROM users WHERE email = ?").get(key);
      if (existing) {
        sendAfterAnswer("already-registered", sendTaken, { to: existing.email, firstName: existing.first_name });
        return;
      }
      const token = issueSignup(db, { email: key, firstName, lastName, orgName, passwordHash, tester, ...agreed }, now);
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

// POST /api/auth/register/complete { token, password } — "Create my account". The person finishing must also type the password
// chosen at sign-up: otherwise whoever asked for the link could pick a password, wait for the address's owner to click "Create my
// account", and then sign in to that account with the password they chose. A missing, non-string or wrong password is a 400 that
// uses nothing up (the link stays good). completeSignup is the one place the link is used up: in one transaction it checks the
// request again (still unexpired, and the address still has no user, since an invitation could have arrived in the meantime),
// creates the organization on its 14-day trial and the broker with the password hashed at sign-up, and deletes the request. Every
// refusal of the link is the same 410. Then the new broker is signed in, as /login does.
// With billing on, the organization starts with no card (billing_status 'none'), or in its free test month if the request came
// with a usable tester code and the code still has a place (asked again in that transaction). The answer's `tester` is true only
// when the month was granted (the page then shows "Start testing" instead of the card ask). Either way the acceptance given at
// sign-up is recorded in the same transaction as the account. For a tester, the Stripe side runs before the answer (bounded).
router.post("/register/complete", signupCompleteLimiter, (req, res) => {
  const { token, password } = req.body ?? {};
  const request = signupFor(db, token, Date.now());
  if (!request) return res.status(410).json(LINK_GONE);
  if (typeof password !== "string" || !bcrypt.compareSync(password, request.password_hash)) {
    return res.status(400).json({ success: false, error: "That isn't the password you chose when you signed up. Try again, or start again to choose a new one." });
  }
  const billing = billingConfigOn(req);
  const nowMs = Date.now();
  // The account and the acceptance together or not at all. The versions are the ones stored with the request, so what the person
  // was shown (a request is only ever replaced under a new token, so the row read above is the one completeSignup uses). A request
  // made while billing was off agreed to nothing, so nothing is recorded: with billing on later, the terms page asks them.
  const user = db.transaction(() => {
    const created = completeSignup(db, token, nowMs, { billingOn: Boolean(billing), config: billing });
    if (created && request.terms_version && request.privacy_version) {
      recordAcceptance(db, created.id, { termsVersion: request.terms_version, privacyVersion: request.privacy_version }, nowMs, req.ip);
    }
    return created;
  })();
  if (!user) return res.status(410).json(LINK_GONE);
  const org = db.prepare("SELECT name, billing_via_tester_code, billing_tester_until FROM organizations WHERE id = ?").get(user.org_id);
  const tester = Boolean(billing && org.billing_via_tester_code);
  setSession(res, user);
  const answer = () => res.json({ success: true, user: safeUser(user), tester });
  if (!tester) return answer();
  startTesterSubscription(req, billing, user, org).then(answer, answer);
});

// How long "Create my account" waits for the tester month's Stripe side before answering without it (the work carries on).
// app.set("testerSubscriptionWaitMs", n) overrides it (tests).
const TESTER_WAIT_MS = 8_000;

// The tester month's Stripe side (spec §6.1.3): a customer and a trialing subscription for one user with no card, ending when the
// month ends (Stripe cancels it then if no card was added), stored by the webhook's own rules, then the follow-ups that leaves (the
// test-month confirmation email). Run before the answer, like the webhook's follow-ups (ruling 9: Cloud Run throttles the CPU once
// a response has gone), but for at most TESTER_WAIT_MS, so a slow Stripe never holds up "Create my account" for long. The month
// itself already runs from our database, so a timeout or a failure costs only Stripe's side: it is logged by our organization id
// and the error's message, never an address or a Stripe object. (If Stripe did make the subscription, its own webhook event
// carries our org id and stores it.) Billing on with no gateway: the month runs with no Stripe subscription, and the log says so.
// Never rejects.
async function startTesterSubscription(req, config, user, org) {
  const orgId = user.org_id;
  const failed = (err) => console.error(`[billing] tester subscription failed for org ${orgId}:`, err?.message);
  let timer;
  try {
    const gateway = req.app.get("billingGateway");
    if (!gateway) {
      console.warn(`[billing] tester month for org ${orgId} started with no Stripe subscription: no payment service is set up`);
      return;
    }
    const send = req.app.get("sendBillingConfirmation") || email.sendBillingConfirmation;
    const waitMs = req.app.get("testerSubscriptionWaitMs") ?? TESTER_WAIT_MS;
    // Never rejects either: a failure is logged where it happens, also one that comes after the wait has given up.
    const work = (async () => {
      const created = await gateway.createTesterSubscription({
        email: user.email, orgId, orgName: org.name, priceId: config.priceId, quantity: 1, trialEndMs: org.billing_tester_until,
      });
      await runFollowUps({ db, gateway, send, config }, storeSubscription(db, orgId, created.subscription, wholeSecond(Date.now())));
      return true;
    })().catch((err) => { failed(err); return true; });
    const done = await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); })]);
    if (!done) console.error(`[billing] tester subscription for org ${orgId} not finished after ${waitMs} ms: answered without it`);
  } catch (err) {
    failed(err);
  } finally {
    clearTimeout(timer);
  }
}

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

// POST /api/auth/terms/accept — the signed-in user agrees to the current Terms of Service and Privacy Policy ("We've updated our
// terms" → I agree, spec §6.6): both are recorded with the time and the address it came from. Not behind the billing gate: it is
// how a user the gate stops with "terms" (no acceptance yet, or an older version) gets past it.
router.post("/terms/accept", requireAuth, (req, res) => {
  try {
    recordAcceptance(db, req.user.id, CURRENT_VERSIONS, Date.now(), req.ip);
  } catch (err) {
    console.error("[auth] terms acceptance not recorded", err?.message);
    return res.status(500).json({ success: false, error: "Database error" });
  }
  res.json({ success: true });
});

// POST /api/auth/invite — broker invites an LO
// A locked brokerage can't add users (the billing gate, middleware/access.js); the rest of this router stays open.
router.post("/invite", requireAuth, requireAccess, inviteLimiter, async (req, res) => {
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
// With billing on, the page's terms tick (`acceptTerms: true`) is required too, checked with the password (it costs nothing either),
// and the current Terms and Privacy versions are recorded in the same transaction that accepts the invitation (spec §6.6).
router.post("/accept-invite", acceptInviteLimiter, (req, res) => {
  const { token, password, acceptTerms } = req.body ?? {};
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
  }
  if (password.length > PASSWORD_MAX) {
    return res.status(400).json({ success: false, error: `Password must be at most ${PASSWORD_MAX} characters` });
  }
  const billingOn = Boolean(billingConfigOn(req));
  if (billingOn && acceptTerms !== true) return res.status(400).json(TERMS_REQUIRED);

  const user = inviteeFor(token, Date.now());
  if (!user) return res.status(410).json(INVITE_GONE);

  const hash = bcrypt.hashSync(password, 12);
  const changed = db.transaction(() => {
    const n = db.prepare(
      "UPDATE users SET password_hash = ?, invite_token_hash = NULL, invite_expires = NULL, invite_accepted = 1 WHERE id = ? AND invite_accepted = 0"
    ).run(hash, user.id).changes;
    if (n && billingOn) recordAcceptance(db, user.id, CURRENT_VERSIONS, Date.now(), req.ip);
    return n;
  })();
  if (!changed) return res.status(410).json(INVITE_GONE);

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  setSession(res, updated);
  res.json({ success: true, user: safeUser(updated) });

  // A new user is a new seat: with billing on and a subscription on file, Stripe's quantity follows (H2). After the answer, so a
  // slow or failing Stripe never holds up the person joining; a failure is logged by its message and tried again on the broker's
  // next billing status call.
  try {
    const config = req.app.get("billingConfig");
    const gateway = req.app.get("billingGateway");
    if (!config?.enabled || !gateway) return;
    const org = db.prepare("SELECT stripe_subscription_id FROM organizations WHERE id = ?").get(updated.org_id);
    if (!org?.stripe_subscription_id) return;
    syncSeats(db, gateway, updated.org_id)
      .catch((err) => console.error(`[billing] sync_seats failed for org ${updated.org_id}:`, err?.message));
  } catch (err) {
    console.error(`[billing] sync_seats failed for org ${updated.org_id}:`, err?.message);
  }
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
      // email and uses up none of its 3 reset emails an hour. Sign-up counts its emails under a key of its own, so sign-up requests
      // never use these up. (The counter forgets an address an hour after its last send, so it can't grow without end either way.)
      // The site-wide count is asked last, only once this account has passed its own limit, so one account being asked for over and
      // over can't use up the whole site's allowance. Past either limit nothing is stored and nothing is sent; a full site cap is
      // logged (once an hour, no address).
      const user = db.prepare("SELECT id, email, first_name FROM users WHERE email = ? AND invite_accepted = 1").get(key);
      if (!user || !counter.take(key, Date.now())) return;
      if (!siteCounter.take("all", Date.now())) {
        warnCapFull(siteCounter, "[auth] reset email limit reached for this hour", Date.now());
        return;
      }
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
