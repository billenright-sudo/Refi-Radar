// What the billing screens say. Pure functions: App.jsx draws them. Prices come from the server's own numbers where it sends them.
// All wording here is draft until Bill approves it.

export const SPEC_LINE = "$0 today. Your 14-day free trial starts now. From day 15 we'll charge $99 a month, plus $49 for each additional user, until you cancel. Cancel any time in Billing.";
export const RETURNING_LINE = "$99 a month, plus $49 for each additional user, starting today, until you cancel.";
export const LO_LOCKED_LINE = "Your brokerage's subscription needs attention. Please contact your broker.";
const PAST_DUE_LINE = "Your last payment didn't go through. Update your card to keep Broker Radar running.";

const BASE_CENTS = 9900;
const ADDITIONAL_CENTS = 4900;

// Which gate page replaces the app: null | "terms" | "start_trial" | "ended" | "lo_locked".
export function gateScreen(access, role) {
  if (!access || access.ok) return null;
  if (access.reason === "terms") return "terms";
  if (access.reason === "needs_card" || access.reason === "ended") {
    if (role !== "broker") return "lo_locked";
    return access.reason === "ended" ? "ended" : "start_trial";
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
