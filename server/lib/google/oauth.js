"use strict";
// A user's own Google connection for Charli's calendar: OAuth 2.0 authorization-code flow with PKCE (S256), the
// tokens kept encrypted (./crypto.js), and a valid access token on demand. Nothing here depends on our own Google
// account: every customer connects theirs, with the client credentials from the environment (GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI; GOOGLE_TOKEN_KEY is the key in ./crypto.js).
//
// `fetchFn` is a parameter (routes/google.js hands over `app.get("googleFetch") || fetch`; it defaults to the global
// fetch), so tests script Google. Tokens never leave this module except as accessToken()'s return value, are never
// logged, and are never part of an error: every failure here is a short code or a fixed message, never the text of an
// upstream response.
const crypto = require("crypto");
const { hasTokenKey, encrypt, decrypt } = require("./crypto");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const SCOPES = ["openid", "email", CALENDAR_SCOPE];

const STATE_TTL_MS = 10 * 60 * 1000;     // a sign-in has ten minutes to come back
const REFRESH_MARGIN_MS = 60 * 1000;     // refresh when less than this is left on the access token
const REQUEST_TIMEOUT_MS = 10_000;       // a call to Google that goes quiet is given up on

const MSG_FAILED = "Couldn't connect Google";
const MSG_STALE = "That Google sign-in is no longer valid — please try again";
const MSG_NEEDS_CALENDAR = "Calendar permission is needed";

// ── Setup ────────────────────────────────────────────────────────────────────

// The client credentials, or null unless all four settings are present (the token key included, valid).
function googleConfig() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const redirectUri = (process.env.GOOGLE_REDIRECT_URI || "").trim();
  if (!clientId || !clientSecret || !redirectUri || !hasTokenKey()) return null;
  return { clientId, clientSecret, redirectUri };
}

// ── Calls to Google ──────────────────────────────────────────────────────────

const postForm = (fetchFn, url, fields) => fetchFn(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

// A response body as JSON, or null when it is not.
async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

const nonEmpty = (value) => typeof value === "string" && value !== "";

// Epoch ms when a token Google just issued runs out, or null when `expires_in` is not a usable number of seconds.
function expiryFrom(body, now) {
  const seconds = Number(body && body.expires_in);
  return Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null;
}

// What gets logged for an unexpected failure: the error's name only. A message can quote a response body.
const errName = (err) => (err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "error");

// ── Starting a sign-in ───────────────────────────────────────────────────────

const sha256url = (text) => crypto.createHash("sha256").update(text).digest("base64url");

// Begins a sign-in for `userId`: a single-use state and a PKCE verifier are stored (ten minutes to finish) and the
// Google consent URL is returned. States that have already expired are swept out here, so the table stays small.
function startAuth(db, userId, now = Date.now()) {
  const config = googleConfig();
  if (!config) throw new Error("Google is not configured");
  const state = crypto.randomBytes(32).toString("base64url");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM google_oauth_states WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO google_oauth_states (state, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?)")
    .run(state, userId, codeVerifier, now + STATE_TTL_MS);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    code_challenge: sha256url(codeVerifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return { url: `${AUTH_URL}?${params}` };
}

// ── Finishing it ─────────────────────────────────────────────────────────────

// Takes the state row out of the table: it is single use, so it is gone whether or not the sign-in goes on to work.
// null for an unknown state or one past its ten minutes.
function takeState(db, state, now) {
  const take = db.transaction((value) => {
    const row = db.prepare("SELECT user_id, code_verifier, expires_at FROM google_oauth_states WHERE state = ?").get(value);
    if (row) db.prepare("DELETE FROM google_oauth_states WHERE state = ?").run(value);
    return row;
  });
  const row = take(state);
  return row && now < row.expires_at ? row : null;
}

// The address in an id_token. The token came straight from Google's token endpoint over TLS in exchange for our own
// code, so (as OpenID Connect allows) its signature is not checked again here.
function emailFromIdToken(idToken) {
  if (!nonEmpty(idToken)) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const email = claims && typeof claims.email === "string" ? claims.email.trim() : "";
    return email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

const isTimeZone = (name) => {
  if (!nonEmpty(name)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
};

// Spends a state without finishing the sign-in (the callback came from a browser that did not start it).
function cancelAuth(db, state) {
  if (nonEmpty(state)) db.prepare("DELETE FROM google_oauth_states WHERE state = ?").run(state);
}

// The other half of the callback: trades the code for tokens and saves the connection. Resolves to { userId } or
// { error } (a short message that is safe to show); never throws. The state names the user, so the CALLER must first
// have checked that this browser is the one that started the sign-in (routes/google.js does, with the flow cookie).
async function finishAuth(db, { code, state } = {}, fetchFn = globalThis.fetch, now = Date.now()) {
  try {
    if (!nonEmpty(state)) return { error: MSG_FAILED };
    const pending = takeState(db, state, now);   // spent from here on, whatever happens next
    if (!pending) return { error: MSG_STALE };
    if (!nonEmpty(code)) return { error: MSG_FAILED };
    const config = googleConfig();
    if (!config) return { error: MSG_FAILED };

    let tokens;
    try {
      const res = await postForm(fetchFn, TOKEN_URL, {
        grant_type: "authorization_code",
        code,
        code_verifier: pending.code_verifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      });
      tokens = res.ok ? await readJson(res) : null;
    } catch {
      return { error: MSG_FAILED };
    }
    if (!tokens || !nonEmpty(tokens.access_token)) return { error: MSG_FAILED };
    if (!nonEmpty(tokens.scope) || !tokens.scope.split(/\s+/).includes(CALENDAR_SCOPE)) return { error: MSG_NEEDS_CALENDAR };
    if (!nonEmpty(tokens.refresh_token)) return { error: MSG_FAILED };   // prompt=consent should always bring one
    const expiresAt = expiryFrom(tokens, now);
    const googleEmail = emailFromIdToken(tokens.id_token);
    if (!expiresAt || !googleEmail) return { error: MSG_FAILED };

    let timeZone;
    try {
      const res = await fetchFn(CALENDAR_EVENTS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const calendar = res.ok ? await readJson(res) : null;
      timeZone = calendar && calendar.timeZone;
    } catch {
      return { error: MSG_FAILED };
    }
    if (!isTimeZone(timeZone)) return { error: MSG_FAILED };

    db.prepare(`
      INSERT INTO google_connections
        (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'connected')
      ON CONFLICT(user_id) DO UPDATE SET
        google_email = excluded.google_email, time_zone = excluded.time_zone, scopes = excluded.scopes,
        access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at,
        refresh_token_enc = excluded.refresh_token_enc, status = 'connected', updated_at = datetime('now')
    `).run(pending.user_id, googleEmail, timeZone, tokens.scope, encrypt(tokens.access_token), expiresAt, encrypt(tokens.refresh_token));
    return { userId: pending.user_id };
  } catch (err) {
    console.error("google finishAuth failed:", errName(err));
    return { error: MSG_FAILED };
  }
}

// ── Using the connection ─────────────────────────────────────────────────────

// Never includes a token.
function getConnection(db, userId) {
  return db.prepare("SELECT google_email AS googleEmail, time_zone AS timeZone, status FROM google_connections WHERE user_id = ?")
    .get(userId) || null;
}

// Flags a connection as needing the user to sign in again. Matched on the refresh token that failed, so a connection
// the user has just redone while the failed call was in flight is left alone.
function markReconnect(db, userId, refreshTokenEnc) {
  db.prepare("UPDATE google_connections SET status = 'reconnect', updated_at = datetime('now') WHERE user_id = ? AND refresh_token_enc = ?")
    .run(userId, refreshTokenEnc);
}

// A usable access token for the user, refreshed first when under a minute is left on it.
//   { token, timeZone, googleEmail }                       the token
//   { code: "not_connected" }                              no connection
//   { code: "reconnect" }                                  Google refused the refresh token (or the stored tokens can no
//                                                          longer be opened): only a new sign-in fixes it
//   { code: "unavailable" }                                Google or the network failed, or the server is not set up;
//                                                          worth trying again later
// Never throws.
async function accessToken(db, userId, fetchFn = globalThis.fetch, now = Date.now()) {
  const unavailable = { code: "unavailable" };
  try {
    const row = db.prepare("SELECT * FROM google_connections WHERE user_id = ?").get(userId);
    if (!row) return { code: "not_connected" };
    if (row.status === "reconnect") return { code: "reconnect" };
    if (!hasTokenKey()) return unavailable;
    const who = { timeZone: row.time_zone, googleEmail: row.google_email };

    if (row.access_expires_at - now >= REFRESH_MARGIN_MS) {
      try {
        return { token: decrypt(row.access_token_enc), ...who };
      } catch {
        markReconnect(db, userId, row.refresh_token_enc);
        return { code: "reconnect" };
      }
    }

    let refreshToken;
    try {
      refreshToken = decrypt(row.refresh_token_enc);
    } catch {
      markReconnect(db, userId, row.refresh_token_enc);
      return { code: "reconnect" };
    }
    const config = googleConfig();
    if (!config) return unavailable;

    let res;
    try {
      res = await postForm(fetchFn, TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
    } catch {
      return unavailable;
    }
    const body = await readJson(res);
    if (!res.ok) {
      if (body && body.error === "invalid_grant") {
        markReconnect(db, userId, row.refresh_token_enc);
        return { code: "reconnect" };
      }
      return unavailable;
    }
    const expiresAt = expiryFrom(body, now);
    if (!body || !nonEmpty(body.access_token) || !expiresAt) return unavailable;

    // Google sometimes issues a new refresh token with the refresh; when it does, that one is the one to keep.
    const newRefresh = nonEmpty(body.refresh_token) ? body.refresh_token : refreshToken;
    db.prepare(`
      UPDATE google_connections
         SET access_token_enc = ?, access_expires_at = ?, refresh_token_enc = ?, updated_at = datetime('now')
       WHERE user_id = ? AND refresh_token_enc = ?
    `).run(encrypt(body.access_token), expiresAt, encrypt(newRefresh), userId, row.refresh_token_enc);
    return { token: body.access_token, ...who };
  } catch (err) {
    console.error("google accessToken failed:", errName(err));
    return unavailable;
  }
}

// Revokes the grant at Google (best effort: a failure there changes nothing), then deletes the connection.
async function disconnect(db, userId, fetchFn = globalThis.fetch) {
  const row = db.prepare("SELECT refresh_token_enc FROM google_connections WHERE user_id = ?").get(userId);
  if (!row) return;
  try {
    await postForm(fetchFn, REVOKE_URL, { token: decrypt(row.refresh_token_enc) });
  } catch { /* offline, or tokens that can no longer be opened: the row goes either way */ }
  db.prepare("DELETE FROM google_connections WHERE user_id = ?").run(userId);
}

module.exports = { SCOPES, STATE_TTL_MS, googleConfig, startAuth, finishAuth, cancelAuth, getConnection, accessToken, disconnect };
