# Subscription Billing and Terms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brokerages pay $49.95 per user per month through Stripe: a card at sign-up, the first charge on day 15, testers get a
free month by code, everyone agrees to versioned Terms and Privacy Policy, and the app locks (never deletes) when billing lapses.

**Architecture:** Pure rules in `server/lib/billing/` (config, access, checkout plan, seats, Stripe event handling) over new
columns on `organizations` and two new tables. Stripe is reached only through one gateway object (`app.set("billingGateway")` in
tests) and a signed webhook mounted before the JSON parser. A route gate (`requireAccess`) returns 402 for gated routers. The
client asks `GET /api/billing/status` after sign-in and shows a gate page, a banner or the app. **Everything switches on with
billing:** with no Stripe settings the app behaves exactly as today (no card step, no gate, no terms checkbox).

**Tech Stack:** Node 20, Express 4, better-sqlite3, the `stripe` npm package (new, exact version), React 18 + Vite, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-05-subscription-billing-design.md` (APPROVED 2026-11-05).

## Global Constraints

- Node 20 only: prefix commands with `export PATH="/c/Users/bille/dev/node20:$PATH" &&`. Server `cd server && npm test`
  (baseline 1266 pass); client `cd client && npm test && npm run build` (baseline 232 pass).
- One new dependency: `stripe`, installed with `--save-exact` at the newest version published at least 14 days before install
  (check `npm view stripe time`). No other new dependency.
- Billing is **on** only when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID` are all set. Other settings:
  `BILLING_TESTER_CODE` (optional), `BILLING_EXEMPT_EMAILS` (comma list, optional). Off = today's behaviour everywhere, including
  sign-up (no terms checkbox, no tester field, tester code ignored) and no gate.
- No test, and no code path outside the gateway, talks to Stripe. Tests inject `app.set("billingConfig", ...)` and
  `app.set("billingGateway", fake)`. Webhook signatures in tests are made with the real `stripe` package's
  `webhooks.generateTestHeaderString` (offline).
- Never store or log card details, Stripe secret keys, webhook secrets or full Stripe objects. Log the event type and
  `err?.message` only.
- Values: `PRICE_PER_USER_CENTS = 4995`, `TRIAL_DAYS = 14`, `TESTER_DAYS = 30`, `TESTER_WARN_DAYS = 7`,
  `TERMS_VERSION = "2026-11-05"`, `PRIVACY_VERSION = "2026-11-05"`. A user (a seat) = a row with `invite_accepted = 1` and
  `removed_at IS NULL`.
- Loan officers never receive prices or billing details from any endpoint.
- No email is sent by our code in this build.
- Exact copy from the spec (verbatim):
  - "I agree to the Terms of Service and Privacy Policy"
  - "Start your free trial"; "$0 today. Your 14-day free trial starts now. From day 15 we'll charge $49.95 per user per month to this card until you cancel. Cancel any time in Billing."; "Add card and start trial"
  - "Your free test month starts now — no card needed. We'll ask for a card before it ends."; "Start testing"
  - "Your free test month ends on {date}. Add a card to keep going."; "Add card"
  - "Your last payment didn't go through. Update your card to keep Broker Radar running."; "Update card"
  - "Your brokerage's subscription needs attention. Please contact your broker."
  - "$49.95 per user per month, starting today, until you cancel."
  - "We've updated our terms"; "I agree"; "Manage billing"
- New copy this plan adds (marked **draft — Bill approves before release**, listed again in the final report):
  "That tester code isn't valid." · "Please agree to the Terms of Service and Privacy Policy." · "Your subscription has ended" ·
  "Restart subscription" · "Tester code (optional)" · Billing page lines in Task 7 · the remove-loan-officer confirm in Task 8.
- The approved layout stays: reuse `AuthCard`, `AuthField`, `btnPrimary`, the red error box, amber text buttons, `card`, `C.*`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The broker comes back from Stripe before the webhook arrives.** They must land on Home, not the "Start your free trial" page
   again: `GET /api/billing/status` syncs from the pending Checkout session (Task 3 test).
2. **Webhooks repeated or out of order** (an old `subscription.updated` after `deleted`). Each event id applies once; an event older
   than the last one applied to that organization is ignored (Task 2 test).
3. **Billing off** (no Stripe settings, today's live site): sign-up, sign-in, invites and every page work exactly as now, a typed
   tester code is ignored, nothing returns 402 (Tasks 3 and 4 tests).
4. **Cancel during the trial**, then the trial ends: works until the trial end, then locks as "ended", and coming back has no
   second trial (Task 1 and Task 2 tests).
5. **A removed loan officer still signed in on a phone**: their next request is refused at once, and their address can be invited
   again (Task 5 test).

---

### Task 1: Billing rules and data

**Files:**
- Create: `server/lib/billing/config.js`, `server/lib/billing/access.js`, `server/lib/billing/plan.js`, `server/lib/billing/seats.js`
- Modify: `server/db.js` (columns and tables below, idempotent, after the existing migrations)
- Test: `server/test/billing-rules.test.js`

**Interfaces (Produces):**
- `billingConfig(env) -> { enabled, secretKey, webhookSecret, priceId, testerCode: string|null, exemptEmails: string[] }` —
  `testerCode` trimmed and lower-cased or null; `exemptEmails` trimmed, lower-cased, empty entries dropped. Exports the value
  constants from Global Constraints and `DAY_MS`.
- `orgBilling(db, orgId) -> organizations row` (all billing columns).
- `accessFor({ config, org, termsOk, nowMs }) -> { ok: true } | { ok: false, reason: "terms" | "needs_card" | "ended" }`.
  Order: billing off → `{ ok: true }` (terms are part of billing's switch); `!termsOk` → `terms`; `billing_exempt` → ok;
  `billing_tester_until > nowMs` → ok; status `trialing` | `active` | `past_due` → ok; status `canceled` | `unpaid` |
  `incomplete_expired` | `paused` → `ended`; anything else (`none`, `incomplete`, NULL) → `needs_card`.
- `bannerFor(org, nowMs) -> null | "tester_ending" | "past_due"`: `past_due` when status is `past_due`; `tester_ending` when
  `billing_tester_until` is in the future, within `TESTER_WARN_DAYS`, and `billing_has_card` is 0.
- `checkoutPlan(org, nowMs) -> { trial: "days", days: 14 } | { trial: "until", endMs } | { trial: "none" }`:
  tester month still running → `until`, `endMs = Math.max(billing_tester_until, nowMs + 49 * 60 * 60 * 1000)` (Stripe needs a
  trial end at least 48 hours away); otherwise `billing_ever_subscribed = 0` → `days`; otherwise `none`.
- `seatCount(db, orgId) -> number`.
- `db.js` adds to `organizations`: `stripe_customer_id TEXT`, `stripe_subscription_id TEXT`, `stripe_item_id TEXT`,
  `billing_status TEXT` (NULL = the organization existed before billing was switched on), `billing_quantity INTEGER`,
  `billing_trial_end INTEGER`, `billing_period_end INTEGER`, `billing_cancel_at_period_end INTEGER NOT NULL DEFAULT 0`,
  `billing_exempt INTEGER NOT NULL DEFAULT 0`, `billing_tester_until INTEGER`, `billing_ever_subscribed INTEGER NOT NULL DEFAULT 0`,
  `billing_has_card INTEGER NOT NULL DEFAULT 0`, `billing_event_at INTEGER`, `billing_pending_checkout TEXT` (all times epoch ms);
  to `users`: `removed_at INTEGER`, `removed_email TEXT`; to `signup_requests`: `tester INTEGER NOT NULL DEFAULT 0`,
  `terms_version TEXT`, `privacy_version TEXT`; new tables
  `stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL)` and
  `terms_acceptances (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, document TEXT NOT NULL CHECK(document IN ('terms','privacy')), version TEXT NOT NULL, accepted_at INTEGER NOT NULL, ip TEXT)`.

- [ ] **Step 1: Write the failing tests** (throwaway DB, the setup used by `server/test/signup-lib.test.js`; `NOW = 1_800_000_000_000`)

```js
test("billingConfig: on only with all three Stripe settings; tester code and exempt list are normalised", () => {
  assert.equal(billingConfig({}).enabled, false);
  assert.equal(billingConfig({ STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" }).enabled, false);
  const c = billingConfig({ STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", STRIPE_PRICE_ID: "price_1",
    BILLING_TESTER_CODE: "  BrokerBeta ", BILLING_EXEMPT_EMAILS: " Bill@X.test, ,ann@y.test" });
  assert.deepEqual([c.enabled, c.testerCode, c.exemptEmails], [true, "brokerbeta", ["bill@x.test", "ann@y.test"]]);
  assert.equal(billingConfig({ STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", STRIPE_PRICE_ID: "p" }).testerCode, null);
});
test("accessFor: off is always ok; terms first; then exempt, tester month, live statuses; ended vs needs_card", () => {
  // off + any org + termsOk false -> ok
  // on: termsOk false -> terms (even if exempt); exempt -> ok; tester_until NOW+1 -> ok, tester_until NOW -> needs_card
  // trialing / active / past_due -> ok; canceled / unpaid / incomplete_expired / paused -> ended; none / incomplete / null -> needs_card
});
test("bannerFor: past_due; tester_ending only inside the last 7 days and only without a card", () => {});
test("checkoutPlan: first time 14 days; tester month -> until its end (at least 49 h away); after any subscription -> none", () => {
  // ever_subscribed 0, no tester -> { trial: "days", days: 14 }
  // tester_until NOW + 10 days -> { trial: "until", endMs: NOW + 10 days }; tester_until NOW + 1 h -> endMs NOW + 49 h
  // ever_subscribed 1, tester over -> { trial: "none" }
});
test("seatCount counts accepted, not removed users of that organization only", () => {
  // broker + accepted LO + pending invite + removed LO + another org's LO -> 2
});
test("the migration adds every billing column and table, idempotently, to a database that predates them", () => {
  // the subprocess pattern of coaching.test.js "users.career_stage: ... idempotently": an old-schema DB, load db.js twice,
  // each new column present exactly once, existing rows keep their data, billing_status NULL for the old organization
});
```

- [ ] **Step 2: Run to verify they fail** — `cd server && node --test test/billing-rules.test.js` → FAIL (`Cannot find module`).
- [ ] **Step 3: Implement** the four modules and the `db.js` migrations (follow the existing `PRAGMA table_info` pattern; one
  "why" comment per block).
- [ ] **Step 4: Run** the file, then `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(billing): billing rules (access, banners, checkout plan, seats) and the billing columns`

---

### Task 2: Stripe gateway and the signed webhook

**Files:**
- Create: `server/lib/billing/stripeGateway.js`, `server/lib/billing/events.js`, `server/routes/billingWebhook.js`
- Modify: `server/index.js` (mount the webhook before `express.json`, next to `/api/integrations`), `server/package.json`
- Test: `server/test/billing-webhook.test.js`

**Interfaces:**
- Consumes: Task 1 columns, `billingConfig`.
- Produces: `createStripeGateway({ secretKey }) -> gateway` with
  - `createCheckout({ customerId, email, orgId, priceId, quantity, plan, successUrl, cancelUrl }) -> Promise<{ id, url }>` —
    `mode: "subscription"`, `payment_method_collection: "always"`, `consent_collection: { terms_of_service: "required" }`,
    `client_reference_id` and `subscription_data.metadata.org_id` = orgId, trial from `plan` (Task 1 `checkoutPlan`);
  - `createPortal({ customerId, returnUrl, updateCard: boolean }) -> Promise<{ url }>` (`flow_data` `payment_method_update` when
    `updateCard`);
  - `createTesterSubscription({ email, orgId, orgName, priceId, quantity, trialEndMs }) -> Promise<{ customerId, subscriptionId, itemId, status, trialEndMs }>`
    — no payment method, `trial_settings.end_behavior.missing_payment_method: "cancel"`, `metadata.org_id`;
  - `setQuantity({ subscriptionId, itemId, quantity }) -> Promise<void>` (`proration_behavior: "create_prorations"`);
  - `retrieveCheckout(id) -> Promise<{ status, customerId, subscriptionId }>`; `retrieveSubscription(id) -> Promise<subscription>`;
  - `constructEvent(rawBody, signature, webhookSecret) -> event` (throws on a bad signature).
- Produces: `applyStripeEvent(db, event) -> "applied" | "duplicate" | "ignored"` and `storeSubscription(db, orgId, subscription, eventCreatedMs)`.
  Handled: `checkout.session.completed` (customer, subscription ids, `billing_has_card = 1`, clear `billing_pending_checkout`),
  `customer.subscription.created|updated|deleted` (status, `billing_trial_end`, `billing_period_end`,
  `billing_cancel_at_period_end`, `stripe_item_id`, `billing_quantity`, `billing_ever_subscribed = 1`, `billing_has_card` from
  `default_payment_method`), `customer.updated` (`billing_has_card` from `invoice_settings.default_payment_method`). The org is
  found by `metadata.org_id`, else by stored customer or subscription id. An event whose `created` is older than the org's
  `billing_event_at` is "ignored". Invoice events are acknowledged and ignored (the subscription events carry the status).
- Produces: `POST /api/billing/webhook` — `express.raw({ type: "application/json", limit: "1mb" })`; bad or missing signature → 400
  `{ success: false }`; otherwise 200 `{ received: true }` whatever the outcome; billing off → 404.

- [ ] **Step 1: Write the failing tests** (an app that mounts only `routes/billingWebhook.js`; `billingConfig` seam with
  `webhookSecret: "whsec_test"`; events signed with `require("stripe").webhooks.generateTestHeaderString`)

```js
test("a bad or missing signature is 400 and changes nothing", async () => {});
test("checkout.session.completed stores the customer and subscription for the org in metadata", async () => {});
test("subscription updated stores status, trial end, period end, cancel flag, item, quantity; deleted -> canceled", async () => {});
test("the same event id twice applies once ('duplicate'); an older event after a newer one is ignored", async () => {
  // deleted (created T+10) then updated (created T+5): status stays canceled
});
test("an event for an unknown org or of an unhandled type is 200 and changes nothing", async () => {});
test("cancel during the trial: trialing + cancel_at_period_end stays allowed; the later deleted event locks as ended", async () => {
  // accessFor after each event: ok, then { ok: false, reason: "ended" }; checkoutPlan afterwards -> { trial: "none" }
});
test("no log line holds a secret or a whole Stripe object", async (t) => {});
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Install and implement** — `npm install --save-exact stripe@<version per Global Constraints>`; the gateway wraps one
  `new Stripe(secretKey)`; `index.js` builds the gateway only when billing is on and puts it and the config on the app
  (`app.set("billingConfig")`, `app.set("billingGateway")`).
- [ ] **Step 4: Run** the file, then `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(billing): Stripe gateway and the signed, idempotent webhook`

---

### Task 3: Billing API, the access gate, seats and start-up

**Files:**
- Create: `server/routes/billing.js`, `server/middleware/access.js`, `server/lib/billing/startup.js`, `docs/billing-setup.md`
- Modify: `server/index.js` (mount `/api/billing`; call `applyBillingStartup` once at start), routers that call `requireAuth` for
  app data — `clients.js`, `org.js`, `notifications.js`, `import.js`, `sweeps.js`, `assistant.js`, `voice.js`, `google.js` — and
  `auth.js` `/invite` (add `requireAccess` right after `requireAuth`); `auth.js` `/accept-invite` (seat sync after the answer);
  `README.md` (the five settings)
- Test: `server/test/billing-api.test.js`

**Interfaces:**
- Consumes: Tasks 1–2; `termsCurrent(db, userId)` from Task 4 — **this task creates `server/lib/terms.js` with
  `TERMS_VERSION`, `PRIVACY_VERSION` and `termsCurrent` only; Task 4 adds the rest.**
- Produces: `requireAccess(req, res, next)` → 402 `{ success: false, error: "Broker Radar needs attention before you can continue.", reason }`.
- Produces: `syncSeats(db, gateway, orgId) -> Promise<void>` (in `seats.js`): when the org has a subscription and item and
  `seatCount` differs from `billing_quantity`, `setQuantity`, then store the new quantity.
- Produces: `applyBillingStartup(db, config, nowMs)`: billing on → every organization with `billing_status IS NULL` gets
  `billing_tester_until = nowMs + 30 days`, `billing_status = 'none'`; `billing_exempt` set to 1 exactly for organizations whose
  broker's email is in `exemptEmails` and to 0 for the rest. Billing off → nothing.
- Produces routes (all JSON):
  - `GET /api/billing/public` (no sign-in) → `{ enabled }`.
  - `GET /api/billing/status` (signed in) → `{ success, access, role, billing }`; `billing` is null for a loan officer, else
    `{ enabled, status, seats, pricePerUserCents: 4995, monthlyTotalCents, trialEnd, testerUntil, periodEnd, cancelAtPeriodEnd, exempt, hasCustomer, banner }`.
    For a broker with `billing_pending_checkout` and no live status it first syncs from `retrieveCheckout`/`retrieveSubscription`
    (Review Focus 1), and it runs `syncSeats` when the quantity differs.
  - `POST /api/billing/card` (broker) → `{ url }`: a live subscription → portal with `updateCard: true`; otherwise Checkout with
    `checkoutPlan`, quantity `seatCount`, and stores the session id in `billing_pending_checkout`. Success/cancel URLs:
    `${APP_URL}/?billing=done` and `${APP_URL}/?billing=cancelled`.
  - `POST /api/billing/portal` (broker, needs a customer) → `{ url }`, return URL `${APP_URL}/`.
  - Loan officer on `card`/`portal` → 403; billing off → 404 on everything but `public`; a gateway failure → 502
    `{ success: false, error: "Couldn't reach the payment service. Please try again." }` (logged by message only).

- [ ] **Step 1: Write the failing tests** (app with `auth`, `billing`, `clients`, `org` routers; `billingConfig` seam on; a fake
  gateway that records calls and returns canned objects; `addBroker` from `server/test-support/accounts.js`)

```js
test("billing off: no 402 anywhere, /status says enabled false, card/portal 404", async () => {});
test("a broker with no card gets 402 needs_card on gated routes but /me, /billing/status and /profile still answer", async () => {});
test("loan officers get 402 like their broker but never billing details (billing: null; card/portal 403)", async () => {});
test("card: first time -> Checkout with a 14-day trial for the seat count; pending session stored", async () => {});
test("card: live subscription -> portal to update the card; returning after cancel -> Checkout with no trial", async () => {});
test("status syncs from the pending Checkout session when the broker is back before the webhook", async () => {});
test("accept-invite pushes the new seat count when there is a subscription, and calls nothing when there isn't", async () => {});
test("a gateway failure is 502 with the fixed message and no secret in the log", async () => {});
test("start-up: existing organizations get a 30-day tester month once; exempt follows the email list; off changes nothing", () => {});
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** `docs/billing-setup.md` is Bill's numbered checklist (each step with what success looks like):
  create the Stripe account in test mode; create the product "Broker Radar" and a recurring $49.95 per-unit monthly price; the
  webhook endpoint `<APP_URL>/api/billing/webhook` with the five event types above; customer portal (update card, invoices,
  cancel at period end); Settings → Subscriptions: retries up to 14 days then cancel, trial-ending reminder 7 days before;
  Checkout terms-of-service URL `<APP_URL>/terms`; Secret Manager for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (clipboard
  method, never pasted to anyone); `--update-env-vars` for `STRIPE_PRICE_ID`, `BILLING_TESTER_CODE`, `BILLING_EXEMPT_EMAILS`;
  live keys only after the lawyer has reviewed the terms.
- [ ] **Step 4: Run** the file, then `npm test` → 0 fail (existing tests run with billing off and must not change).
- [ ] **Step 5: Commit** — `feat(billing): billing API, the access gate, seat sync and start-up`

---

### Task 4: Terms acceptance, the tester code and sign-up

**Files:**
- Modify: `server/lib/terms.js` (add `recordAcceptance`), `server/lib/signup.js` (`issueSignup` stores `tester`,
  `terms_version`, `privacy_version`; `completeSignup` sets billing fields), `server/routes/auth.js` (`/register`,
  `/register/complete`, `/accept-invite`, new `POST /terms/accept`)
- Test: `server/test/billing-signup.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `recordAcceptance(db, userId, { termsVersion, privacyVersion }, nowMs, ip)` (two rows); `termsCurrent` true when the
  user's latest rows carry `TERMS_VERSION` and `PRIVACY_VERSION`.
- `/register` (billing on only): `acceptTerms !== true` → 400 "Please agree to the Terms of Service and Privacy Policy."; a
  non-empty `testerCode` that doesn't match the configured code (trimmed, case-insensitive; none configured = no match) → 400
  "That tester code isn't valid." Both are checked with the other 400s, before the answer (they don't depend on the address).
  The request stores the versions shown and `tester`. Billing off: both fields ignored.
- `completeSignup(db, token, nowMs, { billingOn })`: billing on → `billing_status = 'none'`, and for a tester
  `billing_tester_until = nowMs + 30 days`; billing off → `billing_status` stays NULL. `/register/complete` records the
  acceptance (the request's versions, `req.ip`) in the same request, answers `{ success, user, tester }`, then (tester, billing
  on) calls `createTesterSubscription` after the answer and stores the result with `storeSubscription`; a failure is logged by
  message only and leaves the tester month working.
- `/accept-invite` (billing on): the same `acceptTerms` 400, checked with the password; acceptance recorded on success.
- `POST /api/auth/terms/accept` (signed in) → records the current versions → `{ success: true }`.

- [ ] **Step 1: Write the failing tests**

```js
test("billing on: sign-up without the terms tick is 400 with the exact line; billing off: no tick needed", async () => {});
test("tester code: wrong or unset is 400 'That tester code isn't valid.'; right (any case, spaces) marks the request; off ignores it", async () => {});
test("complete records both acceptances with versions, time and IP, and starts a 30-day tester month with a Stripe trial (no card)", async () => {});
test("a failing tester subscription still leaves the tester month working, logged without secrets", async () => {});
test("accept-invite on: the tick is required and recorded; off: unchanged", async () => {});
test("an existing user with no acceptance gets 402 terms until POST /api/auth/terms/accept", async () => {});
```

- [ ] **Step 2–4:** run → FAIL; implement; run the file and `npm test` → 0 fail (the auth-hardening tests stay green with billing off).
- [ ] **Step 5: Commit** — `feat(billing): terms acceptance, tester code and billing-aware sign-up`

---

### Task 5: Removing a loan officer

**Files:**
- Modify: `server/routes/org.js` (`DELETE /los/:id`; `/los` and `/stats` count only users with `removed_at IS NULL`)
- Test: `server/test/remove-lo.test.js`

**Interfaces:**
- Consumes: `seatCount`, `syncSeats` (Task 3).
- Produces: `DELETE /api/org/los/:id` (broker, same organization, role `lo`; else 404 "LO not found in your org"):
  - an accepted loan officer, in one transaction: their clients move to the broker (`clients.user_id`), `removed_at = now`,
    `removed_email = email`, `email = 'removed-' || id || '@removed.invalid'`, `password_hash = NULL`,
    `session_version = session_version + 1`; answer `{ success: true }`; then `syncSeats` after the answer;
  - a pending invite: the row is deleted (nothing to keep) and the address is free; no seat change.

- [ ] **Step 1: Write the failing tests**

```js
test("removing an LO moves their clients to the broker, ends their session at once and frees the address", async () => {
  // the LO's old cookie -> 401 on /me; login with their old email -> 401; the broker can invite the same address again -> 201
});
test("removing a pending invite deletes it and frees the address; nothing else changes", async () => {});
test("another org's LO, a broker, or an unknown id is 404; an LO can't remove anyone (403)", async () => {});
test("the removed LO is gone from /los and from the seat count, and the new count is pushed to Stripe", async () => {});
```

- [ ] **Step 2–4:** run → FAIL; implement; run the file and `npm test` → 0 fail.
- [ ] **Step 5: Commit** — `feat(org): a broker can remove a loan officer or cancel an invitation`

---

### Task 6: Terms of Service and Privacy Policy drafts

**Files:**
- Create: `client/src/legal/terms.mjs`, `client/src/legal/privacy.mjs` (each exports `VERSION` and `SECTIONS: [{ heading, paragraphs: string[] }]`)
- Test: `client/src/legal/legal.test.mjs`; `server/test/terms-version.test.js` (reads both client files as text and checks their
  `VERSION` equals `TERMS_VERSION` / `PRIVACY_VERSION`)

**Content (plain English, every bracketed item left for Bill and his lawyer):** the parties ("[Company legal name]", doing
business as Broker Radar, a product of Ignite Business Solutions; no personal names); the service; accounts and who may use them;
**the price ($49.95 per user per month), the 14-day free trial for new brokerages and the free test month for testers, the card
taken at sign-up, the automatic monthly charge until cancelled, how the user count changes the charge, how to cancel (Billing →
Manage billing) and that access continues to the end of the paid period, no refunds for partial months [lawyer to confirm],
failed payments and locking**; customer data (the brokerage owns its client data; we process it to provide the service; Charlie's
AI processing by named subprocessors [Anthropic, ElevenLabs, Google when connected, Stripe for payments]); borrower data
responsibilities (the brokerage must have the right to upload it and comply with GLBA and state privacy law [lawyer]); what
happens to data after cancelling ("[kept N days, then deleted]" — Bill to decide); acceptable use; availability and changes;
disclaimers (rate estimates are not offers or advice); limitation of liability [lawyer]; governing law "[State]"; changes to the
terms (users accept the new version on next sign-in); contact "[support email]". The privacy policy: what we collect, why, who it
goes to (the subprocessors), cookies (one sign-in cookie), retention, security, rights, contact.

- [ ] **Step 1: Test** — both documents have a `VERSION` of "2026-11-05", at least 8 sections, no section empty, the price string
  "$49.95 per user per month" and "until you cancel" appear in the terms, and neither document contains a personal name from the
  list ["Bill", "Enright"].
- [ ] **Step 2–4:** run → FAIL; write; run → PASS.
- [ ] **Step 5: Commit** — `docs(legal): Terms of Service and Privacy Policy drafts for lawyer review`

---

### Task 7: Client billing screens

**Files:**
- Create: `client/src/billing/billing.mjs`, `client/src/billing/billing.test.mjs`
- Modify: `client/src/App.jsx` (status fetch after sign-in and on boot, the gate, banners, the Billing view), `client/src/nav.mjs`
  (+ `nav.test.mjs`: broker gets `{ id: "billing", label: "Billing", icon: "card" }` in `BOTTOM` before Profile only when
  billing is on; add an Icon named `card` drawn like the existing icons)

**Interfaces:**
- Consumes: `GET /api/billing/status`, `POST /api/billing/card`, `POST /api/billing/portal`, `POST /api/auth/terms/accept`.
- Produces (`billing.mjs`, pure): `gateScreen(access, role) -> null | "terms" | "start_trial" | "ended" | "lo_locked"`
  (`needs_card` → broker `start_trial`; `ended` → broker `ended`; any not-ok for a loan officer except `terms` → `lo_locked`);
  `bannerText(banner, testerUntilMs) -> string | null` (the two exact lines; the date as "Nov 30, 2026");
  `money(cents) -> "$49.95"`; `billingLines(billing, nowMs) -> string[]` for the Billing page:
  `"{n} users × $49.95 = ${total} a month"` (1 user: "1 user × …"), then one of
  `"Free trial until {date}. First charge on {date}."` (trialing, no tester month), `"Free test month until {date}."`,
  `"Next charge on {date}."` (active), `"Cancelled. Broker Radar keeps working until {date}."` (cancel flag), the past-due line,
  or `"No charge for this account."` (exempt).

- [ ] **Step 1: Tests** for each helper with exact strings (including 1 user vs several, every status, and that `billingLines`
  for `exempt` shows no price).
- [ ] **Step 2–4:** run → FAIL; implement; client tests and build pass.
- [ ] **Step 5: Wire the screens in `App.jsx`:** after `/me` succeeds and after `handleLogin`, `GET /api/billing/status`; while
  it loads, the existing loading screen. `gateScreen` → the page instead of the app shell:
  - `start_trial`: `AuthCard`, heading "Start your free trial", the spec line, `btnPrimary` "Add card and start trial" →
    `POST /card` → `window.location.assign(url)`; a "Sign out" amber text button.
  - `ended`: heading "Your subscription has ended", the line "$49.95 per user per month, starting today, until you cancel.",
    `btnPrimary` "Restart subscription" → `POST /card`.
  - `lo_locked`: the spec line and "Sign out".
  - `terms`: heading "We've updated our terms", links to `/terms` and `/privacy`, `btnPrimary` "I agree" → `POST /api/auth/terms/accept` → re-fetch status.
  - Coming back with `?billing=done`: remove the parameter, show "Finishing up…" and re-fetch status up to 10 times one second apart;
    `?billing=cancelled`: remove it and show the gate again.
  - Banners (broker, app shell): `bannerText` in the existing `NoticeBanner` style with the "Add card" / "Update card" button
    (`POST /card`).
  - Billing view (broker): `billingLines` and `btnPrimary` "Manage billing" (`POST /portal`) when `hasCustomer`.
- [ ] **Step 6: Commit** — `feat(client): billing gate, banners and the Billing page`

---

### Task 8: Client terms, tester code, legal pages and removing a loan officer

**Files:**
- Modify: `client/src/App.jsx` (RegisterPage, AcceptInvitePage, FinishSignupPage outcome, a small `LegalPage` component beside
  `AuthCard`, MyTeam)
- Test: `client/src/billing/billing.test.mjs` (add `registerExtras(enabled) -> { showTerms, showTesterCode }` and
  `removeConfirmText(lo) -> string`)

**Interfaces:**
- Consumes: `GET /api/billing/public`, Task 4's 400 lines and `tester` flag, Task 5's `DELETE /api/org/los/:id`, Task 6's documents.

- [ ] **Step 1: Tests** — `registerExtras(true)` → both true, `(false)` → both false; `removeConfirmText` for an accepted LO →
  `"Remove {first} {last}? They'll be signed out right away, their clients move to you, and you'll stop paying for them."`,
  for a pending invite → `"Cancel the invitation to {email}?"`.
- [ ] **Step 2–4:** run → FAIL; implement; pass.
- [ ] **Step 5: Wire:**
  - Boot reads `GET /api/billing/public` once. RegisterPage (billing on): an `AuthField` "Tester code (optional)" and a checkbox
    "I agree to the Terms of Service and Privacy Policy" with both names linking to `/terms` and `/privacy` (new tab); sends
    `acceptTerms` and `testerCode`. AcceptInvitePage (billing on): the same checkbox; sends `acceptTerms`.
  - After "Create my account": `tester: true` → an `AuthCard` with "Your free test month starts now — no card needed. We'll ask for
    a card before it ends." and `btnPrimary` "Start testing" → the app; otherwise straight to the status check (Task 7), which
    shows "Start your free trial" when billing is on.
  - `window.location.pathname` `/terms` or `/privacy` (before any sign-in check) → `LegalPage` with the document's headings and
    paragraphs, its version date, and "Back" (history back, or `/` when there is none).
  - MyTeam: each row gets an amber text button "Remove" (accepted LO) or "Cancel invitation" (pending) → `window.confirm(removeConfirmText(lo))`
    → `DELETE` → reload the list; an error shows in the page's existing error style.
- [ ] **Step 6: Run** client tests and build; `cd server && npm test` once → 0 fail.
- [ ] **Step 7: Commit** — `feat(client): terms tick, tester code, legal pages and removing a loan officer`

---

## After the tasks (controller)

Local live check with billing **off** (everything as today) and **on** with a fake gateway wrapper (no Stripe network): sign-up
with the tick → Start your free trial → the fake Checkout URL → `?billing=done` → Home; tester code → test-month page → Home →
day-23 banner (by moving `billing_tester_until`); lock pages for broker and loan officer; Billing page; remove a loan officer.
Screenshots to Bill. Real Stripe test mode waits for Bill's account. Merge, push and deploy each wait for Bill's go; billing stays
off in production until Bill sets the Stripe settings.
