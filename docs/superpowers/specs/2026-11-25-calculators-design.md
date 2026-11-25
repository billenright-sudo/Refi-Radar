# Calculators: design

Date: 2026-11-25. Author: Sirius. Status: for Bill's review. Branch `feature/calculators`, off live `9c7f2bc`.
Product: **Broker Radar**. v1 = the four calculators Bill listed on 2026-10-28.

## 1. What it is, and what it is not

A new **Calculators** page gives brokers and loan officers four working tools: the full monthly payment, a refinance
break-even, a blended rate (keep the first mortgage and add a second, or do a cash-out refinance), and a buydown
(temporary and permanent). The broker types the figures and sees the answer at once. From a client's page,
**Open in calculator** fills in that client's loan, so a "does this refi make sense?" check takes seconds.

Charlie gets the same four calculators as tools, so the broker can ask out loud ("what's the payment on four hundred
thousand at six and a half for thirty years?"). Code works out every figure, on the page and for Charlie, with the same
functions. Charlie only reads out what a calculator returned.

**Not in v1:** ARM reset and payment shock; mortgage-insurance removal; amortization tables and extra payments;
affordability and debt-to-income (a guideline question, which Charlie already hands off). No APR anywhere.

**Anti-goals (things this must never do):**
- Show a figure a client could take for a quote: no print, share link, email or client-facing view in v1.
- Give a number on the page that differs from what Charlie says for the same inputs.
- Use a figure the broker did not see. Every default is shown in its field (or said aloud by Charlie) with the word "estimate".
- Save anything. No new table, no change to any client record. Inputs live in the page only and are gone on reload.
- Let a model work out, round or adjust a figure.

## 2. The four calculators

**Rounding, for all four.** Calculations run on the figures as typed. Each monthly amount is rounded to the cent
first; a sum of monthly amounts adds the rounded amounts, so the lines on screen always add up. Totals over months or
years and balances still owed are rounded to whole dollars, after they are added up from the cent-rounded monthly
amounts. Month counts round **up** (`Math.ceil`, as the app's refi break-even does today). Rates are used as typed
(up to three decimals); the blended rate is shown to three decimals (4.375%). The payment formula is the app's
`calcPayment` (zero rate = the amount spread evenly over the months). Page and Charlie get the same rounded numbers.

**Input limits, for all four.** Amounts must be above $0 and at most $50,000,000; rates 0% to 20%; terms 1 to 40
years; months left 1 to 480. A figure outside a limit, or missing where needed, shows a short line under its field and
no result (never a partial result built on a guess). A blank optional field counts as $0 and the result says
"not entered" beside it.

### 2.1 Payment

| Input | Meaning | Where it comes from |
|---|---|---|
| Loan amount | Amount borrowed | Typed (client pre-fill: today's balance) |
| Rate | Note rate, % a year | Typed (pre-fill: current rate) |
| Term | Years | Typed; starts at 30 |
| Property taxes | $ a year | Always typed (optional) |
| Homeowner's insurance | $ a year | Always typed (optional) |
| Mortgage insurance | $ a month | Typed (optional). If home value and credit score are entered and the loan is over 80% of the value, the field fills with the app's conventional PMI estimate (`server/lib/pmi.js`), tagged "estimate" until the broker types over it |
| HOA dues | $ a month | Always typed (optional) |
| Home value, credit score | Only for the PMI estimate | Typed (optional) |

**Outputs:** principal and interest; taxes a month (yearly ÷ 12); insurance a month (yearly ÷ 12); mortgage insurance;
HOA; total monthly payment.

**Formula:** principal and interest = `calcPayment(amount, rate, years)`; the rest are added as monthly amounts.

**Worked example.** $400,000 at 6.5% for 30 years; taxes $4,800 a year; insurance $1,800 a year; home value $450,000
(88.9% of value), credit score 740, so the PMI estimate is 0.38% a year: 400,000 × 0.0038 ÷ 12 = $126.67; HOA $50.
Principal and interest $2,528.27 + taxes $400.00 + insurance $150.00 + PMI $126.67 + HOA $50.00 = **$3,254.94**.
(Checked: `calcPayment(400000, 6.5, 30)` = 2,528.272…; `pmiMonthly(740, 88.9, 30, 400000)` = 126.67.)

**Edge cases.** Zero rate: $400,000 over 30 years = $1,111.11. No taxes or insurance typed: the total is shown with
"not entered" beside those lines. Over 80% with no value or score typed: no estimate is offered; the field stays blank.
FHA, VA and USDA insurance are not estimated (the PMI table is conventional only); the broker types it.

### 2.2 Refi break-even

| Input | Meaning | Where it comes from |
|---|---|---|
| Current balance | Owed today | Typed (pre-fill: today's balance) |
| Current rate | % a year | Typed (pre-fill) |
| Months left | Payments left on the current loan | Typed (pre-fill: from the close date and loan type, when known) |
| New rate | % a year | Typed. A link offers today's FRED average for the term ("Use today's 30-year average, 6.52%, from <date>"); it fills only when clicked |
| New term | Years | Typed; starts at 30 |
| Closing costs | $ | Filled with the app's estimate (`estClosingCosts`: $2,500 + 1% of the balance), tagged "estimate" until typed over |
| Costs paid how | In cash, or added to the new loan | Choice; starts at "in cash" |
| Mortgage insurance now / on the new loan | $ a month | Typed (optional); new-loan PMI estimate offered as in 2.1 |

**Outputs:** current monthly payment; new monthly payment; monthly savings; break-even month; total still to pay on
the current loan; total to pay on the new loan; the difference.

**Formula.** Current payment = `calcPayment(balance, current rate, months left ÷ 12)` (+ its insurance). New loan amount
= balance, plus closing costs if they are added to the loan. New payment = `calcPayment(new amount, new rate, new
term)` (+ its insurance). Monthly savings = current − new. Break-even = closing costs ÷ monthly savings, rounded up,
whether the costs are paid in cash or added to the loan. Long-run totals use principal and interest only (how long
mortgage insurance lasts is not known): current = current P&I × months left; new = new P&I × new months, plus the
costs if paid in cash.

**Worked example.** $350,000 at 7.25% with 324 months left; new 6.25% for 30 years; closing costs estimate
$2,500 + $3,500 = $6,000, paid in cash. Current $2,464.68; new $2,155.01; savings **$309.67** a month; break-even
6,000 ÷ 309.67 = 19.4, so **month 20**. Totals: current 2,464.68 × 324 = $798,556; new 2,155.01 × 360 + 6,000 =
$781,804. The new loan is cheaper over the long run too.

**Same loan at 6.75%:** new $2,270.09; savings $194.59; break-even month 31; but the new total is 2,270.09 × 360 +
6,000 = $823,232, which is **$24,676 more** than the $798,556 left on the current loan. This shows the long-run warning.

**Warnings.** (a) Lower payment but higher total: shown whenever monthly savings are above $0 and the new total is
above the current total. (b) No savings: the new payment is the same or higher; no break-even month is shown.
(c) Break-even after the current loan would be paid off (break-even month > months left).

**Edge cases.** Zero closing costs: break-even shows "No costs entered". Zero rate on either loan: handled by
`calcPayment`. Negative savings: shown as "$X more a month", warning (b).

### 2.3 Blended rate (keep the first, add a second, or cash-out)

| Input | Meaning | Where it comes from |
|---|---|---|
| First mortgage balance, rate, months left | The low-rate loan kept | Typed (pre-fill from the client) |
| Cash needed | Amount of the second, and the cash taken out in the cash-out | Typed |
| Second: kind | Closed-end second or HELOC | Choice |
| Second: rate, term | % a year; years | Typed |
| Second: closing costs | $, paid in cash | Typed (optional; the app has no estimate for a second) |
| Cash-out: rate, term | % a year; years | Typed (today's FRED average offered by link, as in 2.2) |
| Cash-out: closing costs | $, added to the new loan | Filled with `estClosingCosts(first balance + cash)`, tagged "estimate" |
| Compare over | Years | Typed; starts at 5 |

**Outputs:** blended rate of first + second; combined monthly payment; cash-out loan amount and payment; for the years
compared, each option's payments made, balance still owed, costs paid in cash, and the total; which option costs less
and by how much.

**Formula.** Blended rate = (first balance × first rate + second amount × second rate) ÷ (first balance + second
amount). Each payment = `calcPayment`. Over Y years, each option's total = payments made in that time (a loan that ends
sooner stops being paid) + balance still owed at the end + costs paid in cash. Balance still owed uses the standard
remaining-balance formula on the same schedule `calcPayment` makes.

**Worked example.** First: $300,000 at 3% with 300 months left → $1,422.63. Second: $100,000 at 8.5% for 20 years →
$867.82; $1,500 costs in cash. Blended rate (900,000 + 850,000) ÷ 400,000 = **4.375%**; combined payment **$2,290.45**.
Cash-out: $400,000 + estimated costs $6,500 = $406,500 at 6.75% for 30 years → **$2,636.55**. Over 7 years: keep +
second = 2,290.45 × 84 = $192,398 paid + $237,215 + $81,779 still owed + $1,500 = **$512,892**; cash-out = 2,636.55 × 84
= $221,470 + $369,051 still owed = **$590,521**. Keeping the first and adding a second costs **$77,629 less** over 7 years.

**HELOC with an interest-only draw period: v1 decision.** v1 works the second as a fixed-rate loan that pays itself off
over its term, for both kinds. For a HELOC it adds one information line, "Interest-only payment on the second:
$708.33 a month" (100,000 × 8.5% ÷ 12), and the HELOC note (section 6). Draw periods and rate changes are left for later.

**Edge cases.** Cash needed $0: refuse ("Enter the cash needed"). Compare-over longer than a loan's term: that loan is
paid off in the window and owes $0 at the end. Second's rate below the first's: no warning; the math stands.

### 2.4 Buydown

**Temporary (2-1, 3-2-1, 1-0).** Inputs: loan amount, note rate, term (typed; pre-fill from a client is not offered:
a buydown is on a new loan), buydown kind. Outputs: the payment in each buydown year and from then on at the note rate;
the cost of the buydown (subsidy). Formula: year k payment = `calcPayment(amount, note rate − reduction k, term)`, with
2-1 = 2 then 1 point off, 3-2-1 = 3, 2, 1, 1-0 = 1; subsidy = Σ 12 × (note-rate payment − that year's payment), from the
cent-rounded payments, shown **to the cent**.
Example: $400,000 at 7%, 30 years, 2-1. Note-rate payment $2,661.21; year 1 at 5% $2,147.29; year 2 at 6% $2,398.20.
Subsidy 12 × 513.92 + 12 × 263.01 = **$9,323.16**. (3-2-1, same loan: year 1 at 4% $1,909.66; subsidy $18,341.76.)
Edge cases: term shorter than the buydown (for example 2 years with 3-2-1): refused, "The term must be at least as long
as the buydown." A reduced rate below 0% (note rate under the reduction): refused, "The note rate is too low for this
buydown."

**Permanent (points).** Inputs: loan amount, rate without points, rate with points (always typed: the app has no pricing
engine), points (% of the loan) or cost in dollars (either; the other is shown), term. Outputs: cost, both payments,
monthly savings, break-even month, and savings over the full term less the cost.
Example: $400,000, 7% → 6.5% for 1.5 points. Cost 400,000 × 1.5% = **$6,000.00**; $2,661.21 → $2,528.27, savings
**$132.94**; break-even 6,000 ÷ 132.94 = 45.1 → **month 46**; over 30 years 132.94 × 360 − 6,000 = **$41,858**.
Edge cases: rate with points not lower: refused, "The rate with points must be lower than the rate without." Zero cost:
"No cost entered". Break-even after the term: the never-pays-back warning.

## 3. The page

**Where:** "Calculators" in the left navigation, after Rate Watch, for brokers and loan officers. It is inside the
signed-in app, so the existing billing and lock screens cover it as they cover every page.

**What the broker sees, top to bottom:** the page header "Calculators" with one line under it (the estimate line,
section 6); a row of four buttons, Payment / Refi break-even / Blended rate / Buydown, choosing which one card shows;
then that calculator's card: inputs on the left, results on the right, warnings under the results. Switching cards keeps
what was typed in each until the page is left. The cards, inputs, buttons, colors and figure styles are the existing
ones (`card`, `inputStyle`, the tile figures in `App.jsx`); no new visual style.

**Open in calculator** is a button on a client's page beside the existing refi figures. It opens Calculators on
**Refi break-even** and fills in the current balance, current rate and months left, and the same three in Payment and
Blended rate. Balance and value are the client page's own figures (today's balance and cautious value, `equity.mjs`
`pricedToday`), so they match the Equity Projection and Upgrades cards. A strip above the card says where they came
from, in the app's existing basis words: "Filled in from Robert & Linda Chen's record: balance $350,000 (estimated for
today), rate 7.25%, 324 months left. Change any figure. Nothing here is saved to the client." with a "Clear" link. A loan
officer only ever has their own clients' pages, so they can only fill in their own clients.

**Phone width:** as on the other pages, the four buttons wrap, inputs stack in one column, and results sit under the
inputs (`gridCols(2, isPhone)` and the `ph()` helper).

## 4. Charlie

**Tools** (read-only, like `findClient`; they change nothing). Each takes the page's inputs by name, or `clientId`
(from `findClient`) to fill the client's balance, rate and months left in code. Each returns the inputs it used, the
outputs with the page's rounding, any warning as a code-written line, `estimates` (the fields that used the app's
estimate), and `missing` (the one input it still needs). A result's source is `"calculator"`, so it grounds figures as
other cited results do.
- `paymentCalcTool` { loanAmount, rate, termYears, taxesYearly?, insuranceYearly?, miMonthly?, hoaMonthly?, clientId? }.
  With none of the optional four, it returns principal and interest only, flagged `principalAndInterestOnly`.
- `breakEvenCalcTool` { clientId? or currentBalance + currentRate + monthsLeft, newRate, newTermYears, closingCosts?, costsInLoan? }.
  No closing costs given: it uses `estClosingCosts` and lists it in `estimates`.
- `blendedRateCalcTool` { first loan or clientId, cashNeeded, second {kind, rate, termYears, costs?}, cashOut {rate, termYears, costs?}, compareYears }.
- `buydownCalcTool` { kind: "2-1" | "3-2-1" | "1-0" | "points", loanAmount, noteRate, termYears, rateWithPoints?, points? }.
- `showScreenTool` gains the page `calculators` ("Here's Calculators."). It opens the page only; it does not fill it in.

Client payloads carry the client's id and name and the loan figures used, never email, phone or notes. The new rate,
taxes, insurance and HOA are never filled in by code for Charlie; closing costs are, and she says "estimated".

**Example exchanges** (figures from the tools; the Okafor loan is the 2.2 example):
- Broker: "What's the payment on four hundred thousand at six and a half for thirty years?" Tool: P&I 2,528.27.
  Charlie: "On $400,000 at 6.5 percent over 30 years, principal and interest is $2,528.27 a month, before taxes,
  insurance and any HOA."
- Broker: "What's the break-even on the Okafors' refinance?" `findClient` → one match; `breakEvenCalcTool` returns
  `missing: newRate`. Charlie: "What rate are you looking at for them?" Broker: "Six and a quarter, thirty years."
  Charlie: "At 6.25 percent over 30 years their payment goes from $2,464.68 to $2,155.01, saving $309.67 a month. With
  estimated closing costs of $6,000, they break even in month 20."
- Same at 6.75: "That saves $194.59 a month with break-even in month 31, but restarting the clock costs $24,676 more
  over the life of the loan."
- Broker: "Open the calculators." → "Here's Calculators."

**Missing input:** she asks for that one input in one question, starting with the question word, as the confirmation
rule already says; she never supplies it. Two clients match: she asks which one, as today.

**Prompt:** one new paragraph: use the calculator tools for payment, break-even, blended-rate and buydown questions;
say the inputs used before the answer; say "estimated" for anything in `estimates`; say "principal and interest" when
the result is P&I only; never give an APR; never call a figure a quote or an offer.

**Must keep working:** the figure check (`ungroundedNumbers`), the ungrounded screens (`classifyUngrounded`), the
action backstop and confirmation rule, "Charlie opens screens" (`navigation.js` page lists, `PAGE_NAME_RE`,
`charlieNav.mjs` `SAME`, `nav.mjs`), the form-open lock, the broker-only page refusals, scoped lookups (an LO's
`clientId` outside their book is "no such client"), and the Charlie eval suite.

**Build risks:**
1. The figure check accepts any number found anywhere in this turn's tool results. A calculator result is full of
   numbers (inputs, each year's payment), so a figure said in the wrong place (year 1's payment as year 2's) passes.
   Keep payloads small and named; add eval cases for swapped figures.
2. The model turns the broker's spoken words into tool inputs ("six and a half" → 6.5). A mishearing becomes a
   correctly computed answer to the wrong question. The tool echoes its inputs, and she must say them first.
3. The closing-cost estimate is applied for Charlie without a question. The safeguard is that she must say
   "estimated"; code should check that the word is in the reply when `estimates` is not empty, or the turn is can't-verify.
4. "Show me the break-even on the Okafors" must stay a question, not a page request; "open the calculator" must be one.
   Add both to the navigation tests.
5. Months left for a client is worked out inside `lib/equity.js balanceToday` today but not sent to the browser; the
   build adds it to the today block, which other screens read. Check nothing else changes.

## 5. One source of math

**Why not one shared file:** the Docker build copies only `client/` into the browser build and only `server/` into the
running server, so neither side can load a file from the other at build or run time without changing the Dockerfile
(the deploy). The app already keeps two copies in step with a test (`refiAnalysis.mjs` ↔ `refi.js`, checked by
`refiAnalysis.test.mjs`). This design does the same, made stricter.

**Arrangement:** `server/lib/calculators.js` (CommonJS, Charlie's tools) and `client/src/calculators.mjs` (the page)
each hold the four calculators between two marker lines, `// ---- calculators: shared math begin ----` and
`// ---- calculators: shared math end ----`. The code between the markers is plain functions with no `require`, no
`import` and no `export`; it takes `calcPayment`, `estClosingCosts` and `pmiMonthly` from its own side
(`refi.js`/`pmi.js` on the server, `refiAnalysis.mjs` in the browser). Only the few lines outside the markers differ.

**The test** (`server/test/calculators.test.js`, run by `npm test` in `server/`):
1. The text between the markers is byte-for-byte the same in both files. Any edit to one without the other fails.
2. Every worked example in this document gives the same answer from both files.
3. About 500 input sets (rates 0 to 12%, terms 1 to 40 years, every buydown kind, both cost choices) give identical
   results from both files, including `calcPayment`, `estClosingCosts` and `pmiMonthly` on each side.
4. Each Charlie tool returns exactly the server function's outputs for the same inputs.

## 6. Sentences for Bill's OK

- Page title and nav label: **Calculators**. Button on the client page: **Open in calculator**.
- Estimate line, under the page title and on every result (**for a lawyer's look**): "Estimate for your own use only.
  This is not a Loan Estimate, a rate quote or an offer of credit."
- Pre-fill strip: "Filled in from <client>'s record: <figures and where they came from>. Change any figure. Nothing here
  is saved to the client."
- Estimate tag beside a filled-in default: "estimate".
- Long-run warning: "Lower payment, higher total: restarting the clock costs $X more over the life of the loan than
  keeping the current loan."
- No savings: "The new payment isn't lower, so the costs are never earned back."
- Break-even too late: "Break-even comes after the current loan would have been paid off."
- Points never pay back: "The savings don't cover the cost of the points within the term."
- HELOC note: "Worked as a fixed rate paid off over the term. A HELOC's rate can change, and an interest-only draw
  period changes the payment."
- Refusals: "The term must be at least as long as the buydown." / "The note rate is too low for this buydown." /
  "The rate with points must be lower than the rate without." / "Enter the cash needed."
- Charlie opening the page: "Here's Calculators."

## 7. Bill decides

1. **Ship before the lawyer reads the estimate line?** Recommend yes: it is broker-only, with no client output; the
   lawyer review gates any later client-facing step.
2. **May Charlie use today's FRED average when the broker says "at today's rate"?** Recommend yes, said as "today's
   estimated average", never as the client's rate. (As written, she asks for the rate.)
3. **Long-run warning measured on total still to pay** (payments plus cash costs, as in 2.2) rather than interest
   alone? Recommend total paid: it is what the borrower actually hands over.

### Sirius's calls for Bill to check

- Code computes every number; Charlie reads only tool results (the existing grounding rule).
- Broker-facing only; no print, share, email or client view; no APR; one estimate line on every result.
- Taxes, insurance and HOA always typed; the rate after points always typed; closing costs and conventional PMI filled
  in as visible, tagged estimates; today's FRED rate offered by a link, never filled in by itself.
- One Calculators page in the navigation for brokers and LOs; four cards, one shown at a time; existing look.
- Open in calculator fills balance, rate and months left from the client page's own figures, and says so.
- Nothing saved; no new table; same access and billing rules as the rest of the app.
- Rounding as in section 2; page and Charlie get identical rounded numbers.
- Charlie answers a bare payment question with principal and interest only, and says so, instead of asking for taxes.
- HELOC worked as fixed and fully paid off over its term, with an interest-only line for information.
- Compare-over window starts at 5 years. Refuse rather than guess when an input is out of range.
- Two marked copies plus a byte-equality test, rather than changing the Dockerfile.

## 8. Left to the builder, and size

Left to the builder: file and function names inside the two calculator files; how the page component is split out of
`App.jsx` (a small `calculators` component file is preferred to growing `App.jsx`); the tool schemas' wording; where
months left joins the today block; test layout.

Rough size: **about 11 plan tasks**: shared math and its tests (one task per calculator, 4); the browser copy and the
drift test (1); the page shell, navigation and the Payment card (1); the other three cards (1); Open in calculator and
months left (1); the four Charlie tools (1); prompt, `showScreenTool` page and navigation phrases (1); eval cases, phone
pass and a practice run (1).
