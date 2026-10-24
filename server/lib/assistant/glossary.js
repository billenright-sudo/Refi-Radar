"use strict";
// Charli's glossary: what a term means, in plain spoken English, from a FIXED, code-authored list. The model never
// defines a term from memory (a new LO who asks "what does LTV mean?" would otherwise get the can't-verify line,
// or worse, an unsourced definition): it calls explainTerm (tools.js) and reads the definition as given.
//
// Definitions only. Where Broker Radar's own engine (lib/refi.js) uses a number it is said as a product fact
// ("Broker Radar estimates cash-out up to 80 percent of the home's value"); no definition states a loan-guideline
// limit (DTI limits, maximum LTVs, ...). Those stay in the deferred loan-guideline domain, which hands off.
// Pure: no I/O, no state.

const GLOSSARY_SOURCE = "Broker Radar glossary";

const entry = (term, aliases, definition) => Object.freeze({ term, aliases: Object.freeze(aliases), definition });

// `aliases` are matched case-insensitively with hyphens, slashes and runs of spaces treated alike (see normalize),
// so "Loan-to-Value", "loan to value" and "loan-to-value?" are one alias.
const GLOSSARY = Object.freeze([
  entry("LTV", [
    "ltv", "loan-to-value", "loan-to-value ratio",
  ],
    "LTV, or loan-to-value, is the loan balance divided by what the home is worth, shown as a percentage. " +
    "The lower it is, the more equity the borrower has."),

  entry("break-even", [
    "break-even", "breakeven", "break-even point", "break-even months",
  ],
    "Break-even is how many months of the new, lower payment it takes to earn back the closing costs of a refinance. " +
    "For rate-and-term opportunities, Broker Radar requires a break-even of 36 months or less."),

  entry("rate-and-term refinance", [
    "rate-and-term refinance", "rate-and-term", "rate and term", "rate-term", "rate/term", "rate/term refinance",
    "rate-and-term refi", "rate and term refi", "rate/term refi",
  ],
    "A rate-and-term refinance replaces the current loan with a new one to get a lower rate, a different term, or both, " +
    "without taking cash out. Broker Radar flags one when today's rates would meaningfully lower a client's payment."),

  entry("cash-out refinance", [
    "cash-out refinance", "cash-out", "cash out", "cash-out refi", "cash out refi",
  ],
    "A cash-out refinance replaces the loan with a larger one so the borrower can take some of their home equity as cash. " +
    "Broker Radar estimates cash-out up to 80 percent of the home's value."),

  entry("ARM", [
    "arm", "arms", "adjustable-rate mortgage", "adjustable rate mortgage", "adjustable-rate", "adjustable rate", "5/1 arm",
  ],
    "An adjustable-rate mortgage, or ARM, has a rate that is fixed for an initial period and then adjusts, so the payment can change. " +
    "Broker Radar looks for ARM clients who could lock in a fixed rate before it adjusts."),

  entry("term swap", [
    "term swap", "15-year vs 30-year", "15 year vs 30 year", "switching terms", "changing terms",
  ],
    "A term swap changes the length of the loan, such as moving from a 30-year loan to a 15-year loan to pay it off sooner, " +
    "or from a 15-year to a 30-year to lower the payment. Broker Radar flags a 15-year when its rate is at or under the " +
    "client's current rate, and a 30-year when it would clearly lower the payment."),

  entry("LLPA", [
    "llpa", "llpas", "loan-level price adjustment", "loan-level price adjustments",
  ],
    "An LLPA, or loan-level price adjustment, is an add-on to the price of a loan based on things like the borrower's credit score " +
    "and loan-to-value, so riskier loans cost more. Broker Radar builds an estimated adjustment into the rate it shows for each client."),

  entry("points", [
    "points", "point", "discount points", "discount point", "mortgage points",
  ],
    "Points, also called discount points, are fees a borrower pays up front to buy a lower interest rate, and each point costs " +
    "1 percent of the loan amount. Whether they pay off depends on how long the borrower keeps the loan."),

  // The definition only. The limits (and what any program allows) are guideline questions: they hand off.
  entry("DTI", [
    "dti", "debt-to-income", "debt-to-income ratio",
  ],
    "DTI, or debt-to-income, compares what a borrower owes each month to what they earn: their monthly debt payments divided by " +
    "their gross monthly income."),

  entry("check-in", [
    "check-in", "checkin", "check-ins", "6-month check-in", "six-month check-in",
  ],
    "A check-in is Broker Radar's relationship reminder to touch base with a past client. A client comes due for one when 6 months " +
    "have passed since your last contact with them, or since their closing if there is no contact on file."),

  entry("opportunity", [
    "opportunity", "opportunities",
  ],
    "An opportunity is a client that Broker Radar's sweep flags as worth a call, because a refinance such as a lower rate, " +
    "cash out, or moving off an ARM could help them."),
]);

// ── Lookup ───────────────────────────────────────────────────────────────────

// Lower case, quotes and trailing punctuation gone, hyphens, slashes and spaces one space, a leading article dropped,
// "refi" spelled out: "A Cash-Out Refi?" and "cash out refinance" are the same key.
const normalize = (raw) =>
  String(raw)
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[?!.,;:()]/g, " ")
    .replace(/[-/_\s]+/g, " ")
    .trim()
    .replace(/^(?:a|an|the)\s+/, "")
    .replace(/\brefi\b/g, "refinance");

const MAX_TERM_CHARS = 100;
const BY_ALIAS = new Map();
for (const e of GLOSSARY) {
  for (const alias of [e.term, ...e.aliases]) {
    const key = normalize(alias);
    if (BY_ALIAS.has(key) && BY_ALIAS.get(key) !== e) throw new Error(`glossary: "${alias}" is an alias of two terms`);
    BY_ALIAS.set(key, e);
  }
}

// The entry for a term as the model or the user may spell it, or null. EXACT match on a whole alias only: a sentence
// ("what does LTV mean"), two terms ("LTV and DTI") or a near miss is not found, so the tool never guesses.
function lookupTerm(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_TERM_CHARS) return null;
  return BY_ALIAS.get(normalize(raw)) || null;
}

// ── Does a message name a glossary term? ─────────────────────────────────────

// "point(s)" and "arm" are everyday words ("a good point", "my arm"): they are looked up but not noticed in a
// sentence. "opportunity" and "check-in" are already book nouns for the screening in orchestrator.js.
const NOT_NOTICED = new Set(["point", "points", "arm", "arms", "opportunity", "opportunities", "checkin", "check ins", "check in"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const noticed = [...BY_ALIAS.keys()].filter((key) => !NOT_NOTICED.has(key));
// each alias as whole words, with a hyphen, slash or space(s) between them
const GLOSSARY_TERM_RE = new RegExp(
  "\\b(?:" + noticed.map((key) => key.split(" ").map(escapeRe).join("[-/\\s]+")).join("|") + ")\\b", "i"
);

// True if `text` names a glossary term. With no tool result behind a reply, a question that names one is a question
// about the book's vocabulary: the model may not answer it from memory (screenUngroundedText). Pure.
const mentionsGlossaryTerm = (text) => typeof text === "string" && GLOSSARY_TERM_RE.test(text);

module.exports = { GLOSSARY, GLOSSARY_SOURCE, lookupTerm, mentionsGlossaryTerm };
