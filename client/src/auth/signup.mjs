// The sign-up and invite screens' logic, with no DOM and no React (the screens are in App.jsx: RegisterPage, FinishSignupPage and
// AcceptInvitePage). Server contracts (server/routes/auth.js):
//   POST /api/auth/register          { firstName, lastName, email, password, orgName } -> 200 { success } (no cookie, no user, for every valid request);
//                                                                                          400 / 429 / 503 { success: false, error } (a line to show as it is)
//   POST /api/auth/register/check    { token }            -> 200 { success, email, orgName }; 410 { success: false, error }
//   POST /api/auth/register/complete { token, password }  -> 200 { success, user } and the session cookie (signed in);
//                                                           400 (not the password chosen at sign-up; the link stays good) / 410 / 429 { success: false, error }
//   POST /api/auth/invite/check      { token }            -> 200 { success, firstName, lastName, email, orgName }; 410 { success: false, error }
//   POST /api/auth/accept-invite     { token, password }  -> 200 { user } and the session cookie; 400 / 410 / 429 { success: false, error }
// The emailed links are <site>/#signup=<token> and <site>/#invite=<token>. Invitations emailed before this release are
// <site>/accept-invite?token=<token>, and they must still open.

const TOKEN = /^[0-9a-f]{64}$/;
const RETRY_TEXT = "Couldn't check your link — please try again";

function fragmentValue(hash, name) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;
  const value = new URLSearchParams(hash.slice(1)).get(name);
  return value !== null && TOKEN.test(value) ? value : null;
}

// The sign-up token out of `location.hash` ("#signup=<token>"): 64 lowercase hex characters, else null. In the fragment so the host's
// request log can never hold it, as with the reset link.
export function signupTokenFrom(hash) {
  return fragmentValue(hash, "signup");
}

// The invitation token: the "#invite=" fragment first, else the legacy "?token=" query of an older emailed link. 64 lowercase hex only.
export function inviteTokenFrom(hash, search) {
  const fromFragment = fragmentValue(hash, "invite");
  if (fromFragment) return fromFragment;
  if (typeof search !== "string") return null;
  const value = new URLSearchParams(search).get("token");
  return value !== null && TOKEN.test(value) ? value : null;
}

// What the register page says after the server accepted the request (same for every address, new or not).
export function signupSentText(email) {
  return `We've sent a link to ${email}. Open it within 24 hours to finish creating your account. If it doesn't arrive in a few minutes, check your spam folder.`;
}

// What "Finish creating your account" does with the answer to its open-time check. Only a 410 says the link is no good (final);
// any other failure says nothing about the link, so the page offers "Try again". `data` is the parsed body, or null.
export function signupCheckOutcome(status, data) {
  if (status === 410) return { kind: "gone", text: data?.error || "This link has expired or was already used." };
  if (status === 200 && typeof data?.email === "string" && typeof data?.orgName === "string") return { kind: "ok", email: data.email, orgName: data.orgName };
  return { kind: "retry", text: data?.error || RETRY_TEXT };
}

// What "Create my account" says instead of sending, or null to send. Finishing needs the password chosen at sign-up (so whoever
// asked for the link can't hand the address's owner an account with a password they know); an empty field is caught here, and
// anything typed goes to the server as it is (passwords are never trimmed).
export function finishSignupProblem(password) {
  return password ? null : "Enter the password you chose when you signed up.";
}

// The same for the invitation page's open-time check.
export function inviteCheckOutcome(status, data) {
  if (status === 410) return { kind: "gone", text: data?.error || "This invitation has expired or was already used." };
  if (status === 200 && typeof data?.email === "string" && typeof data?.orgName === "string") {
    return { kind: "ok", info: { firstName: data.firstName, lastName: data.lastName, email: data.email, orgName: data.orgName } };
  }
  return { kind: "retry", text: data?.error || RETRY_TEXT };
}
