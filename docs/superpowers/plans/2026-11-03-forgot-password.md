# Forgot Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Broker Radar user who forgets their password gets a one-time emailed link, chooses a new password, and is signed
in, and every older session on that account ends.

**Architecture:** Server:
- a session version in the JWT, checked by `requireAuth`, so old sessions can be ended;
- a small reset store (`lib/passwordReset.js`) that keeps only a hash of each token;
- three routes in `routes/auth.js`;
- two message builders and senders in `email.js`.

Client: two new sign-in-card pages in `App.jsx`, with their logic and copy in a tested `.mjs` helper.

**Tech Stack:** Node 20, Express, better-sqlite3, bcryptjs, jsonwebtoken, nodemailer (Gmail), express-rate-limit;
React/Vite client; `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-03-forgot-password-design.md` (approved 2026-11-03). Read it before any task.

## Global Constraints

- **Node:** Node 20 only: `export PATH="/c/Users/bille/dev/node20:$PATH"`.
- **Test commands:** server `cd server && npm test`, client `cd client && npm test`, plus `cd client && npm run build`.
- **Secrets:** never read or print `server/.env` or any `.env*`. Refer to secrets by name (`EMAIL_USER`, `EMAIL_PASS`).
- **No real email in tests.** Every send goes through an app seam (`req.app.get(...)`), as `routes/profile.js` does for
  `sendEmailChange`.
- **Never log a reset token or a reset link**, failures included. The database stores only `sha256(token)` as hex.
- **Link lifetime:** 60 minutes (`RESET_TTL_MS = 60 * 60 * 1000`). One use. A new request replaces the old link.
- **Passwords:** at least 8 characters, with the exact message `"Password must be at least 8 characters"`, as register uses.
  bcrypt cost 12.
- **Limits:**
  - `/forgot`: 5 an hour per IP, and 3 emails an hour per account (a 4th answers 200 and sends nothing);
  - `POST /reset`: 10 per 15 minutes per IP.
- **Email copy:** the two emails' words are spec §7 verbatim (Bill approved them). They come from `"Broker Radar" <FROM>`.
  User-supplied text (first name, email) is HTML-escaped.
- **Screen copy:** spec §8 verbatim.
- **No restyling.** New pages reuse `AuthCard`, `AuthField`, `btnPrimary`, the red error box and the amber link button
  exactly as `LoginPage` uses them.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The same answer, at the same speed,** for a real account, a made-up email, an unused invite and an account over its
   hourly limit. Pinned in Task 3, test "forgot: one answer for every email".
2. **A session cookie from before a reset is refused** on its next request. Pinned in Task 1 (version bump) and Task 3
   (end to end).
3. **A link used twice, past 60 minutes, or replaced by a newer one is refused** with the same 410. Pinned in Task 2
   (store) and Task 3 (routes).
4. **No log line ever contains the token or link,** even when the send throws. Pinned in Task 3.
5. **Email case and spaces:** `" Lou@Example.com "` finds `lou@example.com`. Pinned in Task 3.

---

### Task 1: Sessions that can be ended

**Files:**
- Modify: `server/db.js` (migrations block, next to the other `ALTER TABLE` checks).
- Modify: `server/middleware/auth.js`.
- Modify: `server/routes/auth.js`: register, login and accept-invite each sign a token at lines ~54, ~73 and ~149.
- Test (create): `server/test/sessions.test.js`, set up like `server/test/auth.test.js`: a temp `DATA_DIR`, a random
  `JWT_SECRET` and `makeApp()`.

**Interfaces:**
- Produces:
  - `users.session_version INTEGER NOT NULL DEFAULT 0`.
  - `sessionTokenFor(user: { id: number, session_version?: number }) -> string`, exported from `middleware/auth.js`.
    It signs `{ userId: user.id, sv: user.session_version || 0 }` with the existing 7-day `signToken`. `signToken` stays
    exported unchanged, since tests use it.
  - `requireAuth` also selects `session_version`. It answers 401 `{ success: false, error: "Invalid or expired session" }`
    when `(payload.sv ?? 0) !== user.session_version`.
  - `setSession(res, user)`, internal to `routes/auth.js`: sets the `rr_token` cookie with the options used today
    (httpOnly, sameSite strict, 7 days, secure in production) and the token from `sessionTokenFor(user)`. Register, login
    and accept-invite use it in place of their three copies.

- [ ] **Step 1: Write the failing tests** in `server/test/sessions.test.js`:

```js
test("a token signed before this change (no sv) still works while the version is 0", async () => {
  // signToken({ userId }) for a fresh user -> GET /api/auth/me is 200
});
test("login, register and accept-invite tokens carry the account's current version", async () => {
  // register -> jwt.decode(cookie).sv === 0; UPDATE users SET session_version = 2; login -> sv === 2;
  // an accepted invite (insert an LO with invite_token, POST /accept-invite) -> sv === 0
});
test("raising the version ends every older session", async () => {
  // login -> cookie A works; UPDATE users SET session_version = session_version + 1
  // A -> 401 { success: false, error: "Invalid or expired session" }; a fresh login -> 200
});
test("the migration adds session_version, default 0", () => {
  // PRAGMA table_info(users) has session_version, dflt_value '0', notnull 1
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd server && node --test test/sessions.test.js`
Expected: FAIL (no `session_version` column; tokens without `sv`).

- [ ] **Step 3: Implement** the migration, `sessionTokenFor`, the `requireAuth` check and `setSession` as described in
  Interfaces.

- [ ] **Step 4: Run the new file, then the whole server suite**

Run: `cd server && node --test test/sessions.test.js && npm test`
Expected: all pass (1199 + 4).

- [ ] **Step 5: Commit**: `feat(auth): session version in the token, so a reset can end old sessions`

---

### Task 2: The reset store and the two emails

**Files:**
- Modify: `server/db.js`: add the `password_resets` table (spec §11), with a comment in the style of `email_changes`.
- Create: `server/lib/passwordReset.js`.
- Modify: `server/email.js`: the two messages and senders; move `emailLinksWork` here.
- Modify: `server/routes/profile.js`: import `emailLinksWork` from `../email` and delete its local copy along with
  `LOCAL_HOST_RE`. Nothing else in the file changes.
- Test (create): `server/test/password-reset-lib.test.js`.

**Interfaces:**
- Consumes: `users.session_version` (Task 1).
- Produces, from `lib/passwordReset.js`:
  - `RESET_TTL_MS = 60 * 60 * 1000`.
  - `hashToken(token: string) -> string`: SHA-256 as hex.
  - `issueReset(db, userId: number, nowMs: number) -> string`: a new 64-hex token. It upserts `{ user_id, token_hash,
    expires_at: nowMs + RESET_TTL_MS }`, so the newest request replaces the older one.
  - `userForReset(db, token: unknown, nowMs: number) -> object | null`: the `users` row, or `null` when:
    - the token is not `/^[0-9a-f]{64}$/`;
    - it is unknown;
    - `expires_at <= nowMs`;
    - the user has `invite_accepted = 0`.
  - `completeReset(db, token: string, passwordHash: string, nowMs: number) -> object | null`. In one transaction it:
    - checks the token with `userForReset`;
    - sets `password_hash`;
    - adds 1 to `session_version`;
    - deletes the user's `password_resets` row;
    - returns the updated `users` row, or `null` when the token is not valid.
  - `createSendCounter({ max = 3, windowMs = 60 * 60 * 1000 } = {}) -> { take(key: string, nowMs: number): boolean }`. It
    is held in memory. `take` returns `true` and counts when the key has had fewer than `max` takes in the last `windowMs`;
    otherwise it returns `false`.
- Produces, from `email.js`:
  - `passwordResetMessage({ firstName, email, link }) -> { subject, html }`.
  - `passwordChangedMessage({ firstName, email }) -> { subject, html }`.
  - `sendPasswordReset({ to, firstName, link }) -> Promise<boolean>`.
  - `sendPasswordChanged({ to, firstName }) -> Promise<boolean>`.
  - `mailReady(env) -> boolean`: true when `env.EMAIL_USER` and `env.EMAIL_PASS` are both non-empty and
    `emailLinksWork(env)`.
  - `emailLinksWork(env)`: moved from `profile.js` unchanged.

  The senders mirror `sendEmailChange`: `false` when mail isn't set up or the send throws; they log `err.message` only,
  never the link. The button in the reset email reads **Choose a new password**, styled like the existing email buttons.

- [ ] **Step 1: Write the failing tests** in `server/test/password-reset-lib.test.js`:

```js
test("issueReset stores only a hash, and a second request replaces the first", () => {
  // t1 = issueReset(db, uid, NOW); row.token_hash === hashToken(t1) && row.token_hash !== t1
  // t2 = issueReset(db, uid, NOW); userForReset(db, t1, NOW) === null; userForReset(db, t2, NOW).id === uid
});
test("userForReset: expired at exactly 60 minutes, malformed, unknown and unused-invite tokens are null", () => {
  // userForReset(db, t, NOW + RESET_TTL_MS) === null; userForReset(db, t, NOW + RESET_TTL_MS - 1).id === uid
  // "abc", 42, "G".repeat(64), a well-formed unknown token -> null; an invite_accepted = 0 user's token -> null
});
test("completeReset sets the hash, ends sessions, and works once", () => {
  // after: password_hash === "new-hash", session_version === before + 1, no password_resets row; again -> null
});
test("createSendCounter allows 3 an hour per key", () => {
  // three take("a", t) true, fourth false; take("b", t) true; take("a", t + 60*60*1000) true
});
test("the two emails use the approved words, escape names, and carry the link", () => {
  // passwordResetMessage({ firstName: "<b>Lou</b>", email: "lou@x.test", link: L }).subject === "Reset your Broker Radar password"
  // html includes L, "within 60 minutes", "&lt;b&gt;Lou&lt;/b&gt;", "Your password won't change." and not "<b>Lou</b>"
  // passwordChangedMessage(...).subject === "Your Broker Radar password was changed"; html includes "let your broker know"
});
test("mailReady needs both mail settings and, in production, a public APP_URL", () => {
  // {} false; { EMAIL_USER: "a" } false; { EMAIL_USER: "a", EMAIL_PASS: "b" } true
  // production + APP_URL "http://localhost:8080" false; production + "https://x.run.app" true
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd server && node --test test/password-reset-lib.test.js`
Expected: FAIL ("Cannot find module '../lib/passwordReset'").

- [ ] **Step 3: Implement** the table, `lib/passwordReset.js` and the `email.js` additions, and move `emailLinksWork`. The
  HTML bodies carry the spec §7 sentences exactly, with `{first name}` and `{email}` filled and escaped.

- [ ] **Step 4: Run the new file, then the whole server suite.** `profile-api` must still pass after the move.

Run: `cd server && node --test test/password-reset-lib.test.js && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**: `feat(auth): password reset store (hashed, one-time, 60 min) and the two approved emails`

---

### Task 3: The routes

> **Changed during execution (controller rulings R3, R6):** the emailed link is `${APP_URL}/#reset=<token>`, and
> `GET /api/auth/reset/:token` became `POST /api/auth/reset/check { token }` with the same answers, so the token never
> reaches a URL the server logs. `/forgot` answers before any account-dependent work. The text below is the original plan.

**Files:**
- Modify: `server/routes/auth.js`.
- Test (create): `server/test/password-reset-api.test.js`. The test app sets `app.set("trust proxy", true)`, and each test
  sends its own `X-Forwarded-For`, so the module-level IP limiters don't leak between tests. Only the limiter tests reuse
  one address.

**Interfaces:**
- Consumes: everything Tasks 1 and 2 produce.
- **Seams**, each read on every request:
  - `req.app.get("authEnv") || process.env`, for `mailReady`;
  - `req.app.get("sendPasswordReset") || email.sendPasswordReset`;
  - `req.app.get("sendPasswordChanged") || email.sendPasswordChanged`;
  - `req.app.get("resetSendCounter") || moduleCounter`, where `moduleCounter = createSendCounter()`.
- **`POST /api/auth/forgot { email }`**, through `forgotLimiter` (5 an hour per IP; 429
  `{ success: false, error: "Too many reset requests — please try again in an hour" }`):
  1. When `email` is not a string, or once trimmed it is empty, longer than 254 characters or has no `@`: 400
     `{ success: false, error: "Enter a valid email address" }`.
  2. When `!mailReady(env)`: 503 `{ success: false, error: "Password reset isn't available right now. Please try again later." }`.
     Nothing is stored.
  3. Look up the trimmed, lower-cased email with `invite_accepted = 1`. If found and `counter.take(key, Date.now())`, then
     `token = issueReset(...)`.
  4. Answer `res.json({ success: true })` in every case.
  5. Then, when there is a token, call `send({ to: user.email, firstName: user.first_name, link:
     `${email.APP_URL}/?reset=${token}` })`. On a `false` result or a rejection, log `"[auth] reset email not sent"` (plus
     `err.message` on a rejection). Never log the link.
- **`GET /api/auth/reset/:token`**: answers 200 `{ success: true, email }` when `userForReset` finds the user. Otherwise
  410 `{ success: false, error: "This link has expired or was already used." }`.
- **`POST /api/auth/reset { token, password }`**, through `resetLimiter` (10 per 15 minutes per IP; 429
  `{ success: false, error: "Too many attempts — please try again in 15 minutes" }`):
  1. When `password` is not a string or is under 8 characters: 400 "Password must be at least 8 characters", and nothing
     changes.
  2. `completeReset(db, token, bcrypt.hashSync(password, 12), Date.now())`. When it returns `null`: 410 with the same body
     as the GET.
  3. Otherwise `setSession(res, updated)` and answer `{ success: true, user: safeUser(updated) }`.
  4. Then call `sendPasswordChanged({ to, firstName })`, with failures logged as above.

- [ ] **Step 1: Write the failing tests** in `server/test/password-reset-api.test.js`. Each test's fake sender records
  its calls.

```js
test("forgot: one answer for every email (real, made-up, unused invite, over the limit)", async () => {
  // real x4, made-up, invite_accepted=0 -> every body deepStrictEqual { success: true }, status 200
  // the reset sender was called exactly 3 times, all for the real account
});
test("forgot: the answer does not wait for the email", async () => {
  // sendPasswordReset seam returns new Promise(() => {}); the request still answers 200 within 1000 ms
});
test("forgot: the link is APP_URL/?reset=<64 hex>, and the email is matched trimmed and lower-cased", async () => {
  // POST { email: " Lou@Example.com " } -> sender got { to: "lou@example.com", firstName: "Lou" } and
  // link matching /^http:\/\/localhost:8080\/\?reset=[0-9a-f]{64}$/
});
test("forgot: mail not set up is 503 and stores nothing", async () => {
  // authEnv { NODE_ENV: "test", EMAIL_USER: "a" } -> 503 with the exact message; COUNT(*) FROM password_resets === 0
});
test("forgot: a bad email is 400, and the 6th request in an hour from one IP is 429", async () => {});
test("reset: the link works once, not after 60 minutes, not after a newer one; every refusal is the same 410", async () => {
  // GET valid -> { success: true, email }; POST it -> 200; GET and POST again -> 410
  // expired (UPDATE expires_at = 0) -> 410; replaced by a second forgot -> old 410
});
test("reset: a new password signs in here, ends older sessions, and sends the changed notice", async () => {
  // cookie A from login; POST /reset -> 200 + new rr_token B; /me with A -> 401; /me with B -> 200
  // login with the old password -> 401, with the new one -> 200; changed sender called once with { to, firstName }
  // a 7-character password -> 400 and the link still works
});
test("no log line contains the token or the link, even when the send throws", async () => {
  // capture console.log/warn/error; sender throws new Error("smtp down"); the captured text includes
  // "[auth] reset email not sent" and does not include the token taken from the sender's link
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd server && node --test test/password-reset-api.test.js`
Expected: FAIL (404s from the missing routes).

- [ ] **Step 3: Implement** the three routes, the two limiters and the seams as described in Interfaces.

- [ ] **Step 4: Run the file, then the whole server suite**

Run: `cd server && node --test test/password-reset-api.test.js && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**: `feat(auth): forgot-password routes (same answer for every email, one-time link, sessions end)`

---

### Task 4: The screens

**Files:**
- Create: `client/src/auth/reset.mjs` and `client/src/auth/reset.test.mjs`.
- Modify: `client/package.json`: add `src/auth/` to the `test` script's paths.
- Modify: `client/src/App.jsx`:
  - a `goForgot` prop and link on `LoginPage`;
  - new `ForgotPasswordPage` and `ResetPasswordPage` beside `AcceptInvitePage`;
  - the `authView` wiring in `App`;
  - the `#reset=` read in the load effect, before the invite `token` check.

**Interfaces:**
- Produces, from `reset.mjs`:
  - `resetTokenFrom(hash: string) -> string | null`: the `reset` value in a `location.hash` like `#reset=<token>` when it
    is 64 lowercase hex, else `null`. (Ruling R3: the token travels in the URL fragment, which the browser never sends to
    the server, so Cloud Run's request log never records it.)
  - `newPasswordProblem(password: string, confirm: string) -> string | null`. It returns
    `"Password must be at least 8 characters"` first, then `"Passwords don't match"`, else `null`.
  - `forgotSentText(email: string) -> string`. It returns exactly: `If there's a Broker Radar account for ${email}, we've
    sent it a link to choose a new password. The link works for 60 minutes. If it doesn't arrive in a few minutes, check
    your spam folder.`
  - `PASSWORD_CHANGED_NOTICE = "Your password was changed. Any other devices were signed out."`
- **Screen copy** (spec §8):
  - the Sign In link: "Forgot password?";
  - the request page: heading "Reset your password", the sentence "Enter the email you sign in with and we'll send you a
    link.", the "Send reset link" button and the "Back to sign in" link;
  - the new-password page: heading "Choose a new password", the account email under it, fields "New password" and
    "Confirm new password", and the "Save new password" button;
  - an expired link: the 410 message and a "Send a new link" button that opens the request page.
- **Wiring:**
  - `authView` gains `"forgot"` and `"reset"`.
  - A `#reset=` token sets `authView = "reset"` and `authState = "unauthenticated"`, and is removed from the address with
    `history.replaceState`, so the token doesn't stay in the address bar or browser history.
  - `ResetPasswordPage({ token, onDone, goForgot })` checks the token on mount with `POST /api/auth/reset/check { token }`
    (200 `{ success, email }` or 410), and saves with `POST /api/auth/reset { token, password }`.
  - `onDone(user)` runs `handleLogin(user)`, then `setEmailNotice({ text: PASSWORD_CHANGED_NOTICE, bad: false })`. It must
    run in that order, because `handleLogin` clears the notice.
  - `ForgotPasswordPage({ goLogin })` shows `forgotSentText(email)` on 200, and `data.error` in the red box on 400, 429 or
    503.

- [ ] **Step 1: Write the failing tests** in `client/src/auth/reset.test.mjs`:

```js
test("resetTokenFrom reads only a 64-hex reset value from the fragment", () => {
  // "#reset=" + "a".repeat(64) -> that; "#reset=abc", "#token=" + "a".repeat(64), "", "#reset=" + "A".repeat(64),
  // "?reset=" + "a".repeat(64) -> null
});
test("newPasswordProblem: length first, then match", () => {
  // ("short", "short") -> "Password must be at least 8 characters"; ("longenough", "different") -> "Passwords don't match"
  // ("longenough", "longenough") -> null
});
test("the sent text and the changed notice are the approved words", () => {
  // forgotSentText("lou@x.test") === exact string above; PASSWORD_CHANGED_NOTICE exact
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd client && node --test src/auth/`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `reset.mjs`, then the pages and wiring in `App.jsx` using only the existing auth-card pieces.

- [ ] **Step 4: Run the client tests and the build**

Run: `cd client && npm test && npm run build`
Expected: all pass; the build is clean.

- [ ] **Step 5: Commit**: `feat(client): forgot-password and choose-a-new-password pages`

---

### Task 5: Live check (controller, not a subagent)

- On a scratch copy of the local DB, with preview configs pointed at this worktree as in earlier live checks:
  - screenshot the Sign In link and the Reset page;
  - send a request and screenshot the "sent" message. With no local mailbox this shows the 503 message, which is correct;
  - make a reset token for the demo user with a one-off script calling `issueReset`, keeping it in a scratch file and never
    printing it;
  - open `/#reset=<token>`, and screenshot "Choose a new password" and the expired-link view.
- Claude doesn't type passwords. Bill may finish the form himself; Task 3's tests already cover the save.
- Send Bill the screenshots.

### Task 6 (ONLY with Bill's yes): rename the three old emails

Connecting the mailbox also turns on the invite, refi-alert and email-change emails, which still say "RefiRadar".
- In `server/email.js`, the From name, subjects and bodies say "Broker Radar".
- Test: the `email.js` source no longer contains "RefiRadar".
- Commit: `fix(email): the invite, alert and email-change emails say Broker Radar`.

## Go-live (Bill, after merge)

`APP_URL` is ALREADY set on the live service (`https://refi-radar-194747178897.us-central1.run.app`, set 2026-11-03), so it is
not a new step; step 1 only checks that it is still there. Deploy the code and the mailbox in the SAME deploy: until both are
in place the Reset page answers 503 ("isn't available right now"), and the same mailbox turns on the invite, refi-alert and
email-change emails.

Numbered steps go to Bill at deploy time:
1. Check `APP_URL` is still set on the service (look for `APP_URL` in the output; it must be the https address above, not
   localhost):
   `gcloud run services describe refi-radar --region us-central1 --project refi-radar-496318 --format="yaml(spec.template.spec.containers[0].env)"`
2. Create the new Google account for Broker Radar, turn on 2-step verification, and create an app password.
3. In Secret Manager (project `refi-radar-496318`), create `EMAIL_PASS` with the app password, typed by Bill and never
   pasted to Claude. Grant `roles/secretmanager.secretAccessor` on it to
   `194747178897-compute@developer.gserviceaccount.com`, as the other secrets have.
4. Deploy the code and the mailbox together with `--max-instances 1 --update-env-vars EMAIL_USER=<new address> --update-secrets EMAIL_PASS=EMAIL_PASS:latest`.
   Keep `--max-instances 1`: the reset email counters (3 an hour per account, 60 an hour in all) and the rate limiters are
   kept in memory, so a second instance would count separately and double every limit.
5. Live test on Bill's own account: ask for a reset from Sign In, use the link, sign in. Success checks:
   - The Reset page answers "If there's a Broker Radar account for…". If it answers "Password reset isn't available right
     now" (the 503 line), `EMAIL_USER`, `EMAIL_PASS` or `APP_URL` is missing or wrong.
   - In the browser's network tab, the `RateLimit-Remaining` response header on the FIRST `/forgot` reads 4. A lower number
     means the limiter sees a shared proxy address instead of each visitor's own, so everyone would share one 5-an-hour limit.
   - The reset email arrives, and its link opens "Choose a new password" for the right address.
   - After saving, the "Your Broker Radar password was changed" email arrives.
   - A second device (or browser) that was signed in to the same account before the reset is signed out.
