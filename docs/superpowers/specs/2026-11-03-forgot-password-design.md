# Forgot password: design

Status: DRAFT for Bill (2026-11-03). Bill asked for the design without the question round ("just draft the design"), so
every decision below is my call unless it says otherwise. The two items in §9 are his.

## 1. Why

A broker or loan officer who forgets their password has no way back in today. There is no reset, no change-password screen
and no support desk. Somebody would have to edit the database by hand. Bill flagged this as a gap to close before selling
Broker Radar to other brokerages.

## 2. What exists today

- **Sign-in** (routes/auth.js): email + password (bcrypt), a 7-day session cookie `rr_token` (a JWT holding only `userId`),
  10 tries per 15 minutes per IP. A session can't be ended early: the server keeps no list of sessions.
- **Passwords:** set at registration or when accepting an invite, at least 8 characters. Nothing changes them afterwards.
- **Email** (server/email.js): nodemailer through Gmail, from the mailbox in `EMAIL_USER` with an app password in
  `EMAIL_PASS`. **Neither is set on the live service.** So the live site sends no email at all:
  - invites quietly skip the email while the screen still says "Invitation sent";
  - the login-email change answers "mail not set up" (503).
- **Emailed links** land on the app as `/?…` and the app reads the query: `?token=` (invite), `?emailChanged=`.

## 3. Goals

1. A **"Forgot password?"** link on the Sign In page opens a "Reset your password" page with one email field.
2. Submitting it always shows the same message, whether or not the email has an account.
3. If it does, that address gets an email with a **one-time link**:
   - it works for **60 minutes**;
   - it works **once**;
   - asking again replaces the old link, which stops working.
4. The link opens a **"Choose a new password"** page: new password and confirm, at least 8 characters (the rule
   registration uses).
5. Saving it:
   - changes the password;
   - **signs out every other device** that was signed in to that account;
   - signs the person in on this device and lands them on Home, with a one-time note: "Your password was changed. Any other
     devices were signed out."
6. A second email goes to the account to say the password was changed. It covers a reset the owner didn't make.

## 4. Non-goals

- **Change password while signed in** (on Profile). Small, and the natural next step; not in this build.
- **A broker resetting a loan officer's password.** A loan officer's account can hold their connected Google calendar and
  Gmail (Charlie), so a broker who could set an LO's password could act as that LO. Every reset goes to the account's own
  inbox.
- SMS, two-factor sign-in, account lockout, Google sign-in.
- **Renaming the old emails.** The invite, refi-alert and email-change emails still say "RefiRadar". These two new ones say
  "Broker Radar". Renaming the old three is a separate small fix (§10).

## 5. Must never happen

- The reset page reveals whether an email has an account, by its words, its timing or its errors.
- A reset link, or the secret in it, appears in a log. The database holds only a hash of it.
- An old link works after it was used, expired or replaced.
- A session from before the reset keeps working afterwards.
- Any email goes out other than the two in §7.

## 6. How it works

### 6.1 Asking for a link: `POST /api/auth/forgot { email }`

- The email is matched trimmed and lower-cased against `users.email`.
- Only accounts that can sign in count: `invite_accepted = 1`. Someone with an unused invite is treated as having no
  account; they should use their invite link.
- **Answer:** `200 { success: true }` in every case, sent *before* any email work starts, so a real account answers no slower
  than a made-up one. The email goes out after the answer. A send failure is logged without the link and not reported to the
  page.
- **Limits:**
  - 5 requests an hour per IP (429 with a plain message);
  - for one account, at most 3 emails an hour. Extra requests still answer 200 but send nothing, so nobody can flood an inbox.
- **Mail not set up:** if `EMAIL_USER`/`EMAIL_PASS` are unset, or in production `APP_URL` is unset or local, the answer is
  503: "Password reset isn't available right now. Please try again later." This is the same for every email, so it reveals
  nothing.
- **The link:** `${APP_URL}/?reset=<token>`.
  - The token is 32 random bytes as 64 hex characters.
  - Stored as its SHA-256 in `password_resets`, one row per user. A new request replaces the row.

### 6.2 Opening the link: `GET /api/auth/reset/:token`

- A well-formed, unexpired token answers `200 { email }`, and the page shows "Choose a new password for <email>".
- Anything else answers 410: "This link has expired or was already used." The page then offers **"Send a new link"**, which
  goes to the Reset page with the email filled in when it is known.
- Opening the link does not use it up: email scanners often open links before the person does.

### 6.3 Saving the new password: `POST /api/auth/reset { token, password }`

- The token must be valid as in 6.2. The password must be at least 8 characters; the page also checks that "confirm"
  matches.
- **In one transaction:**
  - the new bcrypt hash is stored (cost 12, as today);
  - `users.session_version` goes up by one;
  - the `password_resets` row is deleted.
- The answer sets a fresh session cookie and returns the user, as sign-in does. The "password changed" email goes out after
  the answer.
- **Limit:** 10 tries per 15 minutes per IP, like sign-in.

### 6.4 Ending old sessions

- The session token gains a version: `{ userId, sv }`.
- `requireAuth` already reads the user row on every request. It now also reads `session_version` and rejects a token whose
  `sv` differs. A token from before this change has no `sv` and counts as 0, the column's starting value, so nobody is
  signed out by the deploy itself.
- Sign-in, registration and invite acceptance write the current version into the tokens they make.
- A Google connection belongs to the account, not to a session, so a reset leaves it connected.

## 7. The two emails (Bill to approve the wording)

Both come from `"Broker Radar" <EMAIL_USER>` in the same simple style as the existing emails. Nothing in them is tracked.

**Reset link.** Subject: **Reset your Broker Radar password**

> Hi {first name},
>
> Someone asked to reset the password for your Broker Radar account ({email}). To choose a new password, use this button
> within 60 minutes:
>
> **[Choose a new password]**
>
> If you didn't ask for this, you can ignore this email. Your password won't change.

**Changed notice.** Subject: **Your Broker Radar password was changed**

> Hi {first name},
>
> The password for your Broker Radar account ({email}) was just changed, and any other devices signed in to it were signed
> out.
>
> If you did this, there's nothing else to do. If you didn't, reset your password from the Broker Radar sign-in page right
> away and let your broker know.

## 8. Screens

The approved layout stays as it is. These are additions in the existing sign-in card style (`AuthCard`, amber links), with
no restyling.

- **Sign In:** a small amber "Forgot password?" link under the password field.
- **Reset your password:** heading, one sentence ("Enter the email you sign in with and we'll send you a link."), the email
  field, a **Send reset link** button and **Back to sign in**. After sending, the card shows:
  "If there's a Broker Radar account for {email}, we've sent it a link to choose a new password. The link works for 60
  minutes. If it doesn't arrive in a few minutes, check your spam folder."
- **Choose a new password:** opened by the emailed link. Heading, the account's email, New password and Confirm new
  password, and a **Save new password** button. Errors show inline in the existing red box: too short, don't match, link
  expired.
- **Home after a reset:** the one-time note from §3.5, shown the same way as today's email-changed note.

## 9. Bill's part

1. **Which mailbox sends.** My pick is a dedicated Google account for Broker Radar, not your own address, so you stay out of
   it and its limits are its own. Gmail allows about 500 emails a day, plenty for now. That account needs two-step
   verification and an app password. I'll give you numbered steps to:
   - put `EMAIL_USER` and `EMAIL_PASS` in Secret Manager and attach them to the service;
   - never paste the password to me.
   This also starts the invite emails working.
2. **Approve the two emails in §7**, or tell me what to change.
3. After the deploy, **one live test on your own account**: request a reset, use the link, sign in.

## 10. Review focus

- The same answer and the same speed for a real account, a made-up email, an unused invite, and an account over its hourly
  limit.
- A link used twice, used after 60 minutes, or used after a newer link was sent: all are refused.
- After a reset, a session cookie from before it gets 401 on the next request; the new one works.
- No log line contains the token or the link (send failures included).
- Mail not set up: 503 and nothing is stored.
- Email case and spaces: " Lou@Example.com " finds lou@example.com.

## 11. Data changes (additive)

- `CREATE TABLE IF NOT EXISTS password_resets (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL)`. `expires_at` is epoch milliseconds, as in `email_changes`.
- The 3-an-hour count per account is kept in memory, keyed by the lower-cased email. The service runs one instance
  (`--max-instances 1`), and a restart resetting the count is harmless.
- `ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0`.

## 12. Follow-ups this unlocks (not in this build)

- Change password on Profile.
- The open email-change item: tell the *old* address when the login email changes.
- Rename "RefiRadar" to "Broker Radar" in the invite, refi-alert and email-change emails.
- The invite screen says "Invitation sent" even when no email went out; it should say so when mail isn't set up.
