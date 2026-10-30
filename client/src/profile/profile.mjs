// The Profile page's logic, with no DOM and no React (the page is ProfileView.jsx, the cards it shares with the old Charlie panel
// are in cards.jsx). Each API wrapper takes the fetch to use, calls the app's own server and never throws:
//   -> { ok: true, data } | { ok: false, error }     `error` is a line to show the user as it is.
//
// Server contracts (server/routes/profile.js):
//   GET  /api/profile                  -> { firstName, lastName, email, pendingEmail, careerStage, nmlsId, orgNmlsId, canEditOrg }
//   PUT  /api/profile/name             { firstName, lastName }  -> the profile; 400 "Use letters only in your name"
//   PUT  /api/profile/career-stage     { stage }                -> the profile; 400 "A valid career stage is required"
//   POST /api/profile/email            { email }                -> { pendingEmail }; 400, 409 (taken), 429 (5 an hour), 503 (mail not set up)
//   PUT  /api/profile/nmls             { nmlsId }               -> { nmlsId, orgNmlsId, canEditOrg } (NOT the whole profile)
//   PUT  /api/profile/org-nmls         { nmlsId }               -> the same (a broker only)
//   The emailed confirm link sends the browser to /?emailChanged=1 (done) or /?emailChanged=0 (did not work).

export const BAD_NAME = "Use letters only in your name";
export const TOO_MANY = "Too many tries. Please wait a bit and try again.";
const NO_SERVER = "Couldn't reach the server. Check your connection and try again.";
const SESSION_ENDED = "Your session has ended. Sign in again.";

// ── validators: keep in sync with parseNamePart and EMAIL_RE in server/routes/profile.js ──

const NAME_MAX = 50;
const EMAIL_MAX = 254;
// A basic x@y.z: no whitespace, no empty label, and none of <>(),;:"\[] anywhere (those make a mailer read a display name, a quoted
// local part or a list, i.e. a different or an extra recipient).
const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@.<>(),;:"\\[\]]+(\.[^\s@.<>(),;:"\\[\]]+)+$/;

// A name part the way the server stores it: trimmed, with a curly apostrophe (iOS smart punctuation types U+2018 / U+2019) made a
// plain one. Anything that is not a string is "".
export function cleanName(value) {
  return typeof value === "string" ? value.trim().normalize("NFC").replace(/[\u2018\u2019]/g, "'") : "";
}

// Whether `value` is a name part: letters, spaces, apostrophes and hyphens only, with a letter in it if it is not empty, and at most
// 50 characters. `required` parts need at least one character.
function namePart(value, required) {
  if (typeof value !== "string") return false;
  const name = cleanName(value);
  if (name.length > NAME_MAX || (required && name.length < 1)) return false;
  return name.length === 0 || (/^[\p{L} '-]+$/u.test(name) && /\p{L}/u.test(name));
}

// -> null when the names are fine, else the message the server would answer with. The first name is required, the last may be empty.
export function validName(first, last) {
  return namePart(first, true) && namePart(last, false) ? null : BAD_NAME;
}

// -> boolean. The address is trimmed first, as the server does (it also lowercases, which changes nothing here).
export function validEmail(value) {
  if (typeof value !== "string") return false;
  const mail = value.trim();
  return mail.length <= EMAIL_MAX && EMAIL_RE.test(mail);
}

// ── the API wrappers ──

// One call to the app's own API. -> { network: true } when it could not be made, else { status, ok, data } (data null when the body
// was not JSON).
async function send(fetchFn, method, url, body) {
  try {
    const init = body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetchFn(url, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: !!res.ok, status: res.status, data };
  } catch {
    return { network: true };
  }
}

// The server's own words are shown for the answers it writes for a person (400, 409, 429, 503). Any other failure, a 500 above all
// ("Database error"), is shown as the call's plain `fallback`.
const SPEAKS = new Set([400, 409, 429, 503]);
const messageOf = (data) => (data && typeof data.error === "string" && data.error.trim()) || "";

function answer(res, { accept, fallback }) {
  if (res.network) return { ok: false, error: NO_SERVER };
  if (res.ok) return accept(res.data) ? { ok: true, data: res.data } : { ok: false, error: fallback };
  if (res.status === 401) return { ok: false, error: SESSION_ENDED };
  if (SPEAKS.has(res.status)) return { ok: false, error: messageOf(res.data) || (res.status === 429 ? TOO_MANY : fallback) };
  return { ok: false, error: fallback };
}

const isObject = (data) => !!data && typeof data === "object" && !Array.isArray(data);
const isProfile = (data) => isObject(data) && typeof data.email === "string" && typeof data.firstName === "string";
const isNmls = (data) => isObject(data) && "nmlsId" in data;
const isPending = (data) => isObject(data) && typeof data.pendingEmail === "string" && data.pendingEmail !== "";

const NOT_SAVED = "That didn't save. Try again.";

export async function loadProfile(fetchFn) {
  return answer(await send(fetchFn, "GET", "/api/profile"), { accept: isProfile, fallback: "Couldn't load your profile. Try again." });
}

export async function saveName(fetchFn, first, last) {
  return answer(await send(fetchFn, "PUT", "/api/profile/name", { firstName: first, lastName: last }), { accept: isProfile, fallback: NOT_SAVED });
}

export async function saveStage(fetchFn, stage) {
  return answer(await send(fetchFn, "PUT", "/api/profile/career-stage", { stage }), { accept: isProfile, fallback: NOT_SAVED });
}

// -> { ok: true, data: { pendingEmail } }. The login email does not change until the link mailed to the new address is opened.
export async function requestEmailChange(fetchFn, email) {
  return answer(await send(fetchFn, "POST", "/api/profile/email", { email }), { accept: isPending, fallback: "That didn't go through. Try again." });
}

// `which` is "own" (the caller's NMLS ID) or "org" (the company's, a broker only). An empty value clears the ID.
// -> { ok: true, data: { nmlsId, orgNmlsId, canEditOrg } }
export async function saveNmls(fetchFn, which, value) {
  const url = which === "own" ? "/api/profile/nmls" : which === "org" ? "/api/profile/org-nmls" : null;
  if (!url) return { ok: false, error: NOT_SAVED };
  return answer(await send(fetchFn, "PUT", url, { nmlsId: typeof value === "string" ? value.trim() : value }), { accept: isNmls, fallback: NOT_SAVED });
}

// ── where the emailed confirm link sends the browser ──

// The line to show from the page's query string ("?emailChanged=1"); null when there is none (or it is not one of the two the
// server sends). -> { text, bad } | null
export function emailChangedNotice(search) {
  if (typeof search !== "string") return null;
  switch (new URLSearchParams(search).get("emailChanged")) {
    case "1": return { text: "Your email address is updated.", bad: false };
    case "0": return { text: "That link didn't work. If you already confirmed it, sign in with your new address.", bad: true };
    default: return null;
  }
}
