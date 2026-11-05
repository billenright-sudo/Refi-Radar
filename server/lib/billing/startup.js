"use strict";
// Switching billing on when the server starts (spec §6.4 H5, §6.7). index.js calls startBilling before it listens and puts what comes
// back on the app (app.set("billingConfig"), app.set("billingGateway")). Billing is on only when all three Stripe settings are there
// AND the configured Stripe price is exactly the one the app shows ($99 a month for the first user, $49 for each additional one, US
// dollars, per user, monthly). Anything else leaves billing off, with "[billing] off: <reason>" in the log, so nobody is ever
// charged a price the app doesn't show. The check waits about 10 seconds at most: a slow Stripe can't hold up the start.
// Nothing here logs a setting's value; an error's message is logged with anything that looks like a Stripe key taken out.
const { billingConfig, BASE_CENTS, ADDITIONAL_CENTS, TESTER_DAYS } = require("./config");

const DAY_MS = 24 * 3600_000;
const CHECK_TIMEOUT_MS = 10_000;
const STRIPE_SETTINGS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"];

// Stripe masks keys in its own messages, but a message of ours or a library's might not.
const safeMessage = (err) => String(err?.message ?? err).replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_*]+|\bwhsec_[A-Za-z0-9_*]+/g, "[key]");

// The last tier comes back from Stripe with up_to null (it is "inf" only when a price is created).
const endless = (upTo) => upTo === null || upTo === "inf";

// -> { ok: true } | { ok: false, reason }. Fails closed: anything not positively the right price is refused, and so is a price
// that can't be read.
async function verifyPrice(gateway, priceId) {
  let price;
  try {
    price = await gateway.retrievePrice(priceId);
  } catch (err) {
    return { ok: false, reason: `the Stripe price couldn't be read (${safeMessage(err)})` };
  }
  if (!price || typeof price !== "object") return { ok: false, reason: "the Stripe price couldn't be read" };
  // An archived price can't start a subscription: billing on with one would ask every new broker for a card they couldn't add.
  if (price.active !== true) return { ok: false, reason: "the Stripe price is archived (not active)" };
  if (price.interval !== "month") return { ok: false, reason: "the Stripe price isn't charged once a month" };
  if (price.currency !== "usd") return { ok: false, reason: "the Stripe price isn't in US dollars" };
  if (price.otherCurrencies !== false) return { ok: false, reason: "the Stripe price also charges in other currencies" };
  if (price.usageType !== "licensed") return { ok: false, reason: "the Stripe price charges for usage, not per user" };
  if (price.tiersMode !== "graduated") return { ok: false, reason: "the Stripe price isn't a graduated (tiered) price" };
  const tiers = Array.isArray(price.tiers) ? price.tiers : [];
  const right = tiers.length === 2
    && tiers[0]?.upTo === 1 && tiers[0]?.unitAmount === BASE_CENTS
    && endless(tiers[1]?.upTo) && tiers[1]?.unitAmount === ADDITIONAL_CENTS;
  if (!right) return { ok: false, reason: "the Stripe price isn't $99 for the first user and $49 for each additional user" };
  return { ok: true };
}

// What switching billing on does to the organizations already there (spec §6.7). Off: nothing. On:
//   - every organization from before billing (billing_status NULL: nothing has told us otherwise) gets a free 30-day month from
//     today and the status 'none', once (the status is never NULL again). It is not a tester-code sign-up, so it doesn't count
//     against the code's limit. These brokerages have no Stripe subscription yet, so Stripe sends them no reminder (H13).
//   - billing_exempt follows BILLING_EXEMPT_EMAILS on every start: an organization is exempt exactly while its broker's address is
//     on the list (any case), so taking an address off the list ends the exemption.
function applyBillingStartup(db, config, nowMs) {
  if (!config || !config.enabled) return;
  const emails = [...new Set((config.exemptEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  db.transaction(() => {
    db.prepare("UPDATE organizations SET billing_status = 'none', billing_tester_until = ? WHERE billing_status IS NULL")
      .run(nowMs + TESTER_DAYS * DAY_MS);
    if (!emails.length) {
      db.prepare("UPDATE organizations SET billing_exempt = 0 WHERE billing_exempt <> 0").run();
      return;
    }
    db.prepare(`
      UPDATE organizations SET billing_exempt = CASE WHEN id IN (
        SELECT org_id FROM users WHERE role = 'broker' AND removed_at IS NULL AND lower(email) IN (${emails.map(() => "?").join(", ")})
      ) THEN 1 ELSE 0 END
    `).run(...emails);
  })();
}

// -> { config, gateway }: config.enabled is true only when the price check passed and the start-up was saved; gateway is null
// whenever billing is off. makeGateway(config) builds the Stripe gateway (index.js passes createStripeGateway; tests a fake).
// Never throws.
async function startBilling(db, env, makeGateway, { timeoutMs = CHECK_TIMEOUT_MS, nowMs } = {}) {
  const config = billingConfig(env || {});
  config.enabled = false;
  const off = (reason) => {
    console.warn(`[billing] off: ${reason}`);
    return { config, gateway: null };
  };

  if (!config.stripeConfigured) {
    // A deployment that never set billing up says nothing; one with some of the settings is told which are missing (names only).
    const missing = STRIPE_SETTINGS.filter((name) => !(typeof env?.[name] === "string" && env[name].trim()));
    return missing.length < STRIPE_SETTINGS.length ? off(`${missing.join(", ")} not set`) : { config, gateway: null };
  }

  let gateway;
  try {
    gateway = makeGateway(config);
  } catch (err) {
    return off(`the Stripe connection couldn't be set up (${safeMessage(err)})`);
  }

  let timer;
  const tooSlow = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `the Stripe price check took longer than ${timeoutMs / 1000} s` }), timeoutMs);
  });
  const check = await Promise.race([verifyPrice(gateway, config.priceId), tooSlow]);
  clearTimeout(timer);
  if (!check.ok) return off(check.reason);

  config.enabled = true;
  try {
    applyBillingStartup(db, config, nowMs ?? Date.now());
  } catch (err) {
    // Without the free month, every brokerage from before billing would be locked at once: billing stays off instead.
    config.enabled = false;
    return off(`the billing start-up couldn't be saved (${safeMessage(err)})`);
  }
  console.log("[billing] on");
  return { config, gateway };
}

module.exports = { verifyPrice, applyBillingStartup, startBilling, CHECK_TIMEOUT_MS };
