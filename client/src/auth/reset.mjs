// The forgot-password screens' logic, with no DOM and no React (the screens are in App.jsx: LoginPage's link, ForgotPasswordPage and
// ResetPasswordPage). Server contracts (server/routes/auth.js):
//   POST /api/auth/forgot       { email }            -> 200 { success }; 400 / 429 / 503 { success: false, error } (the error is a line to show as it is)
//   POST /api/auth/reset/check  { token }            -> 200 { success, email }; 410 { success: false, error }
//   POST /api/auth/reset        { token, password }  -> 200 { success, user } and the session cookie (signed in); 400 / 410 / 429 { success: false, error }
// The emailed link is <site>/#reset=<token>.

export const PASSWORD_CHANGED_NOTICE = "Your password was changed. Any other devices were signed out.";

// The reset token out of `location.hash` ("#reset=<token>"): 64 lowercase hex characters, else null. The token travels in the
// fragment because a browser never sends the fragment to the server, so the host's request log (Cloud Run records every request URL)
// can never hold it. A value that is not exactly that shape is not a token this app made, so it is not worth asking the server about.
export function resetTokenFrom(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;   // a "?reset=" in the query is not the emailed link
  const value = new URLSearchParams(hash.slice(1)).get("reset");
  return value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

// What is wrong with the new password and its confirmation, as a line to show, or null. The length rule is the server's (registration,
// invite and reset all use 8), checked first so a short password is told so before it is told the two boxes differ.
export function newPasswordProblem(password, confirm) {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters";
  if (password !== confirm) return "Passwords don't match";
  return null;
}

// What the request page says after it asks for a link. It is the same for every address on purpose (the server answers the same
// for an address with no account), so it says "if there's an account", never "we sent it".
export function forgotSentText(email) {
  return `If there's a Broker Radar account for ${email}, we've sent it a link to choose a new password. The link works for 60 minutes. If it doesn't arrive in a few minutes, check your spam folder.`;
}
