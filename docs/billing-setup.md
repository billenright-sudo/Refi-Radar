# Switching on billing: the owner's checklist

Broker Radar charges each brokerage **$99 a month, which includes the broker, plus $49 a month for each additional user**, through
Stripe. Until the live settings in Part 4 are in place, billing stays **off** on the live app, and the app works exactly as it does
today: nobody sees a price and nobody is charged.

There are four parts, done in order:

1. **Approve the wording**: every line customers will read.
2. **Set up Stripe in test mode**, where only fake cards work and no real money moves.
3. **Test the whole thing on your own computer**, with your assistant alongside you. The live app is never touched: test keys go
   only into your computer's settings file, and the test brokerages live only in a test database on your computer.
4. **Switch on the live app with the live keys.** Do this only after a lawyer has reviewed the Terms of Service and Privacy
   Policy, and after the test run has passed.

Each step ends with a **Check**. Don't go on until it passes.

`<APP_URL>` below means the live app's web address. Today that is `https://refi-radar-194747178897.us-central1.run.app`.
Stripe sometimes renames its menus. If a name below doesn't match exactly, look for the closest one.

**The secret keys are never pasted anywhere.** Not into a chat, an email, a document, or a command you type. Each one goes from
Stripe to its place through your clipboard, using the commands below, and never appears on screen.

---

# Part 1: Approve the wording

## 1. Approve every line customers will read

Before any test, read and approve each of these. Your assistant can show you each one.

- The new lines in the app: the sign-up price line, "Start your free trial", the test-month page and its banner, the past-due
  banner, the lock pages, the Billing page lines, "We've updated our terms", Send feedback, and the remove-a-loan-officer
  confirmations.
- **Our own confirmation email**: the one Broker Radar sends when a brokerage's free trial or test month starts.
- Stripe's emails to customers: the receipt, the failed-payment notice and the trial reminder. Read each in Stripe's email preview
  once your Stripe account exists (step 2). Switch each one on only after you have approved it.

**Check:** you have said yes to each line and each email, or asked for changes and then approved the changed wording.

---

# Part 2: Set up Stripe in test mode

## 2. Create the Stripe account, in test mode

1. Go to stripe.com and create the account. Enter the business details, the bank account payouts go to, and the statement name
   customers will see on their card bill (for example `BROKER RADAR`).
2. Make sure the dashboard is in **test mode**. Stripe may call it a "sandbox"; there is a switch or a banner at the top.

**Check:** the dashboard shows the test-mode (or sandbox) banner, and under **Developers → API keys** the secret key starts with
`sk_test_`.

## 3. Create the product and its one price

1. Go to **Product catalog → Add product**. Name: `Broker Radar`.
2. Add **one** price only:
   - **Recurring**, billed **monthly**, in **USD**. Not usage-based.
   - Pricing model: **Graduated** (under the tiered pricing options).
   - Tier 1: units **1 to 1**, **$99.00** per unit, no flat fee.
   - Tier 2: units **2 and up** (to infinity), **$49.00** per unit, no flat fee.
   - Don't add prices in any other currency.
3. Save. Open the price and copy its **price ID** into a note. It starts with `price_`. It isn't a secret.

**Check:** the product shows exactly one price: monthly, USD, graduated, $99.00 for the first unit and $49.00 for each unit after.
That makes 1 user $99, 3 users $197 and 10 users $540.

When the app starts, it reads this price. If the price isn't exactly this, or it has been archived, billing stays off and the app's
log says why.

## 4. Set up the customer portal

The portal is Stripe's own page where a broker updates their card, sees invoices and cancels. It is the app's **Manage billing**
button.

1. Go to **Settings → Billing → Customer portal**.
2. Turn **on**:
   - updating payment methods;
   - invoice history;
   - cancelling subscriptions, set to cancel **at the end of the billing period**.
3. Turn **off** changing quantities, switching plans (updating subscriptions) and promotion codes. A broker must never be able to
   change their own number of users or their price.
4. Save.

**Check:** open the portal preview. It shows the card, the invoices and a cancel button. It shows nothing that changes the
quantity, the plan or a promotion code.

## 5. Set the subscription rules

1. Go to **Settings → Billing → Subscriptions and emails**. The retry part may be under **Revenue recovery → Retries**.
2. Failed payments: retry for up to **2 weeks (14 days)**, then **cancel the subscription**.
3. Free trials: send the trial reminder **7 days** before a trial ends, once you have approved its wording (step 1).
4. Save.

**Check:** the page shows retries for up to 2 weeks, then "cancel the subscription", and the trial reminder at 7 days.

## 6. Give Stripe the terms and privacy addresses

Stripe's card page asks every new customer to tick "I agree to the Terms of Service", and it needs the address of your terms to do
that.

1. Go to **Settings → Business → Public details** (or "Public business information").
2. Enter `<APP_URL>/terms` as the Terms of service and `<APP_URL>/privacy` as the Privacy policy.
3. Save.

**Check:** both addresses are saved there.

---

# Part 3: Test the whole thing on your own computer

Everything in this part happens on your computer. The live app keeps running as it is, with billing off.

## 7. Install the Stripe CLI and sign in

The Stripe CLI is Stripe's own small program. While you test, it passes Stripe's messages (a card was added, a trial ended) on to
the copy of Broker Radar running on your computer.

1. Install it by following Stripe's page "Get started with the Stripe CLI" (docs.stripe.com/stripe-cli), Windows section.
2. In PowerShell, run the command below. A browser page opens: confirm there, in test mode.

```powershell
stripe login
```

**Check:** this prints a version number:

```powershell
stripe --version
```

`stripe login` should also have said that the CLI is now configured for your account.

## 8. Put the test settings into your computer's settings file (the clipboard method)

The settings file is the `.env` file in the app's `server` folder on your computer. Your assistant will tell you the exact folder.
Each command below adds one line to the end of that file. If you ever repeat a command, the newest line is the one that counts.

1. Open PowerShell in the app's `server` folder:

```powershell
cd <the app's folder>\server
```

2. In Stripe (test mode), go to **Developers → API keys**, reveal the **secret key** (it starts with `sk_test_`), and click to copy
   it. Then run:

```powershell
Add-Content -Path .env -Value "`nSTRIPE_SECRET_KEY=$(Get-Clipboard)"
```

3. Ask Stripe's CLI for its test webhook secret, put it on your clipboard, and add it. Two commands; nothing is shown:

```powershell
stripe listen --print-secret | Set-Clipboard
Add-Content -Path .env -Value "`nSTRIPE_WEBHOOK_SECRET=$(Get-Clipboard)"
```

4. Add the test price ID from step 3, a tester code for the test, and the address your computer's copy of the app opens at. None
   of these is a secret, so you can type them (replace `price_REPLACE_ME` with your price ID):

```powershell
Add-Content -Path .env -Value "`nSTRIPE_PRICE_ID=price_REPLACE_ME"
Add-Content -Path .env -Value "`nBILLING_TESTER_CODE=test-month"
Add-Content -Path .env -Value "`nAPP_URL=http://localhost:5173"
```

5. Copy any ordinary word, so the secret is no longer on your clipboard.

**Check:** this lists the setting **names** in the file, never their values. It must show `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `BILLING_TESTER_CODE` and `APP_URL`. It must also show `EMAIL_USER` and `EMAIL_PASS`,
because sign-up sends its link by email; if those two are missing, your assistant sets them up with you first.

```powershell
Select-String -Path .env -Pattern "^(STRIPE_|BILLING_|APP_URL|EMAIL_)" | ForEach-Object { $_.Line.Split("=")[0] } | Sort-Object -Unique
```

## 9. Start everything on your computer

You need three PowerShell windows, kept open for the whole test. Your assistant can start them for you.

1. **Window 1, Stripe's messages.** This passes Stripe's five billing messages to your computer:

```powershell
stripe listen --forward-to localhost:8080/api/billing/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.updated
```

2. **Window 2, the app's server**, using a test database of its own, so your everyday data on this computer is left alone:

```powershell
cd <the app's folder>\server
$env:DATA_DIR = "$HOME\broker-radar-billing-test"
node index.js
```

3. **Window 3, the app's pages:**

```powershell
cd <the app's folder>\client
npm run dev
```

**Check:**
- Window 1 says it is ready.
- Window 2 shows `[billing] on` and `RefiRadar v2 running on port 8080`. If it shows `[billing] off:` with a reason instead, fix
  that step and start Window 2 again.
- http://localhost:5173 opens the Broker Radar sign-in page in your browser.

## 10. The full test run

Use addresses you control. Test cards take any future expiry date, any CVC and any ZIP.

1. **Sign up and add a card.** At http://localhost:5173, sign up a new brokerage, tick the terms, choose **Start your free trial**,
   then **Add card and start trial**. On Stripe's page, use card `4242 4242 4242 4242`.
   **Check:** you land back on the app's Home page. In Stripe (test mode), **Customers** shows the brokerage with a trialing
   subscription, quantity 1, $99 a month, first charge in 14 days. The app's Billing page says the same, and our confirmation
   email arrives with the wording you approved.
2. **Add a user.** Invite a loan officer and accept the invitation.
   **Check:** in Stripe the subscription's quantity is now 2, and the app's Billing page shows $99 + 1 additional user × $49 = $148
   a month.
3. **The tester code.** Sign up a second brokerage with the tester code `test-month`, and choose **Start testing** (no card).
   **Check:** you are in the app at once. In Stripe, the second brokerage has a trialing subscription with no card, ending in 30
   days.
4. **Cancel.** In the first brokerage, go to Billing → **Manage billing** → cancel.
   **Check:** Stripe shows the subscription set to cancel at the end of the trial, and the app keeps working until then.
5. **A card that fails.** Sign up a third brokerage and add card `4000 0000 0000 0341`. It is accepted, then fails when charged.
   In Stripe, open its subscription and end the trial now, so Stripe tries to charge it.
   **Check:** the payment fails, the subscription shows "past due", and the app shows "Your last payment didn't go through. Update
   your card to keep Broker Radar running." with **Update card**.

**Check for the whole run:**
- Window 1 shows every message passed on with `[200]`.
- No email went out that you hadn't approved.
- The live app is untouched: `<APP_URL>/api/billing/public` still shows `{"enabled":false}`.

## 11. Finish the test

1. Close the three windows.
2. The test brokerages stay only in the test database folder from step 9. Your assistant can delete that folder for you.

**Check:** `<APP_URL>/api/billing/public` still shows `{"enabled":false}`.

---

# Part 4: Switch on the live app (live keys only)

Do this only when all three are true:
- the test run (step 10) has passed;
- a lawyer has reviewed the Terms of Service and Privacy Policy;
- you have approved all the wording (step 1).

The live app only ever receives **live** keys. The moment billing switches on there, every brokerage that already exists gets its
free month, starting that day, and is then asked for a card. Stripe doesn't email these few brokers, so tell them yourself.

The billing release must already be deployed to the live app, with your go, as always. Until it is, these settings do nothing.

## 12. Set up Stripe in live mode

Live mode has its own products, portal settings and subscription rules, separate from test mode.

1. Switch the Stripe dashboard to **live mode**.
2. Repeat steps 3, 4 and 5 there. Copy the **live** price ID into your note.
3. Look at the addresses from step 6: they are shared by both modes, so they should already be there.

**Check:** in live mode there is exactly one Broker Radar price, as in step 3. The portal and the subscription rules match steps
4 and 5.

## 13. Add the live webhook

The webhook is how Stripe tells the live app that a card was added, a trial ended, a payment failed or a subscription was
cancelled.

1. In live mode, go to **Developers → Webhooks → Add endpoint** (or "Add destination").
2. Endpoint URL: `<APP_URL>/api/billing/webhook`
3. Select these **five** events, and no others:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.updated`
4. Save. Leave the page open: in step 14 you copy its **signing secret** (it starts with `whsec_`).

**Check:** the live endpoint is listed as enabled, with that URL and exactly those five events.

## 14. Put the two live secrets into Secret Manager (the clipboard method)

1. In Stripe (live mode), go to **Developers → API keys**, reveal the **secret key** (it starts with `sk_live_`), and click to copy
   it. Then run:

```powershell
Get-Clipboard | gcloud secrets create STRIPE_SECRET_KEY --project refi-radar-496318 --data-file=-
```

2. In Stripe, open the live webhook from step 13, reveal its **signing secret** and click to copy it. Then run:

```powershell
Get-Clipboard | gcloud secrets create STRIPE_WEBHOOK_SECRET --project refi-radar-496318 --data-file=-
```

3. Copy any ordinary word, so the secret is no longer on your clipboard.
4. Find the account the live app runs as:

```powershell
gcloud run services describe refi-radar --region us-central1 --project refi-radar-496318 --format="value(spec.template.spec.serviceAccountName)"
```

5. Let that account read both secrets. Put the address from item 4 in place of `<SERVICE_ACCOUNT>`, and run both lines:

```powershell
gcloud secrets add-iam-policy-binding STRIPE_SECRET_KEY --project refi-radar-496318 --member="serviceAccount:<SERVICE_ACCOUNT>" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding STRIPE_WEBHOOK_SECRET --project refi-radar-496318 --member="serviceAccount:<SERVICE_ACCOUNT>" --role="roles/secretmanager.secretAccessor"
```

If a secret already exists (when you replace a key later, say), use `versions add` instead of `create`:

```powershell
Get-Clipboard | gcloud secrets versions add STRIPE_SECRET_KEY --project refi-radar-496318 --data-file=-
```

**Check:** this lists one enabled version for each secret, without ever showing the secret itself:

```powershell
gcloud secrets versions list STRIPE_SECRET_KEY --project refi-radar-496318
gcloud secrets versions list STRIPE_WEBHOOK_SECRET --project refi-radar-496318
```

## 15. Give the live app its billing settings

Fill in your values, then run the command below. It keeps every setting the app already has and adds these:

- `STRIPE_PRICE_ID`: the **live** price ID from step 12.
- `BILLING_EXEMPT_EMAILS`: the login address of each brokerage that never pays (your own), separated by commas.
- `BILLING_TESTER_CODE`: the private code testers type at sign-up for a free month. Leave it out for no code.
- `BILLING_TESTER_MAX_USES`: how many brokerages may use the code. If you leave it out, it is 25.
- `BILLING_TESTER_EXPIRES`: the last day the code works, as `YYYY-MM-DD`. If you leave it out, there is no end date.
- `FEEDBACK_TO`: the inbox that receives testers' feedback.

The `^;^` at the start tells Google that the settings are separated by semicolons, so the commas inside the exempt list are kept.

```powershell
gcloud run services update refi-radar --region us-central1 --project refi-radar-496318 --update-secrets="STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest,STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest" --update-env-vars="^;^STRIPE_PRICE_ID=price_REPLACE_ME;BILLING_EXEMPT_EMAILS=you@example.com;BILLING_TESTER_CODE=REPLACE_ME;BILLING_TESTER_MAX_USES=25;BILLING_TESTER_EXPIRES=2026-12-31;FEEDBACK_TO=you@example.com"
```

**Check:** open `<APP_URL>/api/billing/public` in your browser. It shows `{"enabled":true}`. The log shows `[billing] on`. The next
real sign-up appears in Stripe's live dashboard.

If the page shows `{"enabled":false}`, read the reason in the log (the line starting `[billing] off:`), fix that step, and run the
command again. To read the log:

```powershell
gcloud run services logs read refi-radar --region us-central1 --project refi-radar-496318 --limit 100
```

---

## Another way to test (optional): a separate staging service

Instead of your own computer, the test in Part 3 can run on a second Cloud Run service with its own database (its own storage
bucket), never the live one's. It costs a little more to set up; your assistant can do it if you prefer. The rule is the same:
test keys go only to that staging service, and the live app only ever receives live keys.

## To switch billing off again

Removing the price setting turns billing off; the app restarts without it. The app stops asking for cards, nothing is deleted, and
nobody is locked out.

**Stripe keeps charging the subscriptions that already exist.** To stop a brokerage's charges, cancel its subscription in Stripe.
While billing is off, the app also refuses Stripe's webhook, so Stripe will warn you about failed deliveries. You can turn the
webhook off in Stripe for that time.

```powershell
gcloud run services update refi-radar --region us-central1 --project refi-radar-496318 --remove-env-vars=STRIPE_PRICE_ID
```

**Check:** `<APP_URL>/api/billing/public` shows `{"enabled":false}`.
