# Subscription billing and terms: design

Status: APPROVED by Bill 2026-11-05 ("Yes"). Marked **Bill** where Bill decided; **my call** where I did (Bill can override any of
these); **open** where only Bill can decide.

## 1. Why

Broker Radar is about to be tried by outside brokers and then sold. Bill needs every brokerage to pay automatically each month until
it cancels, and every person who signs up to agree to written terms first. Test brokers get a free month to try it and send feedback.

## 2. What Bill decided

- **Price: $49.95 a month per user (Bill).** A "user" is anyone in the brokerage who can sign in: the broker plus each loan
  officer who has accepted an invite. Pending invites are not charged (**my call**, Bill did not correct it).
- **The brokerage pays, not each person (my call).** One subscription per organization, paid by the broker who owns it; the
  quantity is the number of users. Loan officers never see prices or billing.
- **Card first, charged on day 15 (Bill).** A new broker enters a card before using the app. Nothing is charged during the 14-day
  trial; Stripe charges the card on day 15, then every month, until the broker cancels. Cancelling before day 15 means no charge.
- **Test brokers: one free month (Bill), through a private code (my call, Bill set the length after it was proposed).** A tester
  types the code at sign-up, skips the card, and uses everything free for 30 days, invited loan officers included. A week before
  the 30 days end they are asked to add a card; with one, normal billing starts on day 31; without one, the app locks (data kept).
  Bill can switch the code off at any time.
- **Stripe (my recommendation; Bill asked who to use and has not objected).** Stripe Checkout (Stripe's own card page), Stripe
  Billing (the monthly charge, retries, receipts) and Stripe's customer portal (update card, see invoices, cancel). Card numbers
  never reach our server. QuickBooks Payments (used for North Star invoices) is weak at trials, per-user quantity and self-serve
  cancellation, so it is not used here.

## 3. Goals

1. No broker uses the app (beyond the card step) without either a saved card, an active tester month, or an exemption Bill set.
2. The charge each month equals $49.95 × users, adjusting itself when users are added or removed.
3. A broker can cancel, update their card and see their invoices without contacting anyone.
4. Every person who signs up has accepted the current Terms of Service and Privacy Policy, and the app can show which version each
   person accepted and when.

## 4. Non-goals

- Annual plans, discounts other than the tester code, multiple price tiers.
- Sales tax collection (**open**, Bill and his accountant; Stripe Tax can be switched on later without changing this design).
- Invoices by email for brokerages that won't use a card.
- Refunds or credits from inside the app (Bill does those in the Stripe dashboard).

## 5. Must never happen

- A card is charged without the person having seen the price, the day-15 start and "until you cancel" next to the button that
  agrees to it.
- A charge for a person who can't sign in (a pending invite, a removed loan officer).
- A card number, CVC or full card details stored by us, or a Stripe secret key in code, a log or the client.
- A loan officer locked out because of billing with no word on why, or shown the brokerage's billing details.
- Data deleted because a card failed or a subscription ended (locking is the response; deletion is a separate, later decision).
- Any email sent by us or by Stripe that Bill has not approved (Stripe's emails are switched on by Bill in the Stripe dashboard).

## 6. How it works

### 6.1 Sign-up (extends the email-verified sign-up shipped 2026-11-05)

1. The sign-up form gains a required checkbox: "I agree to the Terms of Service and Privacy Policy" (both linked) and an optional
   "Tester code" field. The checkbox is checked server-side; the acceptance (document, version, time, IP) is stored when the
   account is created at "Create my account", tied to the new user.
2. After "Create my account" the broker lands on **"Start your free trial"**, not on Home:
   - "$0 today. Your 14-day free trial starts now. From day 15 we'll charge $49.95 per user per month to this card until you
     cancel. Cancel any time in Billing." and one button, **Add card and start trial**, which opens Stripe Checkout
     (subscription, quantity 1, 14-day trial, card required). Back from Checkout, the broker lands on Home.
   - With a valid tester code, the page instead says "Your free test month starts now — no card needed. We'll ask for a card
     before it ends." with **Start testing**; no Stripe page. Behind it, the server creates the Stripe customer and a subscription
     that is trialing for 30 days with no card, set to cancel itself at the end if no card was added (**my call**: so Stripe's
     trial reminder and day-31 charge work for testers exactly as for everyone else). From day 23 the broker sees a banner "Your
     free test month ends on {date}. Add a card to keep going." with **Add card**, which opens Stripe's page to save a card; with a
     card saved, the first charge is on day 31.
3. Until a card is saved (or a tester month or exemption applies), every page except Billing, Profile and Sign out shows the
   "Start your free trial" page.

### 6.2 Who may use the app

One rule, on the server, for every signed-in request except billing, profile, auth and sign-out:

- **Allowed:** the organization is exempt (set by Bill), or its Stripe subscription is `trialing` (a trial or a tester month),
  `active`, or `past_due`. Stripe retries a failed card for up to 14 days (Bill heard this and didn't object; set in the Stripe
  dashboard, with "cancel the subscription" after the last retry); during that time the broker sees a banner "Your last payment
  didn't go through. Update your card to keep Broker Radar running." with **Update card**.
- **Otherwise:** HTTP 402 with a short reason; the client shows the broker a page with one button to fix it (add a card, update
  the card, or restart the subscription), and shows a loan officer "Your brokerage's subscription needs attention. Please contact
  your broker." with nothing else.

The organization's billing state is kept in our database from Stripe's webhooks (6.4), so the rule never calls Stripe.

### 6.3 Users and quantity

- The quantity is the count of users in the organization with an accepted account. It is pushed to Stripe when a loan officer
  accepts an invite and when one is removed; Stripe prorates (a part-month on the next invoice for an addition, a credit for a
  removal).
- **New: the broker can remove a loan officer (my call — there is no way to remove one today, so per-user pricing would charge
  forever for someone who left).** Removing signs them out everywhere and stops their sign-in; their clients move to the broker;
  the row is kept so history and reports stay whole. The address is freed (moved to a separate "removed email" column) so the
  person can be invited again, here or by another brokerage; a re-invite makes a new account (**my call**).

### 6.4 Stripe events we act on

Delivered to a webhook route mounted before the JSON body parser (like `/api/integrations`), checked with the Stripe signing
secret, idempotent by event id: Checkout finished (store customer and subscription ids), subscription created/updated/deleted
(store status and trial end), invoice paid / payment failed (store status). Nothing else changes from a webhook.

### 6.5 Billing page (broker only)

Shows: users × $49.95 = the monthly total, the trial or tester end date, the next charge date, and one button **Manage billing**
that opens Stripe's customer portal (card, invoices, cancel). Cancelling in the portal ends at the period end; the app keeps
working until then.

### 6.6 Terms

- Two pages served by the app: `/terms` and `/privacy`, each with a version date. **I draft both; a lawyer reviews them before
  any real charge (open: Bill's lawyer).** They must state the price, the trial, the automatic monthly charge, how to cancel, and
  what happens to data after cancelling.
- A loan officer accepts the same two documents on the accept-invite page (the same checkbox), stored the same way (**my call**:
  goal 4 covers everyone who signs in).
- New version → existing users accept it on their next sign-in (a one-page "We've updated our terms" with **I agree**).
- Stripe Checkout also shows the terms link and requires the tick (Stripe's own terms-consent option).

### 6.7 Accounts that exist before this ships

- **Bill's own organization: exempt (my call).**
- Every other existing organization: a tester month from the day this ships, then the card ask (**my call**; the live site has a
  handful of accounts).

### 6.8 Cancelling and coming back (my calls)

- Cancelling during the 14-day trial or a tester month: no charge, and the app keeps working until the trial's end date.
- Cancelling a paid month: the app keeps working until the end of the paid month.
- Coming back after a cancellation or a lapse (including a tester whose month ended without a card): no second free trial. The
  page says "$49.95 per user per month, starting today, until you cancel." and the first charge is that day.

### 6.9 Emails

Stripe sends the receipt, the failed-payment notices and a reminder 7 days before a trial or tester month ends (card networks expect
a reminder before a free trial converts; some states' auto-renewal laws do too — the lawyer should confirm). Bill turns each on in
the Stripe dashboard after approving its wording. We send none of our own in this build.

## 7. What Bill does (the app can't)

1. Create the Stripe account (business details, bank account, statement name such as "BROKER RADAR"). Test mode first.
2. Put the Stripe secret key and webhook signing secret into Secret Manager himself (by the clipboard method; never pasted to me).
3. Choose the tester code and approve the wording of the pages in 6.1, 6.2, 6.5 and Stripe's emails.
4. Have a lawyer review the Terms and Privacy Policy.
5. Decide sales tax and how long a cancelled brokerage's data is kept (**open**).

## 8. Left to the builder

Table and column names, the webhook route path, how the tester code is stored (an environment value is enough), proration settings,
the exact moment the quantity is pushed, test layout. Tests use a fake Stripe client (no network). The local live check uses
Stripe test mode once Bill has created the account; nothing touches a live key until Bill says so.

## 9. Open (Bill)

- Sales tax (accountant). Data kept how long after cancelling. Statement name. The tester code itself.
- The wording on the new screens (6.1, 6.2, 6.5) — drafted with this design, approved before release.
