// The two sign-up emails (auth-hardening design §6). No database is needed: these only build and send mail.
process.env.NODE_ENV = "test";
// A fake sender is set before ../email loads (it reads EMAIL_USER once, for the From line); the tests below clear or set the mail
// settings themselves, and the transport is always replaced, so a real mail setting from the environment can never cause a send.
process.env.EMAIL_USER = "sender@x.test";
process.env.EMAIL_PASS = "not-a-real-password";

const test = require("node:test");
const assert = require("node:assert");
const email = require("../email");
const { signupMessage, alreadyRegisteredMessage, sendSignup, sendAlreadyRegistered } = email;

test("email A: the approved words, the link, and every typed value escaped", () => {
  const L = "https://app.example.com/#signup=" + "ab".repeat(32);
  const m = signupMessage({ firstName: "<b>Nia</b>", orgName: "O'Neil & <i>Co</i>", email: "nia@x.test", link: L });
  assert.strictEqual(m.subject, "Finish creating your Broker Radar account");
  assert.ok(m.html.includes("Hi &lt;b&gt;Nia&lt;/b&gt;,"));
  assert.ok(m.html.includes("Thanks for starting a Broker Radar trial for O&#39;Neil &amp; &lt;i&gt;Co&lt;/i&gt;."));
  assert.ok(m.html.includes("To finish creating your account (nia@x.test), use this button within 24 hours:"));
  // one paragraph, as the approved copy (§6) shows it: the two sentences joined by a single space
  assert.ok(m.html.includes("Thanks for starting a Broker Radar trial for O&#39;Neil &amp; &lt;i&gt;Co&lt;/i&gt;. To finish creating your account (nia@x.test), use this button within 24 hours:"));
  assert.ok(m.html.includes(`href="${L}"`) && m.html.includes(">Create my account</a>"));
  assert.ok(m.html.includes("If you didn't ask for this, you can ignore this email. No account will be created."));
  assert.ok(!/<b>Nia|<i>Co/.test(m.html));
});

test("email B: the approved words, a plain sign-in link, and the name escaped", () => {
  const m = alreadyRegisteredMessage({ firstName: "<b>Lou</b>", email: "lou@x.test", link: "https://app.example.com/" });
  assert.strictEqual(m.subject, "You already have a Broker Radar account");
  assert.ok(m.html.includes("Hi &lt;b&gt;Lou&lt;/b&gt;,"));
  assert.ok(m.html.includes("Someone just tried to create a new Broker Radar account with your email (lou@x.test), but there's already an account or an invitation for this address."));
  assert.ok(m.html.includes(`If this was you, sign in instead. If you've forgotten your password, use "Forgot password?" on the sign-in page. If your broker invited you, use the link in that invitation.`));
  assert.ok(m.html.includes('href="https://app.example.com/"') && m.html.includes(">Go to sign in</a>"));
  assert.ok(m.html.includes("If it wasn't you, you can ignore this email. Nothing has changed."));
  assert.ok(!/<b>Lou/.test(m.html));
});

test("the two senders send nothing and answer false without mail settings; with them, they send from Broker Radar to `to`", async (t) => {
  const saved = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  t.after(() => {
    for (const [k, v] of [["EMAIL_USER", saved.u], ["EMAIL_PASS", saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const mails = [];
  t.mock.method(require("nodemailer"), "createTransport", () => ({ sendMail: async (m) => { mails.push(m); } }));
  const LINK = "https://app.example.com/#signup=secret" + "cd".repeat(16);

  // Without settings: false, nothing sent, two warnings, none carrying the link.
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  const warn = t.mock.method(console, "warn", () => {});
  assert.strictEqual(await sendSignup({ to: "a@x.test", firstName: "A", orgName: "Org", link: LINK }), false);
  assert.strictEqual(await sendAlreadyRegistered({ to: "a@x.test", firstName: "A" }), false);
  assert.strictEqual(warn.mock.callCount(), 2);
  assert.ok(!warn.mock.calls.some((c) => c.arguments.join(" ").includes("secret")), "the link is never logged");
  assert.strictEqual(mails.length, 0);
  warn.mock.restore();

  // With (fake) settings: both send, from Broker Radar, to the given address.
  process.env.EMAIL_USER = "sender@x.test";
  process.env.EMAIL_PASS = "not-a-real-password";
  assert.strictEqual(await sendSignup({ to: "nia@x.test", firstName: "Nia", orgName: "Acme", link: LINK }), true);
  assert.strictEqual(await sendAlreadyRegistered({ to: "lou@x.test", firstName: "Lou" }), true);
  assert.strictEqual(mails.length, 2);
  const [a, b] = mails;
  assert.strictEqual(a.from, '"Broker Radar" <sender@x.test>');
  assert.strictEqual(a.to, "nia@x.test");
  assert.strictEqual(a.subject, "Finish creating your Broker Radar account");
  assert.ok(a.html.includes(`href="${LINK}"`));
  assert.strictEqual(b.from, '"Broker Radar" <sender@x.test>');
  assert.strictEqual(b.to, "lou@x.test");
  assert.strictEqual(b.subject, "You already have a Broker Radar account");
  assert.ok(b.html.includes(`href="${email.APP_URL}/"`));
});

// Round 2, item 9: Gmail shows an App Password in groups of four ("abcd efgh ijkl mnop"), and a value pasted into a setting can
// carry a trailing newline. The transport gets the password with every bit of whitespace taken out, and mailReady checks that same
// cleaned value (a password that is only whitespace is no password).
test("EMAIL_PASS with spaces and a trailing newline: the transport's auth gets the cleaned value, and mailReady checks it", async (t) => {
  const saved = { u: process.env.EMAIL_USER, p: process.env.EMAIL_PASS };
  t.after(() => {
    for (const [k, v] of [["EMAIL_USER", saved.u], ["EMAIL_PASS", saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const auths = [];
  t.mock.method(require("nodemailer"), "createTransport", (options) => {
    auths.push({ ...options.auth });
    return { sendMail: async () => {} };
  });
  process.env.EMAIL_USER = "sender@x.test";
  process.env.EMAIL_PASS = "abcd efgh ijkl mnop\n";
  assert.strictEqual(await sendAlreadyRegistered({ to: "lou@x.test", firstName: "Lou" }), true);
  assert.deepStrictEqual(auths, [{ user: "sender@x.test", pass: "abcdefghijklmnop" }]);

  assert.strictEqual(email.mailReady({ EMAIL_USER: "sender@x.test", EMAIL_PASS: "abcd efgh ijkl mnop\n" }), true);
  assert.strictEqual(email.mailReady({ EMAIL_USER: "sender@x.test", EMAIL_PASS: " \t\r\n " }), false);
});
