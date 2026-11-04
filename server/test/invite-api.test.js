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

const db = require("../db");
const { signToken } = require("../middleware/auth");
const authRoutes = require("../routes/auth");

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
