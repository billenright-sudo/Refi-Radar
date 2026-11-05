# Account hardening (sign-up, sign-in, invite links): design

Status: APPROVED by Bill 2026-11-05 ("go, emails approved"), including the wording of both emails in §6. Bill asked for
"the two security fixes" flagged when forgot-password shipped, and chose **email-verified sign-up** over "keep instant sign-up,
add a limit". Everything else below is my call unless it says otherwise.

The live site has sent email since 2026-11-04 (revision 00042, mailbox broker.radar.app@gmail.com), so sign-up through an email
link works as soon as this ships; without a mailbox (local development) sign-up answers 503, as reset does.

## 1. Why

Before Broker Radar is sold to other brokerages, nobody should be able to use the site to find out who has an account, and no
secret that opens an account should sit in a log.

1. **Sign-up reveals accounts.** `POST /api/auth/register` answers 409 "Email already registered" for a taken address.
2. **Sign-in reveals accounts by its speed.** `/login` runs bcrypt only when the account exists, so a wrong password for a real
   account is slower (about a quarter of a second) than any password for a made-up address. The words are already the same.
3. **Invite links put their secret in the address.** The emailed link is `/accept-invite?token=<token>` and the page checks it
   with `GET /api/auth/invite/<token>`. Cloud Run's request log keeps every request's URL, so anyone who can read that log could
   accept a pending invite (valid 48 hours) and own that loan officer's account. The token is also stored as-is in
   `users.invite_token`, so a copy of the database holds live invite secrets.

Sign-up gains a second benefit: today anyone can register using someone else's email address. After this, a broker account
exists only once its owner has opened a link sent to that address.

## 2. Goals

1. Sign-up answers the same way, in the same time, for a new address and a taken one, and creates the account only when the link
   emailed to that address is used.
2. A failed sign-in takes the same time whether or not the account exists.
3. An invite's secret never appears in a URL the server sees, and the database keeps only its SHA-256.
4. Invites already sent keep working.

## 3. Non-goals

- **The invite form (`POST /api/auth/invite`) and the login-email change (`POST /api/profile/email`) still say an address is
  taken.** Both need a signed-in account and are rate-limited (20 and 5 an hour), and the broker needs to know why the invite
  didn't go. Listed in §10.
- **The email-change confirm link** (`GET /api/profile/email/confirm/<token>`) keeps its token in the path. That token is used up
  by the first open, so a copy in the log is already spent.
- Re-sending an invitation, CAPTCHA, two-factor sign-in.

## 4. Must never happen

- The sign-up page, its timing or its errors reveal whether an address has an account or an invitation.
- An account is created for an address whose owner never opened the emailed link.
- A sign-up or invite secret appears in a URL sent to the server, or in any log. The database holds only hashes of them.
- A typed password is stored anywhere but as a bcrypt hash.
- Any email goes out other than the two in §6 and the existing invite email (whose link alone changes).

## 5. How it works

### 5.1 Sign-in timing

When `/login` finds no account that can sign in (no row, an unused invite, or no password), it still runs one
`bcrypt.compareSync` against a fixed dummy hash of the same cost (12), computed once when the module loads, then gives the same
401 as today. Every failed sign-in therefore costs one bcrypt check.

### 5.2 Asking to sign up: `POST /api/auth/register { firstName, lastName, email, password, orgName }`

- **Checked before anything else** (400, as today's wording where it exists):
  - all five fields present ("All fields required");
  - password 8 to 256 characters (the reset rule);
  - email trimmed, at most 254 characters, contains "@", no comma, semicolon or whitespace ("Enter a valid email address", the
    invite form's rule);
  - first name, last name and brokerage name each at most 100 characters after trimming ("Names and the brokerage name can be
    at most 100 characters"). They come from an anonymous visitor and go into email A, so they are capped here and HTML-escaped
    in the email body; both subjects are fixed text with nothing typed in them.
- The email is matched trimmed and lower-cased, as sign-in, `/forgot` and the invite form already store and match it.
- **Mail not set up** (`mailReady` false): 503 "Sign-up isn't available right now. Please try again later." Same for every address.
- **Answer:** `200 { success: true }` for every request that passes those checks, sent *before* anything that depends on the
  address: the lookup, the password hash, storing the request and the email all happen after it (the `/forgot` pattern:
  `setImmediate` and one try/catch that logs only an error message, never a link or token).
- **After the answer:**
  - expired rows in `signup_requests` are deleted;
  - **the address already has a user** (any `users` row, an unused invite included): send email B (§6) to it, addressed with the
    first name *stored on that account*, never the name typed into the form;
  - **otherwise:** hash the password (bcrypt, cost 12), store the request (5.4) and send email A with the link
    `${APP_URL}/#signup=<token>` (the token after the `#`, like reset links, so it never reaches the server).
- **Limits:**
  - 5 requests an hour per IP (429 "Too many sign-up attempts — please try again in an hour");
  - at most 3 emails an hour to one address, counting reset, A and B together (one per-address counter shared with `/forgot`);
    extra requests still answer 200 and send nothing;
  - the site-wide cap of 60 emails an hour is **shared by reset and sign-up emails** (one counter), so between them they can't
    use up the mailbox's daily quota. The per-address count is asked first, as in `/forgot`;
  - sign-up asks the per-address counter about addresses that have no account, so the counter must not grow without end: it
    drops an address once its last send is over an hour old (a sweep inside `take`, or when the map passes a size). Both
    counters stay in memory: the service runs one instance.
- **Page:** the Register page shows a "Check your email" card instead of signing in: "We've sent a link to {email}. Open it within
  24 hours to finish creating your account. If it doesn't arrive in a few minutes, check your spam folder." A 400, 429 or 503
  shows in the existing red box.

### 5.3 Finishing sign-up

- The page reads `#signup=<token>` from the address, takes it out of the address bar (as `#reset=` is), and calls
  **`POST /api/auth/register/check { token }`**:
  - 200 `{ email, orgName }` for a well-formed, unexpired request whose address still has no user;
  - otherwise 410 "This link has expired or was already used."
- The page, **"Finish creating your account"**, shows the email and brokerage name and one button, **Create my account**. Opening
  the link does not create the account: mail scanners open links first.
- **`POST /api/auth/register/complete { token }`**, in one transaction:
  - the request must still be valid and the address must still have no user (else 410, the same message);
  - create the organization (14-day trial starting now) and the broker user (`invite_accepted = 1`, the stored password hash);
  - delete the request.
  Then it sets the session cookie and returns the user, as sign-in does, and the page lands on Home. Limit: 10 tries per
  15 minutes per IP (the reset limit).
- After a 410 the page offers **Start again**, which opens the Register page.

### 5.4 Data: `signup_requests` (new)

```
CREATE TABLE IF NOT EXISTS signup_requests (
  email         TEXT    PRIMARY KEY,          -- lower-cased
  token_hash    TEXT    NOT NULL UNIQUE,      -- SHA-256 of the token
  first_name    TEXT    NOT NULL,
  last_name     TEXT    NOT NULL,
  org_name      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,             -- bcrypt, cost 12
  expires_at    INTEGER NOT NULL              -- epoch ms, now + 24 hours
);
```

One row per address: a new request replaces the old row, so the older link stops working. Names and the brokerage are trimmed
before they are stored.

### 5.5 Invite links

- The invite email's link becomes `${APP_URL}/#invite=<token>`. Its wording is unchanged.
- `GET /api/auth/invite/:token` is removed and replaced by **`POST /api/auth/invite/check { token }`**, which answers 200
  `{ firstName, lastName, email, orgName }` or 410 "This invitation has expired or was already used." for anything else
  (malformed, unknown, expired, used: one answer).
- `POST /api/auth/accept-invite` gives that same 410 for a bad token (today it is 404 or 410 with different words), checks the
  token before the bcrypt hash (it already does), and gains the reset limit: 10 tries per 15 minutes per IP.
- **Stored as a hash:** new column `users.invite_token_hash`. New invites store only the SHA-256 there and leave `invite_token`
  NULL. A one-time step when the server starts moves any pending invite across: `invite_token_hash = sha256(invite_token)`,
  `invite_token = NULL`, for rows that still have an `invite_token`. Lookups use `invite_token_hash`, so links already sent keep
  working.
- **The page** reads `#invite=<token>`, and for links already sent also `?token=<token>`; it takes either out of the address bar
  and checks it with the POST. The old `?token=` form is read only so that pending invites still open; invites live 48 hours and
  mail only started going out on 2026-11-04, so reading `?token=` can be removed in any release after that.
- **Rolling back** to a revision from before this change would break invites that are pending at the time (the old code looks
  them up by `invite_token`, which the start-up step empties). Accepted: the live site has a handful of accounts, and keeping
  the plain token for a release would break goal 3.

### 5.6 The order the app reads a link

`#signup=`, then `#reset=`, then `#invite=`, then `?token=`, then the normal session check. Someone already signed in who opens
a sign-up or invite link gets that page, and finishing it signs them in as the new account (as reset links already do).

## 6. The two new emails (Bill to approve the wording)

Both come from `"Broker Radar" <EMAIL_USER>` in the same plain style as the reset emails. Nothing in them is tracked.

**A. New sign-up.** Subject: **Finish creating your Broker Radar account**

> Hi {first name},
>
> Thanks for starting a Broker Radar trial for {brokerage}. To finish creating your account ({email}), use this button within
> 24 hours:
>
> **[Create my account]**
>
> If you didn't ask for this, you can ignore this email. No account will be created.

**B. The address already has an account.** Subject: **You already have a Broker Radar account**

> Hi {first name on the account},
>
> Someone just tried to create a new Broker Radar account with your email ({email}), but there's already an account or an
> invitation for this address.
>
> If this was you, sign in instead. If you've forgotten your password, use "Forgot password?" on the sign-in page. If your broker
> invited you, use the link in that invitation.
>
> **[Go to sign in]**
>
> If it wasn't you, you can ignore this email. Nothing has changed.

## 7. Screens

The approved layout stays as it is; these use the existing sign-in card (`AuthCard`, amber links, the red error box).

- **Register:** the same form. After sending, the card shows "Check your email" and the line from 5.2, with **Back to sign in**.
- **Finish creating your account:** heading, the email and brokerage name, **Create my account**. Expired: the 410 line and
  **Start again**.
- **Accept invite:** unchanged, except that an expired or used link shows "This invitation has expired or was already used."

## 8. Tests that have to change

Four test files create accounts through `/api/auth/register` (sessions, auth, sweeps-api, coaching). They move to a shared test
helper that creates a signed-in broker through the new flow with a fake mailer (or directly in the database where the flow isn't
the subject). Seams follow the existing pattern: `app.set("sendSignup")`, `app.set("sendAlreadyRegistered")`. The existing seam
names `resetSendCounter` and `resetSiteSendCounter` stay (no rename churn in the reset tests) and now cover sign-up emails too.

The only other caller of `/api/auth/register` is `scripts/seed-demo.js`, which registers the demo broker and logs in on a 409.
It changes to: log in first; if that fails, print that the demo account must first be created through sign-up, and stop.

## 9. Review focus

- Same answer and same speed for a new address, a taken address, an unused invite, and an address over its hourly limit.
- A sign-up link used twice, used after 24 hours, used after a newer request, or used after the address got an account another
  way (an invite): all refused, and no second organization is created.
- No log line holds a sign-up or invite token or link; send failures included.
- A pending invite created before the change still opens and can be accepted after the start-up step runs, and the step is safe
  to run twice.
- Sign-in with no account, with an unused invite, and with a wrong password all take one bcrypt check.

## 10. Left open (not in this build)

- The invite form and the login-email change still say when an address is taken (signed-in, rate-limited).
- **No way to re-send an invitation.** A pending invite blocks inviting that address again, and after 48 hours the invite is dead,
  so that loan officer can't be invited at all. Now that invites really send, this is the next small fix.
- Change password on Profile; tell the old address when the login email changes.
