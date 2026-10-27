"use strict";
// The per-user Google connection: token crypto (lib/google/crypto.js), the OAuth + PKCE flow and token refresh
// (lib/google/oauth.js) and /api/google (routes/google.js), against a throwaway DB. Every outbound Google call goes
// through a scripted fake fetch that records its requests: NO test here touches the network. All env values are fake.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-google-oauth-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
const CLIENT_ID = "test-client-" + Math.random().toString(16).slice(2) + ".apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret-" + Math.random().toString(16).slice(2);
const REDIRECT_URI = "http://localhost:8080/api/google/callback";
const TOKEN_KEY = crypto.randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY;

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const gcrypto = require("../lib/google/crypto");
const oauth = require("../lib/google/oauth");
const googleRoutes = require("../routes/google");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1";
const CAL_EVENTS = "https://www.googleapis.com/auth/calendar.events";
const MIN = 60 * 1000;

// ── seed data ────────────────────────────────────────────────────────────────

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first = "T") => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, 'User', ?)"
).run(orgId, role, first, email).lastInsertRowid);
const connectionRow = (userId) => db.prepare("SELECT * FROM google_connections WHERE user_id = ?").get(userId);
const stateRow = (state) => db.prepare("SELECT * FROM google_oauth_states WHERE state = ?").get(state);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.co", "Ann");
const lou = addUser(orgA, "lo", "lou@a.co", "Lou");
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@b.co", "Bea");

// ── harness ──────────────────────────────────────────────────────────────────

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const idToken = (claims) => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake fetch. `routes` maps a URL (the full string, query included) to a response, or to a function (request) =>
// response, or to a function that throws. Every request is recorded as { url, method, headers, form, body }; `form` is
// the form-urlencoded body parsed to an object. An unscripted URL fails the test that made the call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = typeof init.body === "string" ? init.body : undefined;
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body, form: body ? Object.fromEntries(new URLSearchParams(body)) : {} };
    calls.push(call);
    const handler = routes[call.url];
    if (handler === undefined) throw new Error("fake fetch: unscripted URL " + call.url);
    return typeof handler === "function" ? handler(call) : handler;
  };
  fn.calls = calls;
  return fn;
}

const ACCESS_1 = "ya29.access-one-" + Math.random().toString(16).slice(2);
const REFRESH_1 = "1//refresh-one-" + Math.random().toString(16).slice(2);
const ACCESS_2 = "ya29.access-two-" + Math.random().toString(16).slice(2);
const goodTokens = (extra = {}) => ({
  access_token: ACCESS_1,
  refresh_token: REFRESH_1,
  expires_in: 3599,
  scope: `openid https://www.googleapis.com/auth/userinfo.email ${CAL_EVENTS}`,
  token_type: "Bearer",
  id_token: idToken({ email: "ann@gmail.example", email_verified: true, sub: "1234" }),
  ...extra,
});
const goodRoutes = (tokens = goodTokens()) => ({
  [TOKEN_URL]: () => json(tokens),
  [EVENTS_URL]: () => json({ kind: "calendar#events", timeZone: "America/Denver", items: [] }),
});

// Runs the start of the flow and returns the state and the PKCE challenge Google would have been sent.
function begin(userId, now) {
  const { url } = oauth.startAuth(db, userId, now);
  const params = new URL(url).searchParams;
  return { url, params, state: params.get("state"), challenge: params.get("code_challenge") };
}

// Seeds a connected account directly, tokens encrypted the way finishAuth stores them.
function seedConnection(userId, { accessToken = ACCESS_1, refreshToken = REFRESH_1, expiresAt, status = "connected" } = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO google_connections
      (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc, status)
    VALUES (?, 'ann@gmail.example', 'America/Denver', ?, ?, ?, ?, ?)
  `).run(userId, oauth.SCOPES.join(" "), gcrypto.encrypt(accessToken), expiresAt, gcrypto.encrypt(refreshToken), status);
}

beforeEach(() => {
  db.prepare("DELETE FROM google_connections").run();
  db.prepare("DELETE FROM google_oauth_states").run();
});
after(() => {
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ── token crypto ─────────────────────────────────────────────────────────────

test("crypto: encrypt then decrypt round-trips, and the blob is v1:base64(iv12 | tag16 | ciphertext)", () => {
  const blob = gcrypto.encrypt("ya29.secret-token ✓");
  assert.match(blob, /^v1:[A-Za-z0-9+/]+=*$/);
  assert.strictEqual(Buffer.from(blob.slice(3), "base64").length, 12 + 16 + Buffer.byteLength("ya29.secret-token ✓"));
  assert.strictEqual(gcrypto.decrypt(blob), "ya29.secret-token ✓");
  assert.strictEqual(gcrypto.decrypt(gcrypto.encrypt("")), "");
});

test("crypto: two encryptions of one text differ, and neither contains the text", () => {
  const a = gcrypto.encrypt("same text");
  const b = gcrypto.encrypt("same text");
  assert.notStrictEqual(a, b);
  assert.ok(!a.includes("same text") && !Buffer.from(a.slice(3), "base64").toString("utf8").includes("same text"));
});

test("crypto: a flipped byte anywhere in the blob makes decrypt throw", () => {
  const blob = gcrypto.encrypt("ya29.secret-token");
  const raw = Buffer.from(blob.slice(3), "base64");
  for (const at of [0, 11, 12, 27, 28, raw.length - 1]) {   // iv, tag and ciphertext
    const bad = Buffer.from(raw);
    bad[at] ^= 0x01;
    assert.throws(() => gcrypto.decrypt("v1:" + bad.toString("base64")), `byte ${at}`);
  }
});

test("crypto: decrypt throws on a truncated blob, an unknown version and non-strings", () => {
  const blob = gcrypto.encrypt("x");
  assert.throws(() => gcrypto.decrypt(blob.slice(0, 10)));
  assert.throws(() => gcrypto.decrypt("v2:" + blob.slice(3)));
  assert.throws(() => gcrypto.decrypt("v1:"));
  assert.throws(() => gcrypto.decrypt(null));
});

test("crypto: another key cannot decrypt, and a missing or short key is reported, not guessed", () => {
  const blob = gcrypto.encrypt("ya29.secret-token");
  try {
    process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString("base64");
    assert.strictEqual(gcrypto.hasTokenKey(), true);
    assert.throws(() => gcrypto.decrypt(blob));

    process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(16).toString("base64");   // 16 bytes is not a key
    assert.strictEqual(gcrypto.hasTokenKey(), false);
    assert.throws(() => gcrypto.encrypt("x"));

    delete process.env.GOOGLE_TOKEN_KEY;
    assert.strictEqual(gcrypto.hasTokenKey(), false);
    assert.throws(() => gcrypto.encrypt("x"));
    assert.throws(() => gcrypto.decrypt(blob));
  } finally {
    process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY;
  }
  assert.strictEqual(gcrypto.hasTokenKey(), true);
  assert.strictEqual(gcrypto.decrypt(blob), "ya29.secret-token");
});

// ── startAuth ────────────────────────────────────────────────────────────────

test("googleConfig is null unless all four names are set", () => {
  assert.deepStrictEqual(oauth.googleConfig(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_TOKEN_KEY"]) {
    const saved = process.env[name];
    try {
      delete process.env[name];
      assert.strictEqual(oauth.googleConfig(), null, name);
      process.env[name] = "  ";
      assert.strictEqual(oauth.googleConfig(), null, name + " blank");
    } finally {
      process.env[name] = saved;
    }
  }
});

test("startAuth: the URL asks for the three scopes (no Gmail), PKCE S256, offline access and consent, and the state has a row", () => {
  const now = Date.UTC(2026, 9, 27, 15, 0, 0);
  const { url, params, state, challenge } = begin(ann, now);
  assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  assert.strictEqual(params.get("client_id"), CLIENT_ID);
  assert.strictEqual(params.get("redirect_uri"), REDIRECT_URI);
  assert.strictEqual(params.get("response_type"), "code");
  assert.strictEqual(params.get("scope"), `openid email ${CAL_EVENTS}`);
  assert.ok(!/gmail|mail\.google/i.test(url), "no Gmail scope");
  assert.strictEqual(params.get("code_challenge_method"), "S256");
  assert.strictEqual(params.get("access_type"), "offline");
  assert.strictEqual(params.get("prompt"), "consent");
  assert.strictEqual(params.get("include_granted_scopes"), "true");
  assert.ok(!url.includes(CLIENT_SECRET), "the client secret never goes in the URL");

  // 32 random bytes of state; the row holds the verifier whose SHA-256 is the challenge; ten minutes to finish
  assert.strictEqual(Buffer.from(state, "base64url").length, 32);
  const row = stateRow(state);
  assert.ok(row, "the state has a row");
  assert.strictEqual(row.user_id, ann);
  assert.strictEqual(row.expires_at, now + 10 * MIN);
  assert.strictEqual(crypto.createHash("sha256").update(row.code_verifier).digest("base64url"), challenge);
  assert.ok(row.code_verifier.length >= 43 && row.code_verifier.length <= 128);

  const second = begin(ann, now);
  assert.notStrictEqual(second.state, state);
  assert.notStrictEqual(second.challenge, challenge);
});

test("startAuth: sweeps the states that have already expired", () => {
  const now = Date.UTC(2026, 9, 27, 15, 0, 0);
  const old = begin(ann, now - 30 * MIN);
  const fresh = begin(bea, now - 5 * MIN);
  const { state } = begin(lou, now);
  assert.strictEqual(stateRow(old.state), undefined);
  assert.ok(stateRow(fresh.state), "a state still inside its ten minutes stays");
  assert.ok(stateRow(state));
});

// ── finishAuth ───────────────────────────────────────────────────────────────

test("finishAuth: exchanges the code with the matching verifier, stores the email and time zone, and no raw token appears in the row", async () => {
  const now = Date.UTC(2026, 9, 27, 15, 0, 0);
  const { state, challenge } = begin(ann, now);
  const verifier = stateRow(state).code_verifier;
  const fetchFn = fakeFetch(goodRoutes());

  const result = await oauth.finishAuth(db, { code: "auth-code-1", state }, fetchFn, now + MIN);
  assert.deepStrictEqual(result, { userId: ann });

  const [exchange, calendar] = fetchFn.calls;
  assert.strictEqual(exchange.url, TOKEN_URL);
  assert.strictEqual(exchange.method, "POST");
  assert.match(String(exchange.headers["content-type"] || exchange.headers["Content-Type"]), /application\/x-www-form-urlencoded/);
  assert.deepStrictEqual(exchange.form, {
    grant_type: "authorization_code", code: "auth-code-1", code_verifier: verifier,
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI,
  });
  assert.strictEqual(crypto.createHash("sha256").update(exchange.form.code_verifier).digest("base64url"), challenge);
  assert.strictEqual(calendar.url, EVENTS_URL);
  assert.strictEqual(calendar.method, "GET");
  assert.strictEqual(calendar.headers.Authorization, "Bearer " + ACCESS_1);

  const row = connectionRow(ann);
  assert.strictEqual(row.google_email, "ann@gmail.example");
  assert.strictEqual(row.time_zone, "America/Denver");
  assert.strictEqual(row.status, "connected");
  assert.strictEqual(row.scopes, goodTokens().scope);
  assert.strictEqual(row.access_expires_at, now + MIN + 3599 * 1000);
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes(ACCESS_1) && !dump.includes(REFRESH_1), "neither raw token string is in the row");
  assert.ok(row.access_token_enc.startsWith("v1:") && row.refresh_token_enc.startsWith("v1:"));
  assert.strictEqual(gcrypto.decrypt(row.access_token_enc), ACCESS_1);
  assert.strictEqual(gcrypto.decrypt(row.refresh_token_enc), REFRESH_1);
  assert.deepStrictEqual(oauth.getConnection(db, ann), { googleEmail: "ann@gmail.example", timeZone: "America/Denver", status: "connected" });
});

test("finishAuth: a state is single use, and is spent even when the exchange fails", async () => {
  const now = Date.UTC(2026, 9, 27, 15, 0, 0);
  const { state } = begin(ann, now);
  const fetchFn = fakeFetch(goodRoutes());
  assert.deepStrictEqual(await oauth.finishAuth(db, { code: "c", state }, fetchFn, now), { userId: ann });
  const calls = fetchFn.calls.length;
  const again = await oauth.finishAuth(db, { code: "c", state }, fetchFn, now);
  assert.ok(again.error && again.userId === undefined, "reusing the state is refused");
  assert.strictEqual(fetchFn.calls.length, calls, "and Google is not called");

  const failing = begin(ann, now);
  const bad = fakeFetch({ [TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });
  assert.ok((await oauth.finishAuth(db, { code: "c", state: failing.state }, bad, now)).error);
  assert.strictEqual(stateRow(failing.state), undefined, "a failed exchange still spends the state");
  const retry = fakeFetch(goodRoutes());
  assert.ok((await oauth.finishAuth(db, { code: "c", state: failing.state }, retry, now)).error);
  assert.strictEqual(retry.calls.length, 0);
});

test("finishAuth: an unknown, missing or non-string state or code is an error with no call to Google", async () => {
  const fetchFn = fakeFetch(goodRoutes());
  const { state } = begin(ann, 1_000);
  for (const input of [
    { code: "c", state: "nope" }, { code: "c" }, { state }, { code: "", state }, { code: ["c"], state }, { code: "c", state: { $ne: 1 } }, {}, undefined,
  ]) {
    assert.ok((await oauth.finishAuth(db, input, fetchFn, 1_000)).error, JSON.stringify(input));
  }
  assert.strictEqual(fetchFn.calls.length, 0);
});

test("finishAuth: a state 11 minutes old is an error and makes no connection; 9 minutes is fine", async () => {
  const now = Date.UTC(2026, 9, 27, 15, 0, 0);
  const stale = begin(ann, now);
  const fetchFn = fakeFetch(goodRoutes());
  const result = await oauth.finishAuth(db, { code: "c", state: stale.state }, fetchFn, now + 11 * MIN);
  assert.ok(result.error);
  assert.strictEqual(connectionRow(ann), undefined);
  assert.strictEqual(fetchFn.calls.length, 0, "an expired state never reaches Google");
  assert.strictEqual(stateRow(stale.state), undefined, "and is spent");

  const ok = begin(ann, now);
  assert.deepStrictEqual(await oauth.finishAuth(db, { code: "c", state: ok.state }, fakeFetch(goodRoutes()), now + 9 * MIN), { userId: ann });
});

test("finishAuth: a response with no refresh_token is refused and stores nothing", async () => {
  const { state } = begin(ann, 1_000);
  const { refresh_token, ...noRefresh } = goodTokens();
  const result = await oauth.finishAuth(db, { code: "c", state }, fakeFetch(goodRoutes(noRefresh)), 1_000);
  assert.ok(result.error);
  assert.strictEqual(connectionRow(ann), undefined);
  assert.ok(!JSON.stringify(result).includes(ACCESS_1));
});

test("finishAuth: a scope without calendar.events is 'Calendar permission is needed'", async () => {
  for (const scope of ["openid email", "openid email https://www.googleapis.com/auth/calendar.events.readonly", undefined]) {
    const { state } = begin(ann, 1_000);
    const result = await oauth.finishAuth(db, { code: "c", state }, fakeFetch(goodRoutes(goodTokens({ scope }))), 1_000);
    assert.deepStrictEqual(result, { error: "Calendar permission is needed" }, String(scope));
    assert.strictEqual(connectionRow(ann), undefined);
  }
});

test("finishAuth: Google errors, a thrown fetch, a missing id_token email and a bad time zone are all errors, never throws, never leaks a token", async () => {
  const cases = {
    "token endpoint 400": { [TOKEN_URL]: () => json({ error: "invalid_grant", error_description: "Bad code" }, 400) },
    "token endpoint 500": { [TOKEN_URL]: () => json({}, 500) },
    "token endpoint throws": { [TOKEN_URL]: () => { throw new Error("socket hang up " + ACCESS_1); } },
    "unparseable token body": { [TOKEN_URL]: () => new Response("<html>nope</html>", { status: 200 }) },
    "no access_token": goodRoutes(goodTokens({ access_token: undefined })),
    "no id_token": goodRoutes(goodTokens({ id_token: undefined })),
    "id_token without an email": goodRoutes(goodTokens({ id_token: idToken({ sub: "1" }) })),
    "id_token that is not a jwt": goodRoutes(goodTokens({ id_token: "garbage" })),
    "calendar 403": { ...goodRoutes(), [EVENTS_URL]: () => json({ error: { code: 403 } }, 403) },
    "calendar throws": { ...goodRoutes(), [EVENTS_URL]: () => { throw new Error("offline"); } },
    "calendar without a time zone": { ...goodRoutes(), [EVENTS_URL]: () => json({ items: [] }) },
    "calendar with a bogus time zone": { ...goodRoutes(), [EVENTS_URL]: () => json({ timeZone: "Mars/Olympus" }) },
  };
  for (const [name, routes] of Object.entries(cases)) {
    const { state } = begin(ann, 1_000);
    const result = await oauth.finishAuth(db, { code: "c", state }, fakeFetch(routes), 1_000);
    assert.ok(typeof result.error === "string" && result.error, name);
    assert.ok(!JSON.stringify(result).includes(ACCESS_1) && !JSON.stringify(result).includes(REFRESH_1), name + " leaks a token");
    assert.strictEqual(connectionRow(ann), undefined, name);
  }
});

test("finishAuth: connecting again replaces the row and clears a 'reconnect' status", async () => {
  seedConnection(ann, { expiresAt: 5, status: "reconnect" });
  const { state } = begin(ann, 1_000);
  const fetchFn = fakeFetch(goodRoutes(goodTokens({ access_token: ACCESS_2 })));
  assert.deepStrictEqual(await oauth.finishAuth(db, { code: "c", state }, fetchFn, 1_000), { userId: ann });
  const row = connectionRow(ann);
  assert.strictEqual(row.status, "connected");
  assert.strictEqual(gcrypto.decrypt(row.access_token_enc), ACCESS_2);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM google_connections").get().n, 1);
});

// ── accessToken ──────────────────────────────────────────────────────────────

test("accessToken: with time left it returns the stored token without calling Google", async () => {
  const now = 1_000_000;
  seedConnection(ann, { expiresAt: now + 5 * MIN });
  const fetchFn = fakeFetch({});
  assert.deepStrictEqual(await oauth.accessToken(db, ann, fetchFn, now), { token: ACCESS_1, timeZone: "America/Denver", googleEmail: "ann@gmail.example" });
  assert.strictEqual(fetchFn.calls.length, 0);
});

test("accessToken: with 30 seconds left it refreshes and stores the new token and expiry", async () => {
  const now = 1_000_000;
  seedConnection(ann, { expiresAt: now + 30 * 1000 });
  const fetchFn = fakeFetch({ [TOKEN_URL]: () => json({ access_token: ACCESS_2, expires_in: 3599, scope: CAL_EVENTS, token_type: "Bearer" }) });
  assert.deepStrictEqual(await oauth.accessToken(db, ann, fetchFn, now), { token: ACCESS_2, timeZone: "America/Denver", googleEmail: "ann@gmail.example" });
  assert.strictEqual(fetchFn.calls.length, 1);
  assert.strictEqual(fetchFn.calls[0].method, "POST");
  assert.deepStrictEqual(fetchFn.calls[0].form, { grant_type: "refresh_token", refresh_token: REFRESH_1, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const row = connectionRow(ann);
  assert.strictEqual(row.access_expires_at, now + 3599 * 1000);
  assert.strictEqual(gcrypto.decrypt(row.access_token_enc), ACCESS_2);
  assert.strictEqual(gcrypto.decrypt(row.refresh_token_enc), REFRESH_1, "the refresh token is kept");
  assert.ok(!JSON.stringify(row).includes(ACCESS_2));
  assert.strictEqual(row.status, "connected");

  // the next call, a minute later, uses the new token and does not call Google again
  assert.strictEqual((await oauth.accessToken(db, ann, fetchFn, now + MIN)).token, ACCESS_2);
  assert.strictEqual(fetchFn.calls.length, 1);
});

test("accessToken: 60 seconds left is still enough; 59.999 is not", async () => {
  const now = 1_000_000;
  seedConnection(ann, { expiresAt: now + 60 * 1000 });
  const fetchFn = fakeFetch({ [TOKEN_URL]: () => json({ access_token: ACCESS_2, expires_in: 3599 }) });
  assert.strictEqual((await oauth.accessToken(db, ann, fetchFn, now)).token, ACCESS_1);
  assert.strictEqual(fetchFn.calls.length, 0);
  assert.strictEqual((await oauth.accessToken(db, ann, fetchFn, now + 1)).token, ACCESS_2);
  assert.strictEqual(fetchFn.calls.length, 1);
});

test("accessToken: a refresh that rotates the refresh token stores the new one", async () => {
  const now = 1_000_000;
  seedConnection(ann, { expiresAt: now });
  const fetchFn = fakeFetch({ [TOKEN_URL]: () => json({ access_token: ACCESS_2, refresh_token: "1//rotated", expires_in: 3599 }) });
  assert.strictEqual((await oauth.accessToken(db, ann, fetchFn, now)).token, ACCESS_2);
  assert.strictEqual(gcrypto.decrypt(connectionRow(ann).refresh_token_enc), "1//rotated");
});

test("accessToken: invalid_grant flips the status to 'reconnect' and says so, then stops calling Google", async () => {
  const now = 1_000_000;
  seedConnection(ann, { expiresAt: now });
  const fetchFn = fakeFetch({ [TOKEN_URL]: () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400) });
  assert.deepStrictEqual(await oauth.accessToken(db, ann, fetchFn, now), { code: "reconnect" });
  assert.strictEqual(connectionRow(ann).status, "reconnect");
  assert.deepStrictEqual(oauth.getConnection(db, ann), { googleEmail: "ann@gmail.example", timeZone: "America/Denver", status: "reconnect" });
  assert.deepStrictEqual(await oauth.accessToken(db, ann, fetchFn, now), { code: "reconnect" });
  assert.strictEqual(fetchFn.calls.length, 1);
});

test("accessToken: a thrown fetch, a 5xx, a non-grant 4xx or an unreadable body is 'unavailable' and changes nothing", async () => {
  const now = 1_000_000;
  const cases = {
    "thrown": () => { throw new Error("ECONNRESET " + REFRESH_1); },
    "503": () => json({ error: "backendError" }, 503),
    "invalid_client": () => json({ error: "invalid_client" }, 401),
    "html 200": () => new Response("<html>", { status: 200 }),
    "no access_token": () => json({ expires_in: 3599 }),
  };
  for (const [name, handler] of Object.entries(cases)) {
    seedConnection(ann, { expiresAt: now });
    const before = connectionRow(ann);
    const result = await oauth.accessToken(db, ann, fakeFetch({ [TOKEN_URL]: handler }), now);
    assert.deepStrictEqual(result, { code: "unavailable" }, name);
    assert.deepStrictEqual(connectionRow(ann), before, name + " changed the row");
  }
});

test("accessToken: no row is 'not_connected', and a user only ever gets their own token", async () => {
  const now = 1_000_000;
  const fetchFn = fakeFetch({});
  assert.deepStrictEqual(await oauth.accessToken(db, ann, fetchFn, now), { code: "not_connected" });
  seedConnection(ann, { expiresAt: now + 5 * MIN });
  assert.deepStrictEqual(await oauth.accessToken(db, lou, fetchFn, now), { code: "not_connected" });
  assert.strictEqual(oauth.getConnection(db, lou), null);
  assert.strictEqual(fetchFn.calls.length, 0);
});

test("accessToken: tokens the key cannot open mean 'reconnect' (and it sticks); a missing key is 'unavailable'", async () => {
  const now = 1_000_000;
  seedConnection(ann, { expiresAt: now + 5 * MIN });
  try {
    delete process.env.GOOGLE_TOKEN_KEY;
    assert.deepStrictEqual(await oauth.accessToken(db, ann, fakeFetch({}), now), { code: "unavailable" });
    assert.strictEqual(connectionRow(ann).status, "connected", "a missing key is the server's problem, not the user's");

    process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString("base64");
    assert.deepStrictEqual(await oauth.accessToken(db, ann, fakeFetch({}), now), { code: "reconnect" });
    assert.strictEqual(connectionRow(ann).status, "reconnect");
  } finally {
    process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY;
  }
});

// ── disconnect ───────────────────────────────────────────────────────────────

test("disconnect: revokes the refresh token at Google, then deletes the row", async () => {
  seedConnection(ann, { expiresAt: Date.now() + 5 * MIN });
  seedConnection(bea, { expiresAt: Date.now() + 5 * MIN });
  const fetchFn = fakeFetch({ [REVOKE_URL]: () => json({}) });
  await oauth.disconnect(db, ann, fetchFn);
  assert.strictEqual(fetchFn.calls.length, 1);
  assert.strictEqual(fetchFn.calls[0].method, "POST");
  assert.deepStrictEqual(fetchFn.calls[0].form, { token: REFRESH_1 });
  assert.strictEqual(connectionRow(ann), undefined);
  assert.ok(connectionRow(bea), "another user's connection is untouched");
});

test("disconnect: deletes the row whatever the revoke did, and with no row does nothing", async () => {
  for (const handler of [() => { throw new Error("offline"); }, () => json({ error: "invalid_token" }, 400), () => json({}, 500)]) {
    seedConnection(ann, { expiresAt: Date.now() + 5 * MIN });
    await oauth.disconnect(db, ann, fakeFetch({ [REVOKE_URL]: handler }));
    assert.strictEqual(connectionRow(ann), undefined);
  }
  const fetchFn = fakeFetch({});
  await oauth.disconnect(db, ann, fetchFn);   // already gone
  assert.strictEqual(fetchFn.calls.length, 0);
});

test("disconnect: tokens the key cannot open are still deleted, with no revoke", async () => {
  seedConnection(ann, { expiresAt: Date.now() + 5 * MIN });
  const fetchFn = fakeFetch({});
  try {
    process.env.GOOGLE_TOKEN_KEY = crypto.randomBytes(32).toString("base64");
    await oauth.disconnect(db, ann, fetchFn);
  } finally {
    process.env.GOOGLE_TOKEN_KEY = TOKEN_KEY;
  }
  assert.strictEqual(connectionRow(ann), undefined);
  assert.strictEqual(fetchFn.calls.length, 0);
});

test("the connection rows go with their user", () => {
  const org = addOrg("Gone");
  const gone = addUser(org, "broker", "gone@g.co", "Gone");
  seedConnection(gone, { expiresAt: 1 });
  db.prepare("DELETE FROM users WHERE id = ?").run(gone);
  assert.strictEqual(connectionRow(gone), undefined);
});

// ── routes ───────────────────────────────────────────────────────────────────

function buildApp(router, googleFetch) {
  const a = express();
  a.use(express.json({ limit: "20mb" }));   // as index.js mounts it
  a.use(cookieParser());
  if (googleFetch) a.set("googleFetch", googleFetch);
  a.use("/api/google", router);
  return a;
}
const listen = async (a) => {
  const s = a.listen(0);
  await new Promise((r) => s.once("listening", r));
  return { server: s, base: `http://localhost:${s.address().port}` };
};
// as(userId)(method, path, { cookies }) -> { status, headers, data, text }; as(null) is anonymous (no rr_token); `cookies`
// are extra cookies for the request, { name: value }. Redirects are NOT followed.
const asUser = (base) => (userId) => async (method, p, { cookies = {} } = {}) => {
  const headers = { "content-type": "application/json" };
  const jar = { ...(userId != null ? { rr_token: signToken({ userId }) } : {}), ...cookies };
  if (Object.keys(jar).length) headers.cookie = Object.entries(jar).map(([name, value]) => `${name}=${value}`).join("; ");
  const res = await fetch(base + p, { method, headers, redirect: "manual", ...(method !== "GET" ? { body: "{}" } : {}) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, headers: res.headers, data, text };
};

const FLOW_COOKIE = "rr_google_flow";
const flowSetCookie = (res) => res.headers.getSetCookie().find((c) => c.startsWith(FLOW_COOKIE + "="));
// POST /connect as `userId` through `request` (an asUser(base)): { state, setCookie, cookies } where `cookies` is the flow
// cookie the browser would send back on the callback.
async function connectFlow(request, userId) {
  const res = await request(userId)("POST", "/api/google/connect");
  assert.strictEqual(res.status, 200);
  const setCookie = flowSetCookie(res);
  assert.ok(setCookie, "/connect sets the flow cookie");
  return {
    state: new URL(res.data.url).searchParams.get("state"),
    setCookie,
    cookies: { [FLOW_COOKIE]: setCookie.split(";")[0].slice(FLOW_COOKIE.length + 1) },
  };
}
// Every callback response, whatever the outcome, expires the flow cookie on its own path.
function assertFlowCookieCleared(res, label = "") {
  const cleared = flowSetCookie(res);
  assert.ok(cleared, "the callback clears the flow cookie " + label);
  assert.match(cleared, new RegExp(`^${FLOW_COOKIE}=;`));
  assert.match(cleared, /Path=\/api\/google\/callback/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
}

let server, as, routeFetch;
before(async () => {
  routeFetch = fakeFetch({ ...goodRoutes(), [REVOKE_URL]: () => json({}) });
  const listening = await listen(buildApp(googleRoutes.createGoogleRouter({ limiter: { max: 100000 } }), routeFetch));
  server = listening.server;
  as = asUser(listening.base);
});
after(() => { server.close(); });
beforeEach(() => { routeFetch.calls.length = 0; });

test("routes: POST /connect answers { url } for the signed-in user", async () => {
  const res = await as(ann)("POST", "/api/google/connect");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.data), ["url"]);
  const params = new URL(res.data.url).searchParams;
  assert.strictEqual(params.get("client_id"), CLIENT_ID);
  assert.strictEqual(stateRow(params.get("state")).user_id, ann);
  assert.ok(!res.text.includes(CLIENT_SECRET));
});

test("routes: POST /connect sets a flow cookie bound to the state: HttpOnly, SameSite=Lax, only for the callback path, ten minutes", async () => {
  const flow = await connectFlow(as, ann);
  assert.match(flow.setCookie, /;\s*HttpOnly/i);
  assert.match(flow.setCookie, /;\s*SameSite=Lax/i);
  assert.match(flow.setCookie, /;\s*Path=\/api\/google\/callback(;|$)/);
  assert.match(flow.setCookie, /;\s*Max-Age=600(;|$)/);
  assert.ok(!/;\s*Secure/i.test(flow.setCookie), "Secure only in production (this runs with NODE_ENV=test)");
  assert.ok(flow.cookies[FLOW_COOKIE].length >= 32, "an unguessable value");
  assert.ok(stateRow(flow.state), "for a state that has a row");
  const other = await connectFlow(as, bea);
  assert.notStrictEqual(other.cookies[FLOW_COOKIE], flow.cookies[FLOW_COOKIE], "a different flow gets a different cookie");

  // the value is not the auth cookie, and /status and the other routes do not set it
  assert.ok(!flow.setCookie.includes(signToken({ userId: ann })));
  assert.strictEqual(flowSetCookie(await as(ann)("GET", "/api/google/status")), undefined);
});

test("routes: a failed or unconfigured POST /connect sets no flow cookie", async () => {
  const saved = process.env.GOOGLE_CLIENT_ID;
  try {
    delete process.env.GOOGLE_CLIENT_ID;
    assert.strictEqual(flowSetCookie(await as(ann)("POST", "/api/google/connect")), undefined);
  } finally {
    process.env.GOOGLE_CLIENT_ID = saved;
  }
  assert.strictEqual(flowSetCookie(await as(null)("POST", "/api/google/connect")), undefined);
});

test("routes: unconfigured POST /connect is 503 with the plain message, and writes no state", async () => {
  const saved = process.env.GOOGLE_CLIENT_SECRET;
  try {
    delete process.env.GOOGLE_CLIENT_SECRET;
    const res = await as(ann)("POST", "/api/google/connect");
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(res.data, { success: false, error: "Google isn't set up on this server" });
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM google_oauth_states").get().n, 0);
    const status = await as(ann)("GET", "/api/google/status");
    assert.deepStrictEqual(status.data, { configured: false, connected: false, status: null, googleEmail: null });
  } finally {
    process.env.GOOGLE_CLIENT_SECRET = saved;
  }
});

test("routes: the callback needs only the flow cookie from /connect (no auth cookie), finishes the connection for the user the state names, and redirects to /?google=connected", async () => {
  const flow = await connectFlow(as, ann);
  const res = await as(null)("GET", `/api/google/callback?code=auth-code-9&state=${encodeURIComponent(flow.state)}`, { cookies: flow.cookies });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/?google=connected");
  assert.ok(connectionRow(ann));
  assert.strictEqual(routeFetch.calls[0].form.code, "auth-code-9");
  assert.match(res.headers.get("cache-control") || "", /no-store/);
  assertFlowCookieCleared(res);

  const status = await as(ann)("GET", "/api/google/status");
  assert.deepStrictEqual(status.data, { configured: true, connected: true, status: "connected", googleEmail: "ann@gmail.example" });
});

test("routes: a callback with no flow cookie (another browser) is /?google=error, spends the state, writes no connection and calls nobody", async () => {
  // Attacker Ann starts a flow and sends the Google URL to Bea; Bea approves and her browser lands on the callback with
  // Ann's state, her own code, and none of Ann's cookies.
  const flow = await connectFlow(as, ann);
  const res = await as(null)("GET", `/api/google/callback?code=beas-code&state=${encodeURIComponent(flow.state)}`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/?google=error");
  assert.strictEqual(connectionRow(ann), undefined);
  assert.strictEqual(connectionRow(bea), undefined);
  assert.strictEqual(stateRow(flow.state), undefined, "the state is spent");
  assert.strictEqual(routeFetch.calls.length, 0, "no token request, no Calendar request");
  assertFlowCookieCleared(res);

  // and Ann's own browser can no longer finish that flow either
  const retry = await as(null)("GET", `/api/google/callback?code=c&state=${encodeURIComponent(flow.state)}`, { cookies: flow.cookies });
  assert.strictEqual(retry.headers.get("location"), "/?google=error");
  assert.strictEqual(routeFetch.calls.length, 0);
});

test("routes: a callback carrying another flow's cookie is /?google=error, spends the state and writes no connection", async () => {
  const annsFlow = await connectFlow(as, ann);
  const beasFlow = await connectFlow(as, bea);
  const mismatches = [
    ["another user's flow cookie", beasFlow.cookies],
    ["a cookie of a different length", { [FLOW_COOKIE]: "short" }],
    ["an empty cookie", { [FLOW_COOKIE]: "" }],
    ["the state with one character changed", { [FLOW_COOKIE]: annsFlow.state.slice(0, -1) + (annsFlow.state.endsWith("A") ? "B" : "A") }],
  ];
  for (const [label, cookies] of mismatches) {
    const flow = await connectFlow(as, ann);   // a fresh state each time: a mismatch spends the one it names
    const res = await as(null)("GET", `/api/google/callback?code=c&state=${encodeURIComponent(flow.state)}`, { cookies });
    assert.strictEqual(res.headers.get("location"), "/?google=error", label);
    assert.strictEqual(stateRow(flow.state), undefined, label + ": state spent");
    assert.strictEqual(connectionRow(ann), undefined, label);
    assertFlowCookieCleared(res, label);
  }
  assert.strictEqual(routeFetch.calls.length, 0, "no outbound call for any of them");
  assert.strictEqual(connectionRow(bea), undefined);
  assert.ok(stateRow(beasFlow.state), "a flow nobody attacked is untouched");
  assert.ok(stateRow(annsFlow.state));
});

test("routes: the callback redirects to /?google=error for an unknown or reused state, a missing code or state, or a failed exchange", async () => {
  const get = async (qs, cookies) => (await as(null)("GET", "/api/google/callback" + qs, { cookies })).headers.get("location");
  assert.strictEqual(await get("?code=c&state=unknown"), "/?google=error");
  assert.strictEqual(await get("?code=c&state=unknown", { [FLOW_COOKIE]: "unknown" }), "/?google=error", "a matching cookie does not make an unknown state good");
  assert.strictEqual(await get(""), "/?google=error");
  assert.strictEqual(await get("?state=x"), "/?google=error");
  assert.strictEqual(await get("?code=c&state[]=a&state[]=b"), "/?google=error");
  assert.strictEqual(await get("?code[]=a&state=x"), "/?google=error");
  assert.strictEqual(await get("?error=server_error&state=x"), "/?google=error");
  assert.strictEqual(routeFetch.calls.length, 0);

  const first = await connectFlow(as, ann);
  assert.strictEqual(await get(`?code=c&state=${first.state}`, first.cookies), "/?google=connected");
  assert.strictEqual(await get(`?code=c&state=${first.state}`, first.cookies), "/?google=error", "a state is single use");
});

test("routes: error=access_denied redirects to /?google=denied, connects nothing and clears the flow cookie", async () => {
  const flow = await connectFlow(as, ann);
  const res = await as(null)("GET", `/api/google/callback?error=access_denied&state=${flow.state}`, { cookies: flow.cookies });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/?google=denied");
  assert.strictEqual(connectionRow(ann), undefined);
  assertFlowCookieCleared(res);
  const bare = await as(null)("GET", "/api/google/callback?error=access_denied");
  assert.strictEqual(bare.headers.get("location"), "/?google=denied");
  assertFlowCookieCleared(bare, "(no cookie sent)");
  assert.strictEqual(routeFetch.calls.length, 0);
});

test("routes: a callback whose exchange fails redirects to /?google=error and connects nothing", async () => {
  const bad = fakeFetch({ [TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });
  const listening = await listen(buildApp(googleRoutes.createGoogleRouter({ limiter: { max: 100000 } }), bad));
  try {
    const request = asUser(listening.base);
    const flow = await connectFlow(request, bea);
    const res = await request(null)("GET", `/api/google/callback?code=c&state=${flow.state}`, { cookies: flow.cookies });
    assert.strictEqual(res.headers.get("location"), "/?google=error");
    assert.strictEqual(bad.calls.length, 1, "it did get as far as the token request");
    assert.strictEqual(connectionRow(bea), undefined);
    assert.strictEqual(stateRow(flow.state), undefined);
    assertFlowCookieCleared(res);
  } finally {
    listening.server.close();
  }
});

test("Final fix (Ruling 56): a sign-in that leaves the calendar box unticked redirects to /?google=scope and connects nothing", async () => {
  for (const scope of ["openid email", "openid email https://www.googleapis.com/auth/calendar.events.readonly"]) {
    const unticked = fakeFetch(goodRoutes(goodTokens({ scope })));
    const listening = await listen(buildApp(googleRoutes.createGoogleRouter({ limiter: { max: 100000 } }), unticked));
    try {
      const request = asUser(listening.base);
      const flow = await connectFlow(request, bea);
      const res = await request(null)("GET", `/api/google/callback?code=c&state=${flow.state}`, { cookies: flow.cookies });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get("location"), "/?google=scope", scope);
      assert.strictEqual(connectionRow(bea), undefined);
      assert.strictEqual(stateRow(flow.state), undefined);
      assertFlowCookieCleared(res);
    } finally {
      listening.server.close();
    }
  }
});

test("routes: /status shows only the caller's own connection and never a token field", async () => {
  seedConnection(ann, { expiresAt: Date.now() + 5 * MIN });
  seedConnection(bea, { expiresAt: Date.now() + 5 * MIN, status: "reconnect" });
  db.prepare("UPDATE google_connections SET google_email = 'bea@gmail.example' WHERE user_id = ?").run(bea);

  const mine = await as(ann)("GET", "/api/google/status");
  assert.deepStrictEqual(mine.data, { configured: true, connected: true, status: "connected", googleEmail: "ann@gmail.example" });
  const theirs = await as(bea)("GET", "/api/google/status");
  assert.deepStrictEqual(theirs.data, { configured: true, connected: true, status: "reconnect", googleEmail: "bea@gmail.example" });
  const none = await as(lou)("GET", "/api/google/status");
  assert.deepStrictEqual(none.data, { configured: true, connected: false, status: null, googleEmail: null });

  for (const res of [mine, theirs, none]) {
    assert.ok(!/token|secret|_enc|refresh|ya29|1\/\//i.test(res.text), "no token field in " + res.text);
    assert.ok(!res.text.includes(ACCESS_1) && !res.text.includes(REFRESH_1));
  }
});

test("routes: POST /disconnect calls the revoke URL, deletes the row and answers { success: true }", async () => {
  seedConnection(ann, { expiresAt: Date.now() + 5 * MIN });
  seedConnection(bea, { expiresAt: Date.now() + 5 * MIN });
  const res = await as(ann)("POST", "/api/google/disconnect");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.data, { success: true });
  assert.strictEqual(routeFetch.calls.length, 1);
  assert.strictEqual(routeFetch.calls[0].url, REVOKE_URL);
  assert.deepStrictEqual(routeFetch.calls[0].form, { token: REFRESH_1 });
  assert.strictEqual(connectionRow(ann), undefined);
  assert.ok(connectionRow(bea));
  assert.deepStrictEqual((await as(ann)("GET", "/api/google/status")).data, { configured: true, connected: false, status: null, googleEmail: null });
  assert.deepStrictEqual((await as(ann)("POST", "/api/google/disconnect")).data, { success: true });   // idempotent
});

test("routes: everything but the callback needs a signed-in user", async () => {
  for (const [method, p] of [["GET", "/api/google/status"], ["POST", "/api/google/connect"], ["POST", "/api/google/disconnect"]]) {
    const res = await as(null)(method, p);
    assert.strictEqual(res.status, 401, method + " " + p);
  }
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM google_oauth_states").get().n, 0);
});

test("routes: 20 requests a minute per user, counted separately per user; the callback is limited too", async () => {
  const listening = await listen(buildApp(googleRoutes.createGoogleRouter(), routeFetch));
  try {
    const call = asUser(listening.base);
    for (let i = 0; i < 20; i++) assert.strictEqual((await call(ann)("GET", "/api/google/status")).status, 200);
    const limited = await call(ann)("GET", "/api/google/status");
    assert.strictEqual(limited.status, 429);
    assert.strictEqual((await call(bea)("GET", "/api/google/status")).status, 200, "another user has their own count");
    for (let i = 0; i < 20; i++) assert.strictEqual((await call(null)("GET", "/api/google/callback?code=c&state=x")).status, 302);
    assert.strictEqual((await call(null)("GET", "/api/google/callback?code=c&state=x")).status, 429);
  } finally {
    listening.server.close();
  }
});
