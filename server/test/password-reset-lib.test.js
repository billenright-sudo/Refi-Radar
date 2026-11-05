"use strict";
// lib/passwordReset.js (the one-time reset token store and the per-account send counter) and the two new emails in email.js.
// Throwaway DB. Pure functions and message builders only: nothing here sends mail.
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-pwreset-lib-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const {
  RESET_TTL_MS, hashToken, issueReset, userForReset, completeReset, createSendCounter,
} = require("../lib/passwordReset");
const { passwordResetMessage, passwordChangedMessage, mailReady, inviteLink, APP_URL } = require("../email");

const NOW = 1_800_000_000_000;
const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Reset Org')").run().lastInsertRowid);
// accepted = 1 is someone who can sign in; 0 is an unused invite
const addUser = (email, accepted = 1) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email, password_hash, invite_accepted) VALUES (?, 'lo', 'Lou', 'Smith', ?, 'old-hash', ?)"
).run(orgId, email, accepted).lastInsertRowid);
const resetRow = (id) => db.prepare("SELECT * FROM password_resets WHERE user_id = ?").get(id);

test("issueReset stores only a hash, and a second request replaces the first", () => {
  const uid = addUser("replace@x.test");
  const t1 = issueReset(db, uid, NOW);
  assert.match(t1, /^[0-9a-f]{64}$/);
  const row = resetRow(uid);
  assert.strictEqual(row.token_hash, hashToken(t1));
  assert.notStrictEqual(row.token_hash, t1);
  assert.strictEqual(row.expires_at, NOW + RESET_TTL_MS);
  assert.match(hashToken(t1), /^[0-9a-f]{64}$/);

  const t2 = issueReset(db, uid, NOW);
  assert.notStrictEqual(t2, t1);
  assert.strictEqual(userForReset(db, t1, NOW), null);
  assert.strictEqual(userForReset(db, t2, NOW).id, uid);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").get(uid).n, 1);
});

test("userForReset: expired at exactly 60 minutes, malformed, unknown and unused-invite tokens are null", () => {
  const uid = addUser("expiry@x.test");
  const t = issueReset(db, uid, NOW);
  assert.strictEqual(RESET_TTL_MS, 60 * 60 * 1000);
  assert.strictEqual(userForReset(db, t, NOW + RESET_TTL_MS), null);
  assert.strictEqual(userForReset(db, t, NOW + RESET_TTL_MS - 1).id, uid);

  assert.strictEqual(userForReset(db, "abc", NOW), null);
  assert.strictEqual(userForReset(db, 42, NOW), null);
  assert.strictEqual(userForReset(db, undefined, NOW), null);
  assert.strictEqual(userForReset(db, "G".repeat(64), NOW), null);
  assert.strictEqual(userForReset(db, t.toUpperCase(), NOW), null);   // tokens are lower-case hex only
  assert.strictEqual(userForReset(db, "a".repeat(64), NOW), null);    // well formed, but nobody's

  const invited = addUser("invited@x.test", 0);
  const ti = issueReset(db, invited, NOW);
  assert.strictEqual(userForReset(db, ti, NOW), null);
});

test("completeReset sets the hash, ends sessions, and works once", () => {
  const uid = addUser("complete@x.test");
  const before = db.prepare("SELECT session_version FROM users WHERE id = ?").get(uid).session_version;
  const t = issueReset(db, uid, NOW);

  const user = completeReset(db, t, "new-hash", NOW + 1000);
  assert.strictEqual(user.id, uid);
  // the returned row is the fresh one, so the caller can sign the new session straight from it
  assert.strictEqual(user.password_hash, "new-hash");
  assert.strictEqual(user.session_version, before + 1);
  const stored = db.prepare("SELECT password_hash, session_version FROM users WHERE id = ?").get(uid);
  assert.strictEqual(stored.password_hash, "new-hash");
  assert.strictEqual(stored.session_version, before + 1);
  assert.strictEqual(resetRow(uid), undefined);

  assert.strictEqual(completeReset(db, t, "other-hash", NOW + 2000), null);
  assert.strictEqual(db.prepare("SELECT password_hash FROM users WHERE id = ?").get(uid).password_hash, "new-hash");
});

test("completeReset changes nothing for an expired, malformed or replaced token", () => {
  const uid = addUser("nochange@x.test");
  const t1 = issueReset(db, uid, NOW);
  const t2 = issueReset(db, uid, NOW);
  assert.strictEqual(completeReset(db, t1, "bad-hash", NOW), null);          // replaced
  assert.strictEqual(completeReset(db, t2, "bad-hash", NOW + RESET_TTL_MS), null); // expired
  assert.strictEqual(completeReset(db, "nope", "bad-hash", NOW), null);      // malformed
  const row = db.prepare("SELECT password_hash, session_version FROM users WHERE id = ?").get(uid);
  assert.strictEqual(row.password_hash, "old-hash");
  assert.strictEqual(row.session_version, 0);
  assert.ok(resetRow(uid), "a refused attempt leaves the live link in place");
});

// A reset proves the person holds the inbox and chose a new password, so a login-email change someone started before it (from a
// stolen session, say) must not survive it: the pending row goes in the same transaction, and a refused reset leaves it alone.
const addEmailChange = (id, to = "pending-new@x.test") => db.prepare(
  "INSERT INTO email_changes (user_id, new_email, token, expires_at) VALUES (?, ?, ?, ?)"
).run(id, to, crypto.randomBytes(32).toString("hex"), NOW + 48 * 60 * 60 * 1000);
const changeRowOf = (id) => db.prepare("SELECT * FROM email_changes WHERE user_id = ?").get(id);

test("completeReset also cancels a pending login-email change; a refused reset leaves it", () => {
  const uid = addUser("pendingchange@x.test");
  const t = issueReset(db, uid, NOW);
  addEmailChange(uid);
  assert.strictEqual(completeReset(db, "nope", "bad-hash", NOW), null);                   // malformed: refused
  assert.strictEqual(completeReset(db, t, "bad-hash", NOW + RESET_TTL_MS), null);         // expired: refused
  assert.ok(changeRowOf(uid), "a refused reset leaves the pending change in place");

  assert.strictEqual(completeReset(db, t, "new-hash", NOW + 1000).id, uid);
  assert.strictEqual(changeRowOf(uid), undefined, "a completed reset cancels the pending change");

  // someone else's pending change is none of its business
  const other = addUser("otherchange@x.test");
  addEmailChange(other, "other-new@x.test");
  const t2 = issueReset(db, uid, NOW);
  assert.ok(completeReset(db, t2, "newer-hash", NOW + 1000));
  assert.ok(changeRowOf(other));
});

test("createSendCounter allows 3 an hour per key", () => {
  const c = createSendCounter();
  const t = NOW;
  assert.strictEqual(c.take("a", t), true);
  assert.strictEqual(c.take("a", t), true);
  assert.strictEqual(c.take("a", t), true);
  assert.strictEqual(c.take("a", t), false);
  assert.strictEqual(c.take("b", t), true);
  assert.strictEqual(c.take("a", t + 60 * 60 * 1000), true);
});

test("createSendCounter: a refused take does not count, and the window slides", () => {
  const c = createSendCounter({ max: 2, windowMs: 1000 });
  assert.strictEqual(c.take("k", 0), true);
  assert.strictEqual(c.take("k", 500), true);
  assert.strictEqual(c.take("k", 900), false);    // refused, and must not extend the block
  assert.strictEqual(c.take("k", 1000), true);    // the take at 0 has aged out
  assert.strictEqual(c.take("k", 1001), false);   // 500 and 1000 still count
  assert.strictEqual(c.take("k", 1500), true);    // 500 aged out
});

test("the two emails use the approved words, escape names, and carry the link", () => {
  const L = "https://app.example.com/?reset=" + "ab".repeat(32);
  const m = passwordResetMessage({ firstName: "<b>Lou</b>", email: "lou@x.test", link: L });
  assert.strictEqual(m.subject, "Reset your Broker Radar password");
  assert.ok(m.html.includes(L));
  assert.ok(m.html.includes("within 60 minutes"));
  assert.ok(m.html.includes("&lt;b&gt;Lou&lt;/b&gt;"));
  assert.ok(m.html.includes("Your password won't change."));
  assert.ok(m.html.includes("Choose a new password"));
  assert.ok(m.html.includes("(lou@x.test)"));
  assert.ok(!m.html.includes("<b>Lou</b>"));
  assert.ok(!/RefiRadar/.test(m.html + m.subject));

  const c = passwordChangedMessage({ firstName: "<b>Lou</b>", email: 'l"ou@x.test' });
  assert.strictEqual(c.subject, "Your Broker Radar password was changed");
  assert.ok(c.html.includes("let your broker know"));
  assert.ok(c.html.includes("&lt;b&gt;Lou&lt;/b&gt;"));
  assert.ok(c.html.includes("l&quot;ou@x.test"));
  assert.ok(!c.html.includes("<b>Lou</b>"));
  assert.ok(!/RefiRadar/.test(c.html + c.subject));
});

test("mailReady needs both mail settings and, in production, a public APP_URL", () => {
  assert.strictEqual(mailReady({}), false);
  assert.strictEqual(mailReady({ EMAIL_USER: "a" }), false);
  assert.strictEqual(mailReady({ EMAIL_PASS: "b" }), false);
  assert.strictEqual(mailReady({ EMAIL_USER: "", EMAIL_PASS: "b" }), false);
  assert.strictEqual(mailReady({ EMAIL_USER: "a", EMAIL_PASS: "b" }), true);
  const prod = { NODE_ENV: "production", EMAIL_USER: "a", EMAIL_PASS: "b" };
  assert.strictEqual(mailReady({ ...prod, APP_URL: "http://localhost:8080" }), false);
  assert.strictEqual(mailReady({ ...prod }), false);
  assert.strictEqual(mailReady({ ...prod, APP_URL: "https://x.run.app" }), true);
});

test("the senders answer false, and send nothing, when mail isn't set up", async (t) => {
  // the env is cleared first so a developer's real mail settings can never make this test send
  const saved = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  t.after(() => {
    if (saved.u !== undefined) process.env.EMAIL_USER = saved.u;
    if (saved.p !== undefined) process.env.EMAIL_PASS = saved.p;
  });
  const warn = t.mock.method(console, "warn", () => {});
  const { sendPasswordReset, sendPasswordChanged } = require("../email");
  assert.strictEqual(await sendPasswordReset({ to: "a@x.test", firstName: "A", link: "https://x.test/?reset=secret" }), false);
  assert.strictEqual(await sendPasswordChanged({ to: "a@x.test", firstName: "A" }), false);
  assert.strictEqual(warn.mock.callCount(), 2);
  assert.ok(!warn.mock.calls.some((c) => c.arguments.join(" ").includes("secret")), "the link is never logged");
});

// The invite and refi-alert emails put names typed by people (the broker, the loan officer, the client, the company) into HTML, so
// each is escaped; the subject is plain text, which a mail client never reads as HTML, so it is left as typed. The real senders run
// here with nodemailer's transport replaced by one that only records the message, so no mail goes anywhere.
test("the invite and alert emails escape every name in the body and leave the subject as typed", async (t) => {
  const saved = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  process.env.EMAIL_USER = "sender@x.test";
  process.env.EMAIL_PASS = "not-a-real-password";
  t.after(() => {
    for (const [k, v] of [["EMAIL_USER", saved.u], ["EMAIL_PASS", saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const mails = [];
  t.mock.method(require("nodemailer"), "createTransport", () => ({ sendMail: async (m) => { mails.push(m); } }));
  const { sendInvite, sendRefiAlert } = require("../email");

  await sendInvite({ toEmail: "lo@x.test", toName: "<i>Lou</i>", fromName: "<b>Boss</b> & Co", orgName: '"><script>x()</script>', token: "ab".repeat(32) });
  await sendRefiAlert({ toEmail: "lo@x.test", toName: "<i>Lou</i>", clientName: "<u>Cleo</u>", brokerName: "O'Brien <img src=x>", monthlySavings: 412.6 });
  assert.strictEqual(mails.length, 2);
  const [invite, alert] = mails;

  assert.ok(invite.html.includes("&lt;b&gt;Boss&lt;/b&gt; &amp; Co"));
  assert.ok(invite.html.includes("&quot;&gt;&lt;script&gt;x()&lt;/script&gt;"));
  assert.ok(!/<b>Boss|<script|<i>Lou/.test(invite.html), "no typed tag survives as a tag");
  assert.ok(invite.html.includes(inviteLink("ab".repeat(32))));
  assert.ok(!invite.html.includes("?token="));
  assert.strictEqual(inviteLink("ab".repeat(32)), APP_URL + "/#invite=" + "ab".repeat(32));
  assert.strictEqual(invite.subject, '<b>Boss</b> & Co invited you to join "><script>x()</script> on Broker Radar');

  assert.ok(alert.html.includes("Hi &lt;i&gt;Lou&lt;/i&gt;,"));
  assert.ok(alert.html.includes("&lt;u&gt;Cleo&lt;/u&gt;"));
  assert.ok(alert.html.includes("O&#39;Brien &lt;img src=x&gt;"));
  assert.ok(alert.html.includes("$413/month"));
  assert.ok(!/<i>Lou|<u>Cleo|<img/.test(alert.html), "no typed tag survives as a tag");
  assert.strictEqual(alert.subject, "Action needed: <u>Cleo</u> is ready to refinance");
});

test("the invite, alert and email-change emails say Broker Radar, not RefiRadar", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "email.js"), "utf8");
  assert.ok(!src.includes("RefiRadar"), "email.js still says RefiRadar");
  // three old senders plus the shared password sender (deliverPasswordMail) all use the Broker Radar From line
  const fromLine = '"Broker Radar" <${FROM}>';
  assert.strictEqual(src.split(fromLine).length - 1, 4);
});

test("createSendCounter forgets a key once its last take is over the window old", () => {
  const c = createSendCounter({ max: 3, windowMs: 1000 });
  c.take("a", 0); c.take("b", 500);
  assert.strictEqual(c.size(), 2);
  c.take("c", 1001);                      // "a" (last take 0) is gone; "b" (500) is still inside the window
  assert.strictEqual(c.size(), 2);
  c.take("c", 1501);                      // now "b" is gone too
  assert.strictEqual(c.size(), 1);
  assert.strictEqual(c.take("a", 1501), true, "a forgotten key starts again from nothing");
});
