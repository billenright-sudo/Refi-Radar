# Switching on billing: the owner's checklist

Broker Radar charges each brokerage **$99 a month, which includes the broker, plus $49 a month for each additional user**, through
Stripe. Until every setting below is in place, billing stays **off** and the app works exactly as it does today: nobody sees a
price and nobody is charged.

Do the steps in order, the first time in Stripe's **test mode**, where only fake cards work and no real money moves. Each step ends
with a **Check**: don't go on until it passes.

`<APP_URL>` below means the app's web address. Today that is `https://refi-radar-194747178897.us-central1.run.app`.
Stripe sometimes renames its menus; if a name below doesn't match exactly, look for the closest one.

Before you start:

- The billing release must already be deployed (with your go, as always). Until it is, these settings do nothing.
- Read every email Stripe would send a customer (receipt, failed payment, trial reminder) in Stripe's preview, and approve its
  wording, before you switch that email on. Nothing should reach a customer that you haven't approved.

---

## 1. Create the Stripe account, in test mode

1. Go to stripe.com and create the account with the business details, the bank account payouts go to, and the statement name
   customers will see on their card bill (for example `BROKER RADAR`).
2. Make sure the dashboard is in **test mode** (Stripe may call it a "sandbox"): there is a switch or a banner at the top.

**Check:** the dashboard shows the test-mode (or sandbox) banner, and under **Developers → API keys** the secret key starts with
`sk_test_`.

## 2. Create the product and its one price

1. Go to **Product catalog → Add product**. Name: `Broker Radar`.
2. Add **one** price only:
   - **Recurring**, billed **monthly**, in **USD**. Not usage-based.
   - Pricing model: **Graduated** (under the tiered pricing options).
   - Tier 1: units **1 to 1**, **$99.00** per unit, no flat fee.
   - Tier 2: units **2 and up** (to infinity), **$49.00** per unit, no flat fee.
   - Don't add prices in any other currency.
3. Save, open the price, and copy its **price ID** (it starts with `price_`) into a note. You need it in step 8. It isn't a secret.

**Check:** the product shows exactly one price, monthly, USD, graduated: $99.00 for the first unit and $49.00 for each unit after
(so 1 user is $99, 3 users $197, 10 users $540).

(When the app starts it reads this price. If it isn't exactly this, billing stays off and the app's log says why.)

## 3. Add the webhook

The webhook is how Stripe tells the app that a card was added, a trial ended, a payment failed or a subscription was cancelled.

1. Go to **Developers → Webhooks → Add endpoint** (or "Add destination").
2. Endpoint URL: `<APP_URL>/api/billing/webhook`
3. Select these **five** events, and no others:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.updated`
4. Save. Leave the page open: in step 7 you copy its **signing secret** (it starts with `whsec_`).

**Check:** the endpoint is listed as enabled, with that URL and exactly those five events.

## 4. Set up the customer portal

The portal is Stripe's own page where a broker updates their card, sees invoices and cancels (the app's **Manage billing** button).

1. Go to **Settings → Billing → Customer portal**.
2. Turn **on**: update payment methods; invoice history; cancel subscriptions, set to cancel **at the end of the billing period**.
3. Turn **off**: changing quantities, switching plans (updating subscriptions), and promotion codes. A broker must never be able to
   change their own number of users or their price.
4. Save.

**Check:** open the portal preview. It shows the card, the invoices and a cancel button, and nothing that changes the quantity,
the plan or a promotion code.

## 5. Set the subscription rules

1. Go to **Settings → Billing → Subscriptions and emails** (the retry part may be under **Revenue recovery → Retries**).
2. Failed payments: retry for up to **2 weeks (14 days)**, then **cancel the subscription**.
3. Free trials: send the trial reminder **7 days** before a trial ends (only once you have approved its wording, see the top).
4. Save.

**Check:** the page shows retries for up to 2 weeks, then "cancel the subscription", and the trial reminder at 7 days.

## 6. Give Stripe the terms and privacy addresses

Stripe's card page asks every new customer to tick "I agree to the Terms of Service", and it needs the address of your terms for
that.

1. Go to **Settings → Business → Public details** (or "Public business information").
2. Terms of service: `<APP_URL>/terms`. Privacy policy: `<APP_URL>/privacy`.
3. Save.

**Check:** both addresses are saved there, and opening each one in your browser shows the page.

## 7. Put the two secrets into Secret Manager (the clipboard method)

The secret key and the webhook signing secret go straight from Stripe into Google's Secret Manager. Never paste them into a chat,
an email, a document or a file.

1. In Stripe, **Developers → API keys**, reveal the **secret key** and click to copy it.
2. In PowerShell, run (this reads the key from your clipboard, so nothing is typed or shown):

```powershell
Get-Clipboard | gcloud secrets create STRIPE_SECRET_KEY --project refi-radar-496318 --data-file=-
```

3. In Stripe, open the webhook from step 3, reveal its **signing secret** and click to copy it.
4. In PowerShell, run:

```powershell
Get-Clipboard | gcloud secrets create STRIPE_WEBHOOK_SECRET --project refi-radar-496318 --data-file=-
```

5. Copy any ordinary word, so the secret is no longer on your clipboard.
6. Find the account the app runs as:

```powershell
gcloud run services describe refi-radar --region us-central1 --project refi-radar-496318 --format="value(spec.template.spec.serviceAccountName)"
```

7. Let that account read both secrets (put the address from step 6 in place of `<SERVICE_ACCOUNT>`; run both lines):

```powershell
gcloud secrets add-iam-policy-binding STRIPE_SECRET_KEY --project refi-radar-496318 --member="serviceAccount:<SERVICE_ACCOUNT>" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding STRIPE_WEBHOOK_SECRET --project refi-radar-496318 --member="serviceAccount:<SERVICE_ACCOUNT>" --role="roles/secretmanager.secretAccessor"
```

If a secret already exists (for example when you switch to the live keys in step 10), use `versions add` instead of `create`:

```powershell
Get-Clipboard | gcloud secrets versions add STRIPE_SECRET_KEY --project refi-radar-496318 --data-file=-
```

**Check:** this lists one enabled version for each secret, without ever showing the secret itself:

```powershell
gcloud secrets versions list STRIPE_SECRET_KEY --project refi-radar-496318
gcloud secrets versions list STRIPE_WEBHOOK_SECRET --project refi-radar-496318
```

## 8. Give the app its billing settings

Fill in your values, then run the command below. It keeps every setting the app already has and adds these:

- `STRIPE_PRICE_ID`: the price ID from step 2.
- `BILLING_EXEMPT_EMAILS`: the login address of each brokerage that never pays (your own), separated by commas.
- `BILLING_TESTER_CODE`: the private code testers type at sign-up for a free month. Leave it out for no code.
- `BILLING_TESTER_MAX_USES`: how many brokerages may use the code (25 if left out).
- `BILLING_TESTER_EXPIRES`: the last day the code works, as `YYYY-MM-DD` (no end date if left out).
- `FEEDBACK_TO`: the inbox that receives testers' feedback.

The `^;^` at the start tells Google the settings are separated by semicolons, so the commas inside the exempt list are kept.

```powershell
gcloud run services update refi-radar --region us-central1 --project refi-radar-496318 --update-secrets="STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest" --update-env-vars="^;^STRIPE_PRICE_ID=price_REPLACE_ME;BILLING_EXEMPT_EMAILS=you@example.com;BILLING_TESTER_CODE=REPLACE_ME;BILLING_TESTER_MAX_USES=25;BILLING_TESTER_EXPIRES=2026-12-31;FEEDBACK_TO=you@example.com"
```

**Check:** open `<APP_URL>/api/billing/public` in your browser. It shows `{"enabled":true}`. If it shows `{"enabled":false}`, read
the reason in the log (the line starting `[billing] off:`), fix that step, and run the command again:

```powershell
gcloud run services logs read refi-radar --region us-central1 --project refi-radar-496318 --limit 100
```

When billing switches on, every brokerage that existed before gets a free month from that day, then is asked for a card. Stripe
doesn't email these few brokers, so tell them yourself.

## 9. One full run in test mode, before any live key

Use addresses you control that are **not** on the exempt list. Test cards take any future expiry date, any CVC and any ZIP.

1. **Sign up and add a card.** Sign up a new brokerage, tick the terms, choose **Start your free trial**, then **Add card and start
   trial**. On Stripe's page use card `4242 4242 4242 4242`.
   **Check:** you land back on the app's Home page. In Stripe, **Customers** shows the brokerage with a trialing subscription,
   quantity 1, $99 a month, first charge in 14 days. The app's Billing page says the same.
2. **Add a user.** Invite a loan officer and accept the invitation.
   **Check:** in Stripe the subscription's quantity is now 2, and the app's Billing page shows $99 + 1 additional user × $49 = $148
   a month.
3. **The tester code.** Sign up a second brokerage with the tester code and choose **Start testing** (no card).
   **Check:** you are in the app at once. In Stripe the second brokerage has a trialing subscription with no card, ending in 30 days.
4. **Cancel.** In the first brokerage, go to Billing → **Manage billing** → cancel.
   **Check:** Stripe shows the subscription set to cancel at the end of the trial, and the app keeps working until then.
5. **A card that fails.** Sign up a third brokerage and add card `4000 0000 0000 0341` (it is accepted, then fails when charged).
   In Stripe, open its subscription and end the trial now, so Stripe tries to charge it.
   **Check:** the payment fails, the subscription shows "past due", and the app shows "Your last payment didn't go through. Update
   your card to keep Broker Radar running." with **Update card**.

**Check for the whole run:** in **Developers → Webhooks**, every delivery to the endpoint succeeded, and no email went out that you
hadn't approved.

## 10. Switch to the live keys

Only after step 9 passes, the wording is approved, and a lawyer has reviewed the Terms of Service and Privacy Policy.

1. Switch the Stripe dashboard to **live mode**. Live mode has its own products, webhooks and settings, so repeat steps 2 to 6 there.
2. Repeat step 7 with the **live** secret key (it starts with `sk_live_`) and the live webhook's signing secret, using
   `versions add` because the secrets already exist.
3. Repeat step 8 with the **live** price ID.

**Check:** `<APP_URL>/api/billing/public` shows `{"enabled":true}`, the log shows `[billing] on`, and the next real sign-up appears
in Stripe's live dashboard.

---

## To switch billing off again

Removing the price setting turns billing off (the app restarts without it): the app stops asking for cards, nothing is deleted and
nobody is locked out. **Stripe keeps charging the subscriptions that already exist**, though: to stop a brokerage's charges, cancel
its subscription in Stripe. While billing is off the app also refuses Stripe's webhook, so Stripe will warn you about failed
deliveries; you can turn the webhook off in Stripe for that time.

```powershell
gcloud run services update refi-radar --region us-central1 --project refi-radar-496318 --remove-env-vars=STRIPE_PRICE_ID
```

**Check:** `<APP_URL>/api/billing/public` shows `{"enabled":false}`.
