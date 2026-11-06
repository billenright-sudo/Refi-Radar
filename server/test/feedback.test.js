"use strict";
// POST /api/feedback (routes/feedback.js): checks, per-user limit, the stored row, the email to FEEDBACK_TO through the app seam.
// Throwaway DB; nothing sends real mail.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-feedback-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { addBroker } = require("../test-support/accounts");
const feedbackRoutes = require("../routes/feedback");
const { feedbackMessage } = require("../email");

let server, app, base, sent, n = 0;
before(async () => {
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/feedback", feedbackRoutes);
  app.set("sendFeedback", async (args) => { sent.push(args); return true; });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { sent = []; app.set("billingConfig", { enabled: false, feedbackTo: "owner@example.test" }); });

const newUser = (opts = {}) => addBroker(db, { email: `fb${++n}@example.test`, ...opts });
async function send(user, body) {
  const headers = { "content-type": "application/json" };
  if (user) headers.cookie = `rr_token=${signToken({ userId: user.id, sv: user.session_version || 0 })}`;
  const res = await fetch(base + "/api/feedback", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const rows = (userId) => db.prepare("SELECT * FROM feedback WHERE user_id = ? ORDER BY id").all(userId);

test("needs a signed-in user", async () => {
  const r = await send(null, { message: "hi", page: "home" });
  assert.equal(r.status, 401);
});

test("empty message after trim -> 400", async () => {
  const u = newUser();
  for (const message of ["", "   \n ", undefined, 5]) {
    const r = await send(u, { message, page: "home" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { success: false, error: "Please write a message." });
  }
  assert.equal(rows(u.id).length, 0);
  assert.equal(sent.length, 0);
});

test("over 2,000 characters after trim -> 400; exactly 2,000 is fine", async () => {
  const u = newUser();
  const r = await send(u, { message: "a".repeat(2001), page: "home" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.data, { success: false, error: "Please keep it under 2,000 characters." });
  const ok = await send(u, { message: `  ${"a".repeat(2000)}  `, page: "home" });
  assert.equal(ok.status, 200);
  assert.equal(rows(u.id)[0].message.length, 2000);
});

test("stored with user, org, page and time; answers { success: true }", async () => {
  const u = newUser();
  const started = Date.now();
  const r = await send(u, { message: "  Please add dark mode  ", page: " clients " });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { success: true });
  const [row] = rows(u.id);
  assert.equal(row.org_id, u.org_id);
  assert.equal(row.page, "clients");
  assert.equal(row.message, "Please add dark mode");
  assert.ok(row.created_at >= started && row.created_at <= Date.now());
});

test("page is capped at 100 characters; a missing or blank page is 'unknown'", async () => {
  const u = newUser();
  await send(u, { message: "a", page: "p".repeat(300) });
  await send(u, { message: "b" });
  await send(u, { message: "c", page: "   " });
  const r = rows(u.id);
  assert.equal(r[0].page.length, 100);
  assert.equal(r[1].page, "unknown");
  assert.equal(r[2].page, "unknown");
});

test("emailed to FEEDBACK_TO with the sender's details; every value escaped; no secrets", async () => {
  const u = newUser({ firstName: "<b>Ann</b>", lastName: "O'Neil", orgName: "A&B <Mortgage>" });
  const r = await send(u, { message: "line one <script>x</script>\nline two", page: "<img src=x>" });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  const args = sent[0];
  assert.equal(args.to, "owner@example.test");
  assert.equal(args.brokerage, "A&B <Mortgage>");
  assert.equal(args.role, "broker");
  const { subject, html } = feedbackMessage(args);
  assert.equal(subject, "Broker Radar feedback from A&B <Mortgage>");
  assert.ok(html.includes("&lt;b&gt;Ann&lt;/b&gt; O&#39;Neil"));
  assert.ok(html.includes("A&amp;B &lt;Mortgage&gt;"));
  assert.ok(html.includes("&lt;img src=x&gt;"));
  assert.ok(html.includes("line one &lt;script&gt;x&lt;/script&gt;<br>line two"));
  assert.ok(!html.includes("<script>") && !html.includes("<img") && !html.includes("<b>Ann"));
  assert.ok(!/password|token|cookie/i.test(html));
  assert.match(html, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("no FEEDBACK_TO (or no billing config at all): stored, answered, nothing emailed", async () => {
  const u = newUser();
  app.set("billingConfig", { enabled: false, feedbackTo: null });
  assert.equal((await send(u, { message: "one", page: "home" })).status, 200);
  app.set("billingConfig", undefined);
  const saved = process.env.FEEDBACK_TO;
  delete process.env.FEEDBACK_TO;
  assert.equal((await send(u, { message: "two", page: "home" })).status, 200);
  if (saved !== undefined) process.env.FEEDBACK_TO = saved;
  assert.equal(rows(u.id).length, 2);
  assert.equal(sent.length, 0);
});

test("a billing config without feedbackTo (index.js's start-up fallback) reads FEEDBACK_TO from the environment", async () => {
  const u = newUser();
  const saved = process.env.FEEDBACK_TO;
  process.env.FEEDBACK_TO = " env-owner@example.test ";
  try {
    app.set("billingConfig", { enabled: false });   // what index.js puts on the app when billing's start-up itself failed
    assert.equal((await send(u, { message: "via env", page: "home" })).status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "env-owner@example.test");
    // a config that does carry it (null: FEEDBACK_TO was not set when it was read) is believed
    app.set("billingConfig", { enabled: false, feedbackTo: null });
    assert.equal((await send(u, { message: "not sent", page: "home" })).status, 200);
    assert.equal(sent.length, 1);
  } finally {
    if (saved === undefined) delete process.env.FEEDBACK_TO; else process.env.FEEDBACK_TO = saved;
  }
});

test("a failing or throwing send still answers 200 and keeps the row", async () => {
  const u = newUser();
  app.set("sendFeedback", async () => { throw new Error("smtp down"); });
  const r = await send(u, { message: "still stored", page: "home" });
  app.set("sendFeedback", async (args) => { sent.push(args); return true; });
  assert.equal(r.status, 200);
  assert.equal(rows(u.id).length, 1);
});

test("a slow send holds the answer for the wait limit at most", async () => {
  const u = newUser();
  app.set("feedbackWaitMs", 50);
  app.set("sendFeedback", () => new Promise(() => {}));
  const t = Date.now();
  const r = await send(u, { message: "slow", page: "home" });
  app.set("feedbackWaitMs", undefined);
  app.set("sendFeedback", async (args) => { sent.push(args); return true; });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t < 2000);
});

test("a locked brokerage's user can still send", async () => {
  const u = newUser();
  db.prepare("UPDATE organizations SET billing_status = 'canceled' WHERE id = ?").run(u.org_id);
  app.set("billingConfig", { enabled: true, feedbackTo: "owner@example.test" });
  const r = await send(u, { message: "I am locked out", page: "ended" });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
});

test("the 11th message in an hour from one user is refused (429); another user is unaffected", async () => {
  const u = newUser(), other = newUser();
  for (let i = 0; i < 10; i++) assert.equal((await send(u, { message: `m${i}`, page: "home" })).status, 200);
  const r = await send(u, { message: "m10", page: "home" });
  assert.equal(r.status, 429);
  assert.deepEqual(r.data, { success: false, error: "Too many messages — please try again in an hour" });
  assert.equal(rows(u.id).length, 10);
  assert.equal((await send(other, { message: "fine", page: "home" })).status, 200);
});
