# Account Hardening (sign-up, sign-in, invite links) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign-up creates an account only through a link emailed to the address and never reveals who has an account; failed
sign-ins cost the same with or without an account; invite secrets leave URLs and are stored only as SHA-256.

**Architecture:** A new store `server/lib/signup.js` over a new `signup_requests` table (the `lib/passwordReset.js` pattern: plain
functions over a `db` handle). `routes/auth.js` gets the answer-first `/register`, `/register/check`, `/register/complete`,
`POST /invite/check`, a dummy bcrypt check in `/login`, and hashed invite storage. `email.js` gets the two approved emails on the
shared `deliverPasswordMail` sender. The client reads `#signup=` / `#invite=` fragments and gets a "Check your email" card and a
"Finish creating your account" page, built from the existing auth components.

**Tech Stack:** Node 20, Express 4, better-sqlite3, bcryptjs, express-rate-limit 7, nodemailer; React 18 + Vite; `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-04-auth-hardening-design.md` (APPROVED 2026-11-05, including the §6 email wording).

## Global Constraints

- Node 20 only: prefix every command with `export PATH="/c/Users/bille/dev/node20:$PATH" &&`. Server: `cd server && npm test`.
  Client: `cd client && npm test && npm run build`. Baseline before Task 1: server 1233 pass, client 226 pass, 0 fail.
- No new dependencies. Never open, read or print any `.env*` file. No test sends real mail: senders come in through app seams, or
  `nodemailer.createTransport` is mocked; never set real mail settings.
- Every token is `crypto.randomBytes(32).toString("hex")` (64 lowercase hex); the database keeps only `hashToken(token)` (SHA-256,
  `server/lib/passwordReset.js`). No log line may contain a token or a link: log the kind of failure and `err?.message` only.
- Email is matched and stored `trim().toLowerCase()`. Passwords are never trimmed. Names and the brokerage are stored trimmed.
- Exact strings (copy verbatim):
  - `"All fields required"`, `"Password must be at least 8 characters"`, `"Password must be at most 256 characters"`,
    `"Enter a valid email address"`, `"Names and the brokerage name can be at most 100 characters"` (all 400)
  - `"Sign-up isn't available right now. Please try again later."` (503)
  - `"Too many sign-up attempts — please try again in an hour"` (429, /register)
  - `"Too many attempts — please try again in 15 minutes"` (429, /register/complete and /accept-invite)
  - `"This link has expired or was already used."` (410, sign-up links; the existing `LINK_GONE`)
  - `"This invitation has expired or was already used."` (410, invite links)
  - Page: `"Check your email"`, `"We've sent a link to {email}. Open it within 24 hours to finish creating your account. If it doesn't arrive in a few minutes, check your spam folder."`,
    `"Back to sign in"`, `"Finish creating your account"`, `"Create my account"`, `"Start again"`
- The approved layout stays: reuse `AuthCard`, `AuthField`, `btnPrimary`, the red error box and the amber text buttons already in
  `client/src/App.jsx`. No new colours, fonts or layout.
- Comments follow the codebase: plain-English "why" comments above each route and helper.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A mail scanner opens the sign-up link before the person does.** Opening (`/register/check`) must not create or use up anything;
   pinned in Task 4 test "register/check: ... a check does not use the link up".
2. **The person signs up twice (no email yet, so they try again).** Only the newest link works; the first is the same 410; pinned in
   Task 1 (`issueSignup` replaces) and Task 4 (check after a newer request).
3. **Two tabs: "Create my account" pressed in both.** One account and one organization; the second press is 410 and the page offers
   Start again; pinned in Task 4 test "register/complete ... works once".
4. **An LO invite (or an email change) claims the address while a sign-up is pending.** The pending link is refused and nothing is
   created; pinned in Task 1 and Task 4 ("... after the address got a user another way").
5. **A pending invite emailed before this release (`/accept-invite?token=`).** It still opens and can be accepted after start-up
   moves it to a hash, and a second start-up changes nothing; pinned in Task 2 (migration test) and Task 5 (`inviteTokenFrom` reads
   the legacy query).

---

### Task 1: Send-counter sweep and the sign-up store

**Files:**
- Modify: `server/lib/passwordReset.js` (`createSendCounter`)
- Modify: `server/db.js` (new `signup_requests` table, after `password_resets`)
- Create: `server/lib/signup.js`
- Test: `server/test/password-reset-lib.test.js` (add), `server/test/signup-lib.test.js` (new)

**Interfaces:**
- Produces: `createSendCounter(...)` returns `{ take(key, nowMs) -> boolean, size() -> number }`.
- Produces (`server/lib/signup.js`):
  `SIGNUP_TTL_MS = 24 * 60 * 60 * 1000`, `TRIAL_MS = 14 * 24 * 60 * 60 * 1000`,
  `issueSignup(db, { email, firstName, lastName, orgName, passwordHash }, nowMs) -> string` (the token),
  `signupFor(db, token, nowMs) -> signup_requests row | null`,
  `completeSignup(db, token, nowMs) -> users row | null`,
  `purgeExpiredSignups(db, nowMs) -> void`.

- [ ] **Step 1: Write the failing tests**

In `password-reset-lib.test.js`:

```js
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
```

New `signup-lib.test.js` (throwaway DB set up exactly like `password-reset-lib.test.js`; `NOW = 1_800_000_000_000`; a request
`REQ = { email: "new@x.test", firstName: " Nia ", lastName: " New ", orgName: " Nia Mortgage ", passwordHash: "bcrypt-hash" }`):

```js
test("issueSignup stores only a hash and the trimmed names; a second request for the address replaces the first", () => {
  const t1 = issueSignup(db, REQ, NOW);
  assert.match(t1, /^[0-9a-f]{64}$/);
  const row = db.prepare("SELECT * FROM signup_requests WHERE email = ?").get("new@x.test");
  assert.strictEqual(row.token_hash, hashToken(t1));
  assert.ok(!Object.values(row).includes(t1));
  assert.deepStrictEqual([row.first_name, row.last_name, row.org_name, row.password_hash, row.expires_at],
    ["Nia", "New", "Nia Mortgage", "bcrypt-hash", NOW + SIGNUP_TTL_MS]);
  const t2 = issueSignup(db, REQ, NOW + 5);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM signup_requests").get().n, 1);
  assert.strictEqual(signupFor(db, t1, NOW + 5), null);
  assert.strictEqual(signupFor(db, t2, NOW + 5).email, "new@x.test");
});

test("signupFor: null when expired (at exactly 24 hours), malformed, unknown, or the address already has a user (an unused invite too)", () => {
  // expired: signupFor(db, t, NOW + SIGNUP_TTL_MS) === null; one ms earlier it is the row
  // malformed: "abc", 64 upper-case hex, undefined, 42 -> null; unknown: "cd".repeat(32) -> null
  // a users row (invite_accepted = 1) for the address -> null; an unused invite (invite_accepted = 0) -> null
});

test("completeSignup creates the organization (14-day trial from now) and the broker, deletes the request, and works once", () => {
  // user: role "broker", invite_accepted 1, password_hash "bcrypt-hash", first/last name trimmed, email "new@x.test",
  //       session_version 0; org: name "Nia Mortgage", plan "trial", trial_ends === new Date(NOW + TRIAL_MS).toISOString()
  // the signup_requests row is gone; completeSignup(db, sameToken, NOW) === null and the organizations count did not change again
});

test("completeSignup creates nothing when the address got a user another way, or the link expired", () => {
  // insert an LO invite row for the address after issueSignup -> completeSignup === null; organizations and users counts unchanged
  // expired: completeSignup(db, t, NOW + SIGNUP_TTL_MS) === null
});

test("purgeExpiredSignups deletes only expired requests", () => {
  // one request issued at NOW, one at NOW + 10; purgeExpiredSignups(db, NOW + SIGNUP_TTL_MS) leaves only the second
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test test/signup-lib.test.js test/password-reset-lib.test.js`
Expected: FAIL — `Cannot find module '../lib/signup'` and `c.size is not a function`.

- [ ] **Step 3: Implement**

- `createSendCounter`: at the start of every `take`, delete every key whose newest take is at or before `nowMs - windowMs` (a full
  sweep of the map; it only holds keys taken within the last window, so it stays small). Add `size()`. Update its comment: the
  counter now forgets an address an hour after its last send, so sign-up can ask it about addresses that have no account.
- `db.js`: the `signup_requests` table exactly as spec §5.4, with a comment in the style of `password_resets`.
- `lib/signup.js`: reuse `hashToken` from `./passwordReset` and the same `/^[0-9a-f]{64}$/` check. `issueSignup` upserts on
  `email` (`ON CONFLICT(email) DO UPDATE`), lower-casing and trimming the email and trimming the three names. `signupFor` requires
  `expires_at > nowMs` and `NOT EXISTS (SELECT 1 FROM users WHERE email = r.email)`. `completeSignup` runs in one
  `db.transaction`: `signupFor` again, insert the organization (`plan 'trial'`, `trial_ends = new Date(nowMs + TRIAL_MS).toISOString()`),
  insert the user (`role 'broker'`, `invite_accepted 1`, the stored `password_hash`), delete the request, return the new users row.

- [ ] **Step 4: Run to verify they pass, then the full server suite**

Run: `cd server && node --test test/signup-lib.test.js test/password-reset-lib.test.js && npm test`
Expected: all pass; server total = 1233 + the new tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/lib/passwordReset.js server/lib/signup.js server/db.js server/test/password-reset-lib.test.js server/test/signup-lib.test.js
git commit -m "feat(auth): sign-up request store; the send counter forgets old addresses"
```

---

### Task 2: Invite links: hashed secret, fragment link, POST check

**Files:**
- Modify: `server/db.js` (column `users.invite_token_hash` + start-up move, after the `session_version` migration)
- Modify: `server/routes/auth.js` (`/invite`, remove `GET /invite/:token`, add `POST /invite/check`, `/accept-invite`)
- Modify: `server/email.js` (`inviteLink`, used by `sendInvite`)
- Modify: `server/test/coaching.test.js:1110-1140`, `server/test/sessions.test.js:87-96` (they insert `invite_token` directly)
- Test: `server/test/invite-api.test.js` (add), `server/test/invite-hash-migration.test.js` (new),
  `server/test/password-reset-lib.test.js` (the invite-email test)

**Interfaces:**
- Consumes: `hashToken(token)` from `server/lib/passwordReset.js`.
- Produces: `email.inviteLink(token) -> string` = `` `${APP_URL}/#invite=${token}` ``.
- Produces: `POST /api/auth/invite/check { token }` -> `200 { success: true, firstName, lastName, email, orgName }` or
  `410 { success: false, error: "This invitation has expired or was already used." }`.
- Produces: `POST /api/auth/accept-invite { token, password }` -> `200 { success, user }` + cookie; 400 (password); 410 (token, the
  message above); 429.

- [ ] **Step 1: Write the failing tests**

`invite-hash-migration.test.js` — the subprocess pattern of `coaching.test.js` "users.career_stage: ... idempotently": an old-schema
DB (the `users` table without `invite_token_hash`) holding one pending invite with `invite_token = "ab".repeat(32)` and one broker
with no invite.

```js
test("start-up moves a pending invite's token to its SHA-256, and running again changes nothing", () => {
  // first load of db.js:  invite row -> invite_token null, invite_token_hash === sha256("ab".repeat(32)); broker row -> both null
  // second load:          the same values (the step is idempotent and does not fail)
});
```

In `invite-api.test.js` (add `app.set("trust proxy", 1)` already there; give each new request its own X-Forwarded-For as the file does):

```js
test("invite: the row keeps only the SHA-256 of the token, and the emailed token checks out", async () => {
  // after a 201: row.invite_token === null; row.invite_token_hash === hashToken(sends[0].token)
  // POST /invite/check { token: sends[0].token } -> 200, deepStrictEqual
  //   { success: true, firstName: "Nia", lastName: "Newhire", email: <the address>, orgName: "Invite API Org" }
});
test("invite check: malformed, unknown, expired and used tokens all get the same 410", async () => {
  // each -> 410, deepStrictEqual { success: false, error: "This invitation has expired or was already used." }
  // a body with no token, and { token: 42 }, are the same 410
});
test("GET /api/auth/invite/<token> is gone (the secret no longer goes in a URL)", async () => {
  // fetch(base + "/api/auth/invite/" + "ab".repeat(32)) -> 404
});
test("accept-invite: a bad token is the same 410 and costs no bcrypt hash; a good one works once", async (t) => {
  // malformed and unknown -> 410 with the invitation message; t.mock.method(bcrypt, "hashSync") callCount 0 for them
  // good -> 200 + a set-cookie; the row now has invite_accepted 1, invite_token_hash null, invite_expires null
  // the same token again -> 410
});
test("accept-invite: a password under 8 or over 256 characters is 400 and the invite stays good", async () => {});
test("accept-invite: 10 tries per 15 minutes per IP, then 429", async () => {
  // 10 requests from one pinned IP with a made-up token -> 410 each; the 11th -> 429,
  //   { success: false, error: "Too many attempts — please try again in 15 minutes" }
});
```

In `password-reset-lib.test.js`, in "the invite and alert emails escape ...": `assert.ok(invite.html.includes(inviteLink("ab".repeat(32))))`,
`assert.ok(!invite.html.includes("?token="))`, and a new line `assert.strictEqual(inviteLink("ab".repeat(32)), APP_URL + "/#invite=" + "ab".repeat(32))`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test test/invite-api.test.js test/invite-hash-migration.test.js test/password-reset-lib.test.js`
Expected: FAIL — no `invite_token_hash` column, `/invite/check` 404, `inviteLink` undefined.

- [ ] **Step 3: Implement**

- `db.js`: add `invite_token_hash TEXT` when missing; then, on every start, move each row with a non-NULL `invite_token`
  (`invite_token_hash = hashToken(invite_token)`, `invite_token = NULL`) inside one transaction. Comment why: a copy of the
  database must hold nothing that opens an account, and links already mailed keep working because lookups use the hash.
- `routes/auth.js`: `INVITE_GONE` constant; one local helper `inviteeFor(token, nowMs) -> users row | null` (format check, lookup
  by `invite_token_hash` with `invite_accepted = 0`, `invite_expires` after now) used by both routes. `/invite` stores the hash and
  never the token. `/invite/check` has no rate limit (the same reasoning as the comment on `/reset/check`). `/accept-invite` gets
  its own limiter instance `acceptInviteLimiter` (10 per 15 minutes, the message above; not the `resetLimiter` instance, so the
  two routes don't share a count), checks the password (8..256, `PASSWORD_MAX`), then `inviteeFor`, then hashes; the UPDATE is
  `... WHERE id = ? AND invite_accepted = 0` and a 0-row change is the 410.
- `email.js`: `inviteLink`; `sendInvite` uses it; the email's wording is unchanged.
- `coaching.test.js` and `sessions.test.js`: insert `invite_token_hash = hashToken(token)` instead of `invite_token`.

- [ ] **Step 4: Run to verify they pass, then the full server suite**

Run: `cd server && npm test`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/db.js server/routes/auth.js server/email.js server/test/
git commit -m "feat(auth): invite secrets stored as SHA-256, link after #invite=, checked by POST; one 410 for every bad invite"
```

---

### Task 3: The two approved sign-up emails

**Files:**
- Modify: `server/email.js`
- Test: `server/test/signup-email.test.js` (new; needs no DB)

**Interfaces:**
- Produces: `signupMessage({ firstName, orgName, email, link }) -> { subject, html }`,
  `alreadyRegisteredMessage({ firstName, email, link }) -> { subject, html }`,
  `sendSignup({ to, firstName, orgName, link }) -> Promise<boolean>`,
  `sendAlreadyRegistered({ to, firstName }) -> Promise<boolean>` (its button links to `` `${APP_URL}/` ``).

- [ ] **Step 1: Write the failing tests**

```js
test("email A: the approved words, the link, and every typed value escaped", () => {
  const L = "https://app.example.com/#signup=" + "ab".repeat(32);
  const m = signupMessage({ firstName: "<b>Nia</b>", orgName: "O'Neil & <i>Co</i>", email: "nia@x.test", link: L });
  assert.strictEqual(m.subject, "Finish creating your Broker Radar account");
  assert.ok(m.html.includes("Hi &lt;b&gt;Nia&lt;/b&gt;,"));
  assert.ok(m.html.includes("Thanks for starting a Broker Radar trial for O&#39;Neil &amp; &lt;i&gt;Co&lt;/i&gt;."));
  assert.ok(m.html.includes("To finish creating your account (nia@x.test), use this button within 24 hours:"));
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
});
test("the two senders send nothing and answer false without mail settings; with them, they send from Broker Radar to `to`", async (t) => {
  // without EMAIL_USER/EMAIL_PASS (cleared and restored as in password-reset-lib.test.js): both resolve false, console.warn twice,
  //   no warning contains the link
  // with fake settings and t.mock.method(require("nodemailer"), "createTransport", ...) recording mail: both resolve true;
  //   from === '"Broker Radar" <sender@x.test>', to as given, subjects as above; B's html links to email.APP_URL + "/"
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test test/signup-email.test.js`
Expected: FAIL — `signupMessage is not a function`.

- [ ] **Step 3: Implement**

Both builders follow `passwordResetMessage`: `<p>` paragraphs, the amber button style already used there, the closing line in
`<p style="color:#666;font-size:12px">`, every interpolated value through `escapeHtml` (the link too). The copy is exactly spec §6
and the test strings above. Both senders go through `deliverPasswordMail` (`what` = `"sign-up"` and `"already-registered"`), so
the `From` line count asserted in "the invite, alert and email-change emails say Broker Radar" stays 4. Update the comments: the
wording is Bill's, approved 2026-11-05 (auth-hardening design §6); `deliverPasswordMail` now sends four messages. Export all four.

- [ ] **Step 4: Run to verify they pass, then the full server suite**

Run: `cd server && npm test`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/email.js server/test/signup-email.test.js
git commit -m "feat(email): the two approved sign-up emails (finish creating your account / you already have one)"
```

---

### Task 4: Email-verified sign-up routes, sign-in timing, tests and seed script moved off the old /register

**Files:**
- Modify: `server/routes/auth.js` (`/register`, new `/register/check`, `/register/complete`, `/login`, the `/forgot` comment)
- Create: `server/test-support/accounts.js` (outside `server/test/`, so `node --test` does not run it as a test file)
- Modify: `server/test/auth.test.js`, `server/test/sweeps-api.test.js`, `server/test/sessions.test.js`, `server/test/coaching.test.js:1018-1031`
- Modify: `scripts/seed-demo.js:209-227`
- Test: `server/test/signup-api.test.js` (new)

**Interfaces:**
- Consumes: Task 1 `issueSignup`, `signupFor`, `completeSignup`, `purgeExpiredSignups`, `createSendCounter`; Task 3 `sendSignup`,
  `sendAlreadyRegistered`; existing `mailReady`, `APP_URL`, `LINK_GONE`, `setSession`, `safeUser`, `sendAfterAnswer`.
- Produces: `POST /api/auth/register` -> 200 `{ success: true }` | 400 | 429 | 503; `POST /api/auth/register/check { token }` ->
  200 `{ success: true, email, orgName }` | 410 `LINK_GONE`; `POST /api/auth/register/complete { token }` -> 200
  `{ success: true, user }` + `rr_token` cookie | 410 `LINK_GONE` | 429.
- Produces: app seams `sendSignup`, `sendAlreadyRegistered` (alongside the existing `authEnv`, `resetSendCounter`,
  `resetSiteSendCounter`).
- Produces: `addBroker(db, { email, firstName = "Ann", lastName = "Broker", orgName = "Alpha Mortgage", password = "password123" }) -> users row`
  in `server/test-support/accounts.js` (org with a 14-day trial, broker with `invite_accepted 1`, bcrypt cost 4).

- [ ] **Step 1: Write the failing tests**

New `signup-api.test.js`, set up like `password-reset-api.test.js` (throwaway DB, `trust proxy`, a fresh X-Forwarded-For per
request, `until()`, `READY_ENV`, fresh `resetSendCounter` / `resetSiteSendCounter` and recording `sendSignup` /
`sendAlreadyRegistered` / `sendPasswordReset` seams before each test; `FORM = { firstName: "Nia", lastName: "New", email: "nia@x.test", password: "password123", orgName: "Nia Mortgage" }`):

```js
test("register: one answer for a new address, a taken one, an unused invite, and one over its hourly limit", async () => {
  // each -> 200, deepStrictEqual { success: true }, and no set-cookie
});
test("register: the answer does not wait for the email", async () => {
  // sendSignup returns a promise that never settles -> the answer is still 200
});
test("register: a new address gets email A with APP_URL/#signup=<64 hex>; nothing exists until the link is used", async () => {
  // email "  NIA@X.test " -> one sendSignup call: to "nia@x.test", firstName "Nia", orgName "Nia Mortgage",
  //   link matches /^http:\/\/localhost:8080\/#signup=[0-9a-f]{64}$/ (APP_URL is deleted at the top of the file)
  // users and organizations counts unchanged; one signup_requests row whose password_hash !== "password123" and
  //   bcrypt.compareSync("password123", row.password_hash) === true
});
test("register: a taken address gets email B with the account's own first name, never the typed one, and nothing is stored", async () => {
  // addBroker(db, { email: "lou@x.test", firstName: "Lou" }); register with firstName "Mallory" ->
  //   sendAlreadyRegistered called with { to: "lou@x.test", firstName: "Lou" }; sendSignup not called; no signup_requests row
  // the same for an unused LO invite row (invite_accepted 0, first_name "Ivy") -> firstName "Ivy"
});
test("register: the 400s, checked in order, each with its own words", async () => {
  // a missing field, a name of only spaces, or a non-string field -> "All fields required"
  // password "1234567" -> "Password must be at least 8 characters"; 257 chars -> "Password must be at most 256 characters"; 256 -> 200
  // email "a@b.c,d@e.f", "a@b.c;d", "a b@c.d", "nope", ("a".repeat(245) + "@x.test" is 252 chars -> 200; 255 chars -> 400)
  //   -> "Enter a valid email address"
  // firstName / lastName / orgName of 101 characters -> "Names and the brokerage name can be at most 100 characters";
  //   100 characters (with spaces around them) -> 200
});
test("register: mail not set up is 503 for every address and stores and sends nothing", async () => {
  // app.set("authEnv", { NODE_ENV: "test" }); new and taken address -> 503
  //   { success: false, error: "Sign-up isn't available right now. Please try again later." }
});
test("register: 5 an hour per IP, then 429", async () => {
  // 5 from one pinned IP -> 200 (a 400 counts too: make one of the five invalid); the 6th ->
  //   429 { success: false, error: "Too many sign-up attempts — please try again in an hour" }
});
test("register: at most 3 emails an hour to one address, counted together with reset emails; the site cap is shared too", async () => {
  // addBroker "lou@x.test": 2 x POST /forgot + 2 x POST /register for it -> 3 sends in all; every answer 200
  // app.set("resetSiteSendCounter", createSendCounter({ max: 2 })): 3 registers for 3 new addresses -> 2 sendSignup calls,
  //   and a /forgot for an account after that sends nothing
});
test("register/check: 200 with the email and brokerage; a check does not use the link up; 410 for every bad link", async () => {
  // good -> 200 { success: true, email: "nia@x.test", orgName: "Nia Mortgage" }, twice; users count unchanged
  // malformed, unknown, replaced by a newer register for the address, expired (the row's expires_at set to Date.now() - 1),
  //   and after addBroker for the address -> 410 deepStrictEqual { success: false, error: "This link has expired or was already used." }
});
test("register/complete: signs in as the new broker, with a 14-day trial, and works once", async () => {
  // 200; user keys sorted === ["careerStage","email","firstName","id","lastName","orgId","role"]; role "broker"; careerStage null
  // jwt.decode(cookie token).sv === 0; GET /me with the cookie -> 200 and email "nia@x.test"
  // the org's trial_ends is 14 days (± 1 minute) from now; POST /login with FORM's email and password -> 200
  // complete again -> 410 LINK_GONE; organizations count went up by exactly 1
});
test("register/complete: refused, and nothing created, after the address got an invite in the meantime", async () => {});
test("register/complete: 10 tries per 15 minutes per IP, then 429", async () => {
  // 10 with a made-up token from one pinned IP -> 410; the 11th -> 429 "Too many attempts — please try again in 15 minutes"
});
test("no log line holds a sign-up token or link, even when the send throws or the store fails", async (t) => {
  // mock console.error / console.warn / console.log. Run 1: sendSignup throws new Error("smtp down"). Run 2: t.mock.method(db,
  //   "prepare", ...) wraps the real one and throws for any SQL containing "INSERT INTO signup_requests". Both answers are 200;
  //   after until() sees the error logged, no logged argument contains "#signup=" or matches /[0-9a-f]{64}/
});
test("login: no account, an unused invite, no password, and a wrong password each run one bcrypt check and give the same 401", async (t) => {
  // const cmp = t.mock.method(bcrypt, "compareSync"); for each case: 401
  //   deepStrictEqual { success: false, error: "Invalid email or password" }, and exactly one new compareSync call
});
```

Move the old `/register` callers onto `addBroker` + `POST /api/auth/login` (`auth.test.js` both brokers; `sweeps-api.test.js`;
`sessions.test.js` tests 1 and 3; `coaching.test.js` "register and login return careerStage: null" becomes "a new broker's login
returns careerStage: null"). In `sessions.test.js` test 2, drop the register part (its version-0 check now lives in
"register/complete: signs in ...") and rename it "login and accept-invite tokens carry the account's current version".

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && node --test test/signup-api.test.js`
Expected: FAIL — `/register` answers 201 and signs in; `/register/check` 404.

- [ ] **Step 3: Implement**

- `/register` (`registerLimiter`: 5 per hour, standard headers, the message above; placed before every check, like
  `forgotLimiter`): the four 400 checks in the spec's order (strings only; names and email trimmed before the presence check;
  `NAME_MAX = 100`), then `mailReady` (503), then `res.json({ success: true })`, then one `setImmediate` with one try/catch that
  logs `"[auth] sign-up not issued"` and `err?.message` only. Inside it, in this order:
  1. `bcrypt.hashSync(password, 12)` first, in every case, so the work after the answer is the same shape whichever case it is;
  2. `purgeExpiredSignups`;
  3. the per-address counter, then the site counter (the same two counters and seams as `/forgot`); either refusing ends it;
  4. any `users` row for the address -> `sendAfterAnswer("already-registered", ...)` with `{ to: row.email, firstName: row.first_name }`;
  5. otherwise `issueSignup` and `sendAfterAnswer("sign-up", ...)` with the trimmed first name and brokerage and
     `` link: `${email.APP_URL}/#signup=${token}` ``.
- `/register/check`: no rate limit (the `/reset/check` reasoning); `signupFor` -> 200 `{ success: true, email, orgName }` or 410.
- `/register/complete` (`signupCompleteLimiter`: its own instance, 10 per 15 minutes): `completeSignup(db, token, Date.now())`;
  null -> 410 `LINK_GONE`; else `setSession` and `res.json({ success: true, user: safeUser(user) })`.
- `/login`: `DUMMY_HASH = bcrypt.hashSync(<a fixed string>, 12)` at module load; when there is no row or no `password_hash`, run
  `bcrypt.compareSync(password, DUMMY_HASH)` and give the same 401. Comment why.
- `/forgot`: rewrite the comment that says the counter "never forgets a key" (Task 1 changed that); the code stays.
- `scripts/seed-demo.js`: step 1 logs in first (`✓ Logged in`); on any other answer print, in red,
  `✗ Couldn't sign in as the demo broker (${status}). Create the demo account through sign-up on the site first (sign-up now needs the emailed link), then run this again.`
  and exit 1. No call to `/api/auth/register` remains.

- [ ] **Step 4: Run to verify they pass, then the full server suite**

Run: `cd server && npm test && grep -rn "auth/register\"" test/ ../scripts/`
Expected: 0 fail; the grep prints only lines from `test/signup-api.test.js`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.js server/test-support/accounts.js server/test/ scripts/seed-demo.js
git commit -m "feat(auth): email-verified sign-up with one answer for every address; failed sign-ins cost one bcrypt check"
```

---

### Task 5: Client: "Check your email", "Finish creating your account", invite links from the fragment

**Files:**
- Create: `client/src/auth/signup.mjs`, `client/src/auth/signup.test.mjs`
- Modify: `client/src/App.jsx` (`RegisterPage`, new `FinishSignupPage`, `AcceptInvitePage`, the link-reading effect at ~2097-2125,
  `authView` values, the unauthenticated render at ~2288)

**Interfaces:**
- Consumes: Task 2 `POST /api/auth/invite/check`; Task 4 `/register`, `/register/check`, `/register/complete`.
- Produces (`signup.mjs`): `signupTokenFrom(hash) -> string | null`; `inviteTokenFrom(hash, search) -> string | null` (the
  `#invite=` fragment first, else the legacy `?token=` query; 64 lowercase hex only); `signupSentText(email) -> string`;
  `signupCheckOutcome(status, data) -> { kind: "ok", email, orgName } | { kind: "gone", text } | { kind: "retry", text }`;
  `inviteCheckOutcome(status, data) -> { kind: "ok", info: { firstName, lastName, email, orgName } } | { kind: "gone", text } | { kind: "retry", text }`.

- [ ] **Step 1: Write the failing tests** (`signup.test.mjs`, the style of `reset.test.mjs`)

```js
const HEX = "a".repeat(64);
test("signupTokenFrom reads only a 64-hex signup value from the fragment", () => {
  assert.equal(signupTokenFrom(`#signup=${HEX}`), HEX);
  for (const bad of ["#signup=abc", `#reset=${HEX}`, `?signup=${HEX}`, `#signup=${"A".repeat(64)}`, `#signup=${HEX}0`, "", null, undefined])
    assert.equal(signupTokenFrom(bad), null);
});
test("inviteTokenFrom prefers #invite=, still reads a legacy ?token=, and refuses anything else", () => {
  assert.equal(inviteTokenFrom(`#invite=${HEX}`, ""), HEX);
  assert.equal(inviteTokenFrom("", `?token=${HEX}`), HEX);
  assert.equal(inviteTokenFrom(`#invite=${HEX}`, `?token=${"b".repeat(64)}`), HEX);
  assert.equal(inviteTokenFrom("", "?token=abc"), null);
  assert.equal(inviteTokenFrom(`#signup=${HEX}`, ""), null);
  assert.equal(inviteTokenFrom(undefined, undefined), null);
});
test("signupSentText is the approved line", () => {
  assert.equal(signupSentText("nia@x.test"),
    "We've sent a link to nia@x.test. Open it within 24 hours to finish creating your account. If it doesn't arrive in a few minutes, check your spam folder.");
});
test("signupCheckOutcome: ok needs email and orgName; only a 410 is final", () => {
  assert.deepEqual(signupCheckOutcome(200, { email: "a@x", orgName: "Co" }), { kind: "ok", email: "a@x", orgName: "Co" });
  assert.deepEqual(signupCheckOutcome(410, null), { kind: "gone", text: "This link has expired or was already used." });
  assert.equal(signupCheckOutcome(200, { email: "a@x" }).kind, "retry");
  assert.equal(signupCheckOutcome(502, null).kind, "retry");
});
test("inviteCheckOutcome: ok carries the four fields; only a 410 is final", () => {
  assert.deepEqual(inviteCheckOutcome(410, null), { kind: "gone", text: "This invitation has expired or was already used." });
  assert.equal(inviteCheckOutcome(429, { error: "Too many" }).kind, "retry");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && node --test src/auth/`
Expected: FAIL — `Cannot find module './signup.mjs'`.

- [ ] **Step 3: Implement `signup.mjs`, then the screens**

- `signup.mjs`: a header comment listing the server contracts (like `reset.mjs`); fragment parsing as in `resetTokenFrom`.
  The "retry" text for both outcomes is `data?.error` or `"Couldn't check your link — please try again"`.
- `RegisterPage({ goLogin })`: on 200 show heading "Check your email", `signupSentText(<trimmed email>)` in a `role="status"`
  block, and a "Back to sign in" amber text button; errors stay in the red box; the loading label becomes "Sending…".
- `FinishSignupPage({ token, onDone, goRegister })`: modelled on `ResetPasswordPage` — "Checking your link…" while
  `POST /api/auth/register/check` runs; ok -> heading "Finish creating your account", an info box like `AcceptInvitePage`'s
  (labels "Email" and "Brokerage"), and a full-width `btnPrimary` "Create my account" that POSTs `/register/complete`
  (200 -> `onDone(data.user)`; 410 -> the gone state; anything else -> the red line); gone -> red box + `btnPrimary` "Start again"
  (`goRegister`); retry -> red box + "Try again". Opening the page never creates the account.
- `AcceptInvitePage`: check with `POST /api/auth/invite/check { token }` through `inviteCheckOutcome`; gone -> its red box with the
  text; retry -> red box + "Try again"; a 410 from accept shows the gone state.
- The link-reading effect, in this order: `#signup=` (authView `"finish-signup"`), `#reset=`, then `inviteTokenFrom(hash, search)`
  (authView `"accept-invite"`), then `/me`. Each found link is taken out of the address at once (`replaceState` to
  `pathname + search` for a fragment, to `"/"` for the legacy query), as `#reset=` already is. Someone signed in still gets the page.
  `handleSignupDone(user)` = `handleLogin(user)` then clear the signup token.

- [ ] **Step 4: Run the client tests and the build**

Run: `cd client && npm test && npm run build`
Expected: 0 fail (226 + the new tests); the build finishes with no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/auth/signup.mjs client/src/auth/signup.test.mjs client/src/App.jsx
git commit -m "feat(client): sign-up waits for the emailed link; Finish creating your account; invite links read from #invite="
```

---

## After the tasks (controller)

Live check on a local server with a fake mail transport (a scratchpad wrapper that sets dummy `EMAIL_USER`/`EMAIL_PASS` for this
process only and replaces `nodemailer.createTransport` with one that writes each message to a scratchpad file; nothing is sent):
sign up -> "Check your email"; open the written link -> "Finish creating your account" -> Create my account -> Home; sign up again
with the same address -> email B written, the page identical; an invite opened from `#invite=` and from a legacy `?token=` link;
screenshots to Bill. Then merge, push and deploy each wait for Bill's go.
