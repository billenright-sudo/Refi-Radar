"use strict";
// The client emails Charli can set up, and the compose links that open them in the broker's own mail app.
//
// Charli never writes an email and never sends one. The wording below is code-authored and fixed (Bill approves it):
// it quotes no rate and no dollar figure (advertising a mortgage figure carries disclosure duties), and every email ends
// with the sender's NMLS ID (and the company's, when it has one), as mortgage advertising rules expect. The broker
// reads the email in their own Gmail, Outlook or mail app and sends it from there, or doesn't.

const PURPOSES = ["check_in", "refi_review"];
// How each purpose is said aloud and in a read-back.
const PURPOSE_WORDS = { check_in: "check-in", refi_review: "refinance review" };

// Null-prototype: a model-supplied purpose like "constructor" must not resolve to an inherited function.
const TEMPLATES = Object.freeze(Object.assign(Object.create(null), {
  check_in: {
    subject: "Checking in",
    paragraphs: [
      "Hi {clientName},",
      "It's been a little while since we last talked, so I wanted to check in and see how everything is going with the house.",
      "If anything has changed on your end, like plans to move, renovate, or put some of your equity to work, I'd be glad to walk through your options with you. Just reply here whenever it's convenient.",
      "Best,\n{SIGNATURE}",
    ],
  },
  refi_review: {
    subject: "A fresh look at your mortgage",
    paragraphs: [
      "Hi {clientName},",
      "The mortgage market has shifted since you closed on your loan, and it could be worth taking a fresh look at where you stand. I'd be happy to put together a no-obligation review of your options.",
      "Would you have a few minutes this week? Just reply with a time that works for you.",
      "Best,\n{SIGNATURE}",
    ],
  },
}));

// An NMLS ID is digits only, one to twelve of them. Surrounding space is ignored and an empty value clears the ID.
// -> { value: "123456" } | { value: null } (cleared) | { invalid: true }. Anything that is not a string is invalid.
const NMLS_PATTERN = /^\d{1,12}$/;
function parseNmls(raw) {
  if (typeof raw !== "string") return { invalid: true };
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  return NMLS_PATTERN.test(trimmed) ? { value: trimmed } : { invalid: true };
}

// The email for one purpose, or null for a purpose that is not in PURPOSES. `clientName` is the stored name as it is (no
// first-name guessing) and `senderName` the user's first and last name. The signature is the sender's name, their NMLS ID,
// the company and, only when the company has one, the company's NMLS ID. Line breaks are "\n"; there is no trailing newline.
function renderEmail({ clientName, senderName, nmlsId, orgName, orgNmlsId, purpose } = {}) {
  const template = typeof purpose === "string" ? TEMPLATES[purpose] : undefined;
  if (!template) return null;
  const lines = [senderName, `NMLS #${nmlsId}`, orgName];
  if (orgNmlsId) lines.push(`NMLS #${orgNmlsId}`);
  const signature = lines.join("\n");
  // One pass over the template, so text that is filled in is never scanned again: a client named "{SIGNATURE}" stays a name.
  const body = template.paragraphs
    .map((paragraph) => paragraph.replace(/\{clientName\}|\{SIGNATURE\}/g, (token) => (token === "{SIGNATURE}" ? signature : clientName)))
    .join("\n\n");
  return { subject: template.subject, body };
}

// Links that open a prefilled, unsent message. Every value goes through encodeURIComponent, so a "&", "#" or "?" in a
// subject or body can't end the value early. A mailto link wants its line breaks as CRLF.
function composeLinks({ to, subject, body }) {
  const t = encodeURIComponent(to);
  const s = encodeURIComponent(subject);
  const b = encodeURIComponent(body);
  const mailtoBody = encodeURIComponent(String(body).replace(/\r?\n/g, "\r\n"));
  return {
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${t}&su=${s}&body=${b}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${t}&subject=${s}&body=${b}`,
    mailto: `mailto:${t}?subject=${s}&body=${mailtoBody}`,
  };
}

module.exports = { PURPOSES, PURPOSE_WORDS, NMLS_PATTERN, parseNmls, renderEmail, composeLinks };
