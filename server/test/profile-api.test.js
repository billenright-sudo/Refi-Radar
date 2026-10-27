"use strict";
// /api/profile (routes/profile.js): the signed-in user's own NMLS ID and, for a broker, the company's. Throwaway DB,
// the real router behind a signed rr_token cookie.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-profile-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const profileRoutes = require("../routes/profile");

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

let server, as;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/profile", profileRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}`;
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
