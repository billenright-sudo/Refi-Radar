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

async function sendInvite({ toEmail, toName, fromName, orgName, token }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("[email] EMAIL_USER/EMAIL_PASS not set — skipping invite email");
    return;
  }
  const link = `${APP_URL}/accept-invite?token=${token}`;
  await createTransport().sendMail({
    from: `"RefiRadar" <${FROM}>`,
    to: toEmail,
    subject: `${fromName} invited you to join ${orgName} on RefiRadar`,
    html: `
      <h2>You've been invited to RefiRadar</h2>
      <p><strong>${fromName}</strong> has invited you to join <strong>${orgName}</strong> as a Loan Officer on RefiRadar — the broker intelligence platform.</p>
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
    from: `"RefiRadar" <${FROM}>`,
    to: toEmail,
    subject: `Action needed: ${clientName} is ready to refinance`,
    html: `
      <h2>Refi Opportunity Alert</h2>
      <p>Hi ${toName},</p>
      <p>Your broker <strong>${brokerName}</strong> has flagged <strong>${clientName}</strong> as a high-priority refinance opportunity, with potential savings of <strong>$${Math.round(monthlySavings)}/month</strong>.</p>
      <p>Log in to RefiRadar to review this client's analysis and follow up.</p>
      <p><a href="${APP_URL}" style="display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View in RefiRadar</a></p>
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
      from: `"RefiRadar" <${FROM}>`,
      to,
      subject: "Confirm your new RefiRadar login email",
      html: `
      <h2>Confirm your new login email</h2>
      <p>You asked to use this address to sign in to RefiRadar. Confirm it to finish the change.</p>
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

module.exports = { sendInvite, sendRefiAlert, sendEmailChange, APP_URL };
