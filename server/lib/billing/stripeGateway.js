"use strict";
// The one place that talks to Stripe. Everything else in the app (and every test) goes through a gateway object with these methods,
// so tests hand in a fake with app.set("billingGateway", fake) and nothing ever reaches the network. Card numbers never pass through
// here: Stripe Checkout and the customer portal collect them on Stripe's own pages. Nothing here logs; callers log err.message only.
// Ids go to Stripe as strings; times come back as epoch ms (Stripe's own are whole seconds).
const Stripe = require("stripe");

const idOf = (v) => (typeof v === "string" ? v : v && typeof v.id === "string" ? v.id : null);
const seconds = (ms) => Math.floor(ms / 1000);
const ENDED = new Set(["canceled", "incomplete_expired"]);

function createStripeGateway({ secretKey }) {
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });

  return {
    // For the start-up price check (H5). Fails closed: a price billed every N months reads "N month", and a tier carrying a flat fee
    // has no single unitAmount (null), so neither can pass a check for "monthly, $99 then $49".
    async retrievePrice(id) {
      const price = await stripe.prices.retrieve(id, { expand: ["tiers"] });
      const recurring = price.recurring;
      const interval = !recurring ? null : recurring.interval_count === 1 ? recurring.interval : `${recurring.interval_count} ${recurring.interval}`;
      return {
        currency: price.currency,
        interval,
        tiersMode: price.tiers_mode ?? null,
        tiers: (price.tiers || []).map((t) => ({ upTo: t.up_to, unitAmount: t.flat_amount ? null : t.unit_amount })),
      };
    },

    // Stripe's own card page. The quantity is the user count; `plan` is checkoutPlan's answer (14 days, until a date, or no trial).
    // The organization rides along twice: on the session (client_reference_id) and on the subscription it makes (metadata.org_id).
    async createCheckout({ customerId, email, orgId, priceId, quantity, plan, successUrl, cancelUrl }) {
      const subscriptionData = { metadata: { org_id: String(orgId) } };
      if (plan?.trial === "days") subscriptionData.trial_period_days = plan.days;
      else if (plan?.trial === "until") subscriptionData.trial_end = seconds(plan.endMs);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity }],
        payment_method_collection: "always",
        consent_collection: { terms_of_service: "required" },
        allow_promotion_codes: false,
        client_reference_id: String(orgId),
        subscription_data: subscriptionData,
        success_url: successUrl,
        cancel_url: cancelUrl,
        ...(customerId ? { customer: customerId } : { customer_email: email }),
      });
      return { id: session.id, url: session.url };
    },

    async retrieveCheckout(id) {
      const session = await stripe.checkout.sessions.retrieve(id);
      return { status: session.status, url: session.url, customerId: idOf(session.customer), subscriptionId: idOf(session.subscription) };
    },

    // The whole subscription, for storeSubscription (lib/billing/events.js).
    retrieveSubscription(id) {
      return stripe.subscriptions.retrieve(id);
    },

    // Stripe's customer portal; `updateCard` opens it straight on the card form.
    async createPortal({ customerId, returnUrl, updateCard }) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        ...(updateCard ? { flow_data: { type: "payment_method_update" } } : {}),
      });
      return { url: session.url };
    },

    // The tester month: a customer and a trialing subscription with no card, which cancels itself at the end of the month if no
    // card was added by then. `subscription` is the whole object, for storeSubscription.
    async createTesterSubscription({ email, orgId, orgName, priceId, quantity, trialEndMs }) {
      const customer = await stripe.customers.create({ email, name: orgName, metadata: { org_id: String(orgId) } });
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: priceId, quantity }],
        trial_end: seconds(trialEndMs),
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { org_id: String(orgId) },
      });
      return {
        customerId: customer.id,
        subscriptionId: subscription.id,
        itemId: subscription.items?.data?.[0]?.id ?? null,
        status: subscription.status,
        trialEndMs: subscription.trial_end ? subscription.trial_end * 1000 : null,
        subscription,
      };
    },

    // The user count (H2). Stripe prorates the change.
    async setQuantity({ subscriptionId, itemId, quantity }) {
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: itemId, quantity }],
        proration_behavior: "create_prorations",
      });
    },

    // A second subscription for one brokerage (H1): cancel it now, and refund whatever its latest invoice took. It is read first, so a
    // subscription that has already ended is neither cancelled again nor refunded.
    async cancelAndRefund(subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (ENDED.has(sub.status)) return { cancelled: false, refunded: false };
      await stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false });
      const invoiceId = idOf(sub.latest_invoice);
      if (!invoiceId) return { cancelled: true, refunded: false };
      let refunded = false;
      const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: "paid" });
      for (const p of payments.data) {
        if (!(p.amount_paid > 0)) continue;   // a trial's $0 invoice took nothing
        const paymentIntent = idOf(p.payment?.payment_intent);
        const charge = idOf(p.payment?.charge);
        if (paymentIntent) await stripe.refunds.create({ payment_intent: paymentIntent });
        else if (charge) await stripe.refunds.create({ charge });
        else continue;
        refunded = true;
      }
      return { cancelled: true, refunded };
    },

    // The billing email follows the broker's login email (H14).
    async updateCustomerEmail(customerId, email) {
      await stripe.customers.update(customerId, { email });
    },

    // Throws when the signature is missing, wrong or too old. Offline: an HMAC over the raw bytes.
    constructEvent(rawBody, signature, secret) {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    },
  };
}

module.exports = { createStripeGateway };
