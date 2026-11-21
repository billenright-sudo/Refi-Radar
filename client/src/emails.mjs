// The occasion emails on Home's Dates Coming Up and on Charlie's compose card (design 2026-11-21): which email a date calls for,
// the plain line a refusal shows, whether a date was already marked emailed, and the bodies the two routes take. The email itself
// is set up by the server (POST /api/clients/:id/email); nothing here or there sends anything. Pure: no I/O.
//
// purposeForKind mirrors server/lib/assistant/outreach.js (the test holds the two together).

const KIND_PURPOSE = Object.freeze({
  birthday: "birthday", spouse_birthday: "family_birthday", child_birthday: "family_birthday", wedding: "wedding_anniversary",
  loan: "home_anniversary", home: "home_anniversary",
});
const PURPOSES = new Set(["check_in", "refi_review", ...Object.values(KIND_PURPOSE)]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The three ways an email opens, in the broker's own mail app: the compose links the server sets up.
export const COMPOSE_LINKS = Object.freeze([["gmail", "Open in Gmail"], ["outlook", "Open in Outlook"], ["mailto", "Other email app"]]);

// The links a server email opens with, as the browser may follow them: each of the three must start with its provider's compose
// address. -> a fresh { gmail, outlook, mailto }, or null when any one is missing or is anything else (then nothing opens).
const COMPOSE_LINK_PREFIXES = Object.freeze({ gmail: "https://mail.google.com/", outlook: "https://outlook.office.com/", mailto: "mailto:" });
export function safeComposeLinks(links) {
  if (!links || typeof links !== "object" || Array.isArray(links)) return null;
  const kept = {};
  for (const [key, prefix] of Object.entries(COMPOSE_LINK_PREFIXES)) {
    if (typeof links[key] !== "string" || !links[key].startsWith(prefix)) return null;
    kept[key] = links[key];
  }
  return kept;
}

// The `who` a family birthday is asked for: the family member's stored name, or "your spouse" for a spouse with no name on file
// (the server takes it only then).
const whoFor = (kind, who) => (who ? who : kind === "spouse_birthday" ? "your spouse" : null);

// The email purpose for an occasion kind (lib/occasions.js), or null.
export const purposeForKind = (kind) => (typeof kind === "string" && Object.hasOwn(KIND_PURPOSE, kind) ? KIND_PURPOSE[kind] : null);

// The one plain line a refused email shows, by the server's code.
const REFUSALS = Object.freeze({
  do_not_email: "This client is marked do not email.",
  no_email: "No email address on file. Add one on the client's Edit page.",
  nmls_missing: "Save your NMLS ID in Profile first. Every client email carries it.",
});
export const refusalLine = (code) => (typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : "Couldn't set up the email. Try again.");

// Whether `occasion` ({ kind, who, date }; who null when there is none) is among `client.occasionEmails` (the API's
// [{ kind, who, date }], who '' when there is none).
export function isEmailed(client, occasion) {
  const list = client && Array.isArray(client.occasionEmails) ? client.occasionEmails : [];
  if (!occasion) return false;
  const who = occasion.who || "";
  return list.some((e) => e && e.kind === occasion.kind && (e.who || "") === who && e.date === occasion.date);
}

// What POST /api/clients/:id/email takes for a date's row: { purpose, who? } (who only for a family member's birthday: the name, or
// "your spouse" for a spouse with no name on file), or null for an occasion kind with no email.
export function emailRequest(occasion) {
  const purpose = purposeForKind(occasion && occasion.kind);
  if (!purpose) return null;
  const who = purpose === "family_birthday" ? whoFor(occasion.kind, occasion.who) : null;
  return who ? { purpose, who } : { purpose };
}

// What POST /api/clients/:id/email-sent takes for a date's row: the email's request and the occasion's date.
export function sentRequest(occasion) {
  const ask = emailRequest(occasion);
  return ask ? { ...ask, date: occasion.date } : null;
}

// What POST /api/clients/:id/email-sent takes for Charlie's compose card: { purpose } and, when the compose names the occasion
// coming up, its family member and date. null when the compose names no client or purpose (no Mark sent).
export function composeSentRequest(compose) {
  if (!compose || !Number.isInteger(compose.clientId) || compose.clientId <= 0 || !PURPOSES.has(compose.purpose)) return null;
  const o = compose.occasion;
  if (!o || purposeForKind(o.kind) !== compose.purpose || typeof o.date !== "string" || !DAY_RE.test(o.date)) return { purpose: compose.purpose };
  const who = compose.purpose === "family_birthday" ? whoFor(o.kind, o.who) : null;
  return { purpose: compose.purpose, ...(who ? { who } : {}), date: o.date };
}

// Charlie's compose's Mark sent fields, kept only as the server documents them: { clientId, purpose, occasion? }, each field dropped
// when it is not that shape (an empty object when none is usable).
export function composeMarkFields(compose) {
  if (!compose || typeof compose !== "object") return {};
  const { clientId, purpose, occasion } = compose;
  if (!Number.isInteger(clientId) || clientId <= 0 || typeof purpose !== "string" || !PURPOSES.has(purpose)) return {};
  const out = { clientId, purpose };
  if (occasion && typeof occasion === "object" && purposeForKind(occasion.kind) === purpose && typeof occasion.who === "string" &&
    typeof occasion.date === "string" && DAY_RE.test(occasion.date)) {
    out.occasion = { kind: occasion.kind, who: occasion.who, date: occasion.date };
  }
  return out;
}
