"use strict";
// The email-verified sign-up routes (routes/auth.js): POST /register, POST /register/check, POST /register/complete, and the
// bcrypt check every failed /login now costs. Throwaway DB, the real router. No test sends mail: the senders, the mail-ready
// check and both send counters come in through app seams. The IP limiters in the router are module-level, so every request here
// carries its own X-Forwarded-For (the app trusts one proxy hop, as server/index.js does) unless a test pins an address on purpose.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-signup-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
delete process.env.APP_URL;   // the link under test is then the default, http://localhost:8080

const crypto = require("crypto");
const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("../db");
const authRoutes = require("../routes/auth");
const { createSendCounter, hashToken } = require("../lib/passwordReset");
const { addBroker } = require("../test-support/accounts");

const READY_ENV = { NODE_ENV: "test", EMAIL_USER: "a", EMAIL_PASS: "b" };
const OK = { success: true };
const GONE = { success: false, error: "This link has expired or was already used." };
const FORM = { firstName: "Nia", lastName: "New", email: "nia@x.test", password: "password123", orgName: "Nia Mortgage" };
const DAY_MS = 24 * 60 * 60 * 1000;

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const signupRow = (mail) => db.prepare("SELECT * FROM signup_requests WHERE email = ?").get(mail);
const tokenOf = (link) => link.split("#signup=")[1];
// An unused loan-officer invitation for this address, in an office of its own (a pending invite, as POST /invite leaves it).
const addInvite = (mail, firstName = "Ivy") => {
  const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Invite Office')").run().lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO users (org_id, role, first_name, last_name, email, invite_token_hash, invite_expires, invite_accepted)
    VALUES (?, 'lo', ?, 'Invitee', ?, ?, ?, 0)
  `).run(orgId, firstName, mail, hashToken(crypto.randomBytes(32).toString("hex")), new Date(Date.now() + 2 * DAY_MS).toISOString()).lastInsertRowid);
};

let server, app, base, ipCounter = 0;
// What the fake senders were asked to send, and what they do about it (set per test, cleared before each).
let signupCalls, takenCalls, resetCalls, signupImpl, takenImpl, resetImpl;
before(async () => {
  app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.set("sendSignup", async (args) => { signupCalls.push(args); return signupImpl(args); });
  app.set("sendAlreadyRegistered", async (args) => { takenCalls.push(args); return takenImpl(args); });
  app.set("sendPasswordReset", async (args) => { resetCalls.push(args); return resetImpl(args); });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  // a clean slate: no accounts (deleting an organization deletes its users), no waiting sign-ups, no reset links
  db.prepare("DELETE FROM signup_requests").run();
  db.prepare("DELETE FROM password_resets").run();
  db.prepare("DELETE FROM organizations").run();
  signupCalls = []; takenCalls = []; resetCalls = [];
  signupImpl = async () => true; takenImpl = async () => true; resetImpl = async () => true;
  app.set("authEnv", { ...READY_ENV });
  app.set("resetSendCounter", createSendCounter());
  app.set("resetSiteSendCounter", createSendCounter({ max: 60 }));    // fresh each test, like the per-address one
  app.set("signupSiteSendCounter", createSendCounter({ max: 20 }));   // and sign-up's own site cap
});

// One request. Each gets a fresh client address unless the test pins one with `ip`; `cookie` carries a session. A request that
// never answers fails the test instead of hanging it.
async function call(method, p, body, { ip, cookie } = {}) {
  const headers = { "content-type": "application/json", "x-forwarded-for": ip || `10.2.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}` };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, { method, headers, signal: AbortSignal.timeout(10000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data, cookie: setCookie ? setCookie.split(";")[0] : null };
}
const register = (over = {}, opts) => call("POST", "/api/auth/register", { ...FORM, ...over }, opts);
// "is this link still good?" and "use it": the token goes in the body, never in a URL the server would receive (and so log)
const check = (token) => call("POST", "/api/auth/register/check", { token });
const complete = (token, opts) => call("POST", "/api/auth/register/complete", { token }, opts);
const login = (mail, password) => call("POST", "/api/auth/login", { email: mail, password });
const forgot = (mail) => call("POST", "/api/auth/forgot", { email: mail });
const me = (cookie) => call("GET", "/api/auth/me", undefined, { cookie });

// Everything after the answer happens later (and starts with a cost-12 bcrypt hash), so a test that looks at what it did waits.
async function until(check, ms = 5000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
// Room for a wrong, extra send (or a row) to show up before a test says there was none.
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// Asks for a sign-up link (for FORM's address unless `over` says otherwise) and returns its token. A fresh per-address counter
// each time, since one address only gets 3 emails an hour.
async function signupToken(over = {}) {
  app.set("resetSendCounter", createSendCounter());
  const n = signupCalls.length;
  const r = await register(over);
  assert.strictEqual(r.status, 200);
  await until(() => signupCalls.length === n + 1);
  return tokenOf(signupCalls[n].link);
}

test("register: one answer for a new address, a taken one, an unused invite, and one over its hourly limit", async (t) => {
  addBroker(db, { email: "lou@x.test", firstName: "Lou" });
  addInvite("ivy@x.test", "Ivy");
  const hashSync = t.mock.method(bcrypt, "hashSync");   // still the real function, just counted
  const answers = [];
  answers.push(await register());                                         // new
  answers.push(await register({ email: "lou@x.test" }));                  // taken: an account that can sign in
  answers.push(await register({ email: "ivy@x.test" }));                  // taken: an unused invitation
  for (let i = 0; i < 4; i++) answers.push(await register({ email: "over@x.test" }));   // the 4th is past 3 emails an hour
  for (const a of answers) {
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.data, OK);
    assert.strictEqual(a.cookie, null, "nobody is signed in by asking");
  }
  await until(() => signupCalls.length >= 4 && takenCalls.length >= 2);
  await settle();
  assert.deepStrictEqual(signupCalls.map((c) => c.to), ["nia@x.test", "over@x.test", "over@x.test", "over@x.test"]);
  assert.deepStrictEqual(takenCalls.map((c) => c.to), ["lou@x.test", "ivy@x.test"]);
  // and the same work after each answer: one cost-12 hash of the typed password, whichever case it was
  assert.strictEqual(hashSync.mock.callCount(), answers.length);
  assert.ok(hashSync.mock.calls.every((c) => c.arguments[0] === FORM.password && c.arguments[1] === 12));
});

test("register: the answer does not wait for the email", async () => {
  signupImpl = () => new Promise(() => {});   // never finishes
  const r = await register();
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, OK);
  await until(() => signupCalls.length === 1);   // it was started, just not waited for
});

test("register: a new address gets email A with APP_URL/#signup=<64 hex>; nothing exists until the link is used", async () => {
  const users = count("users");
  const orgs = count("organizations");
  // someone else's request whose link ran out: cleared away by the next request
  db.prepare("INSERT INTO signup_requests (email, token_hash, first_name, last_name, org_name, password_hash, expires_at) VALUES ('old@x.test', 'h', 'O', 'L', 'D', 'x', ?)").run(Date.now() - 1);
  const r = await register({ email: "  NIA@X.test ", firstName: " Nia ", lastName: " New ", orgName: "  Nia Mortgage " });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, OK);
  await until(() => signupCalls.length === 1);
  await settle();
  assert.strictEqual(signupCalls.length, 1);
  const sent = signupCalls[0];
  assert.strictEqual(sent.to, "nia@x.test");
  assert.strictEqual(sent.firstName, "Nia");
  assert.strictEqual(sent.orgName, "Nia Mortgage");
  assert.match(sent.link, /^http:\/\/localhost:8080\/#signup=[0-9a-f]{64}$/);
  assert.deepStrictEqual(Object.keys(sent).sort(), ["firstName", "link", "orgName", "to"]);
  assert.strictEqual(takenCalls.length, 0);

  // no account and no organization yet: only the waiting request, with the names trimmed
  assert.strictEqual(count("users"), users);
  assert.strictEqual(count("organizations"), orgs);
  assert.strictEqual(count("signup_requests"), 1);
  assert.strictEqual(signupRow("old@x.test"), undefined, "the expired request was deleted");
  const row = signupRow("nia@x.test");
  assert.deepStrictEqual([row.first_name, row.last_name, row.org_name], ["Nia", "New", "Nia Mortgage"]);
  // the password only as a cost-12 bcrypt hash; the token only as its SHA-256
  assert.notStrictEqual(row.password_hash, "password123");
  assert.ok(!row.password_hash.includes("password123"));
  assert.match(row.password_hash, /^\$2[aby]\$12\$/);
  assert.strictEqual(bcrypt.compareSync("password123", row.password_hash), true);
  const token = tokenOf(sent.link);
  assert.strictEqual(row.token_hash, hashToken(token));
  assert.ok(!Object.values(row).some((v) => String(v).includes(token)), "the token itself is stored nowhere");
  const expiresIn = row.expires_at - Date.now();
  assert.ok(expiresIn > DAY_MS - 60000 && expiresIn <= DAY_MS, "the link lasts 24 hours");
});

test("register: a taken address gets email B with the account's own first name, never the typed one, and nothing is stored", async () => {
  const lou = addBroker(db, { email: "lou@x.test", firstName: "Lou" });
  const r = await register({ email: " Lou@X.test ", firstName: "Mallory", password: "mallory-password" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, OK);
  await until(() => takenCalls.length === 1);
  assert.deepStrictEqual(takenCalls[0], { to: "lou@x.test", firstName: "Lou" });

  // the same for an unused LO invitation: addressed with the invitation's first name
  const ivyId = addInvite("ivy@x.test", "Ivy");
  const ivyBefore = db.prepare("SELECT * FROM users WHERE id = ?").get(ivyId);
  const r2 = await register({ email: "ivy@x.test", firstName: "Mallory", password: "mallory-password" });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r2.data, OK);
  await until(() => takenCalls.length === 2);
  assert.deepStrictEqual(takenCalls[1], { to: "ivy@x.test", firstName: "Ivy" });

  await settle();
  assert.strictEqual(signupCalls.length, 0, "no sign-up link for a taken address");
  assert.strictEqual(count("signup_requests"), 0, "nothing stored for a taken address");
  // and neither account changed: the typed password went nowhere
  assert.deepStrictEqual(db.prepare("SELECT * FROM users WHERE id = ?").get(lou.id), lou);
  assert.deepStrictEqual(db.prepare("SELECT * FROM users WHERE id = ?").get(ivyId), ivyBefore);
});

test("register: the 400s, checked in order, each with its own words", async () => {
  const bad = async (body, error) => {
    const r = await call("POST", "/api/auth/register", body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.deepStrictEqual(r.data, { success: false, error }, JSON.stringify(body).slice(0, 60));
  };
  const ALL = "All fields required";
  const SHORT = "Password must be at least 8 characters";
  const LONG = "Password must be at most 256 characters";
  const EMAIL = "Enter a valid email address";
  const NAMES = "Names and the brokerage name can be at most 100 characters";

  // a missing field, an empty one, a name of only spaces, or a field that isn't a string
  await bad({}, ALL);
  for (const f of Object.keys(FORM)) {
    await bad({ ...FORM, [f]: undefined }, ALL);
    await bad({ ...FORM, [f]: "" }, ALL);
    await bad({ ...FORM, [f]: 42 }, ALL);
    await bad({ ...FORM, [f]: ["x"] }, ALL);
    await bad({ ...FORM, [f]: null }, ALL);
  }
  for (const f of ["firstName", "lastName", "email", "orgName"]) await bad({ ...FORM, [f]: "   " }, ALL);
  await bad({ ...FORM, password: 12345678 }, ALL);

  // the password: 8 to 256 characters, never trimmed
  await bad({ ...FORM, password: "1234567" }, SHORT);
  await bad({ ...FORM, password: "x".repeat(257) }, LONG);

  // the email: at most 254 characters after trimming, an @, and no comma, semicolon or whitespace
  const tooLong = "a".repeat(248) + "@x.test";
  assert.strictEqual(tooLong.length, 255);
  for (const e of ["a@b.c,d@e.f", "a@b.c;d", "a b@c.d", "a@b.c\td", "nope", tooLong]) await bad({ ...FORM, email: e }, EMAIL);

  // names and the brokerage: at most 100 characters after trimming
  for (const f of ["firstName", "lastName", "orgName"]) await bad({ ...FORM, [f]: "n".repeat(101) }, NAMES);

  // in that order: the first problem is the one named
  await bad({ firstName: "n".repeat(101), lastName: "New", email: "nope", password: "short" }, ALL);
  await bad({ ...FORM, firstName: "n".repeat(101), email: "nope", password: "short" }, SHORT);
  await bad({ ...FORM, firstName: "n".repeat(101), email: "nope" }, EMAIL);

  // a refused request stores nothing and sends nothing
  await settle();
  assert.strictEqual(signupCalls.length + takenCalls.length, 0);
  assert.strictEqual(count("signup_requests"), 0);

  // the longest allowed of each is fine
  const ok = async (over, mail) => {
    const r = await register(over);
    assert.strictEqual(r.status, 200, JSON.stringify(over).slice(0, 60));
    assert.deepStrictEqual(r.data, OK);
    await until(() => signupRow(mail));
    return signupRow(mail);
  };
  const pw256 = await ok({ email: "pw@x.test", password: "y".repeat(256) }, "pw@x.test");
  assert.ok(bcrypt.compareSync("y".repeat(256), pw256.password_hash));
  const longest = "a".repeat(245) + "@x.test";
  assert.strictEqual(longest.length, 252);
  await ok({ email: longest }, longest);
  const hundred = "n".repeat(100);
  const names = await ok({ email: "names@x.test", firstName: `  ${hundred} `, lastName: ` ${hundred}  `, orgName: `   ${hundred}   ` }, "names@x.test");
  assert.deepStrictEqual([names.first_name, names.last_name, names.org_name], [hundred, hundred, hundred]);
});

test("register: mail not set up is 503 for every address and stores and sends nothing", async () => {
  addBroker(db, { email: "taken@x.test" });
  app.set("authEnv", { NODE_ENV: "test" });
  for (const mail of ["nia@x.test", "taken@x.test"]) {   // the same for a new address and a taken one
    const r = await register({ email: mail });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.data, { success: false, error: "Sign-up isn't available right now. Please try again later." });
    assert.strictEqual(r.cookie, null);
  }
  // a bad request is still told what is wrong with it first
  assert.strictEqual((await register({ email: "nope" })).status, 400);
  await settle();
  assert.strictEqual(signupCalls.length + takenCalls.length, 0);
  assert.strictEqual(count("signup_requests"), 0);
});

test("register: 5 an hour per IP, then 429", async () => {
  const pinned = { ip: "203.0.113.60" };
  // a bad request counts toward the five too
  for (let i = 0; i < 4; i++) assert.strictEqual((await register({ email: `ip${i}@x.test` }, pinned)).status, 200);
  assert.strictEqual((await register({ email: "nope" }, pinned)).status, 400);
  const sixth = await register({ email: "ip5@x.test" }, pinned);
  assert.strictEqual(sixth.status, 429);
  assert.deepStrictEqual(sixth.data, { success: false, error: "Too many sign-up attempts — please try again in an hour" });
  assert.strictEqual((await register({ email: "nope" }, pinned)).status, 429, "even a bad one is now 429, not 400");
  assert.strictEqual((await register({ email: "elsewhere@x.test" })).status, 200, "another IP is not affected");
  await until(() => signupCalls.length === 5);
  await settle();
  assert.ok(!signupCalls.some((c) => c.to === "ip5@x.test"), "nothing sent for a refused request");
});

test("register: at most 3 emails an hour to one address, counted together with reset emails; sign-up has its own site cap, so it can't use up the reset emails' cap", async () => {
  addBroker(db, { email: "lou@x.test", firstName: "Lou" });
  const answers = [];
  answers.push(await forgot("lou@x.test"));
  answers.push(await forgot("lou@x.test"));
  answers.push(await register({ email: "lou@x.test" }));
  answers.push(await register({ email: "lou@x.test" }));   // the 4th email for this address in the hour: not sent
  for (const a of answers) {
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.data, OK);
  }
  await until(() => resetCalls.length + takenCalls.length >= 3);
  await settle();
  assert.strictEqual(resetCalls.length, 2);
  assert.strictEqual(takenCalls.length, 1);
  assert.strictEqual(signupCalls.length, 0);

  // (a) sign-up's own site cap (A and B together): past it, still 200, nothing stored or sent, and the reset emails' cap is never
  // asked, so a crowd asking for sign-up emails to made-up addresses can't stop password resets
  const resetSite = createSendCounter({ max: 60 });
  const resetSiteAsked = [];
  app.set("resetSiteSendCounter", { take: (key, nowMs) => { resetSiteAsked.push(key); return resetSite.take(key, nowMs); } });
  app.set("signupSiteSendCounter", createSendCounter({ max: 2 }));
  const dee = addBroker(db, { email: "dee@x.test", firstName: "Dee" });
  for (const mail of ["cap1@x.test", "cap2@x.test", "cap3@x.test", "dee@x.test"]) {
    const r = await register({ email: mail });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, OK);
  }
  await until(() => signupCalls.length >= 2);
  await settle();
  assert.deepStrictEqual(signupCalls.map((c) => c.to), ["cap1@x.test", "cap2@x.test"]);
  assert.strictEqual(signupRow("cap3@x.test"), undefined, "past the cap nothing is stored");
  assert.strictEqual(takenCalls.length, 1, "email B is under the same sign-up cap");
  assert.deepStrictEqual(resetSiteAsked, [], "sign-up never asks the reset emails' cap");
  const r = await forgot("dee@x.test");
  assert.strictEqual(r.status, 200);
  await until(() => resetCalls.length === 3);
  assert.strictEqual(resetCalls[2].to, "dee@x.test", "a reset email still goes out past sign-up's cap");
  assert.deepStrictEqual(resetSiteAsked, ["all"]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(dee.id).n, 1);

  // (b) and the other way: with the reset emails' cap used up, sign-up emails A and B still go out
  app.set("resetSiteSendCounter", createSendCounter({ max: 0 }));
  app.set("signupSiteSendCounter", createSendCounter({ max: 20 }));
  const eve = addBroker(db, { email: "eve@x.test", firstName: "Eve" });
  assert.strictEqual((await forgot("eve@x.test")).status, 200);
  await settle();
  assert.strictEqual(resetCalls.length, 3, "the reset cap is in force");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(eve.id).n, 0);
  assert.strictEqual((await register({ email: "fresh@x.test" })).status, 200);
  assert.strictEqual((await register({ email: "eve@x.test" })).status, 200);
  await until(() => signupCalls.length === 3 && takenCalls.length === 2);
  assert.strictEqual(signupCalls[2].to, "fresh@x.test");
  assert.ok(signupRow("fresh@x.test"), "the request is stored");
  assert.deepStrictEqual(takenCalls[1], { to: "eve@x.test", firstName: "Eve" });
});

test("register/check: 200 with the email and brokerage; a check does not use the link up; 410 for every bad link", async () => {
  const users = count("users");
  const token = await signupToken();
  for (let i = 0; i < 2; i++) {
    const r = await check(token);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, { success: true, email: "nia@x.test", orgName: "Nia Mortgage" });
  }
  assert.strictEqual(count("users"), users, "checking creates nothing");
  assert.ok(signupRow("nia@x.test"), "checking leaves the request waiting");

  const gone = async (t, what) => assert.deepStrictEqual(await check(t).then((r) => [r.status, r.data]), [410, GONE], what);
  // malformed and unknown
  for (const t of ["not-a-token", "A".repeat(64), token.toUpperCase(), token.slice(1), "a".repeat(64), 42, null, ["x"]]) await gone(t, String(t));
  assert.deepStrictEqual(await call("POST", "/api/auth/register/check", {}).then((r) => [r.status, r.data]), [410, GONE]);
  // the token never travels in a URL: no GET route answers for it
  assert.strictEqual((await call("GET", `/api/auth/register/check?token=${token}`)).status, 404);

  // replaced by a newer request for the address
  const newer = await signupToken();
  assert.notStrictEqual(newer, token);
  await gone(token, "replaced");
  assert.strictEqual((await check(newer)).status, 200);

  // expired
  db.prepare("UPDATE signup_requests SET expires_at = ? WHERE email = ?").run(Date.now() - 1, "nia@x.test");
  await gone(newer, "expired");

  // the address got an account another way after the link was sent
  const late = await signupToken();
  assert.strictEqual((await check(late)).status, 200);
  addBroker(db, { email: "nia@x.test" });
  await gone(late, "the address has an account now");
});

test("register/complete: signs in as the new broker, with a 14-day trial, and works once", async () => {
  const orgs = count("organizations");
  const users = count("users");
  const token = await signupToken();
  const r = await complete(token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.success, true);
  const user = r.data.user;
  assert.deepStrictEqual(Object.keys(user).sort(), ["careerStage", "email", "firstName", "id", "lastName", "orgId", "role"]);
  assert.strictEqual(user.role, "broker");
  assert.strictEqual(user.careerStage, null);
  assert.deepStrictEqual([user.email, user.firstName, user.lastName], ["nia@x.test", "Nia", "New"]);
  assert.ok(!JSON.stringify(r.data).includes("password"));

  // signed in, with a session at the new account's version 0
  assert.ok(r.cookie && r.cookie.startsWith("rr_token="));
  assert.strictEqual(jwt.decode(r.cookie.slice("rr_token=".length)).sv, 0);
  const signedIn = await me(r.cookie);
  assert.strictEqual(signedIn.status, 200);
  assert.strictEqual(signedIn.data.user.email, "nia@x.test");

  // the brokerage, on a 14-day trial from now, and a broker who can sign in with the password typed at sign-up
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(user.orgId);
  assert.strictEqual(org.name, "Nia Mortgage");
  assert.strictEqual(org.plan, "trial");
  assert.ok(Math.abs(Date.parse(org.trial_ends) - (Date.now() + 14 * DAY_MS)) < 60000, "a 14-day trial");
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  assert.deepStrictEqual([row.role, row.invite_accepted, row.org_id], ["broker", 1, user.orgId]);
  const signIn = await login(FORM.email, FORM.password);
  assert.strictEqual(signIn.status, 200);
  assert.strictEqual(signIn.data.user.id, user.id);

  // used up: a second try is refused, and no second organization or account appears
  assert.deepStrictEqual(await complete(token).then((x) => [x.status, x.data, x.cookie]), [410, GONE, null]);
  assert.deepStrictEqual(await check(token).then((x) => [x.status, x.data]), [410, GONE]);
  assert.strictEqual(count("organizations"), orgs + 1);
  assert.strictEqual(count("users"), users + 1);
  assert.strictEqual(count("signup_requests"), 0);

  // every other bad link is the same 410, and makes nothing
  for (const t of ["not-a-token", "a".repeat(64), 42, undefined]) {
    assert.deepStrictEqual(await complete(t).then((x) => [x.status, x.data]), [410, GONE], String(t));
  }
  const expired = await signupToken({ email: "late@x.test" });
  db.prepare("UPDATE signup_requests SET expires_at = ? WHERE email = ?").run(Date.now() - 1, "late@x.test");
  assert.deepStrictEqual(await complete(expired).then((x) => [x.status, x.data]), [410, GONE], "expired");
  const older = await signupToken({ email: "twice@x.test" });
  const newer = await signupToken({ email: "twice@x.test" });
  assert.deepStrictEqual(await complete(older).then((x) => [x.status, x.data]), [410, GONE], "replaced");
  assert.strictEqual(count("organizations"), orgs + 1);
  assert.strictEqual((await complete(newer)).status, 200, "the newest link works");
});

test("register/complete: refused, and nothing created, after the address got an invite in the meantime", async () => {
  const token = await signupToken();
  assert.strictEqual((await check(token)).status, 200);
  const ivyId = addInvite("nia@x.test", "Nia");
  const invite = db.prepare("SELECT * FROM users WHERE id = ?").get(ivyId);
  const orgs = count("organizations");
  const users = count("users");
  const r = await complete(token);
  assert.strictEqual(r.status, 410);
  assert.deepStrictEqual(r.data, GONE);
  assert.strictEqual(r.cookie, null);
  assert.strictEqual(count("organizations"), orgs, "no organization");
  assert.strictEqual(count("users"), users, "no broker");
  assert.deepStrictEqual(db.prepare("SELECT * FROM users WHERE id = ?").get(ivyId), invite, "the invitation is untouched");
  assert.deepStrictEqual(await check(token).then((x) => [x.status, x.data]), [410, GONE]);
});

test("register/complete: 10 tries per 15 minutes per IP, then 429", async () => {
  const pinned = { ip: "203.0.113.61" };
  for (let i = 0; i < 10; i++) {
    const r = await complete("b".repeat(64), pinned);
    assert.strictEqual(r.status, 410);
    assert.deepStrictEqual(r.data, GONE);
  }
  const eleventh = await complete("b".repeat(64), pinned);
  assert.strictEqual(eleventh.status, 429);
  assert.deepStrictEqual(eleventh.data, { success: false, error: "Too many attempts — please try again in 15 minutes" });
  // its own count: the same IP still gets its tries at accepting an invitation and at resetting a password
  assert.strictEqual((await call("POST", "/api/auth/accept-invite", { token: "c".repeat(64), password: "password123" }, pinned)).status, 410);
  assert.strictEqual((await call("POST", "/api/auth/reset", { token: "c".repeat(64), password: "password123" }, pinned)).status, 410);
  // and /register/check has no limit of its own
  assert.strictEqual((await call("POST", "/api/auth/register/check", { token: "b".repeat(64) }, pinned)).status, 410);
});

test("no log line holds a sign-up token or link, even when the send throws or the store fails", async (t) => {
  const logged = [];
  for (const m of ["error", "warn", "log"]) t.mock.method(console, m, (...args) => { logged.push(args); });
  const loggedText = () => logged.map((args) => args.map(String).join(" ")).join("\n");

  // run 1: the sign-up email can't be sent (and B can't either)
  signupImpl = async () => { throw new Error("smtp down"); };
  takenImpl = async () => { throw new Error("smtp still down"); };
  addBroker(db, { email: "lou@x.test", firstName: "Lou" });
  assert.strictEqual((await register()).status, 200);
  assert.strictEqual((await register({ email: "lou@x.test" })).status, 200);
  await until(() => loggedText().includes("smtp down") && loggedText().includes("smtp still down"));
  assert.strictEqual(signupCalls.length, 1);
  const token = tokenOf(signupCalls[0].link);

  // run 2: the database refuses to store the request, as a full or failing disk would
  const realPrepare = db.prepare;
  t.mock.method(db, "prepare", function (sql) {
    if (String(sql).includes("INSERT INTO signup_requests")) throw new Error("disk I/O error");
    return realPrepare.call(this, sql);
  });
  const r = await register({ email: "quiet@x.test" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data, OK);
  await until(() => loggedText().includes("disk I/O error"));
  db.prepare.mock.restore();
  await settle();

  const text = loggedText();
  assert.ok(text.includes("[auth] sign-up email not sent"));
  assert.ok(text.includes("[auth] already-registered email not sent"));
  assert.ok(text.includes("[auth] sign-up not issued"));
  for (const args of logged) {
    for (const a of args) {
      assert.ok(!String(a).includes("#signup="), "a log line holds a sign-up link");
      assert.ok(!/[0-9a-f]{64}/.test(String(a)), "a log line holds a token");
    }
  }
  assert.ok(!text.includes(token));
  for (const mail of ["nia@x.test", "lou@x.test", "quiet@x.test"]) assert.ok(!text.includes(mail), "a log line names the address");
  assert.strictEqual(signupCalls.length, 1, "nothing sent when the request couldn't be stored");
  assert.strictEqual(signupRow("quiet@x.test"), undefined);
});

test("login: no account, an unused invite, no password, and a wrong password each run one bcrypt check and give the same 401", async (t) => {
  addBroker(db, { email: "real@x.test" });
  addInvite("invited@x.test");
  const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('No Password Org')").run().lastInsertRowid);
  db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted) VALUES (?, 'broker', 'Pat', 'Nopass', 'nopass@x.test', 1)").run(orgId);
  const cmp = t.mock.method(bcrypt, "compareSync");   // still the real function, just counted
  for (const [mail, password] of [["nobody@x.test", "password123"], ["invited@x.test", "password123"], ["nopass@x.test", "password123"], ["real@x.test", "wrong-password"]]) {
    const n = cmp.mock.callCount();
    const r = await login(mail, password);
    assert.strictEqual(r.status, 401, mail);
    assert.deepStrictEqual(r.data, { success: false, error: "Invalid email or password" }, mail);
    assert.strictEqual(r.cookie, null);
    assert.strictEqual(cmp.mock.callCount(), n + 1, `${mail}: exactly one bcrypt check`);
    // the check without an account is against a hash of the same cost as a real one
    assert.match(cmp.mock.calls[n].arguments[1], /^\$2[aby]\$\d\d\$/);
    if (mail !== "real@x.test") assert.match(cmp.mock.calls[n].arguments[1], /^\$2[aby]\$12\$/, mail);
  }
  const n = cmp.mock.callCount();
  assert.strictEqual((await login("real@x.test", "password123")).status, 200);
  assert.strictEqual(cmp.mock.callCount(), n + 1);
});
