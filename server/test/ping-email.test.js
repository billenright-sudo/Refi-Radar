"use strict";
// The rate-drop email and the test notification (email.js): market news only, and a failed send logs no address.
// A throwaway database is set up because the ping's words come from lib/rateHistory.js, which opens one on load.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-ping-email-"));
process.env.NODE_ENV = "test";
process.env.EMAIL_USER = "sender@x.test";
process.env.EMAIL_PASS = "not-a-real-password";

const test = require("node:test");
const assert = require("node:assert");
const email = require("../email");
const { rateDropMessage, testPingMessage, sendRateDrop, sendTestPing } = email;

test.after(() => {
  try { require("../db").close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const drop = { rate30: 6.4, move30: -0.15, obsDate: "2026-11-24", sinceDate: "2026-11-21" };

test("the rate-drop email carries market news only", () => {
  const m = rateDropMessage({ drop, localDate: "2026-11-25", appUrl: "https://x.test" });
  assert.equal(m.subject, "Rates dropped: the national average 30-year is 6.4%");
  assert.match(m.html, /down 0\.15 since November 21st \(as of November 24th\)/);
  assert.match(m.html, /Turn these off on your Profile page/);
  assert.match(m.html, /href="https:\/\/x\.test"/);
  assert.match(m.html, /Open Broker Radar/);
});

test("the app URL is escaped in the email", () => {
  const m = rateDropMessage({ drop, localDate: "2026-11-25", appUrl: 'https://x.test/"><script>' });
  assert.ok(!m.html.includes("<script>"));
});

test("the test notification email says it is a test", () => {
  const m = testPingMessage({ appUrl: "https://x.test" });
  assert.equal(m.subject, "Broker Radar test notification");
  assert.match(m.html, /Test notification: rate-drop pings will arrive on this device\./);
  assert.match(m.html, /Turn these off on your Profile page/);
});

test("with mail unset, sendRateDrop and sendTestPing resolve false and send nothing", async (t) => {
  const saved = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  t.after(() => { process.env.EMAIL_USER = saved.u; process.env.EMAIL_PASS = saved.p; });
  const mails = [];
  t.mock.method(require("nodemailer"), "createTransport", () => ({ sendMail: async (m) => { mails.push(m); } }));
  t.mock.method(console, "warn", () => {});
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  assert.equal(await sendRateDrop({ to: "a@x.test", drop, localDate: "2026-11-25" }), false);
  assert.equal(await sendTestPing({ to: "a@x.test" }), false);
  assert.equal(mails.length, 0);
});

test("with mail set, both send from Broker Radar to the given address", async (t) => {
  const mails = [];
  t.mock.method(require("nodemailer"), "createTransport", () => ({ sendMail: async (m) => { mails.push(m); } }));
  assert.equal(await sendRateDrop({ to: "ann@x.test", drop, localDate: "2026-11-25" }), true);
  assert.equal(await sendTestPing({ to: "ann@x.test" }), true);
  assert.equal(mails.length, 2);
  assert.ok(mails.every((m) => m.to === "ann@x.test" && m.from.startsWith('"Broker Radar"')));
  assert.equal(mails[0].subject, "Rates dropped: the national average 30-year is 6.4%");
});

test("a failed send resolves false and logs no address, no message text", async (t) => {
  t.mock.method(require("nodemailer"), "createTransport", () => ({
    sendMail: async () => { throw Object.assign(new Error("550 5.1.1 <ann.private@x.test>: user unknown"), { name: "Error", responseCode: 550 }); },
  }));
  const lines = [];
  t.mock.method(console, "error", (...a) => lines.push(a.join(" ")));
  assert.equal(await sendRateDrop({ to: "ann.private@x.test", drop, localDate: "2026-11-25" }), false);
  assert.equal(await sendTestPing({ to: "ann.private@x.test" }), false);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(!l.includes("ann.private") && !l.includes("user unknown"), l);
    assert.match(l, /^\[email\] (rate-drop|test-notification) send failed: Error 550$/);
  }
});
