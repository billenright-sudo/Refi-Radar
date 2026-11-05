# Subscription Billing and Terms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brokerages pay $99 a month (broker included) plus $49 for each additional user through Stripe: a card at sign-up, the
first charge on day 15, testers get a free month by a limited code, everyone agrees to versioned Terms and Privacy Policy, the app
locks (never deletes, always lets the broker export) when billing lapses, and testers can send feedback.

**Architecture:** Pure rules in `server/lib/billing/` over new columns on `organizations` and new tables. Stripe is reached only
through one gateway object (`app.set("billingGateway")` in tests) and a signed webhook mounted before the JSON parser. A route gate
(`requireAccess`) returns 402 for gated routers. The client asks `GET /api/billing/status` after sign-in and shows a gate page, a
banner or the app. **Everything switches on with billing:** with no Stripe settings (or a Stripe price that doesn't match) the app
behaves exactly as today.

**Tech Stack:** Node 20, Express 4, better-sqlite3, the `stripe` npm package (new, exact version), nodemailer (existing), React 18 +
Vite, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-05-subscription-billing-design.md` (APPROVED and REVISED 2026-11-05; H1–H14 refer to it).

## Global Constraints

- Node 20 only: prefix commands with `export PATH="/c/Users/bille/dev/node20:$PATH" &&`. Server `cd server && npm test`
  (baseline 1266 pass); client `cd client && npm test && npm run build` (baseline 232 pass).
- One new dependency: `stripe`, installed with `--save-exact` at the newest version published at least 14 days before install
  (check `npm view stripe time`). No other new dependency.
- Settings: billing is **on** only when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID` are all set **and** the
  start-up price check passes (H5). Optional: `BILLING_TESTER_CODE`, `BILLING_TESTER_MAX_USES` (default 25),
  `BILLING_TESTER_EXPIRES` (YYYY-MM-DD, end of that day UTC), `BILLING_EXEMPT_EMAILS` (comma list), `FEEDBACK_TO`. Off = today's
  behaviour everywhere (no price line, terms tick, tester field, gate or billing page; tester code ignored).
- No test, and no code outside the gateway, talks to Stripe. Tests inject `app.set("billingConfig", ...)`,
  `app.set("billingGateway", fake)` and the existing mail seams. Webhook signatures in tests: the real `stripe` package's
  `webhooks.generateTestHeaderString` (offline).
- Never store or log card details, Stripe secret keys, webhook secrets or whole Stripe objects; log the event type and
  `err?.message` only.
- Values: `BASE_CENTS = 9900`, `ADDITIONAL_CENTS = 4900`, `monthlyTotalCents(users) = 9900 + 4900 × (users − 1)`,
  `TRIAL_DAYS = 14`, `TESTER_DAYS = 30`, `TESTER_WARN_DAYS = 7`, `STALE_MS = 24 h`, `TERMS_VERSION = PRIVACY_VERSION = "2026-11-05"`.
  A user (a seat) = a row with `invite_accepted = 1` and `removed_at IS NULL`. The Stripe price must be monthly, `usd`, graduated
  tiers `[{ up_to: 1, unit_amount: 9900 }, { up_to: "inf", unit_amount: 4900 }]`.
- Loan officers never receive prices or billing details from any endpoint.
- Emails our code may send: the billing confirmation (Task 2) and feedback to `FEEDBACK_TO` (Task 9). Nothing else.
- Spec copy (verbatim): "I agree to the Terms of Service and Privacy Policy" · "14 days free, then $99 a month, plus $49 for each
  additional user. Cancel anytime." · "Start your free trial" · "$0 today. Your 14-day free trial starts now. From day 15 we'll
  charge $99 a month, plus $49 for each additional user, until you cancel. Cancel any time in Billing." · "Add card and start trial"
  · "Your free test month starts now — no card needed. We'll ask for a card before it ends." · "Start testing" · "Your free test
  month ends on {date}. Add a card to keep going." · "Add card" · "Your last payment didn't go through. Update your card to keep
  Broker Radar running." · "Update card" · "Your brokerage's subscription needs attention. Please contact your broker." · "$99 a
  month, plus $49 for each additional user, starting today, until you cancel." · "We've updated our terms" · "I agree" · "Manage
  billing" · "Download my clients (CSV)" · "That tester code isn't valid." · "Thanks — Bill's team will read this." ·
  "Brokerage $99 + {n} additional users × $49 = ${total} a month" / "Brokerage $99 a month".
- All wording is **draft until Bill approves it** (spec §10); the final report lists it again.
- The approved layout stays: reuse `AuthCard`, `AuthField`, `btnPrimary`, the red error box, amber text buttons, `card`, `C.*`,
  `NoticeBanner`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Back from Stripe before the webhook arrives**: the broker lands on Home, not the card page again (Task 3 test).
2. **Two tabs, two card pages, both finished (H1)**: one subscription survives, the other is cancelled and refunded (Tasks 2–3).
3. **Webhooks repeated, out of order, or missed for a day (H4)**: applied once, older ignored, stale state re-read (Tasks 2–3).
4. **Billing off or a mismatched price (H5)**: everything works as today and nothing returns 402 (Tasks 3–4).
5. **A removed loan officer with a live phone session and a running ARIVE feed (H3)**: both refused at once (Task 5).

---

### Task 1: Billing rules and data

**Files:** Create `server/lib/billing/config.js`, `access.js`, `plan.js`, `seats.js`; modify `server/db.js`; test
`server/test/billing-rules.test.js`.

**Interfaces (Produces):**
- `billingConfig(env) -> { stripeConfigured, secretKey, webhookSecret, priceId, testerCode, testerMaxUses, testerExpiresMs, exemptEmails, feedbackTo }`
  (`testerCode` trimmed lower-case or null; `testerMaxUses` integer ≥ 0, default 25; `testerExpiresMs` end of the given UTC day or
  null; `exemptEmails` trimmed lower-case, empties dropped; `feedbackTo` trimmed or null). `enabled` is NOT here: the app sets
  `config.enabled = stripeConfigured && priceOk` at start (Task 3). Exports the value constants and `monthlyTotalCents(users)`.
- `orgBilling(db, orgId)`; `accessFor({ config, org, termsOk, nowMs }) -> { ok: true } | { ok: false, reason: "terms" | "needs_card" | "ended" }`
  (off → ok; `!termsOk` → terms; exempt → ok; `billing_tester_until > nowMs` → ok; `trialing|active|past_due` → ok;
  `canceled|unpaid|incomplete_expired|paused` → ended; else needs_card).
- `bannerFor(org, nowMs) -> null | "tester_ending" | "past_due"` (tester_ending: tester month within 7 days of its end and
  `billing_has_card = 0`).
- `checkoutPlan(org, nowMs) -> { trial: "days", days: 14 } | { trial: "until", endMs } | { trial: "none" }` (tester month running →
  `until`, `endMs = max(tester_until, nowMs + 49 h)`; never subscribed → 14 days; else none).
- `seatCount(db, orgId)`; `testerCodeUsable(db, config, code, nowMs) -> boolean` (code set, matches trimmed/case-insensitive, not
  past `testerExpiresMs`, and fewer than `testerMaxUses` organizations with `billing_via_tester_code = 1`).
- `db.js` adds to `organizations`: `stripe_customer_id`, `stripe_subscription_id`, `stripe_item_id`, `billing_status` (TEXT, NULL =
  existed before billing), `billing_quantity`, `billing_trial_end`, `billing_period_end`, `billing_cancel_at_period_end` (0),
  `billing_exempt` (0), `billing_tester_until`, `billing_via_tester_code` (0), `billing_ever_subscribed` (0), `billing_has_card` (0),
  `billing_event_at`, `billing_synced_at`, `billing_pending_checkout` TEXT, `billing_confirmation_sent` (0) — times epoch ms; to
  `users`: `removed_at`, `removed_email`; to `signup_requests`: `tester` (0), `terms_version`, `privacy_version`; tables
  `stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL)`,
  `terms_acceptances (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, document TEXT NOT NULL CHECK(document IN ('terms','privacy')), version TEXT NOT NULL, accepted_at INTEGER NOT NULL, ip TEXT)`,
  `feedback (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, org_id INTEGER NOT NULL, page TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)`.

- [ ] **Step 1: Write the failing tests** (throwaway DB as in `server/test/signup-lib.test.js`; `NOW = 1_800_000_000_000`)

```js
test("billingConfig: Stripe configured only with all three; tester limits, exempt list and feedback address normalised", () => {
  // {} -> stripeConfigured false, testerMaxUses 25, testerExpiresMs null, exemptEmails [], feedbackTo null
  // BILLING_TESTER_MAX_USES "5" -> 5; "abc" -> 25; BILLING_TESTER_EXPIRES "2026-12-31" -> Date.UTC(2026, 11, 31, 23, 59, 59, 999)
});
test("monthlyTotalCents: 1 -> 9900, 3 -> 19700, 5 -> 29500, 10 -> 54000", () => {});
test("accessFor: off ok; terms first; exempt, tester month, live statuses; ended vs needs_card", () => {});
test("bannerFor: past_due; tester_ending only in the last 7 days and only without a card", () => {});
test("checkoutPlan: first time 14 days; tester month -> until (at least 49 h away); after any subscription -> none", () => {});
test("seatCount: accepted, not removed, this organization only", () => {});
test("testerCodeUsable: right code any case; wrong, unset, expired, or at the use limit -> false", () => {});
test("the migration adds every column and table, idempotently, to a database that predates them", () => {
  // the subprocess pattern of coaching.test.js "users.career_stage ... idempotently"
});
```

- [ ] **Step 2:** run `node --test test/billing-rules.test.js` → FAIL (`Cannot find module`).
- [ ] **Step 3:** implement (the existing `PRAGMA table_info` migration pattern, one "why" comment per block).
- [ ] **Step 4:** run the file, then `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(billing): billing rules ($99 + $49), tester limits and the billing columns`

---

### Task 2: Stripe gateway, the signed webhook, follow-ups and the confirmation email

**Files:** Create `server/lib/billing/stripeGateway.js`, `server/lib/billing/events.js`, `server/lib/billing/followUps.js`,
`server/routes/billingWebhook.js`; modify `server/index.js` (mount before `express.json`, next to `/api/integrations`),
`server/package.json`, `server/email.js` (`billingConfirmationMessage`, `sendBillingConfirmation` on `deliverPasswordMail` — the
From-line count test stays 4); test `server/test/billing-webhook.test.js`.

**Interfaces:**
- `createStripeGateway({ secretKey }) -> gateway`:
  `retrievePrice(id) -> { currency, interval, tiersMode, tiers: [{ upTo, unitAmount }] }` ·
  `createCheckout({ customerId, email, orgId, priceId, quantity, plan, successUrl, cancelUrl }) -> { id, url }` (`mode:
  "subscription"`, `payment_method_collection: "always"`, `consent_collection.terms_of_service: "required"`,
  `allow_promotion_codes: false`, `client_reference_id` + `subscription_data.metadata.org_id`, trial from `plan`) ·
  `retrieveCheckout(id) -> { status, url, customerId, subscriptionId }` · `retrieveSubscription(id)` ·
  `createPortal({ customerId, returnUrl, updateCard }) -> { url }` ·
  `createTesterSubscription({ email, orgId, orgName, priceId, quantity, trialEndMs }) -> { customerId, subscriptionId, itemId, status, trialEndMs }`
  (no card, `trial_settings.end_behavior.missing_payment_method: "cancel"`, `metadata.org_id`) ·
  `setQuantity({ subscriptionId, itemId, quantity })` (`proration_behavior: "create_prorations"`) ·
  `cancelAndRefund(subscriptionId)` (cancel now; refund the latest paid invoice's payment if any) ·
  `updateCustomerEmail(customerId, email)` · `constructEvent(rawBody, signature, secret)` (throws when bad).
- `applyStripeEvent(db, event) -> { outcome: "applied" | "duplicate" | "ignored", followUps: FollowUp[] }` and
  `storeSubscription(db, orgId, subscription, eventCreatedMs) -> FollowUp[]`. Handles `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `customer.updated` (columns as named in Task 1; `billing_synced_at = now`).
  Org by `metadata.org_id`, else stored customer/subscription id. Older than `billing_event_at` → ignored. Invoice events → ignored.
  FollowUps: `{ type: "cancel_duplicate", subscriptionId }` when a live subscription arrives for an org that already has a different
  live one (H1); `{ type: "sync_seats", orgId }` when Stripe's quantity differs from `seatCount` (H2); `{ type: "confirm", orgId }`
  when the org's first subscription starts and `billing_confirmation_sent = 0` (H6).
- `runFollowUps({ db, gateway, send, config }, followUps) -> Promise<void>` (each failure logged by message only; `confirm` sets
  `billing_confirmation_sent = 1` only after a true send). `syncSeats` lives in `seats.js` (Task 3 uses it too).
- `billingConfirmationMessage({ firstName, orgName, kind: "trial" | "tester", endDate, totalLine }) -> { subject, html }` — draft
  wording for Bill: subject "Your Broker Radar trial has started" / "Your Broker Radar test month has started"; body: "Hi {first
  name}," · "{orgName}'s free {trial|test month} runs until {endDate}." · trial: "After that, Broker Radar is $99 a month, plus $49
  for each additional user, charged to the card you added until you cancel." / tester: "Before it ends we'll ask you for a card;
  without one, Broker Radar pauses and your data is kept." · "You can cancel any time in Broker Radar under Billing → Manage
  billing." — every value escaped.
- `POST /api/billing/webhook`: `express.raw({ type: "application/json", limit: "1mb" })`; billing off → 404; bad signature → 400
  `{ success: false }`; else 200 `{ received: true }`, then `runFollowUps` after the answer.

- [ ] **Step 1: Write the failing tests** (an app mounting only the webhook route; `billingConfig` seam on; a fake gateway that
  records calls; signed bodies)

```js
test("a bad or missing signature is 400 and changes nothing; billing off is 404", async () => {});
test("checkout completed stores customer, subscription and has_card; subscription events store status, dates, item, quantity", async () => {});
test("the same event twice applies once; an older event after a newer one is ignored", async () => {});
test("a second live subscription for one org is cancelled and refunded through the gateway (H1)", async () => {});
test("a quantity that differs from the user count is pushed back (H2)", async () => {});
test("the first subscription sends one confirmation email with the end date and price; never twice; a failed send retries next event (H6)", async () => {});
test("cancel during the trial: allowed until the deleted event, then ended, and no second trial", async () => {});
test("no log line holds a secret or a whole Stripe object", async (t) => {});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** `npm install --save-exact stripe@<version per Global Constraints>`; implement.
- [ ] **Step 4:** run the file, then `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(billing): Stripe gateway, signed webhook, duplicate and quantity guards, confirmation email`

---

### Task 3: Billing API, the gate, price check, stale repair, export and start-up

**Files:** Create `server/routes/billing.js`, `server/middleware/access.js`, `server/lib/billing/startup.js`,
`server/lib/terms.js` (only `TERMS_VERSION`, `PRIVACY_VERSION`, `termsCurrent(db, userId)`; Task 4 adds the rest),
`docs/billing-setup.md`; modify `server/index.js`, the gated routers (`clients.js`, `org.js`, `notifications.js`, `import.js`,
`sweeps.js`, `assistant.js`, `voice.js`, `google.js`: `requireAccess` right after `requireAuth`), `auth.js` (`/invite` gated;
`/accept-invite` runs `syncSeats` after the answer), `org.js` `/stats` (with billing on, `plan` and `trialEnds` come from the
billing state, H12), `README.md` (settings); test `server/test/billing-api.test.js`.

**Interfaces:**
- `requireAccess` → 402 `{ success: false, error: "Broker Radar needs attention before you can continue.", reason }`.
- `syncSeats(db, gateway, orgId)`: when the org has subscription + item and `seatCount ≠ billing_quantity`, `setQuantity` then store.
- `verifyPrice(gateway, priceId) -> { ok: true } | { ok: false, reason }` (monthly, usd, graduated, tiers 9900 then 4900).
- `applyBillingStartup(db, config, nowMs)`: on → orgs with `billing_status IS NULL` get a 30-day tester month (not
  `billing_via_tester_code`) and `billing_status = 'none'`; `billing_exempt` = broker email in `exemptEmails`. Off → nothing.
- `index.js` at start: config from env; when Stripe is configured, build the gateway, `verifyPrice` (a failure or mismatch logs
  "[billing] off: <reason>" and leaves billing off), then `applyBillingStartup`; puts config and gateway on the app.
- Routes:
  - `GET /api/billing/public` (no sign-in) → `{ enabled }`.
  - `GET /api/billing/status` (signed in) → `{ success, access, role, billing }`; `billing` null for a loan officer, else
    `{ enabled, status, users, baseCents: 9900, additionalCents: 4900, monthlyTotalCents, trialEnd, testerUntil, periodEnd, cancelAtPeriodEnd, exempt, hasCustomer, banner }`.
    Before answering: a pending Checkout → `retrieveCheckout` (+ subscription) sync; a subscription with `billing_synced_at` older
    than 24 h → `retrieveSubscription` sync (H4); then `syncSeats` if needed. Sync failures don't fail the request.
  - `POST /api/billing/card` (broker) → `{ url }`: live subscription → portal `updateCard`; a still-open pending Checkout → its
    `url` (H1); else a new Checkout (`checkoutPlan`, quantity `seatCount`), stored as pending. URLs `${APP_URL}/?billing=done|cancelled`.
  - `POST /api/billing/portal` (broker, has customer) → `{ url }`.
  - `GET /api/billing/export.csv` (broker, open even when locked, H11) → the organization's clients as CSV with the client-list
    columns, `Content-Disposition: attachment; filename="broker-radar-clients.csv"`; cells starting with `= + - @` prefixed with `'`.
  - Loan officer on card/portal/export → 403; billing off → 404 on all but `public` and `export.csv`; gateway failure → 502
    `{ success: false, error: "Couldn't reach the payment service. Please try again." }`.
- `docs/billing-setup.md`, Bill's numbered checklist with a success check per step: Stripe account in test mode; product "Broker
  Radar" with ONE monthly graduated price (first unit $99, then $49); webhook `<APP_URL>/api/billing/webhook` with the five event
  types; customer portal = update card, invoices, cancel at period end — **quantity changes, plan switching and promotion codes
  OFF**; Subscriptions settings = retries up to 14 days then cancel, trial reminder 7 days before; Checkout terms URL
  `<APP_URL>/terms`; the secrets via Secret Manager (clipboard method); `--update-env-vars` for the other settings; **one full
  test-mode run** (sign up, card 4242…, tester code, cancel, a failed card with 4000 0000 0000 0341) before live keys.

- [ ] **Step 1: Write the failing tests** (app with auth, billing, clients, org routers; config seam on; fake gateway; `addBroker`)

```js
test("billing off: no 402, status enabled false, card/portal 404, export still works for a broker", async () => {});
test("a mismatched or unreadable Stripe price leaves billing off and logs why (H5)", async () => {});
test("no card: gated routes 402 needs_card; /me, /billing/status, /profile, export still answer", async () => {});
test("loan officers get 402 like their broker but billing: null and 403 on card, portal, export", async () => {});
test("card: first time -> Checkout 14-day trial for the user count; an open pending Checkout is reused (H1); live -> portal; returning -> no trial", async () => {});
test("status syncs a pending Checkout (back before the webhook) and re-reads a subscription older than 24 h (H4)", async () => {});
test("accept-invite pushes the user count when there is a subscription and calls nothing when there isn't", async () => {});
test("export.csv: this org's clients only, formula cells neutralised, locked broker allowed", async () => {});
test("start-up: existing orgs get a 30-day month once; exempt follows the list; off changes nothing", () => {});
test("/org/stats shows the billing state instead of the old trial date when billing is on (H12)", async () => {});
```

- [ ] **Step 2–4:** run → FAIL; implement; run the file and `npm test` → 0 fail (existing tests run with billing off, unchanged).
- [ ] **Step 5: Commit** — `feat(billing): billing API, gate, price check, stale repair, client export and start-up`

---

### Task 4: Terms acceptance, the tester code and sign-up

**Files:** modify `server/lib/terms.js` (`recordAcceptance`), `server/lib/signup.js`, `server/routes/auth.js` (`/register`,
`/register/complete`, `/accept-invite`, new `POST /terms/accept`); test `server/test/billing-signup.test.js`.

**Interfaces:**
- `recordAcceptance(db, userId, { termsVersion, privacyVersion }, nowMs, ip)`; `termsCurrent` true when the latest rows carry the
  current versions.
- `/register` (billing on): `acceptTerms !== true` → 400 "Please agree to the Terms of Service and Privacy Policy."; a non-empty
  `testerCode` that isn't `testerCodeUsable` → 400 "That tester code isn't valid." (checked with the other 400s, before the
  answer). The request stores the versions shown and `tester`. Billing off: both fields ignored.
- `completeSignup(db, token, nowMs, { billingOn })`: on → `billing_status = 'none'`; a tester also gets
  `billing_tester_until = nowMs + 30 days` and `billing_via_tester_code = 1` (the use limit is re-checked inside the transaction;
  over it → no tester month, a normal card ask). Off → `billing_status` NULL.
- `/register/complete` records the acceptance (`req.ip`), answers `{ success, user, tester }`, then for a tester (billing on)
  `createTesterSubscription` after the answer → `storeSubscription` → `runFollowUps` (sends the tester confirmation). A failure is
  logged by message only; the tester month still works.
- `/accept-invite` (billing on): the same terms 400 with the password check; acceptance recorded on success.
- `POST /api/auth/terms/accept` (signed in) → `{ success: true }`.

- [ ] **Step 1: Tests**

```js
test("billing on: the terms tick is required with the exact line; billing off: not needed", async () => {});
test("tester code: wrong, unset, expired or used up is 400; right (any case) gives a 30-day month and a Stripe trial with no card", async () => {});
test("the 26th tester sign-up with a limit of 25 gets the normal card ask (re-checked at complete)", async () => {});
test("complete records both acceptances (versions, time, IP); a failing tester subscription leaves the month working", async () => {});
test("accept-invite: on requires and records the tick; off unchanged", async () => {});
test("an existing user without an acceptance gets 402 terms until POST /api/auth/terms/accept", async () => {});
```

- [ ] **Step 2–4:** run → FAIL; implement; run the file and `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(billing): terms acceptance, limited tester code and billing-aware sign-up`

---

### Task 5: Removing a loan officer, and the billing email in step

**Files:** modify `server/routes/org.js` (`DELETE /los/:id`; `/los` and `/stats` count only `removed_at IS NULL`),
`server/routes/profile.js` (after a confirmed login-email change of a broker whose org has a Stripe customer,
`updateCustomerEmail` after the answer, H14); test `server/test/remove-lo.test.js`.

**Interfaces:** `DELETE /api/org/los/:id` (broker, same org, role `lo`; else 404 "LO not found in your org"):
- accepted LO, one transaction: clients move to the broker; `removed_at`, `removed_email = email`,
  `email = 'removed-' || id || '@removed.invalid'`, `password_hash = NULL`, `session_version + 1`; and delete their
  `integration_keys`, `google_connections`, `password_resets`, `email_changes` rows (H3); `{ success: true }`; `syncSeats` after.
- pending invite: the row is deleted; no seat change.

- [ ] **Step 1: Tests**

```js
test("removal moves clients, ends the session at once, and frees the address for a new invite", async () => {});
test("removal revokes the ARIVE key (a feed post with it is refused), the Google connection and pending reset/email change (H3)", async () => {});
test("a pending invite is deleted and its address freed; other orgs, brokers, unknown ids 404; an LO 403", async () => {});
test("the removed LO leaves /los and the user count, and the new count is pushed to Stripe", async () => {});
test("a broker's confirmed email change updates the Stripe customer email; an LO's does nothing (H14)", async () => {});
```

- [ ] **Step 2–4:** run → FAIL; implement; run the file and `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(org): remove a loan officer or cancel an invitation, revoking every way in`

---

### Task 6: Terms of Service and Privacy Policy drafts

**Files:** create `client/src/legal/terms.mjs`, `client/src/legal/privacy.mjs` (each `VERSION` and
`SECTIONS: [{ heading, paragraphs: string[] }]`); tests `client/src/legal/legal.test.mjs` and `server/test/terms-version.test.js`
(reads both client files as text; their `VERSION` equals the server's).

**Content (plain English; bracketed items for Bill and his lawyer):** parties ("[Company legal name]", doing business as Broker
Radar, a product of Ignite Business Solutions; no personal names); the service; accounts; **price ($99 a month including the
broker, plus $49 for each additional user), the 14-day free trial, the free test month, the card at sign-up, the automatic monthly
charge until cancelled, how added and removed users change the charge, how to cancel (Billing → Manage billing), access to the end
of the paid period, no refunds for partial months [lawyer], failed payments and pausing**; customer data (the brokerage owns its
client data; export any time, including while paused; processed by named subprocessors [Anthropic, ElevenLabs, Google when
connected, Stripe]); borrower-data responsibilities [GLBA, state law — lawyer]; after cancelling ("[kept N days, then deleted]");
acceptable use; feedback (may be used to improve the product); availability and changes; disclaimers (rate estimates are not
offers or advice); limitation of liability [lawyer]; governing law "[State]"; changes to the terms (accept on next sign-in);
contact "[support email]". Privacy: what we collect, why, who it goes to, the one sign-in cookie, retention, security, rights,
contact.

- [ ] **Step 1: Test** — `VERSION` "2026-11-05"; ≥ 8 sections, none empty; the terms contain "$99 a month", "$49 for each
  additional user" and "until you cancel"; neither contains "Bill" or "Enright".
- [ ] **Step 2–4:** run → FAIL; write; run → PASS.
- [ ] **Step 5: Commit** — `docs(legal): Terms of Service and Privacy Policy drafts for lawyer review`

---

### Task 7: Client billing screens

**Files:** create `client/src/billing/billing.mjs`, `client/src/billing/billing.test.mjs`; modify `client/src/App.jsx`,
`client/src/nav.mjs` (+ `nav.test.mjs`: with billing on, a broker gets `{ id: "billing", label: "Billing", icon: "card" }` before
Profile; an Icon `card` drawn like the others).

**Interfaces (`billing.mjs`, pure):** `gateScreen(access, role) -> null | "terms" | "start_trial" | "ended" | "lo_locked"` ·
`bannerText(banner, testerUntilMs)` (the two exact lines; date like "Nov 30, 2026") · `money(cents) -> "$99"` / `"$295"` (no
cents when whole) · `totalLine(users)` → "Brokerage $99 a month" (1) or "Brokerage $99 + {n} additional users × $49 = ${total} a
month" ("1 additional user" when n = 1) · `billingLines(billing, nowMs) -> string[]`: `totalLine`, then one of "Free trial until
{date}. First charge on {date}." · "Free test month until {date}." · "Next charge on {date}." · "Cancelled. Broker Radar keeps
working until {date}." · the past-due line · "No charge for this account." (exempt: no price line).

- [ ] **Step 1: Tests** for each helper with exact strings (1, 2 and 5 users; every status; exempt shows no price).
- [ ] **Step 2–4:** run → FAIL; implement; client tests and build pass.
- [ ] **Step 5: Wire `App.jsx`:** `GET /api/billing/status` after `/me` succeeds and after `handleLogin` (the existing loading
  screen meanwhile); `gateScreen` picks the page instead of the app shell:
  - `start_trial`: `AuthCard`, "Start your free trial", the spec line, `btnPrimary` "Add card and start trial" → `POST /card` →
    `window.location.assign(url)`; amber "Sign out".
  - `ended`: "Your subscription has ended", the returning line, `btnPrimary` "Restart subscription" → `POST /card`.
  - both broker pages: amber "Download my clients (CSV)" → `/api/billing/export.csv`.
  - `lo_locked`: the spec line and "Sign out". `terms`: "We've updated our terms", links to `/terms` and `/privacy`,
    `btnPrimary` "I agree" → `POST /api/auth/terms/accept` → re-fetch status.
  - `?billing=done`: remove it, show "Finishing up…", re-fetch status up to 10 times one second apart; `?billing=cancelled`:
    remove it, show the gate again.
  - Banners (broker, app shell): `bannerText` in `NoticeBanner` style with "Add card" / "Update card" (`POST /card`).
  - Billing view (broker): `billingLines` and `btnPrimary` "Manage billing" (`POST /portal`) when `hasCustomer`.
  - Overview chip: with billing on, the plan chip shows the billing status from `/org/stats` (H12).
- [ ] **Step 6: Commit** — `feat(client): billing gate, banners, Billing page and client export`

---

### Task 8: Client sign-up price, terms tick, tester code, legal pages, removing a loan officer

**Files:** modify `client/src/App.jsx` (RegisterPage, AcceptInvitePage, FinishSignupPage outcome, a small `LegalPage` beside
`AuthCard`, MyTeam); add to `client/src/billing/billing.test.mjs`.

**Interfaces:** `registerExtras(enabled) -> { showPrice, showTerms, showTesterCode }`; `removeConfirmText(lo)` → accepted:
"Remove {first} {last}? They'll be signed out right away, their clients move to you, and you'll stop paying for them." · pending:
"Cancel the invitation to {email}?".

- [ ] **Step 1: Tests** for both helpers (on → all true; off → all false; both confirm texts).
- [ ] **Step 2–4:** run → FAIL; implement; pass.
- [ ] **Step 5: Wire:** boot reads `GET /api/billing/public` once. RegisterPage (on): the price line above the fields (muted, the
  existing small-text style), "Tester code (optional)" `AuthField`, the terms checkbox with "Terms of Service" and "Privacy Policy"
  linking to `/terms` and `/privacy` (new tab); sends `acceptTerms`, `testerCode`. AcceptInvitePage (on): the checkbox. After
  "Create my account": `tester: true` → the test-month card with "Start testing"; otherwise the status check (Task 7). Path
  `/terms` or `/privacy` (before any sign-in check) → `LegalPage` (headings, paragraphs, version date, "Back"). MyTeam: amber
  "Remove" (accepted) / "Cancel invitation" (pending) → `window.confirm(removeConfirmText(lo))` → `DELETE` → reload the list.
- [ ] **Step 6:** client tests and build; `cd server && npm test` once → 0 fail.
- [ ] **Step 7: Commit** — `feat(client): sign-up price, terms tick, tester code, legal pages, removing a loan officer`

---

### Task 9: Feedback

**Files:** create `server/routes/feedback.js` (mounted at `/api/feedback`, `requireAuth`, NOT gated), `client/src/feedback.mjs`
(+ test); modify `server/email.js` (`feedbackMessage`, `sendFeedback` on `deliverPasswordMail`), `client/src/App.jsx`; test
`server/test/feedback.test.js`.

**Interfaces:** `POST /api/feedback { message, page }` → 400 "Please write a message." (empty after trim) or "Please keep it under
2,000 characters." (> 2000); 429 after 10 an hour per user; else store the row and answer `{ success: true }`, then (when
`FEEDBACK_TO` is set) email it after the answer — subject "Broker Radar feedback from {brokerage}", body: who (name, role), page,
the message, all escaped. `feedbackCanSend(message) -> null | errorLine` in `feedback.mjs`.
Client: a "Send feedback" button in the sidebar's bottom group (every signed-in user, and on the lock pages) opens a small panel in
the existing `card` style: a textarea, "Send", and after a 200 "Thanks — Bill's team will read this."

- [ ] **Step 1: Tests** — empty / too long / 11th in an hour; stored with user, org, page; emailed to `FEEDBACK_TO` with every value
  escaped; nothing emailed without it; a locked user can still send; client helper lines.
- [ ] **Step 2–4:** run → FAIL; implement; server and client suites and build pass.
- [ ] **Step 5: Commit** — `feat: Send feedback, stored and emailed to Bill's inbox`

---

## After the tasks (controller)

Local live check, billing **off** (everything as today) and **on** with a fake gateway wrapper (no Stripe network): price on the
form; sign-up with the tick → Start your free trial → fake Checkout URL → `?billing=done` → Home; double "Add card" reuses the page;
tester code → test-month page → banner (by moving `billing_tester_until`); lock pages and CSV download; Billing page; remove a loan
officer; feedback. Screenshots to Bill with the §10 wording for approval. Real Stripe test mode waits for Bill's account and his
end-to-end run. Merge, push and deploy each wait for Bill's go; billing stays off in production until Bill sets the settings.
