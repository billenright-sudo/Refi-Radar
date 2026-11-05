"use strict";
const nodemailer = require("nodemailer");

function createTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,   // Gmail App Password (not account password)
    },
  });
}

const APP_URL = process.env.APP_URL || "http://localhost:8080";
const FROM    = process.env.EMAIL_USER || "noreply@refi-radar.com";

// The invitation secret goes after the "#", which a browser never sends to a server, so it stays out of request logs. The page reads it
// and checks it with a POST.
function inviteLink(token) {
  return `${APP_URL}/#invite=${token}`;
}

// Names in the HTML bodies below come from people (a broker types the company and the invitee, a client's name comes from an import),
// so they go through escapeHtml (defined further down). Subjects are plain text, so they are left as typed.
async function sendInvite({ toEmail, toName, fromName, orgName, token }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("[email] EMAIL_USER/EMAIL_PASS not set — skipping invite email");
    return;
  }
  const link = inviteLink(token);
  await createTransport().sendMail({
    from: `"Broker Radar" <${FROM}>`,
    to: toEmail,
    subject: `${fromName} invited you to join ${orgName} on Broker Radar`,
    html: `
      <h2>You've been invited to Broker Radar</h2>
      <p><strong>${escapeHtml(fromName)}</strong> has invited you to join <strong>${escapeHtml(orgName)}</strong> as a Loan Officer on Broker Radar — the broker intelligence platform.</p>
      <p><a href="${link}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept Invitation</a></p>
      <p style="color:#666;font-size:12px">This link expires in 48 hours. If you didn't expect this invitation, you can ignore this email.</p>
    `,
  });
}

async function sendRefiAlert({ toEmail, toName, clientName, brokerName, monthlySavings }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("[email] EMAIL_USER/EMAIL_PASS not set — skipping alert email");
    return;
  }
  await createTransport().sendMail({
    from: `"Broker Radar" <${FROM}>`,
    to: toEmail,
    subject: `Action needed: ${clientName} is ready to refinance`,
    html: `
      <h2>Refi Opportunity Alert</h2>
      <p>Hi ${escapeHtml(toName)},</p>
      <p>Your broker <strong>${escapeHtml(brokerName)}</strong> has flagged <strong>${escapeHtml(clientName)}</strong> as a high-priority refinance opportunity, with potential savings of <strong>$${Math.round(monthlySavings)}/month</strong>.</p>
      <p>Log in to Broker Radar to review this client's analysis and follow up.</p>
      <p><a href="${APP_URL}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View in Broker Radar</a></p>
    `,
  });
}

// The link that confirms a login-email change (routes/profile.js), mailed to the NEW address only. Resolves true once Gmail has
// taken the mail, false when EMAIL_USER/EMAIL_PASS are unset or the send fails, so the caller can say so instead of promising
// a mail that never left. The link carries the secret token: it is never logged, and neither is the token.
async function sendEmailChange(to, link) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("[email] EMAIL_USER/EMAIL_PASS not set — skipping email-change email");
    return false;
  }
  try {
    await createTransport().sendMail({
      from: `"Broker Radar" <${FROM}>`,
      to,
      subject: "Confirm your new Broker Radar login email",
      html: `
      <h2>Confirm your new login email</h2>
      <p>You asked to use this address to sign in to Broker Radar. Confirm it to finish the change.</p>
      <p><a href="${link}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Confirm new email</a></p>
      <p style="color:#666;font-size:12px">This link expires in 48 hours. Until you confirm, you keep signing in with your current email. If you didn't ask for this, you can ignore this email.</p>
    `,
    });
    return true;
  } catch (err) {
    console.error("[email] email-change send failed:", err.message);
    return false;
  }
}

// Whether a link mailed from here can be opened by the person it goes to. In production APP_URL must be set, and must not name this
// machine: APP_URL above falls back to http://localhost:8080, so without it every link would open nothing (and the page would still
// say "check your inbox"). Outside production (development, tests) any value goes. `env` is process.env, or the "profileEnv" app
// seam in tests. Pure.
const LOCAL_HOST_RE = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;
function emailLinksWork(env) {
  if (!env || env.NODE_ENV !== "production") return true;
  const base = typeof env.APP_URL === "string" ? env.APP_URL.trim() : "";
  if (!base) return false;
  let host;
  try { host = new URL(base).hostname; } catch { return false; }
  return !LOCAL_HOST_RE.test(host);
}

// Whether a reset email can really reach someone: both mail settings present and a link that opens somewhere. The reset route
// answers 503 when this is false, before it stores anything. Pure.
function mailReady(env) {
  return Boolean(env && env.EMAIL_USER && env.EMAIL_PASS) && emailLinksWork(env);
}

// Names and addresses come from people, so every email body escapes them before they go into the HTML.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The wording is Bill's, approved 2026-11-03 (forgot-password design §7): change it only with his say-so. Nothing is tracked.
function passwordResetMessage({ firstName, email, link }) {
  return {
    subject: "Reset your Broker Radar password",
    html: `
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Someone asked to reset the password for your Broker Radar account (${escapeHtml(email)}). To choose a new password, use this button within 60 minutes:</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Choose a new password</a></p>
      <p style="color:#666;font-size:12px">If you didn't ask for this, you can ignore this email. Your password won't change.</p>
    `,
  };
}

function passwordChangedMessage({ firstName, email }) {
  return {
    subject: "Your Broker Radar password was changed",
    html: `
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>The password for your Broker Radar account (${escapeHtml(email)}) was just changed, and any other devices signed in to it were signed out.</p>
      <p>If you did this, there's nothing else to do. If you didn't, reset your password from the Broker Radar sign-in page right away and let your broker know.</p>
    `,
  };
}

// The two sign-up emails. The wording is Bill's, approved 2026-11-05 (auth-hardening design §6): change it only with his say-so.
// A goes to a new address and carries the sign-up link; B goes to an address that already has an account or an invitation.
function signupMessage({ firstName, orgName, email, link }) {
  return {
    subject: "Finish creating your Broker Radar account",
    html: `
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Thanks for starting a Broker Radar trial for ${escapeHtml(orgName)}. To finish creating your account (${escapeHtml(email)}), use this button within 24 hours:</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Create my account</a></p>
      <p style="color:#666;font-size:12px">If you didn't ask for this, you can ignore this email. No account will be created.</p>
    `,
  };
}

function alreadyRegisteredMessage({ firstName, email, link }) {
  return {
    subject: "You already have a Broker Radar account",
    html: `
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Someone just tried to create a new Broker Radar account with your email (${escapeHtml(email)}), but there's already an account or an invitation for this address.</p>
      <p>If this was you, sign in instead. If you've forgotten your password, use "Forgot password?" on the sign-in page. If your broker invited you, use the link in that invitation.</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Go to sign in</a></p>
      <p style="color:#666;font-size:12px">If it wasn't you, you can ignore this email. Nothing has changed.</p>
    `,
  };
}

// The billing confirmation (spec §6.1.5, H6): one email to the broker when the brokerage's first subscription starts, with the end of
// the free trial or test month, the price after it, and how to cancel. DRAFT wording for Bill's approval (spec §10): change it only
// with his say-so. `kind` is "trial" (a card was added) or "tester" (a test month with no card yet).
function billingConfirmationMessage({ firstName, orgName, kind, endDate, totalLine }) {
  const tester = kind === "tester";
  return {
    subject: tester ? "Your Broker Radar test month has started" : "Your Broker Radar trial has started",
    html: `
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>${escapeHtml(orgName)}'s free ${tester ? "test month" : "trial"} runs until ${escapeHtml(endDate)}.</p>
      <p>${tester
        ? "Before it ends we'll ask you for a card; without one, Broker Radar pauses and your data is kept."
        : "After that, Broker Radar is $99 a month, plus $49 for each additional user, charged to the card you added until you cancel."}</p>
      ${totalLine ? `<p>${escapeHtml(totalLine)}</p>` : ""}
      <p>You can cancel any time in Broker Radar under Billing → Manage billing.</p>
    `,
  };
}

// Sends one of the messages above. Resolves true once Gmail has taken the mail, false when EMAIL_USER/EMAIL_PASS are unset or
// the send fails; the caller decides what to do (the routes never tell the page, which must not reveal whether an account exists).
// A reset message carries the secret link, so only err.message is logged, never the message, the link or the token.
async function deliverPasswordMail(to, buildMessage, what) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn(`[email] EMAIL_USER/EMAIL_PASS not set — skipping ${what} email`);
    return false;
  }
  try {
    const { subject, html } = buildMessage();   // built inside the try, so odd input gives false rather than a throw
    await createTransport().sendMail({ from: `"Broker Radar" <${FROM}>`, to, subject, html });
    return true;
  } catch (err) {
    console.error(`[email] ${what} send failed:`, err.message);
    return false;
  }
}

function sendPasswordReset({ to, firstName, link }) {
  return deliverPasswordMail(to, () => passwordResetMessage({ firstName, email: to, link }), "password-reset");
}

function sendPasswordChanged({ to, firstName }) {
  return deliverPasswordMail(to, () => passwordChangedMessage({ firstName, email: to }), "password-changed");
}

function sendSignup({ to, firstName, orgName, link }) {
  return deliverPasswordMail(to, () => signupMessage({ firstName, orgName, email: to, link }), "sign-up");
}

function sendAlreadyRegistered({ to, firstName }) {
  return deliverPasswordMail(to, () => alreadyRegisteredMessage({ firstName, email: to, link: `${APP_URL}/` }), "already-registered");
}

function sendBillingConfirmation({ to, firstName, orgName, kind, endDate, totalLine }) {
  return deliverPasswordMail(to, () => billingConfirmationMessage({ firstName, orgName, kind, endDate, totalLine }), "billing-confirmation");
}

module.exports = {
  sendInvite, inviteLink, sendRefiAlert, sendEmailChange, APP_URL,
  emailLinksWork, mailReady,
  passwordResetMessage, passwordChangedMessage, sendPasswordReset, sendPasswordChanged,
  signupMessage, alreadyRegisteredMessage, sendSignup, sendAlreadyRegistered,
  billingConfirmationMessage, sendBillingConfirmation,
};
