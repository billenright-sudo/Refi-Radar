"use strict";
// POST /api/auth/invite (routes/auth.js): a broker invites a loan officer. The invite email goes through the "sendInvite" app seam,
// so no test sends mail. The IP limiter in the router is module-level, so every request carries its own X-Forwarded-For (the app
// trusts one proxy hop, as server/index.js does) unless a test pins an address on purpose.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-invite-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const authRoutes = require("../routes/auth");
const { hashToken } = require("../lib/passwordReset");

const BAD_EMAIL = { success: false, error: "Enter a valid email address" };

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Invite API Org')").run().lastInsertRowid);
const addUser = (role, mail) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted) VALUES (?, ?, 'Bo', 'Boss', ?, 1)"
).run(orgId, role, mail).lastInsertRowid);
const broker = addUser("broker", "boss@invite.test");
const lo = addUser("lo", "lo@invite.test");
const userCount = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;

let server, base, ipCounter = 0, sends;
before(async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.set("sendInvite", async (args) => { sends.push(args); });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { sends = []; });

async function invite(body, { as = broker, ip } = {}) {
  const headers = { "content-type": "application/json", "x-forwarded-for": ip || `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}` };
  if (as != null) headers.cookie = `rr_token=${signToken({ userId: as, sv: 0 })}`;
  const res = await fetch(base + "/api/auth/invite", { method: "POST", headers, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}
const person = (email) => ({ firstName: " Nia ", lastName: " Newhire ", email });

test("invite: the address is trimmed and lower-cased, for the row, the email and the answer", async () => {
  const r = await invite(person("  New.LO@Example.COM "));
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.data, { success: true, message: "Invitation sent to new.lo@example.com" });
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].toEmail, "new.lo@example.com");
  const row = db.prepare("SELECT first_name, last_name, email, role, invite_accepted FROM users WHERE email = ?").get("new.lo@example.com");
  assert.deepStrictEqual({ ...row }, { first_name: "Nia", last_name: "Newhire", email: "new.lo@example.com", role: "lo", invite_accepted: 0 });
});

test("invite: an address that is empty, too long, without @, or a list or has a space is 400, and no user is made", async () => {
  const before = userCount();
  const bad = ["", "   ", 42, null, ["a@b.co"], "no-at-sign", "a@b.co,c@d.co", "a@b.co;c@d.co", "a b@c.co", "a@b.co\tc@d.co", "a".repeat(252) + "@b.co"];
  for (const email of bad) {
    const r = await invite(person(email));
    assert.strictEqual(r.status, 400, JSON.stringify(email)?.slice(0, 40));
    assert.deepStrictEqual(r.data, BAD_EMAIL);
  }
  const missing = await invite({ firstName: "Nia", lastName: "Newhire" });
  assert.strictEqual(missing.status, 400);
  assert.deepStrictEqual(missing.data, BAD_EMAIL);
  assert.strictEqual(userCount(), before, "no row for any of them");
  assert.strictEqual(sends.length, 0, "and nothing was sent");

  // 254 is the longest allowed, and a name is still required
  const longest = "a".repeat(250) + "@b.c";
  assert.strictEqual(longest.length, 254);
  assert.strictEqual((await invite(person(longest))).status, 201);
  const noName = await invite({ firstName: "", lastName: "Newhire", email: "x@y.co" });
  assert.strictEqual(noName.status, 400);
  assert.strictEqual(noName.data.error, "First name, last name, and email required");
});

test("invite: only a signed-in broker can invite, and an address already in use is 409", async () => {
  assert.strictEqual((await invite(person("a@x.test"), { as: null })).status, 401);
  assert.strictEqual((await invite(person("a@x.test"), { as: lo })).status, 403);
  const taken = await invite(person(" LO@invite.test "));   // the stored address, in other letters and with spaces
  assert.strictEqual(taken.status, 409);
  assert.strictEqual(sends.length, 0);
});

test("invite: 20 an hour per IP, then 429", async () => {
  const pinned = { ip: "203.0.113.90" };
  for (let i = 0; i < 20; i++) assert.strictEqual((await invite(person(`limit${i}@invite.test`), pinned)).status, 201, `invite ${i + 1}`);
  const twentyFirst = await invite(person("limit20@invite.test"), pinned);
  assert.strictEqual(twentyFirst.status, 429);
  assert.deepStrictEqual(twentyFirst.data, { success: false, error: "Too many invitations — please try again in an hour" });
  assert.strictEqual(sends.length, 20);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'limit20@invite.test'").get().n, 0);
  assert.strictEqual((await invite(person("limit21@invite.test"))).status, 201, "the limit is per IP: another address elsewhere is not held back");
});

// ── the link: a hashed secret, checked by POST ───────────────────────────────

const GONE = { success: false, error: "This invitation has expired or was already used." };
async function post(route, body, ip) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip || `10.2.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}` },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data, cookie: res.headers.get("set-cookie") };
}
const rowFor = (mail) => db.prepare("SELECT * FROM users WHERE email = ?").get(mail);
// A pending invite made the way /invite makes it, with a chosen lifetime.
function pending(mail, { ttlMs = 3600 * 1000, accepted = 0 } = {}) {
  const token = require("crypto").randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO users (org_id, role, first_name, last_name, email, invite_token_hash, invite_expires, invite_accepted) VALUES (?, 'lo', 'Nia', 'Newhire', ?, ?, ?, ?)"
  ).run(orgId, mail, hashToken(token), new Date(Date.now() + ttlMs).toISOString(), accepted);
  return token;
}

test("invite: the row keeps only the SHA-256 of the token, and the emailed token checks out", async () => {
  const r = await invite(person("hashed@invite.test"));
  assert.strictEqual(r.status, 201);
  const row = rowFor("hashed@invite.test");
  assert.strictEqual(row.invite_token, null);
  assert.strictEqual(row.invite_token_hash, hashToken(sends[0].token));
  assert.ok(/^[0-9a-f]{64}$/.test(row.invite_token_hash));
  assert.notStrictEqual(row.invite_token_hash, sends[0].token);
  const c = await post("/api/auth/invite/check", { token: sends[0].token });
  assert.strictEqual(c.status, 200);
  assert.deepStrictEqual(c.data, { success: true, firstName: "Nia", lastName: "Newhire", email: "hashed@invite.test", orgName: "Invite API Org" });
});

test("invite check: malformed, unknown, expired and used tokens all get the same 410", async () => {
  const expired = pending("expired@invite.test", { ttlMs: -1000 });
  const used = pending("used@invite.test", { accepted: 1 });
  const cases = ["short", "AB".repeat(32), "zz".repeat(32), "ab".repeat(32), "ab".repeat(33), "", expired, used];
  for (const token of cases) {
    const r = await post("/api/auth/invite/check", { token });
    assert.strictEqual(r.status, 410, token.slice(0, 12));
    assert.deepStrictEqual(r.data, GONE);
  }
  for (const body of [{}, { token: 42 }, { token: null }, { token: ["ab".repeat(32)] }]) {
    const r = await post("/api/auth/invite/check", body);
    assert.strictEqual(r.status, 410, JSON.stringify(body));
    assert.deepStrictEqual(r.data, GONE);
  }
  // the old column is not a way in: a plaintext token in invite_token no longer opens anything
  const legacy = "cd".repeat(32);
  db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, invite_token, invite_expires, invite_accepted) VALUES (?, 'lo', 'L', 'G', 'legacy@invite.test', ?, ?, 0)")
    .run(orgId, legacy, new Date(Date.now() + 3600 * 1000).toISOString());
  assert.strictEqual((await post("/api/auth/invite/check", { token: legacy })).status, 410);
});

test("GET /api/auth/invite/<token> is gone (the secret no longer goes in a URL)", async () => {
  const token = pending("geturl@invite.test");
  assert.strictEqual((await fetch(base + "/api/auth/invite/" + token)).status, 404);
  assert.strictEqual((await fetch(base + "/api/auth/invite/" + "ab".repeat(32))).status, 404);
});

test("accept-invite: a bad token is the same 410 and costs no bcrypt hash; a good one works once", async (t) => {
  const token = pending("accept@invite.test");
  const hashSync = t.mock.method(bcrypt, "hashSync");
  for (const bad of ["not-hex", "ab".repeat(32), undefined, 42]) {
    const r = await post("/api/auth/accept-invite", { token: bad, password: "password123" });
    assert.strictEqual(r.status, 410, String(bad));
    assert.deepStrictEqual(r.data, GONE);
  }
  assert.strictEqual(hashSync.mock.callCount(), 0, "no hash for a bad token");

  const ok = await post("/api/auth/accept-invite", { token, password: "password123" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.success, true);
  assert.strictEqual(ok.data.user.email, "accept@invite.test");
  assert.ok(/rr_token=/.test(ok.cookie || ""), "a session cookie is set");
  assert.strictEqual(hashSync.mock.callCount(), 1);
  const row = rowFor("accept@invite.test");
  assert.strictEqual(row.invite_accepted, 1);
  assert.strictEqual(row.invite_token_hash, null);
  assert.strictEqual(row.invite_expires, null);
  assert.ok(bcrypt.compareSync("password123", row.password_hash));

  const again = await post("/api/auth/accept-invite", { token, password: "password123" });
  assert.strictEqual(again.status, 410);
  assert.deepStrictEqual(again.data, GONE);
});

test("accept-invite: a password under 8 or over 256 characters is 400 and the invite stays good", async () => {
  const token = pending("pw@invite.test");
  for (const password of ["short", "1234567", "", undefined, 12345678, "x".repeat(257)]) {
    const r = await post("/api/auth/accept-invite", { token, password });
    assert.strictEqual(r.status, 400, String(password).slice(0, 10));
    assert.strictEqual(r.data.success, false);
  }
  assert.strictEqual((await post("/api/auth/accept-invite", { token, password: "short" })).data.error, "Password must be at least 8 characters");
  assert.strictEqual((await post("/api/auth/accept-invite", { token, password: "x".repeat(257) })).data.error, "Password must be at most 256 characters");
  // the password is checked before the token, so even a made-up token with a short password is 400
  assert.strictEqual((await post("/api/auth/accept-invite", { token: "ab".repeat(32), password: "short" })).status, 400);
  const row = rowFor("pw@invite.test");
  assert.strictEqual(row.invite_accepted, 0);
  assert.strictEqual(row.invite_token_hash, hashToken(token));
  assert.strictEqual((await post("/api/auth/accept-invite", { token, password: "x".repeat(256) })).status, 200, "256 is allowed");
});

test("accept-invite: 10 tries per 15 minutes per IP, then 429", async () => {
  const ip = "203.0.113.91";
  for (let i = 0; i < 10; i++) {
    const r = await post("/api/auth/accept-invite", { token: "ef".repeat(32), password: "password123" }, ip);
    assert.strictEqual(r.status, 410, `try ${i + 1}`);
  }
  const eleventh = await post("/api/auth/accept-invite", { token: "ef".repeat(32), password: "password123" }, ip);
  assert.strictEqual(eleventh.status, 429);
  assert.deepStrictEqual(eleventh.data, { success: false, error: "Too many attempts — please try again in 15 minutes" });
  assert.strictEqual((await post("/api/auth/accept-invite", { token: "ef".repeat(32), password: "password123" })).status, 410, "another IP is not held back");
  // the check route has no limit of its own
  for (let i = 0; i < 12; i++) assert.strictEqual((await post("/api/auth/invite/check", { token: "ef".repeat(32) }, ip)).status, 410);
});
