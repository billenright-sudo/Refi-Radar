"use strict";
// /api/profile (routes/profile.js): the signed-in user's own profile (name, login email, tenure) and NMLS ID and, for a broker,
// the company's. Throwaway DB, the real router behind a signed rr_token cookie. The email-change mail goes through the
// "sendEmailChange" app seam, so no test sends real mail.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-profile-api-"));
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
const profileRoutes = require("../routes/profile");
const authRoutes = require("../routes/auth");
const emailLib = require("../email");

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, 'T', 'User', ?)"
).run(orgId, role, email).lastInsertRowid);
const userNmls = (id) => db.prepare("SELECT nmls_id FROM users WHERE id = ?").get(id).nmls_id;
const orgNmls = (id) => db.prepare("SELECT nmls_id FROM organizations WHERE id = ?").get(id).nmls_id;

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.co");
const lou = addUser(orgA, "lo", "lou@a.co");
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@b.co");

const DIGITS_ONLY = { success: false, error: "An NMLS ID is digits only" };

// A user who can log in (the login route wants a password and an accepted invite).
const PASSWORD = "password123";
const addLoginUser = (orgId, role, mail, first = "Pat", last = "Jones") => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, ?, ?, ?, ?, ?, 1)"
).run(orgId, role, first, last, mail, bcrypt.hashSync(PASSWORD, 4)).lastInsertRowid);
const userRow = (id) => db.prepare("SELECT first_name, last_name, email, career_stage FROM users WHERE id = ?").get(id);
const changeRow = (id) => db.prepare("SELECT * FROM email_changes WHERE user_id = ?").get(id);

// The sendEmailChange seam: the route calls app.get("sendEmailChange"); this fake records what it was asked to send.
let sent = [];            // [{ to, link }]
let sendResult = true;    // what the fake returns (an Error is thrown instead)
const fakeSend = async (to, link) => {
  sent.push({ to, link });
  if (sendResult instanceof Error) throw sendResult;
  return sendResult;
};
const tokenOf = (link) => link.split("/").pop();

let server, as, raw, app, base;
beforeEach(() => { sent = []; sendResult = true; });
before(async () => {
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/profile", profileRoutes);
  // the email-change rate limit is raised out of the way here; its own tests (below) use a small limit and the real default
  app.set("emailChangeLimit", 100000);
  app.set("sendEmailChange", fakeSend);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
  // a request whose redirect is NOT followed: { status, location }
  raw = async (p, userId) => {
    const headers = userId != null ? { cookie: "rr_token=" + signToken({ userId }) } : {};
    const res = await fetch(base + p, { redirect: "manual", headers });
    return { status: res.status, location: res.headers.get("location") };
  };
  as = (userId) => async (method, p, body) => {
    const headers = { "content-type": "application/json" };
    if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data };
  };
});
after(() => {
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

test("every route needs a signed-in user", async () => {
  for (const [method, p, body] of [["GET", "/api/profile/nmls"], ["PUT", "/api/profile/nmls", { nmlsId: "1" }], ["PUT", "/api/profile/org-nmls", { nmlsId: "1" }]]) {
    const r = await as(null)(method, p, body);
    assert.equal(r.status, 401, `${method} ${p}`);
  }
  assert.equal(userNmls(ann), null);
});

test("GET starts empty: no IDs, and only a broker can edit the company's", async () => {
  assert.deepStrictEqual((await as(ann)("GET", "/api/profile/nmls")).data, { nmlsId: null, orgNmlsId: null, canEditOrg: true });
  assert.deepStrictEqual((await as(lou)("GET", "/api/profile/nmls")).data, { nmlsId: null, orgNmlsId: null, canEditOrg: false });
});

test("a loan officer sets, changes and clears their own NMLS ID, and trimming applies", async () => {
  let r = await as(lou)("PUT", "/api/profile/nmls", { nmlsId: "  445566 " });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, { nmlsId: "445566", orgNmlsId: null, canEditOrg: false });
  assert.equal(userNmls(lou), "445566");
  assert.equal((await as(lou)("GET", "/api/profile/nmls")).data.nmlsId, "445566");

  r = await as(lou)("PUT", "/api/profile/nmls", { nmlsId: "778899" });
  assert.equal(userNmls(lou), "778899");

  r = await as(lou)("PUT", "/api/profile/nmls", { nmlsId: "" });
  assert.equal(r.status, 200);
  assert.equal(r.data.nmlsId, null);
  assert.equal(userNmls(lou), null, "an empty string clears it to NULL, not ''");
  assert.equal((await as(lou)("GET", "/api/profile/nmls")).data.nmlsId, null);
});

test("an NMLS ID with a space, letters, 13 digits or a non-string is a 400 and changes nothing", async () => {
  await as(lou)("PUT", "/api/profile/nmls", { nmlsId: "112233" });
  for (const nmlsId of ["12 34", "abc", "1234567890123", "12-34", "1e3", 123456, null, true, ["1"], { a: 1 }]) {
    const r = await as(lou)("PUT", "/api/profile/nmls", { nmlsId });
    assert.equal(r.status, 400, JSON.stringify(nmlsId));
    assert.deepStrictEqual(r.data, DIGITS_ONLY);
  }
  for (const body of [{}, undefined]) {
    const r = await as(lou)("PUT", "/api/profile/nmls", body);
    assert.equal(r.status, 400);
    assert.deepStrictEqual(r.data, DIGITS_ONLY);
  }
  assert.equal(userNmls(lou), "112233");
  // the longest allowed one is 12 digits
  assert.equal((await as(lou)("PUT", "/api/profile/nmls", { nmlsId: "123456789012" })).status, 200);
});

test("a loan officer cannot touch the company's NMLS ID (403), valid or not", async () => {
  for (const nmlsId of ["999999", "abc", ""]) {
    const r = await as(lou)("PUT", "/api/profile/org-nmls", { nmlsId });
    assert.equal(r.status, 403, nmlsId);
  }
  assert.equal(orgNmls(orgA), null);
});

test("a broker sets and clears the company's NMLS ID, which everyone in that company sees and nobody else", async () => {
  let r = await as(ann)("PUT", "/api/profile/org-nmls", { nmlsId: " 654321 " });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, { nmlsId: null, orgNmlsId: "654321", canEditOrg: true });
  assert.equal(orgNmls(orgA), "654321");
  assert.equal(userNmls(ann), null, "the company's ID is not the broker's own");
  assert.equal(orgNmls(orgB), null, "another company is untouched");

  const lo = (await as(lou)("GET", "/api/profile/nmls")).data;
  assert.equal(lo.orgNmlsId, "654321");
  assert.equal(lo.canEditOrg, false);
  assert.equal((await as(bea)("GET", "/api/profile/nmls")).data.orgNmlsId, null);

  r = await as(ann)("PUT", "/api/profile/org-nmls", { nmlsId: "" });
  assert.equal(r.status, 200);
  assert.equal(orgNmls(orgA), null);
});

test("the company's NMLS ID is validated like the user's", async () => {
  await as(ann)("PUT", "/api/profile/org-nmls", { nmlsId: "654321" });
  for (const nmlsId of ["65 43", "abc", "1234567890123", 654321, null]) {
    const r = await as(ann)("PUT", "/api/profile/org-nmls", { nmlsId });
    assert.equal(r.status, 400, JSON.stringify(nmlsId));
    assert.deepStrictEqual(r.data, DIGITS_ONLY);
  }
  assert.equal(orgNmls(orgA), "654321");
});

test("a broker's own ID and the company's are separate, and GET returns both", async () => {
  await as(ann)("PUT", "/api/profile/nmls", { nmlsId: "123456" });
  assert.deepStrictEqual((await as(ann)("GET", "/api/profile/nmls")).data, { nmlsId: "123456", orgNmlsId: "654321", canEditOrg: true });
});

// ── The full profile, name, tenure ───────────────────────────────────────────

const orgP = addOrg("Profile Co");
const BAD_NAME = { success: false, error: "Use letters only in your name" };

test("the new routes need a signed-in user, except the emailed confirm link", async () => {
  for (const [method, p, body] of [
    ["GET", "/api/profile"], ["PUT", "/api/profile/name", { firstName: "A", lastName: "B" }],
    ["PUT", "/api/profile/career-stage", { stage: "new" }], ["POST", "/api/profile/email", { email: "x@y.co" }],
  ]) {
    assert.equal((await as(null)(method, p, body)).status, 401, `${method} ${p}`);
  }
  // the confirm link is clicked from an inbox, with no session: a bad token is a redirect, not a 401
  const r = await raw("/api/profile/email/confirm/" + "a".repeat(64));
  assert.equal(r.status, 302);
});

test("GET /api/profile returns the whole profile, and the NMLS routes keep their own shape", async () => {
  const id = addLoginUser(orgP, "broker", "gina@p.co", "Gina", "Park");
  assert.deepStrictEqual((await as(id)("GET", "/api/profile")).data, {
    firstName: "Gina", lastName: "Park", email: "gina@p.co", pendingEmail: null, careerStage: null,
    nmlsId: null, orgNmlsId: null, canEditOrg: true,
  });
  await as(id)("PUT", "/api/profile/nmls", { nmlsId: "4455" });
  await as(id)("PUT", "/api/profile/career-stage", { stage: "established" });
  const lo = addLoginUser(orgP, "lo", "lo1@p.co", "Lo", "One");
  assert.equal((await as(lo)("GET", "/api/profile")).data.canEditOrg, false);
  const g = (await as(id)("GET", "/api/profile")).data;
  assert.equal(g.careerStage, "established");
  assert.equal(g.nmlsId, "4455");
  // a stored value that is not a stage id reads as null, like /api/auth/me
  db.prepare("UPDATE users SET career_stage = 'bogus' WHERE id = ?").run(lo);
  assert.equal((await as(lo)("GET", "/api/profile")).data.careerStage, null);
  assert.deepStrictEqual((await as(id)("GET", "/api/profile/nmls")).data, { nmlsId: "4455", orgNmlsId: null, canEditOrg: true });
});

test("PUT /name trims, saves and returns the profile; a last name can be empty", async () => {
  const id = addLoginUser(orgP, "lo", "nina@p.co", "Old", "Name");
  let r = await as(id)("PUT", "/api/profile/name", { firstName: "  Mary-Jane ", lastName: " O'Brien-Smith  " });
  assert.equal(r.status, 200);
  assert.equal(r.data.firstName, "Mary-Jane");
  assert.equal(r.data.lastName, "O'Brien-Smith");
  assert.equal(r.data.email, "nina@p.co");
  assert.deepStrictEqual(userRow(id), { first_name: "Mary-Jane", last_name: "O'Brien-Smith", email: "nina@p.co", career_stage: null });

  r = await as(id)("PUT", "/api/profile/name", { firstName: "José", lastName: "" });
  assert.equal(r.status, 200);
  assert.deepStrictEqual([r.data.firstName, r.data.lastName], ["José", ""]);
  assert.equal(userRow(id).last_name, "");

  r = await as(id)("PUT", "/api/profile/name", { firstName: "A".repeat(50), lastName: "B".repeat(50) });
  assert.equal(r.status, 200, "50 characters is the longest allowed");
});

test("PUT /name turns a curly apostrophe (iOS smart punctuation) into a plain one before it checks and stores", async () => {
  const id = addLoginUser(orgP, "lo", "curly@p.co", "Old", "Name");
  let r = await as(id)("PUT", "/api/profile/name", { firstName: "D’Angelo", lastName: "O’Brien" });
  assert.equal(r.status, 200);
  assert.deepStrictEqual([r.data.firstName, r.data.lastName], ["D'Angelo", "O'Brien"]);
  assert.deepStrictEqual([userRow(id).first_name, userRow(id).last_name], ["D'Angelo", "O'Brien"]);
  r = await as(id)("PUT", "/api/profile/name", { firstName: "Mary‘Jane", lastName: "  ’Neil-O’Hara " });
  assert.equal(r.status, 200);
  assert.deepStrictEqual([r.data.firstName, r.data.lastName], ["Mary'Jane", "'Neil-O'Hara"]);
  // a curly mark alone is still not a name, and the 50-character limit counts the stored (plain) form
  for (const body of [{ firstName: "’", lastName: "" }, { firstName: "‘’", lastName: "Reed" }, { firstName: "A", lastName: "’" }]) {
    assert.equal((await as(id)("PUT", "/api/profile/name", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await as(id)("PUT", "/api/profile/name", { firstName: "O’".repeat(25), lastName: "" })).status, 200);
  assert.equal((await as(id)("PUT", "/api/profile/name", { firstName: "O’".repeat(26), lastName: "" })).status, 400);
  assert.equal(userRow(id).first_name, "O'".repeat(25));
});

test("PUT /name rejects anything but letters, spaces, apostrophes and hyphens, and changes nothing", async () => {
  const id = addLoginUser(orgP, "lo", "owen@p.co", "Owen", "Reed");
  const bad = [
    { firstName: "", lastName: "Reed" }, { firstName: "   ", lastName: "Reed" }, { firstName: "A".repeat(51), lastName: "Reed" },
    { firstName: "Owen", lastName: "R".repeat(51) }, { firstName: "Owen2", lastName: "Reed" }, { firstName: "Owen", lastName: "Re3d" },
    { firstName: "<b>Owen</b>", lastName: "Reed" }, { firstName: "Owen", lastName: "Reed; DROP TABLE users" },
    { firstName: "Owen.", lastName: "Reed" }, { firstName: "Owen", lastName: "Reed\nJr" }, { firstName: "-", lastName: "Reed" },
    { firstName: 5, lastName: "Reed" }, { firstName: null, lastName: "Reed" }, { firstName: ["Owen"], lastName: "Reed" },
    { firstName: "Owen", lastName: 7 }, { firstName: "Owen", lastName: null }, { firstName: "Owen" }, { lastName: "Reed" }, {},
  ];
  for (const body of bad) {
    const r = await as(id)("PUT", "/api/profile/name", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepStrictEqual(r.data, BAD_NAME);
  }
  assert.equal((await as(id)("PUT", "/api/profile/name")).status, 400);
  assert.deepStrictEqual(userRow(id), { first_name: "Owen", last_name: "Reed", email: "owen@p.co", career_stage: null });
});

test("PUT /career-stage sets the caller's own tenure and rejects an unknown stage", async () => {
  const id = addLoginUser(orgP, "lo", "tess@p.co");
  const other = addLoginUser(orgP, "lo", "otto@p.co");
  for (const stage of ["new", "developing", "established", "veteran"]) {
    const r = await as(id)("PUT", "/api/profile/career-stage", { stage });
    assert.equal(r.status, 200, stage);
    assert.equal(r.data.careerStage, stage);
    assert.equal(userRow(id).career_stage, stage);
  }
  for (const stage of ["Veteran", " veteran", "", "expert", null, 3, ["new"], undefined]) {
    const r = await as(id)("PUT", "/api/profile/career-stage", { stage });
    assert.equal(r.status, 400, JSON.stringify(stage));
    assert.equal(r.data.success, false);
  }
  assert.equal((await as(id)("PUT", "/api/profile/career-stage")).status, 400);
  assert.equal(userRow(id).career_stage, "veteran", "a rejected stage changes nothing");
  assert.equal(userRow(other).career_stage, null, "another user is untouched");
});

// ── Changing the login email ─────────────────────────────────────────────────

// the link is built from email.js's APP_URL (which an APP_URL environment variable overrides), so the pattern is too
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const LINK_RE = new RegExp("^" + escapeRe(emailLib.APP_URL) + "/api/profile/email/confirm/[0-9a-f]{64}$");
const HOUR = 60 * 60 * 1000;
const pathOf = (link) => new URL(link).pathname;

test("POST /email lowercases, stores a 48-hour token, mails the link to the NEW address, and changes nothing yet", async () => {
  const id = addLoginUser(orgP, "lo", "emma@p.co");
  const started = Date.now();
  const r = await as(id)("POST", "/api/profile/email", { email: "  Emma.New@Example.COM " });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, { pendingEmail: "emma.new@example.com" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "emma.new@example.com");
  assert.match(sent[0].link, LINK_RE);
  const row = changeRow(id);
  assert.equal(row.new_email, "emma.new@example.com");
  assert.equal(row.token, tokenOf(sent[0].link));
  assert.ok(row.expires_at >= started + 48 * HOUR && row.expires_at <= Date.now() + 48 * HOUR, "expires in 48 hours");
  assert.equal(userRow(id).email, "emma@p.co", "the login email changes only on confirm");
  const g = (await as(id)("GET", "/api/profile")).data;
  assert.equal(g.email, "emma@p.co");
  assert.equal(g.pendingEmail, "emma.new@example.com");
});

test("POST /email: a malformed address, the current one, or a taken one is refused and mails nothing", async () => {
  const id = addLoginUser(orgP, "lo", "faye@p.co");
  addLoginUser(orgP, "lo", "taken@p.co");
  db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, invite_accepted) VALUES (?, 'lo', 'In', 'Vited', 'invited@p.co', 0)").run(orgP);
  for (const mail of [
    "", "nope", "a@b", "a b@c.co", "@c.co", "a@.co", "a@@c.co", "a@b.c o", "a@b..co", 5, null, ["a@b.co"], undefined,
    // forms nodemailer would read as a different or an extra recipient (a display name, a group, a list, a quoted local part)
    "<x@y.co>", "Name<x@y.co>", "Name <x@y.co>", '"a"@y.co', "a;b@y.co", "a,b@c.co", "x@y.co,z@y.co", "x@y.co;z@y.co",
    "a(b)@c.co", "a:b@c.co", "a\\b@c.co", "x@[1.2.3.4]", "x@y.co>", "x@y.c,o", "a\tb@c.co",
  ]) {
    const r = await as(id)("POST", "/api/profile/email", { email: mail });
    assert.equal(r.status, 400, JSON.stringify(mail));
    assert.equal(r.data.success, false);
  }
  assert.equal((await as(id)("POST", "/api/profile/email")).status, 400);
  let r = await as(id)("POST", "/api/profile/email", { email: " FAYE@p.co " });
  assert.equal(r.status, 400, "the same as the current email, in any case");
  for (const mail of ["taken@p.co", "TAKEN@p.co", "invited@p.co", "ann@a.co"]) {
    r = await as(id)("POST", "/api/profile/email", { email: mail });
    assert.equal(r.status, 409, mail);
    assert.deepStrictEqual(r.data, { success: false, error: "That email is already in use" });
  }
  assert.equal(sent.length, 0);
  assert.equal(changeRow(id), undefined);
});

test("POST /email: when the mail cannot be sent the pending change is removed and the answer is a 503", async () => {
  const id = addLoginUser(orgP, "lo", "gus@p.co");
  const NOT_SET_UP = { success: false, error: "Email isn't set up yet" };
  const results = [false, undefined, null, 0, new Error("smtp down")];
  for (const result of results) {
    sendResult = result;
    const r = await as(id)("POST", "/api/profile/email", { email: "gus.new@p.co" });
    assert.equal(r.status, 503, String(result));
    assert.deepStrictEqual(r.data, NOT_SET_UP);
    assert.equal(changeRow(id), undefined, "no live token is left behind");
  }
  assert.equal(sent.length, results.length);
  assert.equal((await as(id)("GET", "/api/profile")).data.pendingEmail, null);
  assert.equal(userRow(id).email, "gus@p.co");
});

test("POST /email with no mailer injected uses email.sendEmailChange, which declines when mail is not set up (nothing is sent)", async () => {
  const id = addLoginUser(orgP, "lo", "hal@p.co");
  const kept = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  delete process.env.EMAIL_USER; delete process.env.EMAIL_PASS;
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  app.set("sendEmailChange", undefined);
  try {
    const r = await as(id)("POST", "/api/profile/email", { email: "hal.new@p.co" });
    assert.equal(r.status, 503);
    assert.equal(r.data.error, "Email isn't set up yet");
    assert.equal(changeRow(id), undefined);
    assert.equal(warned.length, 1);
    assert.ok(!/confirm|[0-9a-f]{64}/.test(warned[0]), "the warning never carries the link or the token");
  } finally {
    console.warn = warn;
    for (const [k, v] of [["EMAIL_USER", kept.u], ["EMAIL_PASS", kept.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    app.set("sendEmailChange", fakeSend);
  }
});

test("I7: in production with APP_URL unset or pointing at this machine, POST /email is a 503 that sends nothing and keeps no link", async () => {
  const id = addLoginUser(orgP, "lo", "iris@p.co");
  const NOT_SET_UP = { success: false, error: "Email isn't set up yet" };
  try {
    for (const APP_URL of [undefined, "", "  ", "http://localhost:8080", "http://LOCALHOST", "https://app.localhost", "http://127.0.0.1:8080",
      "http://127.1.2.3", "http://[::1]:8080", "http://0.0.0.0:8080", "not a url"]) {
      app.set("profileEnv", { NODE_ENV: "production", ...(APP_URL === undefined ? {} : { APP_URL }) });
      const r = await as(id)("POST", "/api/profile/email", { email: "iris.new@p.co" });
      assert.deepStrictEqual([r.status, r.data], [503, NOT_SET_UP], String(APP_URL));
      assert.equal(changeRow(id), undefined, `${APP_URL}: no link stays live`);
    }
    assert.equal(sent.length, 0, "nothing was mailed");

    // a real address in production, or any setting outside production (dev, tests), mails the link as before
    for (const env of [{ NODE_ENV: "production", APP_URL: "https://broker-radar.example.com" }, { NODE_ENV: "development" }, {}]) {
      app.set("profileEnv", env);
      sent = [];
      const r = await as(id)("POST", "/api/profile/email", { email: "iris.new@p.co" });
      assert.equal(r.status, 200, JSON.stringify(env));
      assert.equal(sent.length, 1, JSON.stringify(env));
    }
  } finally {
    app.set("profileEnv", undefined);
  }
});

test("a second request replaces the first: one pending change per user, and the old link dies", async () => {
  const id = addLoginUser(orgP, "lo", "ivy@p.co");
  await as(id)("POST", "/api/profile/email", { email: "ivy.one@p.co" });
  await as(id)("POST", "/api/profile/email", { email: "ivy.two@p.co" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_changes WHERE user_id = ?").get(id).n, 1);
  assert.equal((await as(id)("GET", "/api/profile")).data.pendingEmail, "ivy.two@p.co");
  assert.notEqual(tokenOf(sent[0].link), tokenOf(sent[1].link));
  let r = await raw(pathOf(sent[0].link));
  assert.equal(r.location, "/?emailChanged=0", "the first link no longer works");
  assert.equal(userRow(id).email, "ivy@p.co");
  r = await raw(pathOf(sent[1].link));
  assert.equal(r.location, "/?emailChanged=1");
  assert.equal(userRow(id).email, "ivy.two@p.co");
});

// ── The confirm link ─────────────────────────────────────────────────────────

test("GET /email/confirm/:token with no session sets the new login email once, then redirects to the app", async () => {
  const id = addLoginUser(orgP, "lo", "jon@p.co");
  await as(id)("POST", "/api/profile/email", { email: "jon.new@p.co" });
  const p = pathOf(sent[0].link);
  const r = await raw(p);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/?emailChanged=1");
  assert.equal(userRow(id).email, "jon.new@p.co");
  assert.equal(changeRow(id), undefined, "the token is used up");
  const g = (await as(id)("GET", "/api/profile")).data;
  assert.equal(g.email, "jon.new@p.co");
  assert.equal(g.pendingEmail, null);
  // reused
  assert.deepStrictEqual(await raw(p), { status: 302, location: "/?emailChanged=0" });
  assert.equal(userRow(id).email, "jon.new@p.co");
});

test("the confirm link is refused when the token is bad, unknown, or expired", async () => {
  const id = addLoginUser(orgP, "lo", "kim@p.co");
  await as(id)("POST", "/api/profile/email", { email: "kim.new@p.co" });
  const token = tokenOf(sent[0].link);
  for (const bad of ["abc", "A".repeat(64), token.toUpperCase(), token.slice(1), token + "0", "g".repeat(64), "0".repeat(64), "%00", "..%2F"]) {
    const r = await raw("/api/profile/email/confirm/" + bad);
    assert.deepStrictEqual(r, { status: 302, location: "/?emailChanged=0" }, bad);
  }
  assert.equal(userRow(id).email, "kim@p.co");
  assert.ok(changeRow(id), "a bad guess does not disturb the real pending change");

  db.prepare("UPDATE email_changes SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1000, id);
  assert.equal((await as(id)("GET", "/api/profile")).data.pendingEmail, null, "an expired request is no longer pending");
  const r = await raw("/api/profile/email/confirm/" + token);
  assert.deepStrictEqual(r, { status: 302, location: "/?emailChanged=0" });
  assert.equal(userRow(id).email, "kim@p.co");
  assert.equal(changeRow(id), undefined, "the expired row is cleared");
});

test("the confirm link is refused when someone took the address in the meantime", async () => {
  const id = addLoginUser(orgP, "lo", "lee@p.co");
  await as(id)("POST", "/api/profile/email", { email: "lee.new@p.co" });
  addLoginUser(orgP, "lo", "lee.new@p.co");   // registered while the mail sat in the inbox
  const r = await raw(pathOf(sent[0].link));
  assert.deepStrictEqual(r, { status: 302, location: "/?emailChanged=0" });
  assert.equal(userRow(id).email, "lee@p.co");
  assert.equal(changeRow(id), undefined, "a change that can never work is cleared");
});

test("two users who ask for the same new address: the first to confirm gets it, the second is refused", async () => {
  const a = addLoginUser(orgP, "lo", "max@p.co");
  const b = addLoginUser(orgP, "lo", "nat@p.co");
  await as(a)("POST", "/api/profile/email", { email: "shared@p.co" });
  await as(b)("POST", "/api/profile/email", { email: "shared@p.co" });
  assert.equal((await raw(pathOf(sent[1].link))).location, "/?emailChanged=1");
  assert.equal((await raw(pathOf(sent[0].link))).location, "/?emailChanged=0");
  assert.equal(userRow(b).email, "shared@p.co");
  assert.equal(userRow(a).email, "max@p.co");
});

// ── Each route acts only on the signed-in user ───────────────────────────────

test("a loan officer cannot change another user through any route: ids in the body, query or session are ignored", async () => {
  const boss = addLoginUser(orgP, "broker", "boss@p.co", "Bo", "Ss");
  const lo = addLoginUser(orgP, "lo", "lola@p.co", "Lola", "Lane");
  const bossBefore = userRow(boss);

  let r = await as(lo)("PUT", "/api/profile/name", { firstName: "Hacked", lastName: "Name", userId: boss, id: boss, email: "x@y.co" });
  assert.equal(r.status, 200);
  r = await as(lo)("PUT", "/api/profile/career-stage", { stage: "veteran", userId: boss, id: boss });
  assert.equal(r.status, 200);
  r = await as(lo)("POST", "/api/profile/email?userId=" + boss, { email: "lola.new@p.co", userId: boss, id: boss });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(userRow(boss), bossBefore);
  assert.deepStrictEqual(userRow(lo), { first_name: "Hacked", last_name: "Name", email: "lola@p.co", career_stage: "veteran" });
  assert.equal(changeRow(boss), undefined);
  assert.equal(changeRow(lo).new_email, "lola.new@p.co");

  // confirming (with the boss signed in, even) changes the account the token was issued to, and only that one
  r = await raw(pathOf(sent[0].link) + "?userId=" + boss, boss);
  assert.equal(r.location, "/?emailChanged=1");
  assert.equal(userRow(lo).email, "lola.new@p.co");
  assert.deepStrictEqual(userRow(boss), bossBefore);
});

// ── Signing in ───────────────────────────────────────────────────────────────

test("after a confirm, logging in works with the new email and no longer with the old one", async () => {
  const id = addLoginUser(orgP, "lo", "quin@p.co");
  const login = async (mail) => {
    const res = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: mail, password: PASSWORD }),
    });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await login("quin@p.co")).status, 200);
  assert.equal((await login("quin.new@p.co")).status, 401);

  await as(id)("POST", "/api/profile/email", { email: "Quin.New@P.co" });
  assert.equal((await login("quin@p.co")).status, 200, "the old email still works until the link is clicked");
  assert.equal((await login("quin.new@p.co")).status, 401);

  assert.equal((await raw(pathOf(sent[0].link))).location, "/?emailChanged=1");
  const now = await login("quin.new@p.co");
  assert.equal(now.status, 200);
  assert.equal(now.data.user.id, id);
  assert.equal(now.data.user.email, "quin.new@p.co");
  assert.equal((await login("quin@p.co")).status, 401);
});

// ── email.sendEmailChange ────────────────────────────────────────────────────

// Runs fn with a stubbed nodemailer transport and chosen mail credentials, and puts everything back.
async function withMailStub({ user, pass }, transport, fn) {
  const nodemailer = require("nodemailer");
  const real = nodemailer.createTransport;
  const kept = { EMAIL_USER: process.env.EMAIL_USER, EMAIL_PASS: process.env.EMAIL_PASS };
  const consoleKept = { log: console.log, warn: console.warn, error: console.error };
  const logs = [];
  nodemailer.createTransport = transport;
  if (user === undefined) delete process.env.EMAIL_USER; else process.env.EMAIL_USER = user;
  if (pass === undefined) delete process.env.EMAIL_PASS; else process.env.EMAIL_PASS = pass;
  console.log = console.warn = console.error = (...a) => logs.push(a.join(" "));
  try {
    return await fn(logs);
  } finally {
    nodemailer.createTransport = real;
    Object.assign(console, consoleKept);
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("sendEmailChange: false (and no transport built) when the mail credentials are unset", async () => {
  const link = "http://localhost:8080/api/profile/email/confirm/" + "ab".repeat(32);
  for (const creds of [{}, { user: "me@example.test" }, { pass: "pw" }]) {
    let built = 0;
    await withMailStub(creds, () => { built++; return { sendMail: async () => { throw new Error("must not send"); } }; }, async (logs) => {
      assert.strictEqual(await emailLib.sendEmailChange("new@example.test", link), false);
      assert.equal(built, 0);
      assert.ok(logs.every((l) => !l.includes("ab".repeat(32))), "the link is never logged");
    });
  }
});

test("sendEmailChange: true when the (stubbed) transport sends, false when it fails, and the link is never logged", async () => {
  const link = "http://localhost:8080/api/profile/email/confirm/" + "cd".repeat(32);
  const mails = []; let fail = false;
  const transport = () => ({ sendMail: async (m) => { mails.push(m); if (fail) throw new Error("connection refused"); } });
  await withMailStub({ user: "robot@example.test", pass: "not-a-real-password" }, transport, async (logs) => {
    assert.strictEqual(await emailLib.sendEmailChange("new@example.test", link), true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "new@example.test");
    assert.ok(mails[0].html.includes(link), "the link is in the mail");
    assert.match(mails[0].html, /48 hours/);
    fail = true;
    assert.strictEqual(await emailLib.sendEmailChange("new@example.test", link), false);
    assert.ok(logs.length >= 1, "a failed send is logged");
    assert.ok(logs.every((l) => !l.includes("cd".repeat(32)) && !l.includes("/confirm/")), "never the link or the token");
  });
});

// ── The email-change rate limit ──────────────────────────────────────────────

// A throwaway app around the profile router with the fake mailer and the email-change limit `limit` (undefined: the real default).
// fn gets call(userId)(method, path, body) -> { status, data, headers }.
async function withProfileApp(limit, fn) {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/profile", profileRoutes);
  a.set("emailChangeLimit", limit);
  a.set("sendEmailChange", fakeSend);
  const s = a.listen(0);
  await new Promise((r) => s.once("listening", r));
  const b = `http://localhost:${s.address().port}`;
  const call = (userId) => async (method, p, body) => {
    const res = await fetch(b + p, {
      method, headers: { "content-type": "application/json", cookie: "rr_token=" + signToken({ userId }) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data = null; try { data = await res.json(); } catch { /* */ }
    return { status: res.status, data, headers: res.headers };
  };
  try { await fn(call); } finally { s.close(); }
}

test("POST /email is limited per user: past the limit it is a 429 that sends nothing, and another user is unaffected", async () => {
  const rita = addLoginUser(orgP, "lo", "rita@p.co");
  const sam = addLoginUser(orgP, "lo", "sam@p.co");
  await withProfileApp(2, async (call) => {
    assert.equal((await call(rita)("POST", "/api/profile/email", { email: "rita.1@p.co" })).status, 200);
    assert.equal((await call(rita)("POST", "/api/profile/email", { email: "rita.2@p.co" })).status, 200);
    const kept = changeRow(rita);
    const over = await call(rita)("POST", "/api/profile/email", { email: "rita.3@p.co" });
    assert.equal(over.status, 429);
    assert.equal(over.data.success, false);
    assert.equal(sent.length, 2, "the third request sent nothing");
    assert.deepStrictEqual(changeRow(rita), kept, "and changed nothing");
    assert.equal((await call(rita)("POST", "/api/profile/email", { email: "rita.4@p.co" })).status, 429, "it stays refused");

    // the count is per signed-in user, not per address: another user on the same IP is unaffected
    assert.equal((await call(sam)("POST", "/api/profile/email", { email: "sam.new@p.co" })).status, 200);
    assert.equal(sent.length, 3);

    // only this route is limited
    assert.equal((await call(rita)("GET", "/api/profile")).status, 200);
    assert.equal((await call(rita)("PUT", "/api/profile/name", { firstName: "Rita", lastName: "Ray" })).status, 200);
    assert.equal((await call(rita)("PUT", "/api/profile/career-stage", { stage: "new" })).status, 200);
  });
});

test("POST /email: a refused request (a typo, a taken address) counts toward the limit too", async () => {
  const uma = addLoginUser(orgP, "lo", "uma@p.co");
  await withProfileApp(2, async (call) => {
    assert.equal((await call(uma)("POST", "/api/profile/email", { email: "nope" })).status, 400);
    assert.equal((await call(uma)("POST", "/api/profile/email", { email: "rita@p.co" })).status, 409);
    assert.equal((await call(uma)("POST", "/api/profile/email", { email: "uma.new@p.co" })).status, 429);
    assert.equal(sent.length, 0);
  });
});

test("the router index.js mounts allows 5 email-change requests per user per hour", async () => {
  const tom = addLoginUser(orgP, "lo", "tom@p.co");
  const una = addLoginUser(orgP, "lo", "una@p.co");
  await withProfileApp(undefined, async (call) => {
    for (let i = 1; i <= 5; i++) {
      const r = await call(tom)("POST", "/api/profile/email", { email: `tom.${i}@p.co` });
      assert.equal(r.status, 200, "request " + i);
    }
    const over = await call(tom)("POST", "/api/profile/email", { email: "tom.6@p.co" });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("ratelimit-limit"), "5");
    assert.match(over.headers.get("ratelimit-policy") || "", /w=3600\b/, "a one-hour window");
    assert.equal(sent.length, 5);
    assert.equal(changeRow(tom).new_email, "tom.5@p.co");
    assert.equal((await call(una)("POST", "/api/profile/email", { email: "una.new@p.co" })).status, 200);
  });
});
