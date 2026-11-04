"use strict";
// The forgot-password routes (routes/auth.js): POST /forgot, POST /reset/check, POST /reset. Throwaway DB, the real router. No
// test sends mail: the two senders, the mail-ready check and the per-account send counter all come in through app seams.
// The IP limiters in the router are module-level, so every request here carries its own X-Forwarded-For (the app trusts one
// proxy hop, as server/index.js does) unless a test pins an address on purpose.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-pwreset-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
delete process.env.APP_URL;   // the link under test is then the default, http://localhost:8080

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");

const db = require("../db");
const authRoutes = require("../routes/auth");
const { createSendCounter, issueReset } = require("../lib/passwordReset");

const READY_ENV = { NODE_ENV: "test", EMAIL_USER: "a", EMAIL_PASS: "b" };
const GONE = { success: false, error: "This link has expired or was already used." };
const TOO_SHORT = { success: false, error: "Password must be at least 8 characters" };
const TOO_LONG = { success: false, error: "Password must be at most 256 characters" };
const NEW_PASSWORD = "brand-new-pass";

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Reset API Org')").run().lastInsertRowid);
// accepted = 1 can sign in; 0 is an unused invite. The bcrypt cost is low here only to keep the tests quick.
const addUser = (mail, { first = "Lou", accepted = 1, password = "old-password-1" } = {}) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', ?, 'Smith', ?, ?, ?)"
).run(orgId, first, mail, bcrypt.hashSync(password, 4), accepted).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const resetCount = () => db.prepare("SELECT COUNT(*) AS n FROM password_resets").get().n;
const tokenOf = (link) => link.split("#reset=")[1];

let server, app, base, ipCounter = 0;
// What the fake senders were asked to send, and what they do about it (set per test, cleared before each).
let resetCalls, changedCalls, resetImpl, changedImpl;
before(async () => {
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.set("sendPasswordReset", async (args) => { resetCalls.push(args); return resetImpl(args); });
  app.set("sendPasswordChanged", async (args) => { changedCalls.push(args); return changedImpl(args); });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  db.prepare("DELETE FROM password_resets").run();
  resetCalls = []; changedCalls = [];
  resetImpl = async () => true; changedImpl = async () => true;
  app.set("authEnv", { ...READY_ENV });
  app.set("resetSendCounter", createSendCounter());
  app.set("resetSiteSendCounter", createSendCounter({ max: 60 }));   // fresh each test, like the per-account one
});

// One request. Each gets a fresh client address unless the test pins one with `ip`; `cookie` carries a session.
async function call(method, p, body, { ip, cookie } = {}) {
  const headers = { "content-type": "application/json", "x-forwarded-for": ip || `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}` };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data, cookie: setCookie ? setCookie.split(";")[0] : null };
}
const forgot = (mail, opts) => call("POST", "/api/auth/forgot", { email: mail }, opts);
// "is this link still good?": the token goes in the body, never in a URL the server would receive (and so log)
const getReset = (token) => call("POST", "/api/auth/reset/check", { token });
const postReset = (token, password, opts) => call("POST", "/api/auth/reset", { token, password }, opts);
const login = (mail, password) => call("POST", "/api/auth/login", { email: mail, password });
const me = (cookie) => call("GET", "/api/auth/me", undefined, { cookie });

// The send happens after the answer, so a test that looks at what it did waits for it.
async function until(check, ms = 1000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("forgot: one answer for every email (real, made-up, unused invite, over the limit)", async () => {
  const realId = addUser("real@x.test");
  const inviteId = addUser("invited@x.test", { accepted: 0 });
  // the real counter, watched: it never forgets a key, so it must only ever be asked about an account that exists
  const counter = createSendCounter();
  const asked = [];
  app.set("resetSendCounter", { take: (key, nowMs) => { asked.push(key); return counter.take(key, nowMs); } });
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await forgot("real@x.test"));   // the 4th is past 3 emails an hour
  answers.push(await forgot("nobody@x.test"));
  answers.push(await forgot("invited@x.test"));
  for (const a of answers) {
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.data, { success: true });
  }
  await until(() => resetCalls.length >= 3);
  await new Promise((r) => setTimeout(r, 50));   // room for a 4th, wrong send to show up
  assert.strictEqual(resetCalls.length, 3);
  assert.ok(resetCalls.every((c) => c.to === "real@x.test"));
  assert.deepStrictEqual(asked, ["real@x.test", "real@x.test", "real@x.test", "real@x.test"]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(inviteId).n, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(realId).n, 1);
  assert.strictEqual(resetCount(), 1);
});

test("forgot: the answer does not wait for the email", async () => {
  addUser("slow@x.test");
  resetImpl = () => new Promise(() => {});   // never finishes
  const started = Date.now();
  const r = await forgot("slow@x.test");
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, { success: true });
  assert.ok(Date.now() - started < 1000);
  await until(() => resetCalls.length === 1);   // it was started, just not waited for
});

test("forgot: the link is APP_URL/#reset=<64 hex> (a fragment, never sent to the server), and the email is matched trimmed and lower-cased", async () => {
  const id = addUser("lou@example.com", { first: "Lou" });
  const r = await forgot(" Lou@Example.com ");
  assert.strictEqual(r.status, 200);
  await until(() => resetCalls.length === 1);
  const sent = resetCalls[0];
  assert.strictEqual(sent.to, "lou@example.com");
  assert.strictEqual(sent.firstName, "Lou");
  assert.match(sent.link, /^http:\/\/localhost:8080\/#reset=[0-9a-f]{64}$/);
  assert.deepStrictEqual(Object.keys(sent).sort(), ["firstName", "link", "to"]);
  // the database holds a hash, never the token itself
  const stored = db.prepare("SELECT token_hash FROM password_resets WHERE user_id = ?").get(id).token_hash;
  assert.notStrictEqual(stored, tokenOf(sent.link));
  assert.ok(!stored.includes(tokenOf(sent.link)));
});

test("forgot: mail not set up is 503 and stores nothing", async () => {
  addUser("nomail@x.test");
  app.set("authEnv", { NODE_ENV: "test", EMAIL_USER: "a" });   // no EMAIL_PASS
  for (const mail of ["nomail@x.test", "nobody@x.test"]) {     // the same for a real account and a made-up one
    const r = await forgot(mail);
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.data, { success: false, error: "Password reset isn't available right now. Please try again later." });
  }
  assert.strictEqual(resetCount(), 0);
  assert.strictEqual(resetCalls.length, 0);
});

test("forgot: a bad email is 400, and the 6th request in an hour from one IP is 429", async () => {
  const pinned = { ip: "203.0.113.50" };
  const BAD = { success: false, error: "Enter a valid email address" };
  // not a string, missing, empty, only spaces, no @, and over 254 characters: all refused before anything is looked up
  for (const body of [{ email: 42 }, { email: ["a@b.co"] }, {}, { email: "" }, { email: "   " }, { email: "no-at-sign" }, { email: "a".repeat(252) + "@b.co" }]) {
    const r = await call("POST", "/api/auth/forgot", body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 30));
    assert.deepStrictEqual(r.data, BAD);
  }
  const exactly254 = "a".repeat(250) + "@b.c";
  assert.strictEqual(exactly254.length, 254);
  assert.strictEqual((await forgot(exactly254)).status, 200);   // the longest allowed

  // one address: a bad request counts toward the five, and the sixth is refused whatever it holds
  assert.strictEqual((await forgot("nope", pinned)).status, 400);
  for (let i = 0; i < 4; i++) assert.strictEqual((await forgot(`unknown${i}@x.test`, pinned)).status, 200);
  const sixth = await forgot("unknown5@x.test", pinned);
  assert.strictEqual(sixth.status, 429);
  assert.deepStrictEqual(sixth.data, { success: false, error: "Too many reset requests — please try again in an hour" });
  assert.strictEqual((await forgot("nope", pinned)).status, 429);   // even a bad one is now 429, not 400
});

test("reset: the link works once, not after 60 minutes, not after a newer one; every refusal is the same 410", async () => {
  const id = addUser("once@x.test");
  // a new link each time; a fresh send counter each time, since one account only gets 3 emails an hour
  const askToken = async () => {
    app.set("resetSendCounter", createSendCounter());
    const n = resetCalls.length;
    await forgot("once@x.test");
    await until(() => resetCalls.length === n + 1);
    return tokenOf(resetCalls[n].link);
  };

  // valid: opening it does not use it up, saving does
  const t1 = await askToken();
  const peek = await getReset(t1);
  assert.strictEqual(peek.status, 200);
  assert.deepStrictEqual(peek.data, { success: true, email: "once@x.test" });
  assert.strictEqual((await getReset(t1)).status, 200);
  const used = await postReset(t1, NEW_PASSWORD);
  assert.strictEqual(used.status, 200);
  assert.deepStrictEqual(await getReset(t1).then((r) => [r.status, r.data]), [410, GONE]);
  assert.deepStrictEqual(await postReset(t1, "another-password").then((r) => [r.status, r.data]), [410, GONE]);
  assert.ok(bcrypt.compareSync(NEW_PASSWORD, userRow(id).password_hash), "the second try changed nothing");

  // expired
  const t2 = await askToken();
  db.prepare("UPDATE password_resets SET expires_at = 0 WHERE user_id = ?").run(id);
  assert.deepStrictEqual(await getReset(t2).then((r) => [r.status, r.data]), [410, GONE]);
  assert.deepStrictEqual(await postReset(t2, "expired-password").then((r) => [r.status, r.data]), [410, GONE]);

  // replaced by a newer link
  const t3 = await askToken();
  const t4 = await askToken();
  assert.notStrictEqual(t3, t4);
  assert.deepStrictEqual(await getReset(t3).then((r) => [r.status, r.data]), [410, GONE]);
  assert.deepStrictEqual(await postReset(t3, "replaced-password").then((r) => [r.status, r.data]), [410, GONE]);
  assert.strictEqual((await getReset(t4)).status, 200);

  // the token never travels in a URL: no GET route answers for it (a GET would put it in the host's request log)
  assert.strictEqual((await call("GET", `/api/auth/reset/${t4}`)).status, 404);
  assert.strictEqual((await call("GET", `/api/auth/reset/check?token=${t4}`)).status, 404);

  // malformed, unknown, and an unused invite that somehow has a row: all the same answer
  const invitedId = addUser("pending@x.test", { accepted: 0 });
  const tInvite = issueReset(db, invitedId, Date.now());
  for (const token of ["not-a-token", "a".repeat(64), "A".repeat(64), tInvite]) {
    assert.deepStrictEqual(await getReset(token).then((r) => [r.status, r.data]), [410, GONE], token);
    assert.deepStrictEqual(await postReset(token, "some-password-1").then((r) => [r.status, r.data]), [410, GONE], token);
  }
  assert.deepStrictEqual(await call("POST", "/api/auth/reset/check", {}).then((r) => [r.status, r.data]), [410, GONE]);
  assert.deepStrictEqual(await call("POST", "/api/auth/reset/check", { token: 42 }).then((r) => [r.status, r.data]), [410, GONE]);
  assert.deepStrictEqual(await call("POST", "/api/auth/reset", { password: "some-password-1" }).then((r) => [r.status, r.data]), [410, GONE]);
  assert.deepStrictEqual(await call("POST", "/api/auth/reset", { token: 42, password: "some-password-1" }).then((r) => [r.status, r.data]), [410, GONE]);
});

test("reset: a new password signs in here, ends older sessions, and sends the changed notice", async () => {
  const id = addUser("signin@x.test", { first: "Sam", password: "old-password-1" });
  const a = await login("signin@x.test", "old-password-1");   // the session on some other device
  assert.strictEqual(a.status, 200);
  assert.strictEqual((await me(a.cookie)).status, 200);

  await forgot("signin@x.test");
  await until(() => resetCalls.length === 1);
  const token = tokenOf(resetCalls[0].link);

  // too short: refused, nothing changes, the link still works
  const untouched = userRow(id);
  for (const short of ["1234567", "", undefined, 12345678]) {
    const r = await call("POST", "/api/auth/reset", { token, password: short });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.data, TOO_SHORT);
  }
  assert.deepStrictEqual(userRow(id), untouched);
  assert.strictEqual((await getReset(token)).status, 200);
  assert.strictEqual(changedCalls.length, 0);

  const done = await postReset(token, NEW_PASSWORD);
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.data.success, true);
  assert.strictEqual(done.data.user.email, "signin@x.test");
  assert.strictEqual(done.data.user.firstName, "Sam");
  assert.ok(!("password_hash" in done.data.user) && !JSON.stringify(done.data).includes("password"));
  assert.ok(done.cookie && done.cookie.startsWith("rr_token="));
  assert.strictEqual((await me(a.cookie)).status, 401, "the older session is finished");
  const nowSignedIn = await me(done.cookie);
  assert.strictEqual(nowSignedIn.status, 200, "the session this reset made works");
  assert.strictEqual(nowSignedIn.data.user.email, "signin@x.test");
  assert.strictEqual((await login("signin@x.test", "old-password-1")).status, 401);
  assert.strictEqual((await login("signin@x.test", NEW_PASSWORD)).status, 200);
  assert.strictEqual(userRow(id).session_version, untouched.session_version + 1);

  await until(() => changedCalls.length === 1);
  assert.deepStrictEqual(changedCalls, [{ to: "signin@x.test", firstName: "Sam" }]);
});

test("reset: a password over 256 characters is refused (the link stays good); 256 is fine", async () => {
  const id = addUser("longpw@x.test");
  await forgot("longpw@x.test");
  await until(() => resetCalls.length === 1);
  const token = tokenOf(resetCalls[0].link);
  const untouched = userRow(id);
  const refused = await postReset(token, "x".repeat(257));
  assert.strictEqual(refused.status, 400);
  assert.deepStrictEqual(refused.data, TOO_LONG);
  assert.deepStrictEqual(userRow(id), untouched);
  assert.strictEqual((await getReset(token)).status, 200, "the link still works");
  assert.strictEqual((await postReset(token, "y".repeat(256))).status, 200);
});

test("reset: the link is checked before the password is hashed, so a made-up link never costs a bcrypt hash", async (t) => {
  const id = addUser("hashfirst@x.test");
  await forgot("hashfirst@x.test");
  await until(() => resetCalls.length === 1);
  const token = tokenOf(resetCalls[0].link);
  const hashSync = t.mock.method(bcrypt, "hashSync");   // still the real function, just counted
  for (const junk of ["not-a-token", "a".repeat(64), undefined]) {
    const r = await postReset(junk, NEW_PASSWORD);
    assert.strictEqual(r.status, 410);
    assert.deepStrictEqual(r.data, GONE);
  }
  assert.strictEqual(hashSync.mock.callCount(), 0, "no hash for a link that isn't good");
  assert.strictEqual((await postReset(token, NEW_PASSWORD)).status, 200);
  assert.strictEqual(hashSync.mock.callCount(), 1, "one hash for the good link");
  assert.ok(bcrypt.compareSync(NEW_PASSWORD, userRow(id).password_hash));
});

test("forgot: a site-wide cap on reset emails protects the mailbox: past it, still 200, but nothing is stored or sent", async () => {
  const ids = ["cap1", "cap2", "cap3"].map((n) => addUser(n + "@x.test"));
  const site = createSendCounter({ max: 2 });
  const asked = [];
  app.set("resetSiteSendCounter", { take: (key, nowMs) => { asked.push(key); return site.take(key, nowMs); } });
  const answers = [];
  for (const n of ["cap1", "cap2", "cap3"]) answers.push(await forgot(n + "@x.test"));
  answers.push(await forgot("nobody@x.test"));
  for (const a of answers) {
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.data, { success: true });
  }
  await until(() => resetCalls.length >= 2);
  await new Promise((r) => setTimeout(r, 50));   // room for a 3rd, wrong send to show up
  assert.deepStrictEqual(resetCalls.map((c) => c.to), ["cap1@x.test", "cap2@x.test"]);
  assert.strictEqual(resetCount(), 2);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(ids[2]).n, 0);
  // one shared key, asked only once a real account had passed its own limit: a made-up address never touches it
  assert.deepStrictEqual(asked, ["all", "all", "all"]);
});

test("no log line contains the token or the link, even when the send throws", async () => {
  addUser("quiet@x.test", { first: "Quin" });
  const logged = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => logged.push(args.map(String).join(" "));
  const countOf = (text) => logged.filter((l) => l.includes(text)).length;
  const tokens = [];
  // asks for a link (the sender then fails the way resetImpl says) and returns its token
  const ask = async () => {
    app.set("resetSendCounter", createSendCounter());   // one account only gets 3 emails an hour
    const n = resetCalls.length;
    assert.strictEqual((await forgot("quiet@x.test")).status, 200);
    await until(() => resetCalls.length === n + 1);
    tokens.push(tokenOf(resetCalls[n].link));
    return tokens[tokens.length - 1];
  };
  try {
    resetImpl = async () => { throw new Error("smtp down"); };
    await ask();
    await until(() => countOf("[auth] reset email not sent") === 1);

    resetImpl = async () => false;   // the real sender answers false when Gmail refuses
    await ask();
    await until(() => countOf("[auth] reset email not sent") === 2);

    // using a link: the changed notice fails both ways too, and the person is still signed in
    changedImpl = async () => { throw new Error("smtp still down"); };
    assert.strictEqual((await postReset(await ask(), NEW_PASSWORD)).status, 200);
    await until(() => countOf("smtp still down") === 1);
    changedImpl = async () => false;
    assert.strictEqual((await postReset(await ask(), NEW_PASSWORD)).status, 200);
    await until(() => countOf("password-changed email not sent") === 2);
  } finally {
    Object.assign(console, real);
  }
  const text = logged.join("\n");
  assert.ok(text.includes("smtp down"));
  for (const t of tokens) assert.ok(!text.includes(t), "a log line holds a reset token");
  assert.ok(!/[?#]reset=/.test(text), "a log line holds a reset link");
  assert.ok(!text.includes("quiet@x.test"), "a log line names the account");
});

test("forgot: a failure after the answer (the link can't be stored) is the same 200, and is logged without a token", async () => {
  addUser("unlucky@x.test");
  const logged = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => logged.push(args.map(String).join(" "));
  // the database refuses to store a link, as a full or failing disk would
  const realPrepare = db.prepare;
  db.prepare = function (sql) {
    if (/INSERT INTO password_resets/.test(sql)) throw new Error("disk I/O error");
    return realPrepare.call(this, sql);
  };
  let realAccount, madeUp;
  try {
    realAccount = await forgot("unlucky@x.test");
    madeUp = await forgot("nobody@x.test");
    assert.strictEqual(realAccount.status, 200, "the answer for a real account must not depend on storing the link");
    await until(() => logged.some((l) => l.includes("[auth] reset not issued")));
  } finally {
    delete db.prepare;   // back to the prototype's own
    Object.assign(console, real);
  }
  // a real account can't be told from a made-up one by the answer, even when storing the link fails
  assert.strictEqual(realAccount.status, 200);
  assert.deepStrictEqual(realAccount.data, { success: true });
  assert.strictEqual(madeUp.status, realAccount.status);
  assert.deepStrictEqual(madeUp.data, realAccount.data);
  assert.strictEqual(resetCalls.length, 0);
  assert.strictEqual(resetCount(), 0);
  const text = logged.join(" | ");
  assert.ok(text.includes("disk I/O error"));
  assert.ok(!/[0-9a-f]{64}/.test(text), "a log line holds a token");
  assert.ok(!/[?#]reset=/.test(text), "a log line holds a reset link");
  assert.ok(!text.includes("unlucky@x.test"), "a log line names the account");
});

test("reset: 10 tries per 15 minutes per IP, then 429", async () => {
  const pinned = { ip: "203.0.113.77" };
  for (let i = 0; i < 10; i++) {
    assert.strictEqual((await postReset("a".repeat(64), "short", pinned)).status, 400);   // refused cheaply, but it still counts
  }
  const eleventh = await postReset("a".repeat(64), "long-enough-password", pinned);
  assert.strictEqual(eleventh.status, 429);
  assert.deepStrictEqual(eleventh.data, { success: false, error: "Too many attempts — please try again in 15 minutes" });
});
