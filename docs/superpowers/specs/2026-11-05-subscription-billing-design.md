# Subscription billing and terms: design

Status: APPROVED by Bill 2026-11-05 ("Yes"); REVISED the same day after a hole review: new pricing ($99 + $49, Bill) and fixes
H1–H14 folded in (Bill: "Yes"). Marked **Bill** where Bill decided; **my call** where I did (Bill can override any of these);
**open** where only Bill can decide. The new and changed wording (§10) is approved by Bill before release.

## 1. Why

Broker Radar is about to be tried by outside brokers and then sold. Bill needs every brokerage to pay automatically each month until
it cancels, and every person who signs up to agree to written terms first. Test brokers get a free month to try it and send feedback.

## 2. What Bill decided

- **Price: $99 a month for the brokerage, which includes the broker, plus $49 a month for each additional user (Bill).** A user is
  anyone in the brokerage who can sign in: the broker plus each loan officer who has accepted an invite. Pending invites are not
  charged (**my call**). Examples: 1 user $99; 3 users $197; 5 users $295; 10 users $540.
- **The brokerage pays, not each person (my call).** One subscription per organization, paid by the broker who owns it. Loan
  officers never see prices or billing.
- **Card first, charged on day 15 (Bill).** A new broker enters a card before using the app. Nothing is charged during the 14-day
  trial; Stripe charges the card on day 15, then every month, until the broker cancels. Cancelling before day 15 means no charge.
- **Test brokers: one free month (Bill), through a private code (my call; Bill set the length).** A tester types the code at
  sign-up, skips the card, and uses everything free for 30 days, invited loan officers included. A week before the 30 days end they
  are asked to add a card; with one, normal billing starts on day 31; without one, the app locks (data kept).
- **Stripe (my recommendation; Bill agreed).** Stripe Checkout (Stripe's own card page), Stripe Billing (the monthly charge,
  retries, receipts) and Stripe's customer portal (update card, see invoices, cancel). Card numbers never reach our server.

## 3. Goals

1. No broker uses the app (beyond the card step) without either a saved card, an active tester month, or an exemption Bill set.
2. The charge each month equals $99 + $49 × (users − 1), adjusting itself when users are added or removed, and a broker can never
   lower it themselves.
3. A broker can cancel, update their card, see their invoices and take their clients' data out without contacting anyone.
4. Every person who signs up has accepted the current Terms of Service and Privacy Policy, and the app can show which version each
   person accepted and when.
5. Testers can send Bill feedback from inside the app.

## 4. Non-goals

- Annual plans, discounts other than the tester code, more than one plan.
- Sales tax collection (**open**, Bill and his accountant; Stripe Tax can be switched on later without changing this design).
- A per-user cap on Charlie's AI and voice use (**open**: Bill first checks AI and voice cost per active user, H7).
- Invoices by email for brokerages that won't use a card; refunds or credits from inside the app (Bill uses the Stripe dashboard).
- Closing an account entirely, handing a brokerage to a new owner, stopping repeat trials by the same person under new addresses.

## 5. Must never happen

- A card is charged without the person having seen the price, the day-15 start and "until you cancel", both on the sign-up form and
  next to the button that agrees to it.
- A charge for a person who can't sign in (a pending invite, a removed loan officer), or two subscriptions for one brokerage (H1).
- A broker lowers their own bill by changing the user count anywhere (H2).
- A removed loan officer keeps any way in: session, password, ARIVE feed key, Google connection, pending reset or email change (H3).
- A paying brokerage is locked because a Stripe notification was missed (H4).
- The price the app shows differs from the price Stripe charges (H5).
- A card number, CVC or full card details stored by us, or a Stripe secret key in code, a log or the client.
- A loan officer locked out because of billing with no word on why, or shown the brokerage's billing details.
- Data deleted because a card failed or a subscription ended; or a locked brokerage unable to take its own client data out (H11).
- Any email sent by us or by Stripe whose wording Bill has not approved.

## 6. How it works

### 6.1 Sign-up (extends the email-verified sign-up shipped 2026-11-05)

1. The sign-up form shows the price above the fields (H8): "14 days free, then $99 a month, plus $49 for each additional user.
   Cancel anytime." It gains a required checkbox "I agree to the Terms of Service and Privacy Policy" (both linked) and an optional
   "Tester code" field. The acceptance (document, version, time, IP) is stored when the account is created at "Create my account".
2. After "Create my account" the broker lands on **"Start your free trial"**: "$0 today. Your 14-day free trial starts now. From
   day 15 we'll charge $99 a month, plus $49 for each additional user, until you cancel. Cancel any time in Billing." and
   **Add card and start trial** → Stripe Checkout (14-day trial, card required, Stripe's terms tick). Back from Checkout → Home.
3. With a valid tester code the page says "Your free test month starts now — no card needed. We'll ask for a card before it ends."
   with **Start testing**; no Stripe page. Behind it the server creates the Stripe customer and a 30-day trialing subscription with
   no card, set to cancel itself at the end if no card was added (so Stripe's reminder and day-31 charge work as for everyone).
   From day 23 a banner "Your free test month ends on {date}. Add a card to keep going." with **Add card**.
4. **The tester code is limited (H10, my call):** `BILLING_TESTER_CODE` works for at most `BILLING_TESTER_MAX_USES` sign-ups
   (default 25) and not after `BILLING_TESTER_EXPIRES` (a date; none = no expiry). Past either, it is "That tester code isn't
   valid." Bill can switch it off at any time.
5. **Confirmation email (H6, my call; wording approved by Bill before it is ever sent):** when a brokerage's first subscription
   starts (trial or tester month), we send the broker one email with the trial or test-month end date, the price after it, and how
   to cancel. Sent once per brokerage; never for loan officers.

### 6.2 Who may use the app

One rule, on the server, for every signed-in request except billing, profile, auth, feedback and sign-out:

- **Allowed:** the organization is exempt (set by Bill), or in a tester month, or its Stripe subscription is `trialing`, `active` or
  `past_due`. Stripe retries a failed card for up to 14 days, then cancels the subscription (Stripe dashboard setting); during the
  retries the broker sees "Your last payment didn't go through. Update your card to keep Broker Radar running." with
  **Update card**.
- **Otherwise:** HTTP 402 with a short reason; the broker sees a page with one button to fix it (add a card, or restart the
  subscription) and **Download my clients (CSV)** (H11); a loan officer sees "Your brokerage's subscription needs attention.
  Please contact your broker." with nothing else.

The billing state is kept in our database from Stripe's webhooks (6.4), so the rule never calls Stripe. **Stale-state repair (H4):**
when a signed-in user's organization has a subscription whose state is more than 24 hours old, or a Checkout still pending, the
billing status call re-reads it from Stripe before answering.

### 6.3 Users and the charge

- **One Stripe price, two steps (my call):** a graduated price where the first unit is $99 and each further unit is $49; the
  subscription quantity is the user count. If Stripe Checkout turns out not to accept a graduated price in test mode, the fallback
  is two prices on one subscription ($99 flat, $49 × (users − 1)); nothing else in this design changes.
- The quantity is pushed to Stripe when a loan officer accepts an invite and when one is removed; Stripe prorates.
- **The broker can't change the quantity (H2):** the customer portal is set to card, invoices and cancel only (no quantity, no plan
  switch, no promotion codes), and whenever Stripe reports a quantity different from the user count, the app puts it back.
- **Removing a loan officer (my call — there is no way today):** signs them out everywhere and stops their sign-in; revokes their
  ARIVE feed key, their Google connection, and any pending password reset or email change (H3); their clients move to the broker;
  the row is kept so history stays whole; the address is freed so they can be invited again. A pending invitation can be cancelled
  the same way (it is simply deleted).
- **Billing email in step (H14):** when a broker's login email changes, the Stripe customer's email changes with it.

### 6.4 Stripe events and safety checks

- A webhook route mounted before the JSON body parser, checked with the Stripe signing secret, idempotent by event id, ignoring an
  event older than the last one applied to that organization: Checkout finished, subscription created/updated/deleted, customer
  updated (whether a card is on file). Invoice events are acknowledged and ignored (the subscription events carry the status).
- **No double subscriptions (H1):** "Add card" reuses the brokerage's still-open Checkout page instead of opening a second one; and
  if a second live subscription is ever reported for a brokerage that already has one, the app cancels the newer one at once (and
  refunds it if it was charged).
- **Price check (H5):** at start the server reads the configured Stripe price; unless it is monthly, in US dollars, $99 for the first
  unit and $49 after, billing stays **off** and the log says why (nobody is charged a price the app doesn't show).

### 6.5 Billing page (broker only)

Shows "Brokerage $99 + {n} additional users × $49 = ${total} a month" ("Brokerage $99 a month" when the broker is the only user),
the trial or tester end date, the next charge date, and **Manage billing** (Stripe's portal). Cancelling ends at the period end.

### 6.6 Terms

- `/terms` and `/privacy`, public, each with a version date. **I draft both; a lawyer reviews them before any real charge.** They
  state the price, the trial, the test month, the automatic monthly charge, how to cancel, what happens to data after cancelling,
  and how to take data out.
- Loan officers accept the same two documents on the accept-invite page. A new version → everyone accepts it on next sign-in
  ("We've updated our terms" with **I agree**). Stripe Checkout also requires its terms tick.

### 6.7 Accounts that exist before billing is switched on

- **Bill's own organization: exempt** (by email, `BILLING_EXEMPT_EMAILS`).
- Every other existing organization: a tester month from the day billing is switched on, then the card ask. They have no Stripe
  subscription yet, so they get the in-app banner but **not** Stripe's reminder email (H13): Bill tells these few brokers himself.

### 6.8 Cancelling and coming back (my calls)

- Cancelling during the trial or a tester month: no charge; the app works until that end date. Cancelling a paid month: the app
  works until the end of the paid month.
- Coming back after a cancellation or a lapse: no second free trial. "$99 a month, plus $49 for each additional user, starting
  today, until you cancel." The first charge is that day.

### 6.9 Feedback (H9, my call)

A **Send feedback** button for everyone signed in (broker and loan officer, locked or not): a box, **Send**, and "Thanks — the Broker Radar
team will read this." The text, the page it was sent from, the user and the brokerage are stored, and emailed to the address in
`FEEDBACK_TO` (Bill's inbox) from the app's mailbox. At most 10 an hour per user. Nothing is sent when `FEEDBACK_TO` is unset.

### 6.10 Other fixes

- **The Overview page (H12):** with billing on, its "Trial … ends" chip shows the billing status instead of the old sign-up trial
  date (broker only).

### 6.11 Emails

Stripe sends the receipt, the failed-payment notices and the trial reminder (7 days before a trial or tester month ends); Bill turns
each on in the Stripe dashboard after approving its wording. We send exactly two kinds: the confirmation email (6.1.5) and feedback
to Bill (6.9).

## 7. What Bill does (the app can't)

1. Create the Stripe account (business details, bank account, statement name such as "BROKER RADAR"). Test mode first.
2. Put the Stripe secret key and webhook signing secret into Secret Manager himself (clipboard method; never pasted to anyone).
3. Choose the tester code, its use limit and end date; set `FEEDBACK_TO`.
4. Approve the wording in §10 and of Stripe's emails.
5. Have a lawyer review the Terms and Privacy Policy, and confirm what the confirmation email must say.
6. Run the full checklist once in Stripe test mode, end to end, before live keys (H4).
7. Decide sales tax, data kept how long after cancelling, and whether Charlie needs a fair-use cap (H7).

## 8. Left to the builder

Table and column names, route paths, proration settings, how the quantity push is timed, test layout. Tests use a fake Stripe
client (no network). Nothing touches a live key until Bill says so.

## 9. Open (Bill)

Sales tax. Data kept how long after cancelling. Statement name. The tester code, its limit and end date. AI and voice cost per
active user (H7). A web address of Broker Radar's own and a support email on it (before selling; today's address is a Google
Cloud one and mail comes from a Gmail account).

## 10. Wording for Bill's approval before release

Sign-up price line (6.1.1) · Start your free trial (6.1.2) · test month and its banner (6.1.3) · "That tester code isn't valid." ·
"Please agree to the Terms of Service and Privacy Policy." · the confirmation email (6.1.5) · past-due banner, lock pages, "Your
subscription has ended", "Restart subscription", "Download my clients (CSV)" (6.2, 6.8) · Billing page lines (6.5) · "We've updated
our terms" (6.6) · Send feedback (6.9) · the remove-loan-officer and cancel-invitation confirmations (6.3).

Added in the final fix wave (2026-11-05), awaiting approval:
- The tester's price line, under the test-month banner and on the Billing page while a tester month runs with no card (6.1.3,
  6.5): "From {date} we'll charge {total} a month until you cancel." ({date} is the month's end, as "Nov 30, 2026"; {total} is
  today's monthly total, as "$99" or "$295").
- The remove-loan-officer confirmation while billing is off (or the brokerage is exempt), without the part about paying (6.3):
  "Remove {first} {last}? They'll be signed out right away and their clients move to you."
- The answer an exempt brokerage gets if a card page is asked for anyway (the app shows it no card button): "This account has no
  charge."
