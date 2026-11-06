// What the billing screens say. Pure functions: App.jsx draws them. Prices come from the server's own numbers where it sends them.
// All wording here is draft until Bill approves it.

export const SPEC_LINE = "$0 today. Your 14-day free trial starts now. From day 15 we'll charge $99 a month, plus $49 for each additional user, until you cancel. Cancel any time in Billing.";
export const RETURNING_LINE = "$99 a month, plus $49 for each additional user, starting today, until you cancel.";
export const LO_LOCKED_LINE = "Your brokerage's subscription needs attention. Please contact your broker.";
// The gate for a broker whose free month (a tester month or the one billing gave at start-up) ended with no card: Checkout charges
// today, so the page says so (round 2, item 4). DRAFT for Bill.
export const FREE_ENDED_HEADING = "Your free month has ended";
const PAST_DUE_LINE = "Your last payment didn't go through. Update your card to keep Broker Radar running.";

const BASE_CENTS = 9900;
const ADDITIONAL_CENTS = 4900;

// Which gate page replaces the app: null | "terms" | "start_trial" | "free_ended" | "ended" | "lo_locked". `billing` is the broker's
// billing object from /api/billing/status: its freeUsed (the one free period is behind the brokerage) turns a card ask into
// "free_ended", which says the charge starts today (round 2, item 4).
export function gateScreen(access, role, billing = null) {
  if (!access || access.ok) return null;
  if (access.reason === "terms") return "terms";
  if (access.reason === "needs_card" || access.reason === "ended") {
    if (role !== "broker") return "lo_locked";
    if (access.reason === "ended") return "ended";
    return billing && billing.freeUsed === true ? "free_ended" : "start_trial";
  }
  return null;
}

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function money(cents) {
  const dollars = cents / 100;
  return "$" + (Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2));
}

export function bannerText(banner, testerUntilMs) {
  if (banner === "tester_ending") return `Your free test month ends on ${formatDate(testerUntilMs)}. Add a card to keep going.`;
  if (banner === "past_due") return PAST_DUE_LINE;
  return null;
}

export function totalLine(users) {
  const extra = Math.max(0, (Number(users) || 1) - 1);
  if (extra === 0) return `Brokerage ${money(BASE_CENTS)} a month`;
  const total = BASE_CENTS + ADDITIONAL_CENTS * extra;
  return `Brokerage ${money(BASE_CENTS)} + ${extra} additional ${extra === 1 ? "user" : "users"} × ${money(ADDITIONAL_CENTS)} = ${money(total)} a month`;
}

const ENDED = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

export function billingLines(billing, nowMs) {
  if (billing.exempt) return ["No charge for this account."];
  const lines = [totalLine(billing.users)];
  const live = ["trialing", "active", "past_due"].includes(billing.status);
  if (live && billing.cancelAtPeriodEnd && billing.periodEnd) {
    lines.push(`Cancelled. Broker Radar keeps working until ${formatDate(billing.periodEnd)}.`);
  } else if (billing.status === "past_due") {
    lines.push(PAST_DUE_LINE);
  } else if (billing.status === "trialing" && billing.trialEnd) {
    lines.push(`Free trial until ${formatDate(billing.trialEnd)}. First charge on ${formatDate(billing.trialEnd)}.`);
  } else if (billing.status === "active" && billing.periodEnd) {
    lines.push(`Next charge on ${formatDate(billing.periodEnd)}.`);
  } else if (!live && !ENDED.has(billing.status) && billing.testerUntil > nowMs) {
    lines.push(`Free test month until ${formatDate(billing.testerUntil)}.`);
  }
  return lines;
}

// A tester month with no card yet (the banner and the Billing page): what adding one starts, and when (I4). DRAFT for Bill.
// null in every other state. The date is the month's end; the total is the server's own number for today's user count.
export function testerPriceLine(billing, nowMs = Date.now()) {
  if (!billing || !billing.enabled || billing.exempt || billing.hasCard || billing.cancelAtPeriodEnd) return null;
  if (!(billing.testerUntil > nowMs)) return null;
  const users = Math.max(1, Number(billing.users) || 1);
  const total = Number.isFinite(billing.monthlyTotalCents) ? billing.monthlyTotalCents : BASE_CENTS + ADDITIONAL_CENTS * (users - 1);
  return `From ${formatDate(billing.testerUntil)} we'll charge ${money(total)} a month until you cancel.`;
}

// Whether a response means the billing gate now stands in the way (I3): a 402 from this site's own /api/. `url` is what fetch was
// given (a path, a URL or a Request); `origin` is the page's own (window.location.origin).
export function isGateResponse(url, status, origin = "") {
  if (status !== 402) return false;
  const text = typeof url === "string" ? url : (url && (url.href || url.url)) || "";
  if (text.startsWith("/api/")) return true;
  try {
    const u = new URL(text);
    return Boolean(origin) && u.origin === origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

// Watches responses for the gate (I3): the first 402 schedules one status read `delayMs` later, so a burst of them (a page firing
// several requests at once) reads the status once; none is scheduled while a read is still running. Timers come in for tests.
export function createGateWatch({ onGate, delayMs = 300, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let reading = false;
  return {
    saw(url, status, origin) {
      if (timer !== null || reading || !isGateResponse(url, status, origin)) return;
      timer = setTimer(() => {
        timer = null;
        reading = true;
        let read;
        try { read = Promise.resolve(onGate()); } catch { read = Promise.resolve(); }
        read.catch(() => {}).finally(() => { reading = false; });
      }, delayMs);
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

// Back from Stripe (?billing=done): keep reading the status (up to 10 times, a second apart) while access is still closed (M5).
export function stillFinishing(st) {
  return Boolean(st) && !(st.access && st.access.ok);
}

// The Overview's plan chip, only with billing on (I2): with billing off the live site shows none, as before billing.
export function overviewChip(stats, billingOn) {
  if (!billingOn || !stats || !stats.plan) return null;
  return { label: chipLabel(stats.plan, stats.trialEnds), trialEnd: stats.trialEnds ? formatDate(Date.parse(stats.trialEnds)) : null };
}

// GET /api/billing/public's two switches; anything but a true is off (a failed read too).
export function publicFlags(d) {
  return { billing: Boolean(d) && d.enabled === true, feedback: Boolean(d) && d.feedback === true };
}

// The Overview chip's word for /org/stats' `plan` (a billing status, or "exempt") when billing is on.
export function chipLabel(plan, trialEnds) {
  switch (plan) {
    case "trialing": return "Free trial";
    case "active": return "Active";
    case "past_due": return "Payment due";
    case "exempt": return "No charge";
    case "none": return trialEnds ? "Test month" : "Not started";
    default: return ENDED.has(plan) ? "Ended" : String(plan);
  }
}

// Which sign-up extras show: all of them when billing is on, none when it is off.
export function registerExtras(enabled) {
  const on = Boolean(enabled);
  return { showPrice: on, showTerms: on, showTesterCode: on };
}

// The question before removing a loan officer (accepted) or cancelling an invitation (pending). The part about paying is there only
// while billing is on for the brokerage (I2): with billing off the live site says nothing about a charge.
export function removeConfirmText(lo, { billingOn = false } = {}) {
  if (!lo.inviteAccepted) return `Cancel the invitation to ${lo.email}?`;
  if (billingOn) return `Remove ${lo.firstName} ${lo.lastName}? They'll be signed out right away, their clients move to you, and you'll stop paying for them.`;
  return `Remove ${lo.firstName} ${lo.lastName}? They'll be signed out right away and their clients move to you.`;
}
