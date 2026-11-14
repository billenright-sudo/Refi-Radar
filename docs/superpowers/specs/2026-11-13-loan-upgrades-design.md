# Loan upgrades: loan program, mortgage insurance and today's equity

Date: 2026-11-13. Owner: Bill. Status: DRAFT (for Bill's approval; builder check done, nothing left for Bill, my calls listed
in chat).
Repo: `C:\Users\bille\dev\refi-radar`. Branch `feature/loan-upgrades` @ 03f9ea3, off `feature/accurate-refi-scoring`, in the
worktree `C:\Users\bille\dev\refi-radar-upgrades`.
Builds on: the sweep engine (`server/lib/refi.js`, mirrored in `client/src/refiAnalysis.mjs`), target-rate alerts
(`server/lib/targets.js`, `server/lib/assistant/briefing.js`), the call list (`callList`), clients (`server/db.js`,
`server/routes/clients.js`), import (`server/lib/intake/`, `routes/integrations.js`), rates (`server/routes/rates.js`), Charlie's
tools (`server/lib/assistant/tools.js`) and the screens in `client/src/App.jsx`. Every existing rule (deterministic refi math,
Charlie's laws, no auto-emails to clients, approved layout) still holds unless this document changes it.

## 1. Intent: why we're building this

Bill, 2026-11-13: Broker Radar should catch every client who qualifies for an "upgrade", a better loan than the one they have,
not just a lower rate. These are the refis brokers miss: the rate drop alone doesn't look big enough, but dropping mortgage
insurance or a streamline makes it worth a call.

Today the app can't see any of it. It stores no loan program and no mortgage insurance, the payment it compares is principal
and interest only, the balance is frozen at whatever was entered, and the home value is usually the purchase price
(`PROGRESS.md` already lists "loan program, occupancy, MI status, and today's home value" as the gap blocking these lenses).

Success: after a broker re-imports their loan file, Sweeps shows an "Upgrades" section, for example "Maria Lopez: FHA, about 76%
of value, insurance about $210 a month; conventional saves about $240 a month." Charlie answers "who could drop their mortgage
insurance?" from the same list, and her morning briefing names a client the first day they qualify.

## 2. What Bill decided (2026-11-13, one question at a time)

- **Scope:** every client who qualifies for an upgrade. The five upgrades (Bill: "yes" to this list):
  1. **FHA to conventional:** enough equity that a conventional refi drops FHA insurance for good.
  2. **Drop PMI:** a conventional loan now low enough against the home's value that the client can ask the lender to remove PMI,
     with no refi. Goodwill rather than a loan, so it is flagged differently.
  3. **FHA streamline:** FHA to FHA at a lower rate.
  4. **VA streamline (IRRRL):** VA to VA at a lower rate.
  5. **USDA to conventional:** as FHA to conventional.
- **Data:** an import file usually has the loan program but not the monthly insurance amount, so the app estimates the
  insurance unless the broker types the real figure (Bill: "yes").
- **Equity, both ways:** today's value is estimated by growing the entered value with the free public home-price index for the
  client's area (needs the property ZIP), shown as an estimate, and the broker can type a real value anytime. The balance rolls
  forward month by month from the start date, rate and term, so equity also builds from payments (Bill's addition). A real
  balance the broker types always wins (extra payments).
- **How the broker hears about it:** an "Upgrades" group in Sweeps and on each client's page; Charlie can answer "who could drop
  their mortgage insurance?"; an alert the moment a client newly qualifies, the way target-rate alerts work today: in the app,
  nothing sent to clients (Bill: "yes").
- **The anti-goal (Bill's words):** "flagging clients who don't actually qualify." Bill agreed the guards in 3.3.

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. Each client can carry: loan program, monthly mortgage insurance (optional), original loan amount, original home value,
  property ZIP and occupancy. Import fills them; the Add/Edit Client form shows them.
- G2. The app keeps an estimated balance for today and an estimated home value for today, each labelled as an estimate.
- G3. Five upgrade checks (2, above) run in the sweep beside the existing lenses, with a one-line reason each.
- G4. Upgrades show in Sweeps (an "Upgrades" section), on the client's page, in Charlie's call list and answers, and as a
  once-only alert when new.

**Non-goals (this round)**
- Changing what the existing lenses compute for clients with no loan program on file, or for conventional and jumbo clients.
  Existing flags don't move until the broker adds a government program (4.6).
- Using the new today's balance and today's value in the existing lenses. A follow-up, once the estimates have been watched.
- FHA to conventional **with** PMI (equity between 80% and 95%), USDA streamline, VA cash-out, jumbo-specific checks, second
  mortgages and HELOCs, second-home pricing adjustments.
- Payment history (late payments) and live credit pulls: the app can't see them, so every flag says "looks like".
- Charlie setting the new fields by voice, and any new client email template about mortgage insurance.
- A paid home-value feed (AVM). The index is free.

**Anti-goals (would make this a failure even if it works)**
- A1. **A false flag.** When the app is unsure, it doesn't flag; it says what's missing instead (3.3).
- A2. **An estimate that looks like a fact.** Every estimated figure (value, balance, insurance) is labelled "about" or "est."
  wherever it is shown or spoken.
- A3. **Anything reaching a client.** Same rule as today: the broker decides and sends.
- A4. **The model doing the math.** Every figure comes from deterministic code; Charlie only reads tool output.

### 3.3 The guards against false flags (Bill: "yes")

- No loan program on file: no upgrade flag. The client shows "Add the loan program to check upgrades."
- An estimated home value is cut by 10% before any equity test. A value the broker typed in the last 12 months is used as is.
- A refi upgrade must lower the payment, insurance included, and pay back closing costs within 36 months (today's bar).
- A client is kept out when the app can't confirm a condition: inside a streamline's waiting period; a credit score under the
  minimum or not on file (4.2); insurance that ends on its own within 12 months (refi upgrades only, see 4.6); a missing rate for
  the program; an investment property (my call: pricing for investors isn't modelled).
- Every flag carries its reason in one line with the figures it used, so the broker can sanity-check it.
- **The general rule behind every case below (my call):** with a field missing or near a rule-change date, take the reading that
  does **not** flag. In particular, every estimate of the client's *current* insurance leans low (a lower current insurance
  makes leaving it look less attractive), and every cost of the new loan leans high.

## 4. How it works

### 4.1 New client data

New optional fields (my call on names; the builder matches existing naming):

| Field | Meaning | Values |
|---|---|---|
| `loan_program` | the loan's program | `conventional`, `fha`, `va`, `usda`, `jumbo`, or empty (unknown) |
| `monthly_mi` | the real monthly mortgage insurance, when known | dollars (0 = none), or empty (unknown) |
| `original_amount` | original loan amount | dollars, or empty |
| `original_value` | the Homeowners Protection Act "original value": for a purchase, the lesser of the sales price and the appraisal; for a refinance, that refi's appraisal | dollars, or empty |
| `property_zip` | the property's 5-digit ZIP | text, or empty |
| `occupancy` | primary, second home or investment | `primary`, `second_home`, `investment`, or empty (treated as primary, my call: FHA, VA and USDA require it at closing) |
| `balance_as_of` | the date `loan_balance` was true | date; set whenever a balance is imported or typed |
| `value_as_of` | the date `property_value` was true | date (4.3) |
| `credit_score_known` | whether `credit_score` is a real figure | 0/1 (4.2) |

- Existing clients after the migration: program, MI, originals, ZIP and occupancy empty. `balance_as_of` = the row's last update
  date. `value_as_of` = the last update date (or created date): the app doesn't know whether an existing value was an origination
  value or a current one, so it gets **no** growth until the next import or edit records its basis (my call, cautious).
- The Add/Edit Client form gains these fields in the existing field style (no restyle): Loan Program, Monthly Mortgage Insurance
  ("leave blank if you don't know"), Original Loan Amount, Original Home Value, Property ZIP, Occupancy. The existing "Property
  Value" gets the hint "today's value, if you know it" (my call). The term still comes from the loan type.

### 4.2 Credit score

- Today a blank credit score is stored as 700 (`parseInt(...)||700`), so the app can't tell a real 700 from a missing one. FHA
  and USDA borrowers often score well under 700, so a default would cause false flags.
- `credit_score_known` is set when a score is imported or typed. Existing rows: known when `credit_score` isn't 700 or the score
  was edited by hand; otherwise unknown (my call: a real 700 just needs re-entering).
- Every refi upgrade needs a known score: 620 or more for a conventional loan, 580 or more for a streamline (my call: common
  lender minimums). Unknown: "Add a credit score to check upgrades." Drop PMI needs no score.

### 4.3 Today's balance and value

- **Balance:** start from `loan_balance` on `balance_as_of` and amortize forward at `current_rate` to today, over the loan's
  remaining term (30 years from the close date for a 30-year or ARM loan, 15 for a 15-year). Without a close date: the stored
  balance as is. The broker typing a balance resets `balance_as_of` to today.
- **Value basis:** typed by the broker → `value_as_of` = today. Imported from a "property value" / "estimated value" column →
  the import date (no growth; my call, since an LOS value may be either). Imported from purchase price or appraisal → the close
  date (growth applies).
- **Value today:** when `value_as_of` is within the last 12 months and the value was typed by the broker, use it as is.
  Otherwise grow it with the home-price index from the `value_as_of` quarter to the latest quarter, then cut 10%. Without a ZIP,
  or when the index has nothing for it: no growth, still cut 10% (the client shows "Add the property ZIP to check home value
  growth").
- **The index:** FHFA's House Price Index (free, public, no key). The builder bundles a compact snapshot in the repo (3-digit ZIP
  quarterly where FHFA has it, the state otherwise, from 2000 on) and a script to refresh it; Claude runs the refresh on Bill's
  go each quarter, shipped with the next deploy (my call: no runtime dependency on a government site). A falling index lowers
  the value; nothing floors it.
- The client page shows both with their basis: "Balance about $286,400 (rolled forward from $301,000 in May 2024)", "Value about
  $412,000 (from $355,000 in 2021, area prices up 29%, less 10% for caution)".

### 4.4 Mortgage insurance

When `monthly_mi` is typed it is used as is (0 means none), and the end-date rules below still apply. Otherwise the app
estimates, leaning low (3.3). The figures below are the builder's starting point; **the builder confirms each against the source
named before coding** (a test pins each one), and any difference comes back to Bill as a note.

| Program and closing date | Annual rate for the estimate (of today's balance) | Ends on its own | Source to confirm |
|---|---|---|---|
| FHA > 15 years, after 2023-03-20 | 0.50% (the lower tier whenever LTV is unknown) | original LTV > 90%: never; ≤ 90%: 11 years after closing; unknown: never | HUD ML 2023-05; Handbook 4000.1 |
| FHA > 15 years, 2015-01-26 to 2023-03-20 | 0.80% | as above | ML 2015-01 |
| FHA > 15 years, 2013-06-03 to 2015-01-26 | 1.30% | as above | ML 2013-04 |
| FHA ≤ 15 years | its own lower tiers by era (e.g. 0.15% / 0.40% now, 0.45% / 0.70% before), lower tier when LTV unknown | as above | same |
| FHA, closed before 2013-09-01 | not estimated: no MI-based flag unless `monthly_mi` is typed (old rules; it may already be gone) | | ML 2013-04 |
| Conventional / jumbo | not estimated (4.6, Drop PMI) | automatically when the scheduled balance reaches 78% of the original value | Homeowners Protection Act; Fannie Servicing Guide B-8.1-04 |
| USDA, closed on or after 2011-10-01 | the lowest annual fee in effect for its closing date (0.30% to 0.50%; 0.35% since 2016-10-01) | never | USDA HB-1-3555 |
| USDA, closed before 2011-10-01 | none (no annual fee then) | | same |
| VA | none | | |

Closing-date bands use the close date as a stand-in for the case number date; within 90 days after a boundary, use the band with
the lower figure. The bands stay internal; the reason line just says "about $X a month".

### 4.5 Import

- **`loanProgram` becomes its own import field** with its own synonyms ("Loan Program", "Program", "Loan Type", "Mortgage
  Type", "Agency", "Product Type"). The `amortization` field keeps "Amortization Type", "Amortization", "Product", "Loan
  Product" for ARM and term detection. The synonyms move between the two so each column is read once; when only one of the two
  columns exists, the other field reads its text too (so "FHA 30YR" in a product column still sets the program, and "5/1 ARM" in
  a loan-type column still sets the ARM).
- Program text: FHA → `fha`; VA → `va`; USDA, RD or Rural → `usda`; Jumbo → `jumbo`; Conventional, Conforming, Fannie, Freddie,
  FNMA, FHLMC or Conv → `conventional`; anything else → empty (never guess). Whole-word matching, so "VA" doesn't match inside
  another word.
- New recognized columns: monthly MI ("MI", "PMI", "MIP", "Monthly MI", "Mortgage Insurance", "MI Payment"), ZIP ("Property
  ZIP", "Subject ZIP", "ZIP", "Zip Code", "Postal Code"; the property column wins over a plain "ZIP"), occupancy ("Occupancy",
  "Occupancy Type", "Property Usage").
- `original_amount` from the original loan amount column the import already parses. `original_value` per 4.1: purchase → the
  lesser of purchase price and appraised value (either one when only one is there); refinance (the parsed purpose) → the
  appraised value. `value_as_of` per 4.3; `balance_as_of` = the import date when the file gives a balance, else the close date
  the import already estimates it from.
- Re-import fills empty fields and updates imported ones; fields the broker edited by hand stay (`HAND_KEPT`, extended to the
  new fields).
- The ARIVE/LendingPad feed gains an optional `loan_program` key; without it the program is read from `amortization_type` text
  as above. No broker needs to change anything now (no live Zaps send this feed yet; my call to verify in the build).

### 4.6 The five checks

Each is a sweep lens beside the existing four, returning the existing lens shape (lens id, label, priority, headline, unit,
`detail`) with `detail` carrying the reason line. Each needs: a known program; occupancy not `investment`; a rate, today's
balance and today's value; the rate the check prices from in the current rate set (otherwise it doesn't run).

**Waiting periods** count from the first payment date (`loan.js` `firstPaymentFromClosing()`): FHA: 210 days since closing,
6 payments made, and 6 full months since the first payment; VA: 210 days since the first payment and 6 payments made.

**Costs of the new loan** (lean high): today's formula ($2,500 + 1%), plus 1.75% upfront FHA insurance on an FHA streamline
(no refund credit), plus the 0.5% funding fee on a VA streamline (stricter than VA's own recoupment test, which leaves it out).

1. **FHA to conventional** (`fha_to_conv`, "FHA → Conventional"): FHA; insurance not ending on its own within 12 months; known
   score ≥ 620; today's LTV (today's balance over the cautious value) ≤ 80%. New payment: today's conventional pricing
   (`analyze()` as a 30-year fixed on the cautious value), principal and interest only. Old payment: principal and interest
   plus FHA insurance. Savings > 0 and break-even ≤ 36 months. Priority high at $200 a month or more, else medium (my call).
2. **Drop PMI** (`drop_pmi`, "Drop PMI"): conventional or jumbo with `monthly_mi` **typed or imported above $0** (my call: an
   estimate can't tell lender-paid or single-premium MI, which can't be removed, or PMI that's already gone; without the figure,
   the client page says "Add the monthly mortgage insurance to check whether PMI can be dropped"). Then either the balance is at
   or under 80% of the original value (no waiting period), or today's LTV on the cautious value is ≤ 75% with 2 to 5 years since
   closing, or ≤ 80% after 5 years. Not flagged once the scheduled balance has reached 78% of the original value (it ended on its
   own). Priority low, shown as "Goodwill" (my call); headline = the monthly PMI. The 12-month "ends on its own" exclusion doesn't
   otherwise apply (my call: asking early still saves the client months of PMI). Reason: "Conventional, about 74% of value, PMI
   $95 a month: they can ask their lender to remove it."
3. **FHA streamline** (`fha_streamline`, "FHA Streamline"): FHA fixed; past the FHA waiting period; known score ≥ 580. New rate:
   today's FHA 30-year rate (`rate_30yr_fha`, FRED only today; the fallback rate sets don't carry it, so the check doesn't run
   on them). New insurance: today's FHA annual rate at its top tier (0.55%). HUD's own test: the rate plus the annual insurance
   rate drops by at least 0.5 points; and the app's bar (savings > 0, break-even ≤ 36 months) with the costs above.
4. **VA streamline** (`va_irrrl`, "VA IRRRL"): VA fixed; past the VA waiting period; known score ≥ 580. New rate: today's VA
   30-year rate from the same FRED / Optimal Blue source (`OBMMIVA30YF`; the builder confirms the series and adds it beside the
   FHA one, no new cost); missing → the check doesn't run. Rate drop ≥ 0.5 points and costs recovered within 36 months.
5. **USDA to conventional** (`usda_to_conv`, "USDA → Conventional"): as check 1, with the USDA annual fee.

- **Government loans and the existing lenses:** once a client's program is FHA, VA or USDA, the conventional Rate & Term, ARM →
  Fixed and Term Swap lenses no longer run for them (my call: they price a conventional loan and ignore the PMI the new loan
  might need, a false flag). Their rate options are checks 1, 3, 4 and 5. Cash-Out stays (it already stops at 80% LTV).
- A client's best upgrade is the one with the highest priority, then the largest monthly figure.
- These checks live in `refi.js`; the client mirror in `refiAnalysis.mjs` and its parity test extend to them only where the
  client page computes them itself (the builder's call).
- `scripts/check-scoring.js` gains fixture clients for each check, plus clients that must **not** flag (one per guard in 3.3
  and per Review Focus line in 8).

### 4.7 Where it shows

- **Sweeps:** the five lenses join the lens row with their own counts. A new section, **"Upgrades (N)"**, sits between
  "Opportunities" and "Check-ins due", in the same row style: every client with at least one upgrade, showing their best upgrade
  and its reason (+N more). "Opportunities" keeps listing the existing four lenses as today. The sweep result carries
  `upgrades` beside `opportunities`. The layout is approved; the builder follows the existing patterns and sends Bill screenshots
  before merge.
- **Client page:** an "Upgrades" card in the existing card style: each qualifying upgrade with its reason; or what's missing
  ("Add the loan program to check upgrades."); plus today's balance and value lines (4.3).
- **Charlie's call list and briefing:** upgrades get their own phrases in `callList` (today unknown lenses return null and never
  appear), so a client's upgrade can fill a call-list slot like any opportunity.
- **Charlie's answers:**
  - `findClient` includes the program and the client's upgrades (lens, label, headline, reason).
  - A new read tool, `upgradesTool`, lists clients with upgrades in the user's scope, optionally filtered by kind ("drop
    insurance" = checks 1, 2 and 5; "streamline" = checks 3 and 4), capped and ordered as `targetRatesTool` does.
  - She says "looks like" for every upgrade; every figure must match the tool payload (the orchestrator's existing checks).
  - **Eligibility questions still hand off** (my call): "Is Chen eligible for an FHA streamline?" keeps its pinned
    `GUIDELINE_HANDOFF`; questions about the app's flags ("who could drop their mortgage insurance?", "does Chen have any
    upgrades?") use the tool. No guard is loosened.
  - Phone, email and notes never reach the model (unchanged).
- **The alert:** the first daily check after a client newly qualifies for an upgrade records it (a first-seen date per client
  and lens). Charlie's morning briefing names newly qualified clients once, as it does for target rates (`target_announced_on`
  pattern), and the client shows "New" in Sweeps and on their page until the broker logs a "reached" contact (the at-target
  "handled" pattern). If the client stops qualifying, the record clears and re-arms. The check runs when the daily rate snapshot
  arrives, as target checks do. Nothing is emailed.

## 5. Data changes

- New `clients` columns (4.1), added with the existing idempotent `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` pattern, with
  the backfills in 4.1 and 4.2.
- Upgrade alert state: a small table (client, lens, first seen, announced, cleared) or columns (the builder's call; a table
  fits five lenses better).
- Rates: the VA 30-year series beside the FHA one (4.6).
- The bundled home-price index file and its refresh script.
- Every place that lists client fields gets the new ones: `toClient` (both), `validateClient`, `createClientForUser` and the
  PUT's column lists, `HAND_KEPT`, the import's field list and synonyms, the feed's keys, the form, and Charlie's `toClient`.
  Charlie's `addClientTool` is unchanged (non-goal).
- Validation (my call): program from the list or empty; MI 0 to 5,000; original amount and value > 0; ZIP exactly 5 digits;
  occupancy from the list or empty.

## 6. Constraints

- Refi math stays deterministic. No LLM computes a balance, value, insurance amount, LTV or saving.
- No new paid API calls: the index is a bundled public file; the VA rate comes from the FRED source already in use.
- Approved layouts stay; new UI follows existing patterns (form fields, lens chips, list rows, cards). Screenshots to Bill before
  merge.
- Sample data only in tests and screenshots; no real client data.
- Charlie is she/her in all copy and comments.

## 7. What Bill needs to do

Nothing to build. After deploy, the broker re-imports the loan file to fill the new fields (existing clients show "Add the loan
program to check upgrades" until then). Merge, push and deploy each need Bill's go, and Bill runs `gcloud run deploy`.

## 8. Review focus: inputs a real broker will hit

1. An FHA client, 3.5% down in 2021, purchase price on file, value grown 30%: today's LTV under 80% → FHA to conventional; the
   same client with no ZIP → no growth, likely no flag, and the "add the ZIP" line.
2. An FHA client whose score is the default 700 from an old import: no refi upgrade, "Add a credit score".
3. An FHA loan closed in 2012 with no MI typed: no MI flag (old rules).
4. A conventional loan with 15% down and no MI figure: no Drop PMI, and the "add the monthly mortgage insurance" line. The same
   loan already at 78% of original value by schedule, MI typed: no Drop PMI (it ended on its own).
5. A VA loan whose first payment was 5 months ago: inside the waiting period → no IRRRL.
6. A file with both "Loan Type: FHA" and "Amortization Type: Fixed" columns: program FHA, fixed. Product text "Conv 30 Fixed",
   "FHA 30YR", "VA IRRRL", "USDA RD 30", "Non-QM", "Jumbo ARM 7/1": conventional, FHA, VA, USDA, empty, jumbo (ARM still detected).
7. A broker types a new balance after extra payments: today's balance starts from it; the flag uses it.
8. An investment property: no upgrade flags.
9. A client flagged yesterday who no longer qualifies today (rates rose): the flag and "New" clear; it can alert again later.
10. A loan officer sees only their own clients' upgrades, in Sweeps and from Charlie.
11. The rates came from the fallback set (no FHA or VA rate): no streamline flags; FHA → Conventional still runs.
12. An existing client with a value imported before this change: no growth until re-import or edit.

## 9. Left to the builder

- Column and lens names (matching the existing style), the exact index file format and refresh script, the alert storage shape.
- Confirming every rule figure in 4.4 and 4.6 against its source before coding, with a test pinning each; confirming the VA
  series id.
- Test structure.

**Rollout:** built on `feature/loan-upgrades` with tests, sample data only. Merge, push and deploy each need Bill's go.
