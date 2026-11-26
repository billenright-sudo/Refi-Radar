"use strict";
// Charlie's calculator lines (spec 4): every answer, question and refusal a calculator tool says, written by code from the shared
// function's own result (server/lib/calculators.js), never by the model. A line states the figures that were used (`result.inputs`,
// rounded as the calculator rounded them) before the answer, so a misheard figure is heard and corrected.
const { CALC_LINES, fmtCents, fmtDollars, fmtAmount, fmtRate, fmtBlended, possessive } = require("../calculators");

// The questions, word for word (spec 4), by the field each one asks for.
const QUESTIONS = Object.freeze({
  newRateForClient: "What rate are you looking at for them?",
  newRate: "What's the new rate?",
  monthsLeft: "How many months are left on the current loan?",
  firstMonthsLeft: "How many months are left on the current loan?",
  loanAmount: "What's the loan amount?",
  currentBalance: "What's the loan amount?",
  firstBalance: "What's the loan amount?",
  rate: "What's the rate?",
  currentRate: "What's the rate?",
  firstRate: "What's the rate?",
  noteRate: "What's the rate?",
  cashNeeded: "How much cash do they need?",
  secondRate: "What's the rate on the second?",
  cashOutRate: "What rate for the cash-out?",
  rateWithPoints: "What's the rate with points?",
  points: "How many points?",
  kind: "Which buydown: 2-1, 3-2-1 or 1-0?",
});

// The question for a missing `field` of `calculator` ("payment", "breakEven", "blendedRate" or "buydown"); only break-even's new
// rate depends on whether a client is named. A field with no question (none today) is asked as the rate is: never guessed.
function questionFor(calculator, field, { forClient } = {}) {
  if (calculator === "breakEven" && field === "newRate") return forClient ? QUESTIONS.newRateForClient : QUESTIONS.newRate;
  return Object.prototype.hasOwnProperty.call(QUESTIONS, field) ? QUESTIONS[field] : QUESTIONS.rate;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const years = (n) => plural(n, "year", "years");
const words = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);
const capitalized = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// A rate filled in from the stored FRED average is said as the estimate it is.
const rateSaid = (r, todaysAverage) => (todaysAverage ? `today's estimated average of ${fmtRate(r)}` : fmtRate(r));
const withWarnings = (line, warnings) => [line, ...(warnings || [])].join(" ");

const NOT_ENTERED_WORDS = { taxes: "taxes", insurance: "insurance", mi: "mortgage insurance", hoa: "HOA" };

function paymentLine(r) {
  const { inputs: i, out: o } = r;
  const lead = `On ${fmtAmount(i.loanAmount)} at ${fmtRate(i.rate)} over ${years(i.termYears)}`;
  const missing = r.notEntered || [];
  const miEstimated = !!(r.estimated && r.estimated.mi);
  if (["taxes", "insurance", "mi", "hoa"].every((k) => missing.includes(k)) && !miEstimated) {
    return `${lead}, principal and interest is ${fmtCents(o.pi)} a month, before taxes, insurance and any HOA.`;
  }
  const parts = [`${fmtCents(o.pi)} principal and interest`];
  if (!missing.includes("taxes")) parts.push(`${fmtCents(o.taxes)} taxes`);
  if (!missing.includes("insurance")) parts.push(`${fmtCents(o.insurance)} insurance`);
  if (!missing.includes("mi")) parts.push(`${fmtCents(o.mi)} ${miEstimated ? "estimated " : ""}mortgage insurance`);
  if (!missing.includes("hoa")) parts.push(`${fmtCents(o.hoa)} HOA`);
  let line = `${lead}, the payment is ${fmtCents(o.total)} a month: ${parts.join(", ")}.`;
  const list = missing.filter((k) => NOT_ENTERED_WORDS[k]).map((k) => NOT_ENTERED_WORDS[k]);
  if (list.length) line += ` ${capitalized(words(list))} ${CALC_LINES.notEntered}.`;
  return line;
}

function breakEvenLine(r, { clientName, todaysAverage } = {}) {
  const { inputs: i, out: o } = r;
  const whose = clientName ? `${possessive(clientName)} ` : "the ";
  const saving = o.monthlySavings > 0;
  let line = `Taking ${whose}${fmtAmount(i.currentBalance)} at ${fmtRate(i.currentRate)} with ${plural(i.monthsLeft, "month", "months")} left to ` +
    `${rateSaid(i.newRate, todaysAverage)} over ${years(i.newTermYears)} moves the payment from ${fmtCents(o.currentPayment)} to ` +
    `${fmtCents(o.newPayment)}, ${saving ? `saving ${fmtCents(o.monthlySavings)} a month` : CALC_LINES.moreAMonth(fmtCents(-o.monthlySavings))}.`;
  if (r.estimated && r.estimated.miNew) line += ` The new payment includes ${fmtCents(o.miNew)} of estimated mortgage insurance.`;
  if (o.closingCosts === 0) line += ` ${CALC_LINES.noCosts}.`;
  else if (saving && o.breakEvenMonth !== null) {
    line += ` With ${r.estimated && r.estimated.closingCosts ? "estimated " : ""}closing costs of ${fmtAmount(o.closingCosts)}` +
      `${o.costsInLoan ? " added to the loan" : ""}, break-even is month ${o.breakEvenMonth}.`;
  }
  return withWarnings(line, r.warnings);
}

function blendedLine(r, { todaysAverage } = {}) {
  const { inputs: i, out: o } = r;
  const heloc = i.secondKind === "heloc";
  let line = `Keeping the ${fmtRate(i.firstRate)} first and adding a ${fmtAmount(i.cashNeeded)} ${heloc ? "HELOC" : "second"} at ` +
    `${fmtRate(i.secondRate)} over ${years(i.secondTermYears)} blends to ${fmtBlended(o.blendedRate)} at ${fmtCents(o.combinedPayment)} a month. ` +
    `A cash-out to ${fmtAmount(o.cashOutAmount)} at ${rateSaid(i.cashOutRate, todaysAverage)} over ${years(i.cashOutTermYears)}, with ` +
    `${r.estimated && r.estimated.cashOutCosts ? "estimated " : ""}costs of ${fmtAmount(o.cashOutCosts)} in the loan, is ` +
    `${fmtCents(o.cashOutPayment)} a month. `;
  line += o.cheaper === "same"
    ? `Over ${years(i.compareYears)}, both cost the same.`
    : `Over ${years(i.compareYears)}, ${o.cheaper === "keep" ? "keeping the first" : "the cash-out"} costs ${fmtDollars(o.difference)} less.`;
  if (heloc) line += ` ${CALC_LINES.helocNote}`;
  return line;
}

const YEAR_WORDS = ["one", "two", "three"];

function buydownLine(r) {
  const { inputs: i, out: o } = r;
  if (o.kind !== "points") {
    const [first, ...rest] = o.years;
    const later = rest.map((y) => `, ${fmtCents(y.payment)} in year ${YEAR_WORDS[y.year - 1]}`).join("");
    return `On ${fmtAmount(i.loanAmount)} at ${fmtRate(i.noteRate)} over ${years(i.termYears)}, a ${o.kind} buydown makes the payment ` +
      `${fmtCents(first.payment)} in year one${later}, then ${fmtCents(o.notePayment)}. It costs ${fmtCents(o.subsidy)}.`;
  }
  const pts = Number(o.points.toFixed(3));
  let line = `On ${fmtAmount(i.loanAmount)} over ${years(i.termYears)}, ${plural(pts, "point", "points")} for ${fmtCents(o.cost)} take the rate ` +
    `from ${fmtRate(i.noteRate)} to ${fmtRate(i.rateWithPoints)} and the payment from ${fmtCents(o.paymentWithout)} to ` +
    `${fmtCents(o.paymentWith)}, saving ${fmtCents(o.monthlySavings)} a month.`;
  if (o.cost === 0) line += ` ${CALC_LINES.noCost}.`;
  else if (o.breakEvenMonth !== null) line += ` Break-even is month ${o.breakEvenMonth}.`;
  return withWarnings(line, r.warnings);
}

module.exports = { QUESTIONS, questionFor, paymentLine, breakEvenLine, blendedLine, buydownLine };
