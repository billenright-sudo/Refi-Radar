"use strict";
// The one way a client email is set up: Charlie's draftEmailTool (lib/assistant/tools.js) and the Dates Coming Up button
// (POST /api/clients/:id/email, routes/clients.js) both call setUpEmail, so the rules cannot drift between them:
//   * the wording is the fixed template for the purpose (lib/assistant/outreach.js); nothing a caller passes but the purpose and,
//     for a family birthday, which family member, is read;
//   * a client marked "do not email" never gets one; the sender's NMLS ID signs every email (none saved: no email);
//   * the recipient is the address on the client's record;
//   * a family member is named from the client's record (lib/personal.js), never from the model or the browser.
// Nothing here sends or saves anything.
const { PURPOSES, NMLS_PATTERN, renderEmail, composeLinks, OCCASION_PURPOSES } = require("./outreach");
const { parsePersonal } = require("../personal");
const occasions = require("../occasions");

// One address, nothing else: no space, no angle brackets, no comma, semicolon or quote (so no second recipient, no display
// name, no header line smuggled in behind a newline).
const EMAIL_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const isNmls = (v) => typeof v === "string" && NMLS_PATTERN.test(v);
const SPOUSE_WORDS = "your spouse";
const fold = (s) => s.trim().toLowerCase();

// The family member a family birthday is for, from the stored details: { who, kind } (who: the stored name, or null for a spouse
// with no name on file) | { code: "invalid" | "who_needed" }. A named `who` must be the stored spouse name or a stored child's name
// (trimmed, case-insensitive); left out (or blank), the one family member with a birthday on file is taken.
function familyMember(personal, who) {
  const p = personal || {};
  const children = Array.isArray(p.children) ? p.children.filter((c) => c && c.name) : [];
  if (who != null && typeof who !== "string") return { code: "invalid" };
  if (typeof who === "string" && who.trim()) {
    const wanted = fold(who);
    if (p.spouseName && fold(p.spouseName) === wanted) return { who: p.spouseName, kind: "spouse_birthday" };
    const child = children.find((c) => fold(c.name) === wanted);
    return child ? { who: child.name, kind: "child_birthday" } : { code: "invalid" };
  }
  const withBirthday = [
    ...(p.spouseBirthday ? [{ who: p.spouseName || null, kind: "spouse_birthday" }] : []),
    ...children.filter((c) => c.birthday).map((c) => ({ who: c.name, kind: "child_birthday" })),
  ];
  return withBirthday.length === 1 ? withBirthday[0] : { code: "who_needed" };
}

// setUpEmail(db, user, clientRow, { purpose, who }) -> { ok: true, email: { to, subject, body, links }, who, kind? } | { ok: false, code, client? }
// `user` is the caller's users row (its id and org_id are read; the name and NMLS IDs are read fresh from the DB, so an ID just saved
// works at once) and `clientRow` a clients row the caller may act on (the caller has scoped it). `who` in the answer is the family
// member's stored name (null when there is none, or for a spouse with no name on file) and `kind` the occasion kind of a family
// birthday. Refusals, in this order: invalid (an unknown purpose), do_not_email, unavailable (the profile could not be read),
// nmls_missing, no_email, then invalid (a `who` not on the record) or who_needed. do_not_email, no_email and who_needed name the client.
function setUpEmail(db, user, clientRow, { purpose, who } = {}) {
  if (typeof purpose !== "string" || !PURPOSES.includes(purpose)) return { ok: false, code: "invalid" };
  if (clientRow.do_not_email === 1) return { ok: false, code: "do_not_email", client: clientRow.name };

  const sender = db.prepare("SELECT first_name, last_name, nmls_id FROM users WHERE id = ?").get(user.id);
  const org = db.prepare("SELECT name, nmls_id FROM organizations WHERE id = ?").get(user.org_id);
  if (!sender || !org) return { ok: false, code: "unavailable" };
  if (!isNmls(sender.nmls_id)) return { ok: false, code: "nmls_missing" };
  if (typeof clientRow.email !== "string" || !EMAIL_PATTERN.test(clientRow.email)) return { ok: false, code: "no_email", client: clientRow.name };

  let member = null;
  if (purpose === "family_birthday") {
    member = familyMember(parsePersonal(clientRow.personal), who);
    if (member.code) return member.code === "who_needed" ? { ok: false, code: "who_needed", client: clientRow.name } : { ok: false, code: "invalid" };
  }

  const mail = renderEmail({
    clientName: clientRow.name,
    senderName: `${sender.first_name} ${sender.last_name}`.trim(),
    nmlsId: sender.nmls_id,
    orgName: org.name,
    orgNmlsId: isNmls(org.nmls_id) ? org.nmls_id : null,
    purpose,
    ...(member ? { who: member.who || SPOUSE_WORDS } : {}),
  });
  if (!mail) return { ok: false, code: "unavailable" };
  const to = clientRow.email;
  const email = { to, subject: mail.subject, body: mail.body, links: composeLinks({ to, subject: mail.subject, body: mail.body }) };
  return member ? { ok: true, email, who: member.who, kind: member.kind } : { ok: true, email, who: null };
}

// The client's soonest occasion of an occasion `purpose`'s kinds from `today` through `days` days after it, as
// { kind, who, date } (who '' when there is none), or null. For a family birthday, `member` ({ who, kind } from setUpEmail) says
// which family member.
function matchingOccasion(clientRow, purpose, member, today, days) {
  const kinds = typeof purpose === "string" ? OCCASION_PURPOSES[purpose] : undefined;
  if (!kinds) return null;
  const m = member || {};
  const found = occasions.occasionsFor(occasions.fromRow(clientRow), today, days).find((o) =>
    kinds.includes(o.kind) && (purpose !== "family_birthday" || (o.kind === m.kind && (o.who || null) === (m.who || null))));
  return found ? { kind: found.kind, who: found.who || "", date: found.date } : null;
}

module.exports = { EMAIL_PATTERN, setUpEmail, matchingOccasion, familyMember };
