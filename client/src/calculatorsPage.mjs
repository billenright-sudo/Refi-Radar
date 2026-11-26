// Helpers for the Calculators page (CalculatorsView.jsx): reading what is typed, today's-average links, and the starting inputs.
// Pure. Nothing here saves anything; the page keeps its inputs in React state only.
import { fmtRate, fmtDollars, fmtAmount, possessive } from "./calculators.mjs";
import { pricedToday } from "./equity.mjs";

export const CARDS = [["payment", "Payment"], ["breakEven", "Refi break-even"], ["blended", "Blended rate"], ["buydown", "Buydown"]];

// Typed or pasted text -> a number. Blank -> null; "$" "," and spaces are dropped; anything else that isn't a number -> NaN, which the
// shared limits refuse.
export function readNumber(text) {
  if (typeof text === "number") return text;
  const t = String(text == null ? "" : text).replace(/[$,\s]/g, "");
  if (t === "") return null;
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const realDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, mo, d } : null;
};

// The link under a rate field: today's average for a 30- or 15-year term, only for a real stored-average set.
export function fredLink(rates, termYears) {
  if (!rates || typeof rates.source !== "string" || !rates.source.startsWith("Optimal Blue lock data")) return null;
  const day = realDay(rates.date);
  const rate = termYears === 30 ? rates.rate_30yr_fixed : termYears === 15 ? rates.rate_15yr_fixed : null;
  if (!day || typeof rate !== "number" || !Number.isFinite(rate)) return null;
  return { rate, text: `Use today's ${termYears}-year average, ${fmtRate(rate)}, from ${MONTHS[day.mo - 1]} ${day.d}, ${day.y}` };
}

// The starting inputs of each card: strings, as typed. A new copy each call.
export const freshInputs = () => ({
  payment: { loanAmount: "", rate: "", termYears: "30", taxesYearly: "", insuranceYearly: "", miMonthly: "", hoaMonthly: "", homeValue: "", creditScore: "" },
  breakEven: { currentBalance: "", currentRate: "", monthsLeft: "", newRate: "", newTermYears: "30", closingCosts: "", costsPaid: "cash",
    miNowMonthly: "", miNewMonthly: "", homeValue: "", creditScore: "" },
  blended: { firstBalance: "", firstRate: "", firstMonthsLeft: "", cashNeeded: "", secondKind: "second", secondRate: "", secondTermYears: "30",
    secondCosts: "", cashOutRate: "", cashOutTermYears: "30", cashOutCosts: "", compareYears: "5" },
  buydown: { kind: "2-1", loanAmount: "", noteRate: "", termYears: "30", rateWithPoints: "", points: "", pointsCost: "", lastEdited: null },
});

const NUMERIC = {
  payment: ["loanAmount", "rate", "termYears", "taxesYearly", "insuranceYearly", "miMonthly", "hoaMonthly", "homeValue", "creditScore"],
  breakEven: ["currentBalance", "currentRate", "monthsLeft", "newRate", "newTermYears", "closingCosts", "miNowMonthly", "miNewMonthly", "homeValue", "creditScore"],
  blended: ["firstBalance", "firstRate", "firstMonthsLeft", "cashNeeded", "secondRate", "secondTermYears", "secondCosts", "cashOutRate",
    "cashOutTermYears", "cashOutCosts", "compareYears"],
  buydown: ["loanAmount", "noteRate", "termYears", "rateWithPoints"],
};

// The field edited last is used and the other left null (the shared math refuses a cost that implies too many points).
export function pointsFromEdit(lastEdited, { points, pointsCost }) {
  if (lastEdited === "points") return { points: readNumber(points), pointsCost: null };
  if (lastEdited === "pointsCost") return { points: null, pointsCost: readNumber(pointsCost) };
  return { points: null, pointsCost: null };
}

// What a card's typed strings are, as the shared function wants them: numbers or null.
export function inputFor(card, s) {
  const out = {};
  for (const f of NUMERIC[card]) out[f] = readNumber(s[f]);
  if (card === "breakEven") out.costsInLoan = s.costsPaid === "loan";
  if (card === "blended") out.secondKind = s.secondKind === "heloc" ? "heloc" : "second";
  if (card === "buydown") {
    out.kind = s.kind;
    if (s.kind === "points") Object.assign(out, pointsFromEdit(s.lastEdited, s));
  }
  return out;
}

// A whole-dollar figure that may be negative: "-$9,454" (fmtDollars alone would print "$-9,454").
export const fmtSigned = (n) => (n < 0 ? "-" + fmtDollars(-n) : fmtDollars(n));

// ---- Open in calculator: what a client's record fills in ----

export const MONTHS_MISSING = "Months left isn't on this client's record. Type it.";

const posNum = (n) => (Number.isFinite(n) && n > 0 ? n : null);

// The figures a client's page offers the calculators: today's balance and the cautious value (the same ones as the Equity Projection
// card), the rate, months left only when the server counted them, a credit score only when it is a real one. A figure that is
// blank, zero or paid off is null, never 0.
export function prefillFrom(client) {
  const c = client || {};
  const t = c.upgrades && c.upgrades.today;
  const priced = pricedToday(c);
  const todayUsed = !!t && Number.isFinite(t.cautiousValue) && t.cautiousValue > 0 && Number.isFinite(t.balance) && t.balance >= 0;
  // With a today block that has no balance there is nothing to fill in; without one the stored balance is the figure.
  const balance = t ? (Number.isFinite(t.balance) ? posNum(Number(priced.loanBalance)) : null) : posNum(Number(priced.loanBalance));
  const ml = t ? t.monthsLeft : null;
  return {
    name: String(c.name || ""),
    balance,
    balanceBasis: todayUsed && t.balanceBasis === "rolled" ? "rolled" : "stored",
    rate: posNum(Number(c.currentRate)),
    monthsLeft: Number.isInteger(ml) && ml >= 1 && ml <= 480 ? ml : null,
    monthsTerm: c.loanType === "30yr_fixed" ? 30 : c.loanType === "15yr_fixed" ? 15 : null,
    value: posNum(Number(priced.propertyValue)),
    score: c.creditScoreKnown === true && Number.isFinite(c.creditScore) ? c.creditScore : null,
  };
}

// The line above the card: where the figures came from.
export function prefillStrip(p) {
  const parts = [];
  if (p.balance !== null) parts.push(`balance ${fmtAmount(p.balance)} (${p.balanceBasis === "rolled" ? "estimated for today" : "on file"})`);
  if (p.rate !== null) parts.push(`rate ${fmtRate(p.rate)}`);
  if (p.monthsLeft !== null) parts.push(`${p.monthsLeft} months left (from the closing date${p.monthsTerm ? `, on a ${p.monthsTerm}-year term` : ""})`);
  return `Filled in from ${possessive(p.name)} record${parts.length ? ": " + parts.join(", ") : ""}. Change any figure. Nothing here is saved to the client.`;
}

const str = (n) => (n === null || n === undefined ? "" : String(n));

// The input strings each card starts with.
export function prefillInputs(p) {
  return {
    payment: { loanAmount: str(p.balance), rate: str(p.rate), homeValue: str(p.value), creditScore: str(p.score) },
    breakEven: { currentBalance: str(p.balance), currentRate: str(p.rate), monthsLeft: str(p.monthsLeft), homeValue: str(p.value), creditScore: str(p.score) },
    blended: { firstBalance: str(p.balance), firstRate: str(p.rate), firstMonthsLeft: str(p.monthsLeft) },
  };
}
