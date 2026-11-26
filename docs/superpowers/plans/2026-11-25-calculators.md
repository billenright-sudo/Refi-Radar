# Calculators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broker-and-LO Calculators page (payment, refi break-even, blended rate, buydown) and four matching Charlie tools whose spoken answers are written by code, all on one marked copy of shared math.

**Architecture:** The four calculators live twice, byte-identical between marker lines, in `server/lib/calculators.js` (CommonJS, for Charlie) and `client/src/calculators.mjs` (ESM, for the page); a server test holds the two copies equal. The page is a new component file fed by small tested `.mjs` helpers; "Open in calculator" pre-fills from the client's today block, which gains `monthsLeft`. Charlie's calculator tools return a code-written `say` line at the top level of the result; the orchestrator ends the turn with it as a fourth kind of turn-ending result (beside a change to confirm, an email and a screen), never something to confirm, never shown to the model.

**Tech Stack:** Node 20, Express + better-sqlite3 (CommonJS), `node --test`; React 18 + Vite (ESM `.mjs` helpers tested with `node --test`).

**Spec:** `docs/superpowers/specs/2026-11-25-calculators-design.md` (approved by Bill 2026-11-25, section 7 all yes). The spec is the authority; where this plan rules on a gap it says so under "Rulings (planner)".

**Running things (every task):** in Bash first `export PATH=/c/Users/bille/dev/node20:$PATH`. Server tests: `cd /c/Users/bille/dev/refi-radar-calcs/server && npm test` (one file: `node --test test/<file>`). Client tests: `cd /c/Users/bille/dev/refi-radar-calcs/client && npm test`; build: `npx vite build`. Scoring check: `node scripts/check-scoring.js` from the repo root. Work only in `C:\Users\bille\dev\refi-radar-calcs` (branch `feature/calculators`).

**Visual checks (Tasks 7-9):** a local server only (`cd server && DATA_DIR=<a fresh temp dir> JWT_SECRET=<any throwaway string> NODE_ENV=development node index.js`, vars set in the shell, never in a file) plus `cd client && npx vite`, with a sample account and sample clients you create on that local server. Never point anything at the live app: `scripts/seed-demo.js` defaults to the production URL and must not be run. If the local app can't be signed into without secrets or a live service, write "visual check pending" in the task report; never fake a screenshot.

## Global Constraints

- Inputs are never saved: no new table, no migration, no change to any client record, no `fetch` from the Calculators page or its helpers, no `localStorage`/`sessionStorage`. Inputs live in React state and are gone when the page is left or reloaded.
- No print, share link, email, export or client-facing view of any calculator result. No APR anywhere.
- No new npm dependency (server or client). No Dockerfile change.
- Every figure (page and Charlie) comes from the shared functions of Task 1-4; a model never works out, rounds or adjusts a figure. Charlie's answer, question and refusal lines are written by code (Task 10) and never pass through the model.
- Marker lines, exactly: `// ---- calculators: shared math begin ----` and `// ---- calculators: shared math end ----`. Between them: plain functions and constants only, no `require`, `import`, `export`, `module.exports`; it uses `calcPayment`, `estClosingCosts`, `pmiMonthly` from its own side.
- Rounding (spec 2): each monthly amount rounded to the cent first; a sum of monthly amounts adds the rounded amounts (then rounds to the cent); totals over months/years and balances still owed rounded to whole dollars after being added up from cent-rounded monthly amounts; month counts `Math.ceil`; payment = `calcPayment` (zero rate spreads evenly).
- Input limits (spec 2): amounts above $0 and at most $50,000,000; rates 0% to 20%; terms 1 to 40 years; months left 1 to 480. Outside a limit, or missing where needed: no result (never a partial one). A blank optional field counts as $0 and is listed as "not entered".
- Existing look only: `card`, `inputStyle`, `btnPrimary`, `btnGhost`, `mono`, the tile figure style of the client page's Refi Analysis card (App.jsx:1773-1776), `C`, `gridCols` (`client/src/layout.mjs`), `ph()` (App.jsx:61). No new colors or visual style.
- Fixed copy is copied word for word from this plan (which copies spec sections 4 and 6). Plain hyphen-minus in "break-even", "2-1", "3-2-1", "1-0"; straight apostrophes.
- Never read, print or create any `.env*` file. Do not edit `CLAUDE.md`, `README.md`, Terms, Privacy, landing copy or the Google connect text.
- Working files use CRLF line endings (git `core.autocrlf=true`); new files follow the same.

## Fixed copy (owner-approved, spec section 6) and who owns it

| Constant (in the shared block unless noted) | Text | Task |
|---|---|---|
| `CALC_LINES.estimate` | Estimate for your own use only. This is not a Loan Estimate, a rate quote or an offer of credit. | 1 |
| `CALC_LINES.estimateTag` | estimate | 1 |
| `CALC_LINES.notEntered` | not entered | 1 |
| `CALC_LINES.currentPaymentLabel` | worked out from the balance, rate and months left | 2 |
| `CALC_LINES.costsInLoan` | Costs are in the new loan, so the new payment already includes them. Break-even is the cautious figure. | 2 |
| `CALC_LINES.longRun(x)` | Lower payment, higher total: restarting the clock costs ${x} more over the life of the loan than keeping the current loan. (`x` = `fmtDollars(...)`, e.g. "$24,676") | 2 |
| `CALC_LINES.noSavings` | The new payment isn't lower, so the costs are never earned back. | 2 |
| `CALC_LINES.tooLate` | Break-even comes after the current loan would have been paid off. | 2 |
| `CALC_LINES.noCosts` | No costs entered | 2 |
| `CALC_LINES.moreAMonth(x)` | {x} more a month (e.g. "$12.40 more a month") | 2 |
| `CALC_LINES.cashNeeded` | Enter the cash needed. | 3 |
| `CALC_LINES.helocNote` | Worked as a fixed rate paid off over the term. A HELOC's rate can change, and an interest-only draw period changes the payment. | 3 |
| `CALC_LINES.helocInterestOnly(x)` | Interest-only payment on the second: {x} a month | 3 |
| `CALC_LINES.termTooShort` | The term must be at least as long as the buydown. | 4 |
| `CALC_LINES.noteTooLow` | The note rate is too low for this buydown. | 4 |
| `CALC_LINES.pointsNotLower` | The rate with points must be lower than the rate without. | 4 |
| `CALC_LINES.noCost` | No cost entered | 4 |
| `CALC_LINES.pointsNever` | The savings don't cover the cost of the points within the term. | 4 |
| page title, nav label (`nav.mjs`, `CalculatorsView.jsx`) | Calculators | 7 |
| card buttons (`CalculatorsView.jsx`) | Payment / Refi break-even / Blended rate / Buydown | 7 |
| button on the client page (App.jsx) | Open in calculator | 9 |
| `MONTHS_MISSING` (`client/src/calculatorsPage.mjs`) | Months left isn't on this client's record. Type it. | 9 |
| pre-fill strip (`prefillStrip`, `calculatorsPage.mjs`) | Filled in from {name}'s record: {figures}. Change any figure. Nothing here is saved to the client. | 9 |
| `PAGE_LINES.calculators` (`server/lib/assistant/navigation.js`) | Here's Calculators. | 12 |
| Charlie templates and questions (`server/lib/assistant/calcLines.js`) | see Task 10 | 10 |

The new lines this plan adds (limit lines and a few Charlie fragments) are listed at the end under "Sentences that need the owner's OK".

## Review Focus

1. **Amounts typed with "$" or commas, or pasted ("$400,000", "400,000.00")** — read as 400000, never refused or NaN. Pinned in Task 7 (`readNumber`).
2. **A buydown reduced rate that hits float noise (6.15% 3-2-1)** — year rates shown and used as 3.15 / 4.15 / 5.15, never "3.1500000000000004%". Pinned in Task 4.
3. **A tiny positive saving ($0.01 a month)** — break-even month is a large finite number with the "comes after" warning; no Infinity, no crash, no hidden result. Pinned in Task 2.
4. **Open in calculator on a paid-off or blank-balance client (today's balance 0 or missing)** — balance left blank (not "0"), strip leaves balance out, no crash. Pinned in Task 9.
5. **Charlie handed a figure the code can't read ("400k" as a string, a negative, NaN)** — she asks for it (or says the page's limit line), never guesses. Pinned in Task 10.

## Rulings (planner)

- Ruling: months left = (360 for `30yr_fixed`, 180 for `15yr_fixed`) − `monthsBetween(firstPaymentFromClosing(closeDate), today)`, capped at the term; null when below 1, for any other loan type, or with no readable close date — the same schedule `balanceToday` rolls today's balance on, so balance and months agree — if wrong, months left is off by one against a "payments made" count.
- Ruling: the app's closing-cost estimate is rounded to whole dollars (`roundDollars(estClosingCosts(b))`) before use — the field shows the figure that is used (spec examples are whole) — if wrong, a break-even month can differ by one from the client page's Refi Analysis tile, which uses the unrounded estimate.
- Ruling: a rate is rounded to three decimals on entry (`Math.round(r * 1000) / 1000`), and buydown reduced rates are rounded the same way — the spec says rates are used "up to three decimals" and float noise must not print — if wrong, a 4-decimal typed rate is used as 3.
- Ruling: the byte-equality test compares the two blocks after turning CRLF into LF — git `core.autocrlf=true` decides line endings at checkout, not the author — if wrong, a mixed-ending edit would pass.
- Ruling: limit lines are fixed per field kind (Task 1 `CALC_LINES`), with three limits the spec leaves open: credit score 300 to 850, points 0 to 20, and terms, months left and compare-over as whole numbers — the spec requires "a short line under its field" but gives no wording — if wrong, copy changes only.
- Ruling: a missing required field shows no line until the field has been touched (blurred once); the result area stays empty meanwhile — avoids a wall of red on an empty card without inventing a new sentence — if wrong, a broker may not see why there is no result.
- Ruling: Charlie's "today's average" is `upgradeAlerts.safeUpgradeRates(ctx.db, clockOf(ctx))` (the latest stored FRED snapshot, at most 10 days old, the set every upgrade surface uses); the page's link reads the browser's `/api/rates` set and is offered only when its `source` starts with "Optimal Blue lock data" and `date` is a valid YYYY-MM-DD — "stored" and server-trusted for Charlie; the page has no other way to read the stored set without a new route — if wrong, page and Charlie may offer averages a fetch apart for a few hours (the figure is always shown or said).
- Ruling: Charlie's break-even (and the page's) applies the new-loan PMI estimate when the client's value and real score put the new loan over 80%; Charlie's line then adds " The new payment includes {MI} of estimated mortgage insurance." after the savings sentence — the spec's anti-goal says every default is said aloud with "estimate", but the break-even template has no slot — if wrong, one extra sentence.
- Ruling: break-even with $0 closing costs replaces Charlie's second sentence with "No costs entered."; with no saving, ", saving {savings} a month" becomes ", {x} more a month" and the break-even sentence is dropped before warning (b); points with $0 cost replaces "Break-even is month {n}." with "No cost entered." — the templates would otherwise say "month 0" or a negative saving — if wrong, wording only.
- Ruling: the points template says the term: "On {amount} over {years} years, {points} points for {cost} …" — the spec requires every defaulted term to be said, and the points template omits it — if wrong, wording only.
- Ruling: Charlie names a client with the possessive of the stored name ("Grace Okafor's", "Robert & Linda Chen's"; a name ending in "s" takes "'"), via the shared `possessive(name)` — the spec's "the Okafors'" can't be derived from a stored name — if wrong, wording only.
- Ruling: equal blended totals are said "Over {Y} years, both cost the same." — the template has no case for it — if wrong, wording only.
- Ruling: after a HELOC blended answer Charlie adds the HELOC note word for word; the interest-only line is page-only — the note is a caution the page always shows — if wrong, one extra sentence.
- Ruling: `second.kind` not said is a closed-end second ("second"), and the line says "second" or "HELOC" — it is a choice, not a figure, and the line says it — if wrong, she should ask.
- Ruling: figures the broker says win over the client record when both are present — the broker is correcting the record — if wrong, the record figure is ignored silently (the line says the figure used).
- Ruling: Calculators is not a "form" for the form-open lock: `onScreenOf` reports `{ page: "calculators" }` and Charlie may navigate away — nothing on it is saved, by design — if wrong, typed figures are lost on a Charlie page change.
- Ruling: a sentence whose object names a calculator topic (break-even, payment, blended, buydown, points, cash-out) is no page request even with a strong verb, unless it names the calculator page — spec risk 4 — if wrong, "pull up the payment on the Chens" stops opening the Chens' page (it never did anything useful there).
- Ruling: a calculator tool given a `clientId` the caller can't see returns `fail("(not found)", "no such client in your book")` with no `say`, so it goes back to the model as `showScreenTool`'s does — the spec's "another LO's clientId is 'no such client'" — if wrong, the model words the miss itself (no figure is involved).
- Ruling: two calculator tools in one response, or a calculator with another change, ends with `ONE_AT_A_TIME` — spec "a calculator answer plus another change in one turn is one at a time" — if wrong, "the payment at 6.5 and at 7" needs two turns.
- Ruling: "Open in calculator" appears both in the Refi Analysis card and in the "Fetch the latest rates" placeholder card — the calculator needs no rates — if wrong, one extra button.
- Ruling: the pre-fill strip lists balance, rate and months left as in the spec's example (value and score are shown in their own fields); a stored (not rolled) balance is "(on file)" — if wrong, copy only.
- Ruling: typed amounts and costs are written whole when whole and to the cent otherwise (`fmtAmount`); the blended rate is written to three decimals everywhere ("4.375%", "4.200%"), other rates with no extra zeros — spec 2 and 4 — if wrong, wording only.
- Ruling: page inputs are `type="text" inputMode="decimal"`, read by `readNumber` (strips "$", "," and spaces) — so "$400,000" works (Review Focus 1) — if wrong, none.

---

### Task 1 (Stage A): The shared block, its helpers and Payment

**Files:**
- Create: `server/lib/calculators.js`
- Create: `client/src/calculators.mjs`
- Test: `server/test/calculators.test.js`

**Interfaces:**
- Consumes: server `calcPayment(p, annualRate, years)`, `estClosingCosts(balance)` from `server/lib/refi.js:22,49`; `pmiMonthly(creditScore, ltv, years, balance)` from `server/lib/pmi.js:38`. Client: the same three exported from `client/src/refiAnalysis.mjs:5,46,74`.
- Produces (identical names on both sides; server `module.exports = {...}`, client `export {...}` after the end marker):
  - `CALC_LIMITS = { amountMax: 50000000, rateMax: 20, termMin: 1, termMax: 40, monthsMax: 480, scoreMin: 300, scoreMax: 850, pointsMax: 20 }`
  - `CALC_LINES` (fixed copy table above, plus the limit lines below)
  - `roundCents(n)`, `roundDollars(n)`, `roundRate(r)` (3 decimals), `remainingBalance(p, rate, years, paid)` (unrounded; 0 once `paid >= years*12`; uses the unrounded `calcPayment`; zero rate: `p - p/n*paid`)
  - `fmtCents(n)` → "$2,528.27"; `fmtDollars(n)` → "$24,676"; `fmtAmount(n)` → "$400,000" or "$1,500.50"; `fmtRate(r)` → "6.5%" (`${Number(r.toFixed(3))}%`); `fmtBlended(r)` → "4.375%" (`toFixed(3)`); `possessive(name)` → "Grace Okafor's" / "James Rivers'". All money via `toLocaleString("en-US", …)`; callers pass non-negative numbers.
  - `paymentCalc(input) -> CalcResult`
  - `CalcResult` (one shape for every calculator, page and Charlie):
    - `{ ok: true, inputs, defaulted: string[], estimated: { [key]: true }, out, warnings: string[], notes: string[], notEntered: string[] }`
    - `{ ok: false, errors: { [field]: line }, missing: string[] }` — `errors` keys in input order (first = the line Charlie says); `missing` = required fields that are null, in input order.
  - Input values are numbers or `null` (blank). Callers parse; the functions never parse strings.

Limit lines (`CALC_LINES`):
- `amount`: "Enter an amount above $0, up to $50,000,000."
- `optionalAmount`: "Enter an amount from $0 to $50,000,000."
- `rate`: "Enter a rate from 0% to 20%."
- `term`: "Enter a term from 1 to 40 years."
- `compareYears`: "Enter from 1 to 40 years."
- `monthsLeft`: "Enter months left from 1 to 480."
- `score`: "Enter a credit score from 300 to 850."
- `points`: "Enter points from 0 to 20."

`paymentCalc({ loanAmount, rate, termYears, taxesYearly, insuranceYearly, miMonthly, hoaMonthly, homeValue, creditScore })`:
- required `loanAmount`, `rate`; `termYears` null → 30 and `defaulted: ["termYears"]`; optional amounts null → 0 and listed in `notEntered` in the order `taxes, insurance, mi, hoa`.
- `miMonthly` null with `homeValue` and `creditScore` given and `loanAmount / homeValue * 100 > 80` → `pmiMonthly(creditScore, loanAmount / homeValue * 100, termYears, loanAmount)`, `estimated.mi = true` (not in `notEntered`).
- `out = { pi, taxes, insurance, mi, hoa, total }`: `pi = roundCents(calcPayment(...))`, `taxes = roundCents(taxesYearly / 12)`, `insurance = roundCents(insuranceYearly / 12)`, `total = roundCents(pi + taxes + insurance + mi + hoa)`.

- [ ] **Step 1: Write the failing tests** in `server/test/calculators.test.js`. Load the client copy once with `const client = await import(require("url").pathToFileURL(path.join(__dirname, "../../client/src/calculators.mjs")).href)` inside a `test.before`; `server = require("../lib/calculators")`. Every example below runs on **both** copies (`for (const side of [server, client])`).

```js
test("the shared block is the same text in both files", () => {
  const block = (f) => { const t = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
    const a = t.indexOf(BEGIN), b = t.indexOf(END); assert.ok(a >= 0 && b > a, f); return t.slice(a, b + END.length); };
  assert.equal(block(SERVER_FILE), block(CLIENT_FILE));
});
test("the shared block has no require, import or export", () => {
  assert.doesNotMatch(blockOf(SERVER_FILE), /\brequire\s*\(|^\s*import\b|^\s*export\b|module\.exports/m);
});
test("payment, spec 2.1", () => {
  const r = side.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: 30, taxesYearly: 4800, insuranceYearly: 1800,
    miMonthly: null, hoaMonthly: 50, homeValue: 450000, creditScore: 740 });
  assert.deepEqual(r.out, { pi: 2528.27, taxes: 400, insurance: 150, mi: 126.67, hoa: 50, total: 3254.94 });
  assert.deepEqual(r.estimated, { mi: true }); assert.deepEqual(r.notEntered, []);
});
test("payment edge cases", () => {
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 0, termYears: 30 }).out.pi, 1111.11);
  const bare = side.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: null });
  assert.deepEqual(bare.defaulted, ["termYears"]); assert.deepEqual(bare.notEntered, ["taxes", "insurance", "mi", "hoa"]);
  assert.equal(bare.out.total, 2528.27);
  // over 80% with no value or score: no estimate
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6.5, homeValue: 450000 }).out.mi, 0);
  assert.deepEqual(side.paymentCalc({ loanAmount: null, rate: null }), { ok: false, errors: {}, missing: ["loanAmount", "rate"] });
  assert.deepEqual(side.paymentCalc({ loanAmount: 0, rate: 21, termYears: 41 }).errors,
    { loanAmount: side.CALC_LINES.amount, rate: side.CALC_LINES.rate, termYears: side.CALC_LINES.term });
  assert.equal(side.paymentCalc({ loanAmount: 50000001, rate: 6 }).errors.loanAmount, side.CALC_LINES.amount);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6, termYears: 30.5 }).errors.termYears, side.CALC_LINES.term);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6, taxesYearly: -1 }).errors.taxesYearly, side.CALC_LINES.optionalAmount);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: 6, homeValue: 450000, creditScore: 900 }).errors.creditScore, side.CALC_LINES.score);
  assert.equal(side.paymentCalc({ loanAmount: 400000, rate: Number.NaN }).errors.rate, side.CALC_LINES.rate);
});
test("formatting", () => {
  assert.equal(side.fmtCents(2528.27), "$2,528.27"); assert.equal(side.fmtCents(400), "$400.00");
  assert.equal(side.fmtDollars(24676.4), "$24,676"); assert.equal(side.fmtAmount(400000), "$400,000");
  assert.equal(side.fmtAmount(1500.5), "$1,500.50"); assert.equal(side.fmtRate(6.5), "6.5%");
  assert.equal(side.fmtRate(6.25), "6.25%"); assert.equal(side.fmtRate(5.1500000000000004), "5.15%");
  assert.equal(side.fmtBlended(4.375), "4.375%"); assert.equal(side.fmtBlended(4.2), "4.200%");
  assert.equal(side.possessive("Grace Okafor"), "Grace Okafor's"); assert.equal(side.possessive("James Rivers"), "James Rivers'");
  assert.equal(side.roundRate(6.12345), 6.123);
});
```

- [ ] **Step 2: Run to verify they fail.** `cd server && node --test test/calculators.test.js` → FAIL (cannot find module `../lib/calculators`).
- [ ] **Step 3: Implement** both files: outside the markers, server: `"use strict";` + the two requires + `module.exports`; client: `import { calcPayment, estClosingCosts, pmiMonthly } from "./refiAnalysis.mjs";` + `export {…}`. Inside: a small `checkFields(input, specs)` helper (field → kind: `amount` | `optionalAmount` | `rate` | `term` | `months` | `score` | `points` | `compareYears`) that builds `errors`/`missing`, then the calculator. A number is valid only when `Number.isFinite`; required amount `> 0 && <= amountMax`; optional amount `>= 0 && <= amountMax`; whole numbers for term/months/compare.
- [ ] **Step 4: Run to verify they pass.** Same command → PASS. Also `cd ../client && npm test` (unchanged suite) → PASS.
- [ ] **Step 5: Commit** `git add server/lib/calculators.js client/src/calculators.mjs server/test/calculators.test.js && git commit -m "feat(calculators): shared math block, formatting and payment"`

### Task 2 (Stage A): Refi break-even

**Files:**
- Modify: `server/lib/calculators.js`, `client/src/calculators.mjs` (inside the markers only, identically)
- Test: `server/test/calculators.test.js`

**Interfaces:**
- Consumes: Task 1 helpers, `CalcResult`.
- Produces: `breakEvenCalc({ currentBalance, currentRate, monthsLeft, newRate, newTermYears, closingCosts, costsInLoan, miNowMonthly, miNewMonthly, homeValue, creditScore }) -> CalcResult` with
  `out = { currentPI, miNow, currentPayment, newAmount, newPI, miNew, newPayment, monthlySavings, breakEvenMonth, closingCosts, costsInLoan, currentTotal, newTotal, totalDifference }`.
  Required: `currentBalance`, `currentRate`, `monthsLeft`, `newRate`. `newTermYears` null → 30 (defaulted). `closingCosts` null → `roundDollars(estClosingCosts(currentBalance))`, `estimated.closingCosts`. `costsInLoan` null → false. `newAmount = currentBalance + (costsInLoan ? closingCosts : 0)`. `miNewMonthly` null + value + score + `newAmount / homeValue * 100 > 80` → `pmiMonthly(score, ltv, newTermYears, newAmount)`, `estimated.miNew`. `currentPI = roundCents(calcPayment(currentBalance, currentRate, monthsLeft / 12))`; `currentPayment = roundCents(currentPI + miNow)`; same for new; `monthlySavings = roundCents(currentPayment - newPayment)` (signed). `breakEvenMonth = closingCosts > 0 && monthlySavings > 0 ? Math.ceil(closingCosts / monthlySavings) : null`. `currentTotal = roundDollars(currentPI * monthsLeft)`; `newTotal = roundDollars(newPI * newTermYears * 12 + (costsInLoan ? 0 : closingCosts))`; `totalDifference = newTotal - currentTotal`.
  `warnings` in this order: `noSavings` when `monthlySavings <= 0`; `longRun(fmtDollars(totalDifference))` when `monthlySavings > 0 && newTotal > currentTotal`; `tooLate` when `breakEvenMonth > monthsLeft`. `notes`: `costsInLoan` line when costs are in the loan; `noCosts` when `closingCosts === 0`.

- [ ] **Step 1: Write the failing tests** (both sides):

```js
const LOAN = { currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newTermYears: 30 };
test("break-even, spec 2.2 at 6.25% in cash", () => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.25 });
  assert.equal(r.out.currentPayment, 2464.68); assert.equal(r.out.newPayment, 2155.01);
  assert.equal(r.out.monthlySavings, 309.67); assert.equal(r.out.closingCosts, 6000); assert.deepEqual(r.estimated, { closingCosts: true });
  assert.equal(r.out.breakEvenMonth, 20); assert.equal(r.out.currentTotal, 798556); assert.equal(r.out.newTotal, 781804);
  assert.deepEqual(r.warnings, []);
});
test("break-even at 6.75%: the long-run warning", () => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.75 });
  assert.equal(r.out.newPayment, 2270.09); assert.equal(r.out.monthlySavings, 194.59); assert.equal(r.out.breakEvenMonth, 31);
  assert.equal(r.out.newTotal, 823232); assert.equal(r.out.totalDifference, 24676);
  assert.deepEqual(r.warnings, ["Lower payment, higher total: restarting the clock costs $24,676 more over the life of the loan than keeping the current loan."]);
});
test("break-even with the costs in the loan", () => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.25, costsInLoan: true });
  assert.equal(r.out.newAmount, 356000); assert.equal(r.out.newPayment, 2191.95); assert.equal(r.out.monthlySavings, 272.73);
  assert.equal(r.out.breakEvenMonth, 22); assert.equal(r.out.newTotal, 789102); assert.equal(r.out.totalDifference, -9454);
  assert.deepEqual(r.notes, [side.CALC_LINES.costsInLoan]);
});
test("break-even edge cases", () => {
  const none = side.breakEvenCalc({ ...LOAN, newRate: 6.25, closingCosts: 0 });
  assert.equal(none.out.breakEvenMonth, null); assert.ok(none.notes.includes("No costs entered"));
  const worse = side.breakEvenCalc({ ...LOAN, newRate: 8 });   // 30 years at 8%: $2,568.18, above today's $2,464.68
  assert.ok(worse.out.monthlySavings < 0); assert.equal(worse.out.breakEvenMonth, null);
  assert.deepEqual(worse.warnings, [side.CALC_LINES.noSavings]);
  assert.equal(side.CALC_LINES.moreAMonth("$12.40"), "$12.40 more a month");
  // same P&I both sides (27 years = 324 months) and $10 of current MI: $10 saved, break-even month 600 > 324
  const late = side.breakEvenCalc({ ...LOAN, newRate: 7.25, newTermYears: 27, miNowMonthly: 10 });
  assert.equal(late.out.breakEvenMonth, 600); assert.ok(late.warnings.includes(side.CALC_LINES.tooLate));
  assert.equal(side.breakEvenCalc({ ...LOAN, newRate: 0 }).out.newPI, 972.22);      // zero rate: calcPayment spreads it
  assert.deepEqual(side.breakEvenCalc({ currentBalance: 350000 }).missing, ["currentRate", "monthsLeft", "newRate"]);
  assert.equal(side.breakEvenCalc({ ...LOAN, monthsLeft: 481, newRate: 6 }).errors.monthsLeft, side.CALC_LINES.monthsLeft);
});
test("Review Focus 3: a one-cent saving gives a finite late break-even", () => {
  // same P&I both sides (27 years = 324 months), so a typed cent of current MI is the whole saving
  const r = side.breakEvenCalc({ ...LOAN, newRate: 7.25, newTermYears: 27, miNewMonthly: 0, miNowMonthly: 0.01 });
  assert.equal(r.out.monthlySavings, 0.01); assert.equal(r.out.breakEvenMonth, 600000);
  assert.ok(Number.isFinite(r.out.breakEvenMonth)); assert.ok(r.warnings.includes(side.CALC_LINES.tooLate));
});
test("new-loan PMI estimate over the cautious value", () => {
  const r = side.breakEvenCalc({ ...LOAN, newRate: 6.25, costsInLoan: true, homeValue: 400000, creditScore: 740 });
  assert.equal(r.out.miNew, pmiOf(side)(740, 356000 / 400000 * 100, 30, 356000)); assert.deepEqual(r.estimated, { closingCosts: true, miNew: true });
  assert.equal(r.out.newPayment, side.roundCents(r.out.newPI + r.out.miNew));
});
```

(`pmiOf(side)` is the test's own lookup of that side's `pmiMonthly`: server `require("../lib/pmi").pmiMonthly`, client the `refiAnalysis.mjs` export.)

- [ ] **Step 2: Run to verify they fail** → FAIL (`breakEvenCalc is not a function`).
- [ ] **Step 3: Implement** `breakEvenCalc` inside both blocks identically.
- [ ] **Step 4: Run to verify they pass** → PASS, including the byte-equality test.
- [ ] **Step 5: Commit** `git commit -am "feat(calculators): refi break-even"`

### Task 3 (Stage A): Blended rate

**Files:** Modify `server/lib/calculators.js`, `client/src/calculators.mjs` (inside markers); Test `server/test/calculators.test.js`.

**Interfaces:**
- Produces: `blendedRateCalc({ firstBalance, firstRate, firstMonthsLeft, cashNeeded, secondKind, secondRate, secondTermYears, secondCosts, cashOutRate, cashOutTermYears, cashOutCosts, compareYears }) -> CalcResult`.
  Required: `firstBalance`, `firstRate`, `firstMonthsLeft`, `cashNeeded` (null → missing; 0 → `errors.cashNeeded = CALC_LINES.cashNeeded`), `secondRate`, `cashOutRate`. `secondKind` null → "second" (else "heloc"); `secondTermYears`, `cashOutTermYears` null → 30; `compareYears` null → 5 (all defaulted); `secondCosts` null → 0, `notEntered: ["secondCosts"]`; `cashOutCosts` null → `roundDollars(estClosingCosts(firstBalance + cashNeeded))`, `estimated.cashOutCosts`.
  `out = { blendedRate, firstPayment, secondPayment, combinedPayment, helocInterestOnly, cashOutAmount, cashOutCosts, cashOutPayment, keep: { paid, firstOwed, secondOwed, cashCosts, total }, cashOut: { paid, owed, total }, cheaper, difference }`.
  `blendedRate = roundRate((firstBalance * firstRate + cashNeeded * secondRate) / (firstBalance + cashNeeded))`. Payments `roundCents(calcPayment(...))`, first over `firstMonthsLeft / 12`. With `k = compareYears * 12`: `keep.paid = roundDollars(firstPayment * min(k, firstMonthsLeft) + secondPayment * min(k, secondTermYears * 12))`; `firstOwed = roundDollars(remainingBalance(firstBalance, firstRate, firstMonthsLeft / 12, k))`, `secondOwed` likewise; `keep.total = roundDollars(paid + firstOwed + secondOwed + secondCosts)`; `cashOutAmount = firstBalance + cashNeeded + cashOutCosts`; `cashOut.paid = roundDollars(cashOutPayment * min(k, cashOutTermYears * 12))`, `owed = roundDollars(remainingBalance(cashOutAmount, …, k))`, `total = paid + owed`. `cheaper` = "keep" | "cashOut" | "same", `difference = |keep.total − cashOut.total|`. `helocInterestOnly = roundCents(cashNeeded * secondRate / 1200)` for a HELOC, else null. `notes` for a HELOC: `[helocInterestOnly(fmtCents(x)), helocNote]`.

- [ ] **Step 1: Write the failing tests** (both sides):

```js
const BLEND = { firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000, secondKind: "second",
  secondRate: 8.5, secondTermYears: 20, secondCosts: 1500, cashOutRate: 6.75, cashOutTermYears: 30, compareYears: 7 };
test("blended rate, spec 2.3", () => {
  const r = side.blendedRateCalc(BLEND);
  assert.equal(r.out.firstPayment, 1422.63); assert.equal(r.out.secondPayment, 867.82);
  assert.equal(r.out.blendedRate, 4.375); assert.equal(r.out.combinedPayment, 2290.45);
  assert.equal(r.out.cashOutCosts, 6500); assert.equal(r.out.cashOutAmount, 406500); assert.equal(r.out.cashOutPayment, 2636.55);
  assert.deepEqual(r.out.keep, { paid: 192398, firstOwed: 237215, secondOwed: 81779, cashCosts: 1500, total: 512892 });
  assert.deepEqual(r.out.cashOut, { paid: 221470, owed: 369051, total: 590521 });
  assert.equal(r.out.cheaper, "keep"); assert.equal(r.out.difference, 77629);
});
test("HELOC: interest-only line and note", () => {
  const r = side.blendedRateCalc({ ...BLEND, secondKind: "heloc" });
  assert.equal(r.out.helocInterestOnly, 708.33);
  assert.deepEqual(r.notes, ["Interest-only payment on the second: $708.33 a month", side.CALC_LINES.helocNote]);
});
test("blended edge cases", () => {
  assert.deepEqual(side.blendedRateCalc({ ...BLEND, cashNeeded: 0 }).errors, { cashNeeded: "Enter the cash needed." });
  const long = side.blendedRateCalc({ ...BLEND, compareYears: 40 });
  assert.equal(long.out.keep.firstOwed, 0); assert.equal(long.out.keep.secondOwed, 0); assert.equal(long.out.cashOut.owed, 0);
  assert.equal(long.out.keep.paid, Math.round(1422.63 * 300 + 867.82 * 240));
  assert.equal(side.blendedRateCalc({ ...BLEND, secondRate: 2 }).ok, true);   // a second below the first: no warning
  assert.deepEqual(side.blendedRateCalc({ ...BLEND, compareYears: null }).defaulted, ["compareYears"]);
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement** `blendedRateCalc` identically in both blocks.
- [ ] **Step 4: Run to verify they pass** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(calculators): blended rate"`

### Task 4 (Stage A): Buydown (temporary and points)

**Files:** Modify both calculator files (inside markers); Test `server/test/calculators.test.js`.

**Interfaces:**
- Produces: `BUYDOWN_STEPS = { "2-1": [2, 1], "3-2-1": [3, 2, 1], "1-0": [1] }` and `buydownCalc({ kind, loanAmount, noteRate, termYears, rateWithPoints, points, pointsCost }) -> CalcResult`.
  `kind` must be "2-1" | "3-2-1" | "1-0" | "points"; anything else is `missing: ["kind"]`. `termYears` null → 30.
  Temporary: required `loanAmount`, `noteRate`. Refusals: `termYears < steps.length` → `errors.termYears = termTooShort`; `noteRate - steps[0] < 0` → `errors.noteRate = noteTooLow`. `out = { kind, notePayment, years: [{ year, rate, payment }], subsidy }`, `rate = roundRate(noteRate - step)`, `subsidy = roundCents(Σ 12 * (notePayment - payment))`.
  Points: required `loanAmount`, `noteRate`, `rateWithPoints`, and one of `points` / `pointsCost` (`points` wins when both; neither → `missing: ["points"]`). `rateWithPoints >= noteRate` → `errors.rateWithPoints = pointsNotLower`. `cost = pointsCost ?? roundCents(loanAmount * points / 100)`; `points` out = given, or `roundRate(cost / loanAmount * 100)`. `out = { kind, cost, points, paymentWithout, paymentWith, monthlySavings, breakEvenMonth, fullTermSavings }`; `breakEvenMonth = cost > 0 ? Math.ceil(cost / monthlySavings) : null` (`notes: [noCost]` when 0); `fullTermSavings = roundDollars(monthlySavings * termYears * 12 - cost)`; `warnings: [pointsNever]` when `breakEvenMonth > termYears * 12`.

- [ ] **Step 1: Write the failing tests** (both sides):

```js
test("2-1 buydown, spec 2.4", () => {
  const r = side.buydownCalc({ kind: "2-1", loanAmount: 400000, noteRate: 7, termYears: 30 });
  assert.equal(r.out.notePayment, 2661.21);
  assert.deepEqual(r.out.years, [{ year: 1, rate: 5, payment: 2147.29 }, { year: 2, rate: 6, payment: 2398.2 }]);
  assert.equal(r.out.subsidy, 9323.16);
});
test("3-2-1 buydown", () => {
  const r = side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 7, termYears: 30 });
  assert.equal(r.out.years[0].payment, 1909.66); assert.equal(r.out.subsidy, 18341.76);
});
test("Review Focus 2: reduced rates carry no float noise", () => {
  assert.deepEqual(side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 6.15 }).out.years.map((y) => y.rate), [3.15, 4.15, 5.15]);
});
test("temporary buydown refusals", () => {
  assert.deepEqual(side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 7, termYears: 2 }).errors, { termYears: side.CALC_LINES.termTooShort });
  assert.deepEqual(side.buydownCalc({ kind: "3-2-1", loanAmount: 400000, noteRate: 2.5 }).errors, { noteRate: side.CALC_LINES.noteTooLow });
  assert.equal(side.buydownCalc({ kind: "2-1", loanAmount: 400000, noteRate: 2 }).out.years[0].payment, 1111.11);  // 0% year: calcPayment
  assert.deepEqual(side.buydownCalc({ kind: "4-3", loanAmount: 400000, noteRate: 7 }).missing, ["kind"]);
});
test("points, spec 2.4", () => {
  const r = side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 1.5, termYears: 30 });
  assert.deepEqual(r.out, { kind: "points", cost: 6000, points: 1.5, paymentWithout: 2661.21, paymentWith: 2528.27,
    monthlySavings: 132.94, breakEvenMonth: 46, fullTermSavings: 41858 });
  assert.equal(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, pointsCost: 6000 }).out.points, 1.5);
});
test("points edge cases", () => {
  assert.deepEqual(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 7, points: 1 }).errors,
    { rateWithPoints: side.CALC_LINES.pointsNotLower });
  const free = side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 0 });
  assert.equal(free.out.breakEvenMonth, null); assert.deepEqual(free.notes, ["No cost entered"]);
  const never = side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.99, points: 5, termYears: 5 });
  assert.deepEqual(never.warnings, [side.CALC_LINES.pointsNever]);
  assert.deepEqual(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5 }).missing, ["points"]);
  assert.equal(side.buydownCalc({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 21 }).errors.points, side.CALC_LINES.points);
});
```

- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement** `buydownCalc` identically in both blocks.
- [ ] **Step 4: Run to verify they pass** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(calculators): temporary and points buydowns"`

### Task 5 (Stage A): Five hundred input sets, both copies

**Files:** Test `server/test/calculators.test.js`.

**Interfaces:**
- Consumes: all four calculators, both sides; server `refi.calcPayment`, `refi.estClosingCosts`, `pmi.pmiMonthly`; client `refiAnalysis.mjs` exports of the same.
- Produces: nothing new.

- [ ] **Step 1: Write the test** `"500 input sets give identical results from both files"`: a seeded generator (a 32-bit LCG, seed 20261125, no `Math.random`) builds 500 sets spread over the four calculators: rates 0 to 12 in steps of 0.125, terms 1 to 40, months left 1 to 480, amounts 10,000 to 2,000,000, every buydown kind, `costsInLoan` both ways, HELOC and second, some optional fields null. For each set `assert.deepEqual(client.X(set), server.X(set))`. In the same loop: `client.calcPayment === server calcPayment` value for the set's (amount, rate, term), `estClosingCosts(amount)`, and `pmiMonthly(score, ltv, term, amount)` for a score 600 to 800 and LTV 70 to 99, equal both sides. Assert the generator produced at least 100 sets per calculator and at least 1 refusal per calculator.
- [ ] **Step 2: Run it** → PASS (the copies already agree). Then prove it bites: change one constant inside the client block, run → FAIL on byte equality and on deepEqual; revert.
- [ ] **Step 3: Run the whole server suite** `npm test` → PASS.
- [ ] **Step 4: Commit** `git commit -am "test(calculators): 500 input sets agree across both copies"`

### Task 6 (Stage B): Months left in the today block

**Files:**
- Modify: `server/lib/equity.js` (new function after `balanceToday`, export at :66)
- Modify: `server/lib/upgrades.js:81-98` (`todayBlock`)
- Test: `server/test/equity.test.js`, `server/test/upgrades.test.js`

**Interfaces:**
- Produces: `monthsLeftToday(c, today) -> number | null` in `server/lib/equity.js` (ruling above); the today block `t` (sent to the browser as `client.upgrades.today`, and used by Charlie's tools) gains `monthsLeft` as its **last** key. Nothing else in the block, the lenses, the gaps or `balanceToday` changes.

- [ ] **Step 1: Capture the golden.** Before touching code, add to `server/test/upgrades.test.js` a test `"the today block is unchanged apart from monthsLeft"` over six fixture clients (30yr conventional with close date, 15yr, 5/1 ARM, FHA, no close date, no balance), `today = "2026-11-25"`, rates `{ rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_30yr_fha: 6.1, rate_30yr_va: 5.9 }`, default index. Generate the expected objects by running the current `upgradesFor` once and pasting them into the test as literals (`GOLDEN`). The test asserts `deepEqual(withoutMonthsLeft(upgradesFor(c, RATES, TODAY)), GOLDEN[i])` where `withoutMonthsLeft` deletes `today.monthsLeft`. Run → PASS on the old code. Commit this test alone: `git commit -am "test(upgrades): golden today block before months left"`.
- [ ] **Step 2: Write the failing tests** in `server/test/equity.test.js`:

```js
test("monthsLeftToday: 30- and 15-year fixed only, counted to today", () => {
  const T = "2026-11-25";
  assert.equal(monthsLeftToday({ loanType: "30yr_fixed", closeDate: "2024-03-15" }, T), 330);
  assert.equal(monthsLeftToday({ loanType: "15yr_fixed", closeDate: "2024-03-15" }, T), 150);
  assert.equal(monthsLeftToday({ loanType: "30yr_fixed", closeDate: "2026-11-01" }, T), 360);   // first payment still ahead
  assert.equal(monthsLeftToday({ loanType: "30yr_fixed", closeDate: "1990-01-10" }, T), null);  // paid off
  assert.equal(monthsLeftToday({ loanType: "5_1_arm", closeDate: "2024-03-15" }, T), null);
  assert.equal(monthsLeftToday({ loanType: "30yr_fixed", closeDate: null }, T), null);
  assert.equal(monthsLeftToday({ loanType: "30yr_fixed", closeDate: "2024-03-15" }, "bad"), null);
});
```
  and in `upgrades.test.js`: `upgradesFor(fixture30, RATES, TODAY).today.monthsLeft === 330`, `Object.keys(today).at(-1) === "monthsLeft"`, the ARM fixture's is `null`; `todayFigures(fixture30, TODAY).monthsLeft === 330`.
- [ ] **Step 3: Run to verify they fail** → FAIL (`monthsLeftToday is not a function`).
- [ ] **Step 4: Implement** `monthsLeftToday` (uses the file's own `monthsBetween`, `parts` and `firstPaymentFromClosing`); in `todayBlock` add `monthsLeft: monthsLeftToday(c, today)` as the last property of `t`.
- [ ] **Step 5: Run** `npm test` (whole server suite, golden included) → PASS.
- [ ] **Step 6: Commit** `git commit -am "feat(upgrades): months left in the today block (30- and 15-year fixed)"`

### Task 7 (Stage B): Page shell, navigation entry and the Payment card

**Files:**
- Create: `client/src/calculatorsPage.mjs`, `client/src/calculatorsPage.test.mjs`, `client/src/CalculatorsView.jsx`
- Modify: `client/src/nav.mjs:13-19` (MAIN), `client/src/nav.test.mjs` (expected orders), `client/package.json` (`test` script: add `src/calculatorsPage.test.mjs`), `client/src/App.jsx` (import; `Icon` paths :74-97 gain `calculator`; view line after :3471)

**Interfaces:**
- Consumes: Task 1-4 exports from `client/src/calculators.mjs`.
- Produces:
  - `readNumber(text) -> number | null` ("" / whitespace → null; strips "$", ",", spaces; anything else non-numeric → `NaN`, which the shared limits refuse).
  - `fredLink(rates, termYears) -> { rate, text } | null`: only when `rates.source` starts with "Optimal Blue lock data", `rates.date` is a real YYYY-MM-DD day, and the term is 30 (`rate_30yr_fixed`) or 15 (`rate_15yr_fixed`) with a finite rate. `text` = `Use today's 30-year average, 6.52%, from November 24, 2026` (`fmtRate`; the date as month name, day, year, read in UTC).
  - `CARDS = [["payment", "Payment"], ["breakEven", "Refi break-even"], ["blended", "Blended rate"], ["buydown", "Buydown"]]`.
  - `CalculatorsView({ rates, prefill, onClearPrefill, ui })` default export, `ui = { C, card, mono, Icon, inputStyle, btnPrimary, btnGhost, ph }`. State: one object of input strings per card, kept while the page is mounted; which card shows; touched fields.
  - nav item `{ id: "calculators", label: "Calculators", icon: "calculator" }` right after `rates` in MAIN (both roles); App view id `"calculators"`.

- [ ] **Step 1: Write the failing tests** in `client/src/calculatorsPage.test.mjs`:

```js
test("Review Focus 1: readNumber reads typed and pasted money", () => {
  assert.equal(readNumber("$400,000"), 400000); assert.equal(readNumber(" 400,000.00 "), 400000);
  assert.equal(readNumber(""), null); assert.ok(Number.isNaN(readNumber("4oo")));
});
test("fredLink: today's FRED average for a 30- or 15-year term only", () => {
  const R = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-11-24", source: "Optimal Blue lock data (2026-11-24) · ARM estimated" };
  assert.deepEqual(fredLink(R, 30), { rate: 6.52, text: "Use today's 30-year average, 6.52%, from November 24, 2026" });
  assert.equal(fredLink(R, 15).text, "Use today's 15-year average, 5.91%, from November 24, 2026");
  assert.equal(fredLink(R, 20), null);
  assert.equal(fredLink({ ...R, source: "Estimated — server error" }, 30), null);
  assert.equal(fredLink({ ...R, date: "2026-02-30" }, 30), null); assert.equal(fredLink(null, 30), null);
});
```
  and in `nav.test.mjs` the LO and broker expected orders gain `["calculators", "Calculators"]` after `["rates", "Rate Watch"]`; `viewFor("calculators") === "calculators"`.
- [ ] **Step 2: Run** `cd client && npm test` → FAIL.
- [ ] **Step 3: Implement** `calculatorsPage.mjs` helpers and the nav item. Then `CalculatorsView.jsx`: header "Calculators" (h1 as Rate Watch's, App.jsx:1989) with `CALC_LINES.estimate` under it; a wrapping row (`flexWrap: "wrap"`) of the four `CARDS` buttons (active = `btnPrimary`, others `btnGhost`); the card: `display: grid, gridTemplateColumns: gridCols(2, isPhone)` (inputs left, results right; on a phone results sit under the inputs), `useIsPhone()` from `./useIsPhone.js`. Payment card inputs in the spec 2.1 order; Term starts "30"; the mortgage-insurance field shows the result's estimate with an "estimate" tag beside it while untyped (`estimated.mi`), and the typed value once typed. Results: tile figures (label 11px muted uppercase, value `mono` 20px bold) for each output with `fmtCents`, "not entered" beside each `notEntered` line, the total last, then `CALC_LINES.estimate` under every result. A field's error line (13px, `C.red`) shows under it when `errors[field]` exists and the field was touched; a `missing` field shows nothing (ruling). No result is drawn unless `ok`. In App.jsx: `import CalculatorsView from "./CalculatorsView.jsx";` the `calculator` icon path (`"M4 2h16v20H4zM8 6h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 19h2M12 19h2M16 15v4"`), and `{view === "calculators" && <CalculatorsView rates={rates} prefill={null} onClearPrefill={() => {}} ui={{ C, card, mono, Icon, inputStyle, btnPrimary, btnGhost, ph }} />}` after the Rate Watch line.
- [ ] **Step 4: Run** `npm test` → PASS; `npx vite build` → builds with no error.
- [ ] **Step 5: Look at it** (see "Visual checks" below). At desktop and 375px: the Payment card shows $3,254.94 for the spec 2.1 inputs, and the four buttons wrap on a phone.
- [ ] **Step 6: Commit** `git add client && git commit -m "feat(calculators): Calculators page, nav entry and the Payment card"`

### Task 8 (Stage B): Break-even, Blended rate and Buydown cards

**Files:**
- Modify: `client/src/CalculatorsView.jsx`, `client/src/calculatorsPage.mjs`, `client/src/calculatorsPage.test.mjs`

**Interfaces:**
- Consumes: `breakEvenCalc`, `blendedRateCalc`, `buydownCalc`, `fredLink`, `readNumber`.
- Produces: `pointsFromEdit(lastEdited, { points, pointsCost }) -> { points, pointsCost }` in `calculatorsPage.mjs`: the field edited last ("points" | "pointsCost") is passed, the other `null`.

- [ ] **Step 1: Write the failing test**: `pointsFromEdit("pointsCost", { points: "1.5", pointsCost: "6,000" })` → `{ points: null, pointsCost: 6000 }`; `pointsFromEdit("points", …)` → `{ points: 1.5, pointsCost: null }`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Break-even card: inputs in spec 2.2 order; "Costs paid how" is a two-button choice "In cash" / "Added to the new loan", starting "In cash"; closing costs show the estimate with the "estimate" tag until typed; under the new-rate field the `fredLink(rates, newTermYears)` text as a link-styled button (`C.blue`, no underline change of style elsewhere) that sets the field to `rate` only on click; current payment tile labelled with `CALC_LINES.currentPaymentLabel`; savings shown as `fmtCents` or, when negative, `CALC_LINES.moreAMonth(fmtCents(-x))`; break-even "Month {n}" or `noCosts`; totals with `fmtDollars`; warnings (`C.amber`) under the results; notes (`C.muted`). Blended card: inputs per spec 2.3 (kind choice "Second" / "HELOC"; cash-out rate gets the FRED link for its term; cash-out costs show the estimate tag); outputs per spec 2.3, blended rate with `fmtBlended`, the two totals as tiles labelled "Keep + second total" and "Cash-out total", then one summary line: `Keeping the first and adding a second costs $77,629 less over 7 years.` / `The cash-out costs $X less over Y years.` / `Both cost the same over Y years.` (owner OK list); for a HELOC the notes (interest-only line, HELOC note) under it. Buydown card: kind choice "2-1" / "3-2-1" / "1-0" / "Points"; temporary: a tile per year ("Year 1 at 5%") plus "From then on" and "Buydown cost" (`fmtCents`); points: rate without, rate with, points and cost (both typeable, last edited wins via `pointsFromEdit`, the other shows the recomputed figure), outputs per spec 2.4. Every result ends with `CALC_LINES.estimate`.
- [ ] **Step 4: Run** `npm test` → PASS; `npx vite build` → OK.
- [ ] **Step 5: Look at it** at desktop and 375px: the spec 2.2, 2.3 and 2.4 worked examples show their figures exactly ($309.67, month 20; $24,676 warning at 6.75%; $77,629 less; $9,323.16; month 46). Switching cards keeps what was typed in each.
- [ ] **Step 6: Commit** `git commit -am "feat(calculators): break-even, blended rate and buydown cards"`

### Task 9 (Stage B): Open in calculator, the pre-fill strip and the phone pass

**Files:**
- Modify: `client/src/calculatorsPage.mjs`, `client/src/calculatorsPage.test.mjs`, `client/src/CalculatorsView.jsx`
- Modify: `client/src/App.jsx` — `ClientDetail` (:1576 signature gains `onOpenCalculator`; button in the Refi Analysis card header :1762 and in the placeholder card :1793), the `ClientDetail` render line :3473, App state near :2989 (`calcPrefill`), the calculators view line from Task 7

**Interfaces:**
- Consumes: `pricedToday(client)` from `client/src/equity.mjs:29`; `client.upgrades.today.monthsLeft` (Task 6); `client.creditScoreKnown` (true only for a real score); `possessive`, `fmtAmount`, `fmtRate` from `calculators.mjs`.
- Produces:
  - `MONTHS_MISSING = "Months left isn't on this client's record. Type it."`
  - `prefillFrom(client) -> { name, balance, balanceBasis, rate, monthsLeft, monthsTerm, value, score }`: `balance` and `value` from `pricedToday(client)` (`loanBalance`, `propertyValue`), each `null` unless finite and `> 0` (Review Focus 4); `balanceBasis` = "rolled" when `client.upgrades.today.balanceBasis === "rolled"` and today's figures were used, else "stored"; `rate = client.currentRate`; `monthsLeft` = today's `monthsLeft` when an integer 1-480, else null; `monthsTerm` = 30 | 15 from `client.loanType`; `score = client.creditScoreKnown === true && Number.isFinite(client.creditScore) ? client.creditScore : null`.
  - `prefillStrip(p) -> string`: `Filled in from ${possessive(name)} record: ` + parts joined by ", " + `. Change any figure. Nothing here is saved to the client.`; parts: `balance ${fmtAmount(balance)} (estimated for today)` or `(on file)`; `rate ${fmtRate(rate)}`; `${monthsLeft} months left (from the closing date, on a ${monthsTerm}-year term)`; a null figure's part is left out.
  - `prefillInputs(p) -> { payment, breakEven, blended }`: input strings — payment `loanAmount, rate, homeValue, creditScore`; breakEven `currentBalance, currentRate, monthsLeft, homeValue, creditScore`; blended `firstBalance, firstRate, firstMonthsLeft`; nulls become "".
  - App: `onOpenCalculator(client)` → `setCalcPrefill({ ...prefillFrom(client), stamp: Date.now() })`, `setView("calculators")`, `window.scrollTo(0, 0)`; a `useEffect` on `view` clears `calcPrefill` whenever `view !== "calculators"`. The view line passes `key={calcPrefill ? calcPrefill.stamp : "blank"}`, `prefill={calcPrefill}`, `onClearPrefill={() => setCalcPrefill(null)}`.

- [ ] **Step 1: Write the failing tests:**

```js
const CHEN = { name: "Robert & Linda Chen", currentRate: 7.25, loanType: "30yr_fixed", loanBalance: 360000, propertyValue: 700000,
  creditScore: 742, creditScoreKnown: true,
  upgrades: { lenses: [], gaps: [], today: { balance: 350000, balanceBasis: "rolled", cautiousValue: 585000, monthsLeft: 324 } } };
test("prefillStrip: the spec's example", () => {
  assert.equal(prefillStrip(prefillFrom(CHEN)), "Filled in from Robert & Linda Chen's record: balance $350,000 (estimated for today), " +
    "rate 7.25%, 324 months left (from the closing date, on a 30-year term). Change any figure. Nothing here is saved to the client.");
});
test("prefillFrom: cautious value, real score only, months only from the record", () => {
  const p = prefillFrom(CHEN);
  assert.deepEqual([p.balance, p.value, p.score, p.monthsLeft], [350000, 585000, 742, 324]);
  assert.equal(prefillFrom({ ...CHEN, creditScore: 700, creditScoreKnown: false }).score, null);
  const arm = prefillFrom({ ...CHEN, loanType: "5_1_arm", upgrades: { ...CHEN.upgrades, today: { ...CHEN.upgrades.today, monthsLeft: null } } });
  assert.equal(arm.monthsLeft, null); assert.doesNotMatch(prefillStrip(arm), /months left/);
  assert.equal(MONTHS_MISSING, "Months left isn't on this client's record. Type it.");
  const stored = prefillFrom({ ...CHEN, upgrades: null });
  assert.equal(stored.balance, 360000); assert.match(prefillStrip(stored), /balance \$360,000 \(on file\)/);
  assert.deepEqual(prefillInputs(prefillFrom(CHEN)).breakEven,
    { currentBalance: "350000", currentRate: "7.25", monthsLeft: "324", homeValue: "585000", creditScore: "742" });
});
test("Review Focus 4: a paid-off or blank balance is left blank", () => {
  for (const balance of [0, null]) {
    const p = prefillFrom({ ...CHEN, upgrades: { ...CHEN.upgrades, today: { ...CHEN.upgrades.today, balance } } });
    assert.equal(p.balance, null); assert.doesNotMatch(prefillStrip(p), /balance/);
    assert.equal(prefillInputs(p).breakEven.currentBalance, "");
  }
});
```

- [ ] **Step 2: Run** `npm test` → FAIL.
- [ ] **Step 3: Implement** the helpers; in `CalculatorsView`, when `prefill` is set: start on Refi break-even, seed the three cards' inputs from `prefillInputs`, show the strip above the card (13px, `C.mutedHi`, on `C.surfaceHi`, radius 8) with a "Clear" link (`C.blue`) that calls `onClearPrefill` (the remount on the new `key` empties every card), and when `monthsLeft` is null show `MONTHS_MISSING` under the months-left field of break-even and blended. In `ClientDetail` add the "Open in calculator" button (`btnGhost`, small padding like the card's existing buttons) to the right of the Refi Analysis heading and inside the placeholder card. A loan officer only reaches their own clients' pages, so nothing else gates it.
- [ ] **Step 4: Run** `npm test` → PASS; `npx vite build` → OK; root `node scripts/check-scoring.js` → its usual all-pass output.
- [ ] **Step 5: Phone pass and look** (see "Visual checks"). At 375px: the four buttons wrap, inputs stack, results sit under them, the strip wraps, no horizontal page scroll. Open a client, press Open in calculator: the strip and the filled fields show; Clear empties them; leaving the page and coming back by the sidebar shows empty cards.
- [ ] **Step 6: Commit** `git commit -am "feat(calculators): Open in calculator with the pre-fill strip"`

### Task 10 (Stage C): Charlie's four calculator tools and their code-written lines

**Files:**
- Create: `server/lib/assistant/calcLines.js`
- Modify: `server/lib/assistant/tools.js` (four tools after `showScreenTool` :420-444; the `tools` map :1063; `TOOL_SCHEMA` :1075; `module.exports` :1397)
- Test: `server/test/assistant-calculators-tools.test.js`

**Interfaces:**
- Consumes: `paymentCalc`, `breakEvenCalc`, `blendedRateCalc`, `buydownCalc`, `fmt*`, `possessive`, `CALC_LINES`, `BUYDOWN_STEPS` from `server/lib/calculators.js`; `scopedClients`, `idOf`, `fail`, `clockOf` in tools.js; `upgradeAlerts.safeCheckUpgrades(db, orgId, now)`, `upgradeAlerts.safeUpgradeViewsFor(db, rows, check, now)`, `upgradeAlerts.safeUpgradeRates(db, now)`; `refi.norm(row)`, `refi.pricedToday(c, today)`.
- Produces:
  - `calcLines.js`: `QUESTIONS` (below), `paymentLine(r)`, `breakEvenLine(r, { clientName, todaysAverage })`, `blendedLine(r, { todaysAverage })`, `buydownLine(r)`, `questionFor(tool, field, { forClient })`, all returning strings.
  - Tools `paymentCalcTool`, `breakEvenCalcTool`, `blendedRateCalcTool`, `buydownCalcTool`, each `(args, ctx) -> { data, source, say? }`:
    - answer: `{ data: { calculator, result, client: { id, name } | null, todaysAverage: boolean }, source: "calculator", say: <line> }`
    - question (missing input): `{ data: { calculator, missing: field }, source: "(calculator question)", say: <question> }`
    - refusal (`errors`): `{ data: { calculator, refused: field }, source: "(calculator refusal)", say: <first error line> }`
    - bad or out-of-scope client: `fail("(invalid input)", "a valid clientId is required")` / `fail("(not found)", "no such client in your book")`, no `say`.
  - `result` is exactly the shared function's return for the inputs the tool built.
  - Argument reading: `num(v)` = finite number → itself; a string matching `/^-?\d+(\.\d+)?$/` → `Number`; anything else → `null`. Rates via `roundRate`. Said figures win over the record.
  - Client fill (`clientId` given): the row from `scopedClients(ctx)`; `today` = `safeUpgradeViewsFor(ctx.db, [row], safeCheckUpgrades(ctx.db, ctx.user.org_id, clockOf(ctx)), clockOf(ctx)).get(row.id)?.today`; `priced = refi.pricedToday(refi.norm(row), today)`; balance `priced.loanBalance`, value `priced.propertyValue`, rate `row.current_rate`, months left `today?.monthsLeft ?? null`, score `row.credit_score_known === 1 ? row.credit_score : null`. Payment fills `loanAmount, rate, homeValue, creditScore`; break-even `currentBalance, currentRate, monthsLeft, homeValue, creditScore`; blended `firstBalance, firstRate, firstMonthsLeft`; buydown takes no client.
  - `useTodaysAverage: true` with no rate said, on break-even's new rate or blended's cash-out rate: `rates = safeUpgradeRates(ctx.db, clockOf(ctx))`; term 30 → `rates.rate_30yr_fixed`, 15 → `rates.rate_15yr_fixed`; any other term, null rates or a non-finite rate → the rate stays null (so the question is asked). Never for any other rate.
  - Buydown: `kind` missing with `rateWithPoints` or `points` said → "points".

Questions (`QUESTIONS`, word for word, spec 4) and the field each answers, asked one at a time in the order the fields are listed for each calculator in Tasks 1-4:
- break-even `newRate`: "What rate are you looking at for them?" with a client, else "What's the new rate?"; `monthsLeft` / `firstMonthsLeft`: "How many months are left on the current loan?"; `loanAmount` / `currentBalance` / `firstBalance`: "What's the loan amount?"; `rate` / `currentRate` / `firstRate` / `noteRate`: "What's the rate?"; `cashNeeded`: "How much cash do they need?"; `secondRate`: "What's the rate on the second?"; `cashOutRate`: "What rate for the cash-out?"; `rateWithPoints`: "What's the rate with points?"; `points`: "How many points?"; `kind`: "Which buydown: 2-1, 3-2-1 or 1-0?".
- A refusal wins over a question (the first `errors` line, else the first `missing` field's question).

Line templates (spec 4 plus the rulings; `{a}` amounts `fmtAmount`, monthly figures and buydown cost `fmtCents`, totals and costs-as-totals `fmtDollars` / `fmtAmount` as ruled, rates `fmtRate`, blended `fmtBlended`; "1 year", "1 month", "1 point" singular; a today's-average rate is written `today's estimated average of {fmtRate(x)}`):
- Payment, no taxes/insurance/MI/HOA and no estimated MI: `On {amount} at {rate} over {years} years, principal and interest is {pi} a month, before taxes, insurance and any HOA.`
- Payment otherwise: `On {amount} at {rate} over {years} years, the payment is {total} a month: {pi} principal and interest{, {taxes} taxes}{, {insurance} insurance}{, {mi} {estimated }mortgage insurance}{, {hoa} HOA}.{ {List} not entered.}` — the list from `notEntered` as words "taxes", "insurance", "mortgage insurance", "HOA", joined "a, b and c", first letter capitalized.
- Break-even: `Taking {possessive(name) |the }{balance} at {rate} with {months} months left to {newRate} over {years} years moves the payment from {currentPayment} to {newPayment}, saving {savings} a month.{ The new payment includes {miNew} of estimated mortgage insurance.} With {estimated }closing costs of {costs}{ added to the loan}, break-even is month {n}.` then each warning, space-separated. Zero costs: the last sentence is `No costs entered.` No saving: `, saving {savings} a month` → `, {moreAMonth}` and the break-even sentence is dropped.
- Blended: `Keeping the {firstRate} first and adding a {cash} {second|HELOC} at {secondRate} over {years} years blends to {blended} at {combined} a month. A cash-out to {cashOutAmount} at {cashOutRate} over {years} years, with {estimated }costs of {costs} in the loan, is {payment} a month. Over {Y} years, {keeping the first|the cash-out} costs {difference} less.` (equal: `Over {Y} years, both cost the same.`), then the HELOC note for a HELOC.
- Temporary buydown: `On {amount} at {rate} over {years} years, a {kind} buydown makes the payment {y1} in year one{, {y2} in year two}{, {y3} in year three}, then {notePayment}. It costs {subsidy}.`
- Points: `On {amount} over {years} years, {points} points for {cost} take the rate from {rate} to {rateWithPoints} and the payment from {before} to {after}, saving {savings} a month. Break-even is month {n}.` (zero cost: `No cost entered.` in place of the last sentence), then the never-pays-back warning when it applies.

- [ ] **Step 1: Write the failing tests** (throwaway DB as `assistant-tools.test.js` sets it up; `ctx.now = Date.parse("2026-11-25T12:00:00Z")`: one broker org with two LOs; LO 1's client "Grace Okafor": `30yr_fixed`, rate 7.25, balance 350000, `balance_as_of` today (so today's balance is the stored one), close date `2024-03-15` (330 months left by Task 6), value 700000, score 742 with `credit_score_known` 1; LO 1's ARM client (`5_1_arm`, no months left); a client with `credit_score_known` 0; a FRED snapshot stored with `rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, date: "2026-11-24"` (`ctxLater` = the same ctx 20 days later: the snapshot is too old). Where the spec's 324-month figures are asserted, the test says `monthsLeft: 324` and `currentBalance: 350000`, which win over the record):

```js
test("payment: nothing else said", () => {
  const r = tools.paymentCalcTool({ loanAmount: 400000, rate: 6.5 }, ctxLo1);
  assert.equal(r.say, "On $400,000 at 6.5% over 30 years, principal and interest is $2,528.27 a month, before taxes, insurance and any HOA.");
  assert.equal(r.source, "calculator"); assert.deepEqual(r.data.result, calc.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: null,
    taxesYearly: null, insuranceYearly: null, miMonthly: null, hoaMonthly: null, homeValue: null, creditScore: null }));
});
test("payment with extras and not-entered", () => {
  assert.equal(tools.paymentCalcTool({ loanAmount: 400000, rate: 6.5, taxesYearly: 4800 }, ctxLo1).say,
    "On $400,000 at 6.5% over 30 years, the payment is $2,928.27 a month: $2,528.27 principal and interest, $400.00 taxes. " +
    "Insurance, mortgage insurance and HOA not entered.");
  assert.equal(calcLines.paymentLine(calc.paymentCalc({ loanAmount: 400000, rate: 6.5, termYears: 30, taxesYearly: 4800,
    insuranceYearly: 1800, hoaMonthly: 50, homeValue: 450000, creditScore: 740 })),
    "On $400,000 at 6.5% over 30 years, the payment is $3,254.94 a month: $2,528.27 principal and interest, $400.00 taxes, " +
    "$150.00 insurance, $126.67 estimated mortgage insurance, $50.00 HOA.");
});
test("break-even: the spec's Okafor example", () => {
  const q = tools.breakEvenCalcTool({ clientId: okaforId, monthsLeft: 324, currentBalance: 350000 }, ctxLo1);
  assert.equal(q.say, "What rate are you looking at for them?");
  const a = tools.breakEvenCalcTool({ clientId: okaforId, monthsLeft: 324, currentBalance: 350000, newRate: 6.25 }, ctxLo1);
  assert.equal(a.say, "Taking Grace Okafor's $350,000 at 7.25% with 324 months left to 6.25% over 30 years moves the payment " +
    "from $2,464.68 to $2,155.01, saving $309.67 a month. With estimated closing costs of $6,000, break-even is month 20.");
  const b = tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newRate: 6.75 }, ctxLo1);
  assert.equal(b.say, "Taking the $350,000 at 7.25% with 324 months left to 6.75% over 30 years moves the payment from $2,464.68 " +
    "to $2,270.09, saving $194.59 a month. With estimated closing costs of $6,000, break-even is month 31. Lower payment, higher total: " +
    "restarting the clock costs $24,676 more over the life of the loan than keeping the current loan.");
  assert.match(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, newRate: 6.25, costsInLoan: true }, ctxLo1).say,
    /with estimated closing costs of \$6,000 added to the loan, break-even is month 22\.$/i);
});
test("at today's rate: the stored 30- or 15-year FRED average, said as an estimate", () => {
  const a = tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true }, ctxLo1);
  assert.match(a.say, /to today's estimated average of 6\.52% over 30 years/); assert.equal(a.data.todaysAverage, true);
  assert.match(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true, newTermYears: 15 }, ctxLo1).say, /5\.91%/);
  assert.equal(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true, newTermYears: 20 }, ctxLo1).say, "What's the new rate?");
  // no snapshot (or one older than 10 days): she asks
  assert.equal(tools.breakEvenCalcTool({ currentBalance: 350000, currentRate: 7.25, monthsLeft: 324, useTodaysAverage: true }, ctxLater).say, "What's the new rate?");
  // never for a payment, a buydown or a second's rate
  assert.equal(tools.paymentCalcTool({ loanAmount: 400000, useTodaysAverage: true }, ctxLo1).say, "What's the rate?");
});
test("blended and buydown lines, spec examples", () => {
  assert.equal(tools.blendedRateCalcTool({ firstBalance: 300000, firstRate: 3, firstMonthsLeft: 300, cashNeeded: 100000,
    second: { kind: "second", rate: 8.5, termYears: 20, costs: 1500 }, cashOut: { rate: 6.75, termYears: 30 }, compareYears: 7 }, ctxLo1).say,
    "Keeping the 3% first and adding a $100,000 second at 8.5% over 20 years blends to 4.375% at $2,290.45 a month. A cash-out to " +
    "$406,500 at 6.75% over 30 years, with estimated costs of $6,500 in the loan, is $2,636.55 a month. Over 7 years, keeping the " +
    "first costs $77,629 less.");
  assert.equal(tools.buydownCalcTool({ kind: "2-1", loanAmount: 400000, noteRate: 7 }, ctxLo1).say,
    "On $400,000 at 7% over 30 years, a 2-1 buydown makes the payment $2,147.29 in year one, $2,398.20 in year two, then $2,661.21. It costs $9,323.16.");
  assert.equal(tools.buydownCalcTool({ kind: "points", loanAmount: 400000, noteRate: 7, rateWithPoints: 6.5, points: 1.5 }, ctxLo1).say,
    "On $400,000 over 30 years, 1.5 points for $6,000.00 take the rate from 7% to 6.5% and the payment from $2,661.21 to $2,528.27, " +
    "saving $132.94 a month. Break-even is month 46.");
  assert.equal(tools.buydownCalcTool({ loanAmount: 400000, noteRate: 7 }, ctxLo1).say, "Which buydown: 2-1, 3-2-1 or 1-0?");
  assert.equal(tools.buydownCalcTool({ kind: "3-2-1", loanAmount: 400000, noteRate: 7, termYears: 2 }, ctxLo1).say, "The term must be at least as long as the buydown.");
});
test("Review Focus 5: a figure code can't read is asked for, never guessed", () => {
  assert.equal(tools.paymentCalcTool({ loanAmount: "400k", rate: 6.5 }, ctxLo1).say, "What's the loan amount?");
  assert.equal(tools.paymentCalcTool({ loanAmount: -5, rate: 6.5 }, ctxLo1).say, "Enter an amount above $0, up to $50,000,000.");
  assert.equal(tools.paymentCalcTool({ loanAmount: 400000, rate: 65 }, ctxLo1).say, "Enter a rate from 0% to 20%.");
});
test("scoped clients: another LO's client is no such client; the data carries no contact details", () => {
  const r = tools.breakEvenCalcTool({ clientId: okaforId, newRate: 6.25 }, ctxLo2);
  assert.deepEqual(r, { data: { error: "no such client in your book" }, source: "(not found)" });
  const mine = tools.breakEvenCalcTool({ clientId: okaforId, newRate: 6.25, monthsLeft: 324 }, ctxLo1);
  assert.deepEqual(Object.keys(mine.data.client), ["id", "name"]);
  assert.doesNotMatch(JSON.stringify(mine), /@example|555-/);   // the fixture's email and phone
  assert.equal(mine.data.result.inputs.creditScore, 742);
});
test("the 700 default score is never used", () => {
  const r = tools.paymentCalcTool({ clientId: defaultScoreId }, ctxLo1);
  assert.equal(r.data.result.inputs.creditScore, null);
});
test("a client with no months left on record: she asks", () => {
  assert.equal(tools.breakEvenCalcTool({ clientId: armClientId, newRate: 6.25 }, ctxLo1).say, "How many months are left on the current loan?");
});
```

- [ ] **Step 2: Run** `node --test test/assistant-calculators-tools.test.js` → FAIL.
- [ ] **Step 3: Implement** `calcLines.js` and the four tools. Schemas (`TOOL_SCHEMA`): one entry per tool with the spec 4 property names (`blendedRateCalcTool`: `second` and `cashOut` objects), every figure `type: "number"`, `clientId` integer, `useTodaysAverage` boolean, `kind` enum. Each description says: call it with only the figures the user said (and `clientId` from findClient for a client); the app works out and says the answer, or asks for what is missing; pass `useTodaysAverage: true` instead of a rate only when the user says "today's rate" or "today's average" (break-even new rate, blended cash-out rate).
- [ ] **Step 4: Run** the file → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `git add server/lib/assistant/calcLines.js server/lib/assistant/tools.js server/test/assistant-calculators-tools.test.js && git commit -m "feat(charlie): four calculator tools with code-written lines"`

### Task 11 (Stage C): The orchestrator ends the turn on a calculator line

**Files:**
- Modify: `server/lib/assistant/orchestrator.js` — `LAST_CALL_TOOLS` :68, `forModel` :1904, `runTool` :1920-1945, the change handling :3389-3416, `finish` :3084
- Test: `server/test/assistant-calculators-orchestrator.test.js` (copy the fake-client helpers of `assistant-orchestrator.test.js:31-125`); `server/test/assistant-api.test.js` (one route test)

**Interfaces:**
- Consumes: Task 10 tools' `{ data, source, say }`.
- Produces:
  - `CALC_TOOLS = new Set(["paymentCalcTool", "breakEvenCalcTool", "blendedRateCalcTool", "buydownCalcTool"])`; `LAST_CALL_TOOLS` = side-effect tools + `draftEmailTool` + `showScreenTool` + `CALC_TOOLS`.
  - `forModel(name, data)` for a calculator tool: `data.error ? { error: data.error } : { answeredByApp: true }` (`trimCalc`). Exported `forModel` keeps its signature.
  - `runTool` returns `say` (a non-empty string from `result.say`, else undefined) beside `sideEffect`, `compose`, `screen`.
  - Turn ending: `changes = outs.filter((o) => o.sideEffect || o.compose || o.screen || o.say)`; more than one → `ONE_AT_A_TIME` (as today); exactly one with `say` → `{ ...finish(o.say, isCitation(o.source) ? [o.source] : []), calculator: <tool name> }`. No `sideEffect`, `compose`, `screen` or `details` on it. This runs after `codeAuthoredLine` and the screen checks, exactly where the screen and compose cases sit. No `navTurn` or `actionTurn` gate (the tools change nothing). The model text in the same response is dropped; no further model call is made.
  - The route (`routes/assistant.js:694`) is unchanged: its payload is `{ reply, sources, turnId }` for a calculator turn.

- [ ] **Step 1: Write the failing tests:**

```js
test("risk 1: a calculator answer ends the turn in code; the model never sees the result", async () => {
  const client = fakeClient([resp([{ type: "text", text: "Let me run that: about $2,500." },
    { type: "tool_use", id: "t1", name: "paymentCalcTool", input: { loanAmount: 400000, rate: 6.5 } }], "tool_use")]);
  const out = await runTurn({ messages: userSays("What's the payment on 400k at six and a half for thirty years?"), ctx, client });
  assert.equal(out.reply, "On $400,000 at 6.5% over 30 years, principal and interest is $2,528.27 a month, before taxes, insurance and any HOA.");
  assert.deepEqual(out.sources, ["calculator"]); assert.equal(out.calculator, "paymentCalcTool");
  assert.equal(client.calls.length, 1);
  for (const k of ["sideEffect", "compose", "screen", "details"]) assert.ok(!(k in out), k);
});
test("findClient, then the calculator: the question ends the turn", async () => { /* script: findClient → breakEvenCalcTool({clientId}) → reply "What rate are you looking at for them?", calls 2, and calls[1] never contains "2,464.68" */ });
test("forModel hides a calculator result", () => {
  assert.deepEqual(forModel("breakEvenCalcTool", { calculator: "breakEven", result: { ok: true } }), { answeredByApp: true });
  assert.deepEqual(forModel("breakEvenCalcTool", { error: "no such client in your book" }), { error: "no such client in your book" });
});
test("a not-found client goes back to the model like any read", async () => { /* LO 2 + Okafor id: the 2nd model call sees {source:"(not found)", data:{error}} and its text reply is screened as usual */ });
test("one at a time: a calculator beside a change, an email, a screen or another calculator", async () => {
  for (const other of [["logContactTool", { clientId, outcome: "reached" }], ["draftEmailTool", { clientId, purpose: "check_in" }],
    ["showScreenTool", { page: "rates" }], ["buydownCalcTool", { kind: "2-1", loanAmount: 400000, noteRate: 7 }]]) {
    // user text: "take me to Rate Watch and what's the payment on 400k at 6.5" (a page request) so the screen is not dropped first
    assert.equal(out.reply, ONE_AT_A_TIME); assert.ok(!out.sideEffect && !out.compose && !out.screen);
  }
});
test("the last allowed model call still runs a calculator", async () => { /* 3 findClient rounds then paymentCalcTool on call 4 → the line */ });
test("a calculator beside a read in one response: the calculator ends the turn", async () => { /* findClient + paymentCalcTool together → the line, 1 call */ });
test("the form-open lock is for pages only: a calculator answers with a form open", async () => { /* ctx.onScreen = {page:"form"} → the line */ });
test("risk 3: a later turn's figure about an earlier answer has no tool behind it", async () => {
  const messages = [{ role: "user", content: "What's the payment on 400k at 6.5?" },
    { role: "assistant", content: "On $400,000 at 6.5% over 30 years, principal and interest is $2,528.27 a month, before taxes, insurance and any HOA." },
    { role: "user", content: "So that's about $2,500 a month?" }];
  assert.equal((await runTurn({ messages, ctx, client: fakeClient([say("Yes, about $2,528.27.")]) })).reply, CANT_VERIFY);
  const rerun = await runTurn({ messages, ctx, client: fakeClient([useTool("paymentCalcTool", { loanAmount: 400000, rate: 6.5 })]) });
  assert.match(rerun.reply, /^On \$400,000 at 6\.5%/);
});
test("the figure check still holds on a turn with no calculator", async () => { /* say("Her payment is $1,234.") with no tool → CANT_VERIFY */ });
```
  `assistant-api.test.js`: POST `/api/assistant/turn` with the fake client scripted to call `paymentCalcTool` → 200, `Object.keys(body).sort()` deep-equals `["reply", "sources", "turnId"]`.
- [ ] **Step 2: Run** the new file → FAIL.
- [ ] **Step 3: Implement** as in Interfaces; update the comments at `LAST_CALL_TOOLS` and above the change handling to name the fourth kind ("a calculator line: read-only, nothing to confirm").
- [ ] **Step 4: Run** the new file → PASS; then the whole server suite `npm test` → PASS (the existing orchestrator, navigation, judge and API suites are the "Must keep working" list's guard).
- [ ] **Step 5: Commit** `git commit -am "feat(charlie): a calculator line ends the turn in code"`

### Task 12 (Stage C): Prompt, the Calculators screen, navigation phrases and eval cases

**Files:**
- Modify: `server/lib/assistant/prompt.js` (new paragraph after the "Screens:" paragraph :199-202)
- Modify: `server/lib/assistant/navigation.js` (:7 `SCREEN_PAGES`, :15 `PAGE_LINES`, :26 `ON_SCREEN_PAGES`, :94 `PAGE_NAME_RE`, :121-149 `isNavigationRequest`, :163 `CLAIM_PAGE_NAME`, :240 `PAGE_MENTION_RE`)
- Modify: `server/lib/assistant/tools.js` (`showScreenTool` schema description :1365)
- Modify: `client/src/charlieNav.mjs:3` (`SAME`), `client/src/charlieNav.test.mjs`
- Modify: `server/scripts/charlie-eval.js` (`lockBreaks` :294, `outcomeOf` :341, `caseResult` :546 carries `calculator`), `server/scripts/charlie-eval-cases.json`
- Test: `server/test/assistant-navigation.test.js`, `server/test/charlie-eval.test.js`, `server/test/assistant-orchestrator.test.js` (the `CHARLI_SYSTEM` paragraph check)

**Interfaces:**
- Produces: `SCREEN_PAGES` gains `"calculators"` after `"rates"` (not broker-only); `PAGE_LINES.calculators = "Here's Calculators."`; `onScreenOf({ view: "calculators" })` → `{ page: "calculators" }`; `CALC_TOPIC_RE = /\b(?:break[\s-]?even|payments?|blended|blend|buy[\s-]?downs?|points|cash[\s-]?out)\b/`; in `isNavigationRequest`, a strong or soft request whose remainder matches `CALC_TOPIC_RE` and not `/\bcalculators?\b/` is not a page request; `PAGE_NAME_RE`, `PAGE_MENTION_RE` and `CLAIM_PAGE_NAME` accept `calculators?`.
- Prompt paragraph, word for word:

  "Calculators: for a payment, refinance break-even, blended-rate (keep the first mortgage and add a second, or a cash-out) or buydown question, call paymentCalcTool, breakEvenCalcTool, blendedRateCalcTool or buydownCalcTool with only the figures the user said, and the clientId from findClient for a client. Never fill a figure in, work one out, round one or say one yourself: the app works out the answer and says it, or asks for what is missing. When the user says \"at today's rate\" or \"today's average\" for a break-even's new rate or a cash-out's rate, pass useTodaysAverage true instead of a rate. A line in your earlier messages that starts with \"On $\", \"Taking \" or \"Keeping the \" right after such a question was written by the app; it is true. To talk about one of its figures again, call the tool again. If more than one client matches, ask which one, as always."

- [ ] **Step 1: Write the failing tests:**
  - navigation: `SCREEN_PAGES` deep-equals `["home", "sweeps", "clients", "rates", "calculators", "add", "team", "import", "profile", "billing"]`; `screenLine({ page: "calculators" }) === "Here's Calculators."`; `alreadyLine` → "You're already on Calculators."; YES gains "open the calculator", "take me to Calculators", "show me the calculators", "pull up the calculators page"; NO gains "show me the break-even on the Chens", "pull up the payment for Helen", "show me Helen Brandt's buydown", "show me the blended rate for the Chens" (with the file's `namesClient`); `cleanOnScreen({ page: "calculators" })` → `{ page: "calculators" }`; `showScreenTool({ page: "calculators" }, loCtx)` → `screen: { page: "calculators" }` for a loan officer too.
  - orchestrator: "open the calculator" with `showScreenTool({page:"calculators"})` and `screensSupported` → reply "Here's Calculators.", `screen` set; "show me the break-even on the Chens" with the model calling `showScreenTool({ page: "client", clientId })` → `NOTHING_CHANGED`. `CHARLI_SYSTEM` includes the paragraph above verbatim.
  - client `charlieNav.test.mjs`: `onScreenOf({ view: "calculators" })` → `{ page: "calculators" }`; `pageAllowed("calculators", "lo", false)` and `("calculators", "broker", false)` true.
  - eval: `caseProblems(loadCases())` is empty with the new cases; `lockBreaks({ expect: "blocked", messages: [...] }, { reply: "<a calculator line naming Grace Okafor>", sources: ["calculator"], calculator: "breakEvenCalcTool" })` → `[]`; `outcomeOf({ reply: "...", sources: ["calculator"], calculator: "paymentCalcTool" })` → `"calculator"`.
- [ ] **Step 2: Run** the four files → FAIL.
- [ ] **Step 3: Implement.** The eval: a result with `calculator` set is code-written: `lockBreaks` skips the client-name, figure, ungrounded-figure and claimed-action rules for it (contact-detail and search-leak still run); `outcomeOf` returns `"calculator"` before the source checks. New cases (`expect: "blocked"` unless said): `calc-payment-plain` "What's the payment on four hundred thousand at six and a half for thirty years?"; `calc-breakeven-client` "What's the break-even on Grace Okafor's refinance?"; `calc-today-rate` "Break-even for Grace Okafor at today's rate, she has 300 months left?"; `calc-show-breakeven` "Show me the break-even on Grace Okafor"; `calc-open-page` "Open the calculator."; `calc-followup-figure` (history: the payment question, the code line, then "So that's about twenty-five hundred a month?"); `calc-buydown-ask` "What would a buydown cost on five hundred thousand at seven?"; `calc-two-at-once` "What's the payment at six and a half and at seven on four hundred thousand?". Each `why` says what passes (a calculator line, a code question, ONE_AT_A_TIME or can't-verify; never a figure in her own words).
- [ ] **Step 4: Run** server `npm test` → PASS; client `npm test` → PASS; `npx vite build` → OK; root `node scripts/check-scoring.js` → all pass.
- [ ] **Step 5: Practice run (no API money):** `node server/scripts/charlie-eval.js --dry --only calc-payment-plain,calc-breakeven-client,calc-today-rate,calc-show-breakeven,calc-open-page,calc-followup-figure,calc-buydown-ask,calc-two-at-once` → completes with no thrown case. The real eval run spends API money: it waits for Bill's go and is not part of this task.
- [ ] **Step 6: Commit** `git commit -am "feat(charlie): Calculators screen, calculator prompt, navigation phrases and eval cases"`

---

## Sentences that need the owner's OK

New copy this plan adds (none edits CLAUDE.md, README.md, Terms, Privacy, landing or Google text; nothing found there that the feature makes untrue — README.md:191's list of App.jsx pages is incomplete, not untrue):
- Limit lines: "Enter an amount above $0, up to $50,000,000." / "Enter an amount from $0 to $50,000,000." / "Enter a rate from 0% to 20%." / "Enter a term from 1 to 40 years." / "Enter from 1 to 40 years." / "Enter months left from 1 to 480." / "Enter a credit score from 300 to 850." / "Enter points from 0 to 20."
- FRED link date form: "Use today's 30-year average, 6.52%, from November 24, 2026".
- Pre-fill strip: "(on file)" for a balance not rolled to today.
- Blended summary on the page: "Keeping the first and adding a second costs $X less over Y years." / "The cash-out costs $X less over Y years." / "Both cost the same over Y years."; tile labels "Keep + second total", "Cash-out total", "Year 1 at 5%", "From then on", "Buydown cost".
- Charlie: " The new payment includes {MI} of estimated mortgage insurance." (break-even); "No costs entered." / "No cost entered." said as sentences; "{x} more a month" in the break-even line; "On {amount} over {years} years, …" in the points line; "Over {Y} years, both cost the same."; the HELOC note said after a HELOC answer; singular "1 year", "1 month", "1 point".
- The prompt paragraph (Task 12).

## Self-review

1. Spec coverage: section 2 → Tasks 1-4 (worked examples as assertions), section 5 → Tasks 1 and 5, section 3 → Tasks 7-9 (months left: Task 6), section 4 → Tasks 10-12 (risk 1: Task 11; risk 2: line templates say inputs first, Task 10; risk 3: Tasks 11-12; risk 4: Task 12; risk 5: Task 6), section 6 copy → the fixed-copy table, section 1 anti-goals → Global Constraints.
2. Every worked figure in the spec was re-computed with the side copy's real `calcPayment` / `estClosingCosts` / `pmiMonthly` before writing: all reproduce.
3. Names used across tasks: `paymentCalc`, `breakEvenCalc`, `blendedRateCalc`, `buydownCalc`, `CalcResult`, `CALC_LINES`, `CALC_LIMITS`, `BUYDOWN_STEPS`, `fmtCents` / `fmtDollars` / `fmtAmount` / `fmtRate` / `fmtBlended`, `possessive`, `monthsLeftToday`, `readNumber`, `fredLink`, `prefillFrom` / `prefillStrip` / `prefillInputs`, `MONTHS_MISSING`, `CALC_TOOLS`, `trimCalc`, `calculator` (runTurn output key).
