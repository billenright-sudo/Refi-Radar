# Loan upgrades: loan program, mortgage insurance and today's equity

Date: 2026-11-13. Owner: Bill. Status: DRAFT (for Bill's approval).
Repo: `C:\Users\bille\dev\refi-radar`. Branch `feature/loan-upgrades` @ 03f9ea3, off `feature/accurate-refi-scoring`, in the
worktree `C:\Users\bille\dev\refi-radar-upgrades`.
Builds on: the sweep engine (`server/lib/refi.js`, mirrored in `client/src/refiAnalysis.mjs`), target-rate alerts
(`server/lib/targets.js`, `server/lib/assistant/briefing.js`), clients (`server/db.js`, `server/routes/clients.js`), import
(`server/lib/intake/`), Charlie's tools (`server/lib/assistant/tools.js`) and the screens in `client/src/App.jsx`. Every existing
rule (deterministic refi math, Charlie's laws, no auto-emails to clients, approved layout) still holds unless this document
changes it.

## 1. Intent: why we're building this

Bill, 2026-11-13: Broker Radar should catch every client who qualifies for an "upgrade", a better loan than the one they have,
not just a lower rate. These are the refis brokers miss: the rate drop alone doesn't look big enough, but dropping mortgage
insurance or a streamline makes it worth a call.

Today the app can't see any of it. It stores no loan program and no mortgage insurance, the payment it compares is principal
and interest only, the balance is frozen at whatever was entered, and the home value is usually the purchase price
(`PROGRESS.md` already lists "loan program, occupancy, MI status, and today's home value" as the gap blocking these lenses).

Success: after a broker re-imports their loan file, Sweeps shows an "Upgrades" group, for example "Maria Lopez: FHA, about 76% of
value, insurance about $210 a month; conventional saves about $240 a month." Charlie answers "who could drop their mortgage
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
- G4. Upgrades show in Sweeps (an "Upgrades" group), on the client's page, to Charlie, and as a once-only alert when new.

**Non-goals (this round)**
- Changing what the existing lenses (Rate & Term, Cash-Out, ARM → Fixed, Term Swap) compute for clients with no loan program on
  file. Existing clients' flags don't move until the broker adds a program (exception in 4.6).
- Using the new today's balance and today's value in the existing lenses. A follow-up, once the estimates have been watched.
- FHA to conventional **with** PMI (equity between 80% and 95%), USDA streamline, VA cash-out, jumbo-specific checks, second
  mortgages and HELOCs.
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
  minimum or not on file (4.2); insurance that ends on its own within 12 months (refi upgrades only, see 4.4); an investment
  property (my call: pricing for investors isn't modelled).
- Every flag carries its reason in one line with the figures it used, so the broker can sanity-check it.
- Near a rule-change date, or with a field missing, the app takes the reading that does **not** flag (my call, the general rule
  behind every case below).

## 4. How it works

### 4.1 New client data

New optional fields (my call on names; the builder matches existing naming):

| Field | Meaning | Values |
|---|---|---|
| `loan_program` | the loan's program | `conventional`, `fha`, `va`, `usda`, `jumbo`, or empty (unknown) |
| `monthly_mi` | the real monthly mortgage insurance, when the broker knows it | dollars, or empty |
| `original_amount` | original loan amount | dollars, or empty |
| `original_value` | home value at closing (purchase price or appraisal) | dollars, or empty |
| `property_zip` | the property's 5-digit ZIP | text, or empty |
| `occupancy` | primary, second home or investment | `primary`, `second_home`, `investment`, or empty (treated as primary, my call: FHA, VA and USDA require it at closing) |
| `balance_as_of` | the date `loan_balance` was true | date; set whenever a balance is imported or typed |
| `value_as_of` | the date `property_value` was true | date; set whenever a value is typed, or by import (4.5) |
| `credit_score_known` | whether `credit_score` is a real figure | 0/1 (4.2) |

- Existing clients after the migration: program, MI, originals, ZIP and occupancy empty. `balance_as_of` = the row's last update
  date; `value_as_of` = the close date, or the last update date when the value was edited by hand (`edited_by_hand`), or the
  created date when there is no close date (my call: both readings make the estimate cautious).
- The Add/Edit Client form gains these fields in the existing field style (no restyle): Loan Program, Monthly Mortgage Insurance
  (with "leave blank to estimate"), Original Loan Amount, Original Home Value, Property ZIP, Occupancy. The existing "Property
  Value" label gets a hint "today's value, if you know it" (my call). The term still comes from the loan type.

### 4.2 Credit score

- Today a blank credit score is stored as 700 (`parseInt(...)||700`), so the app can't tell a real 700 from a missing one. FHA
  and USDA borrowers often score well under 700, so a default would cause false flags.
- `credit_score_known` is set when a score is imported or typed. Existing rows: known when `credit_score` isn't 700 or the score
  was edited by hand; otherwise unknown (my call: a real 700 just needs re-entering).
- Every refi upgrade needs a known score: 620 or more for a conventional loan, 580 or more for a streamline (my call: common
  lender minimums). Unknown: "Add a credit score to check upgrades." The PMI request needs no score.

### 4.3 Today's balance and value

- **Balance:** start from `loan_balance` on `balance_as_of` and amortize forward at `current_rate` to today, over the loan's
  remaining term (30 years from the close date for a 30-year or ARM loan, 15 for a 15-year). Without a close date: the stored
  balance as is. The broker typing a balance resets `balance_as_of` to today.
- **Value:** when `value_as_of` is within the last 12 months and was typed by the broker, use `property_value` as is.
  Otherwise grow it with the home-price index from the `value_as_of` quarter to the latest quarter, then cut 10%.
  Without a ZIP, or when the index can't be found for it: no growth, but still cut 10% (my call; the client shows "Add the
  property ZIP to check home value growth").
- **The index:** FHFA's House Price Index (free, public, no key). The builder bundles a compact snapshot in the repo (3-digit ZIP
  quarterly where FHFA has it, the state otherwise, from 2000 on) and a script to refresh it; Claude runs the refresh on Bill's
  go each quarter, shipped with the next deploy (my call: no runtime dependency on a government site). A falling index lowers the
  value; nothing floors it.
- The client page shows both with their basis: "Balance about $286,400 (rolled forward from $301,000 in May 2024)", "Value
  about $412,000 (from $355,000 in 2021, area prices up 29%, less 10% for caution)".

### 4.4 Mortgage insurance

When `monthly_mi` is typed it is used as is, and the app still applies the end-date rules below. Otherwise the app estimates.
The figures below are the builder's starting point; **the builder confirms each against the source named before coding** (a test
pins each one), and any difference comes back to Bill as a note.

| Program | Monthly amount (estimate) | When it ends on its own | Source to confirm |
|---|---|---|---|
| FHA, closed after 2023-03-20 | 0.55% a year of today's balance (0.50% if original value known and LTV ≤ 95%) | original LTV > 90% or unknown: never; ≤ 90%: 11 years after closing | HUD ML 2023-05; Handbook 4000.1 |
| FHA, 2015-01-26 to 2023-03-20 | 0.85% (0.80% if LTV ≤ 95%) | as above | ML 2015-01 |
| FHA, 2013-06-03 to 2015-01-26 | 1.35% (1.30% if LTV ≤ 95%) | as above | ML 2013-04 |
| FHA, closed before 2013-09-01 | not estimated | old rules: insurance may already be gone, so no MI flag unless `monthly_mi` is typed (my call: case numbers predate closing) | ML 2013-04 |
| Conventional with PMI | from a small grid by credit score and original LTV (builder sets it from a published MI rate card, using the higher end) | automatically when the scheduled balance reaches 78% of the original value | Homeowners Protection Act; Fannie Servicing Guide B-8.1-04 |
| Conventional, original LTV ≤ 80% or originals unknown | none, unless `monthly_mi` is typed | n/a | |
| USDA | 0.35% a year of today's balance | never | USDA HB-1-3555 |
| VA, jumbo | none | n/a | |

Closing-date bands use the close date as a stand-in for the FHA case number date; within 90 days after a boundary, use the older
(higher) band. The bands stay internal; the reason line just says "about $X a month".

### 4.5 Import

- The product/program column the import already reads (`amortization` synonyms such as "loan program", "product", "loan type")
  now also sets `loan_program`: text containing FHA → `fha`; VA → `va`; USDA, RD or Rural → `usda`; Jumbo → `jumbo`; Conventional,
  Conforming, Fannie, Freddie, FNMA, FHLMC or Conv → `conventional`; anything else → empty (my call: never guess). Word
  matching, so "VA" doesn't match inside another word.
- New recognized columns: monthly MI ("MI", "PMI", "MIP", "Monthly MI", "Mortgage Insurance", "MI Payment"), ZIP ("Property ZIP",
  "Subject ZIP", "ZIP", "Zip Code", "Postal Code"; the property column wins over a plain "ZIP"), occupancy ("Occupancy",
  "Occupancy Type", "Property Usage").
- `original_amount` from the original loan amount column the import already parses; `original_value` from purchase price, then
  appraised value. `value_as_of` and `balance_as_of`: the import date when the file gives a current balance or value, the close
  date when the value came from purchase price or appraisal.
- Re-import fills empty fields and updates imported ones; fields the broker edited by hand stay (the existing `HAND_KEPT`
  pattern, extended to the new fields).
- The ARIVE/LendingPad feed goes through the same mapping.

### 4.6 The five checks

Each is a sweep lens beside the existing four, returning the existing lens shape (lens id, label, priority, headline, unit) plus
a `reason` line and, where it applies, the figures used. Each needs: a known program; occupancy not `investment`; a rate,
today's balance and today's value.

1. **FHA to conventional** (`fha_to_conv`, "FHA → Conventional"): FHA; insurance not ending on its own within 12 months; known
   score ≥ 620; today's LTV (today's balance over the cautious value) ≤ 80%. New payment: today's conventional pricing
   (`analyze()` as a 30-year fixed with the cautious value), principal and interest only. Old payment: principal and interest
   plus FHA insurance. Savings > 0 and break-even ≤ 36 months with today's closing-cost formula. Priority high at $200 a month
   or more, else medium (my call).
2. **Drop PMI** (`drop_pmi`, "Drop PMI"): conventional with PMI (typed, or estimated per 4.4). Either the balance is at or under
   80% of the original value (no waiting period), or today's LTV on the cautious value is ≤ 75% with 2 to 5 years since closing,
   or ≤ 80% after 5 years. Priority low (shown as "Goodwill", my call), headline = the monthly PMI. The 12-month "ends on its
   own" exclusion does not apply here (my call: asking early still saves the client months of PMI). Reason: "Conventional,
   about 74% of value, PMI about $95 a month: they can ask their lender to remove it."
3. **FHA streamline** (`fha_streamline`, "FHA Streamline"): FHA 30-year fixed; at least 210 days since closing and 6 payments
   (taken as 7 months after closing, my call); known score ≥ 580. New rate: today's FHA 30-year rate (`rate_30yr_fha`, already
   fetched). New insurance: today's FHA annual rate at the top tier (0.55%). HUD's own test: the rate plus the annual insurance
   rate drops by at least 0.5 points; and the app's bar (savings > 0, break-even ≤ 36 months). Priority as FHA to conventional.
4. **VA streamline** (`va_irrrl`, "VA IRRRL"): VA fixed; at least 210 days since the first payment and 6 payments (taken as 8
   months after closing); known score ≥ 580. There is no VA rate feed, so the new rate is today's FHA 30-year rate (my call: VA
   rates usually sit at or below FHA, so this understates the saving). Rate drop ≥ 0.5 points and costs recovered within 36
   months (VA's own tests, which match the app's bar). Closing costs include the 0.5% funding fee (my call).
5. **USDA to conventional** (`usda_to_conv`, "USDA → Conventional"): as check 1, with the USDA annual fee.

- Several can qualify at once; the client's best is the largest monthly saving among them, as today.
- **Existing Rate & Term for FHA, VA and USDA clients:** once a client's program is FHA, VA or USDA, the conventional Rate & Term
  lens no longer runs for them (my call: it prices a conventional loan, so for an FHA client at 90% LTV it ignores the PMI the new
  loan would need, which is a false flag). Their rate options are checks 1, 3, 4 and 5. Cash-Out, ARM → Fixed and Term Swap stay.
- These checks live in `refi.js`; the client mirror in `refiAnalysis.mjs` and its parity test extend to them only where the
  client page computes them itself (the builder's call).
- `scripts/check-scoring.js` gains fixture clients for each check, plus clients that must **not** flag (one per guard in 3.3).

### 4.7 Where it shows

- **Sweeps:** the five lenses join the lens row with their own counts, grouped under an "Upgrades" label, and rows show their
  reason line. The layout is approved; the builder follows the existing lens pattern and sends Bill screenshots before merge.
- **Client page:** an "Upgrades" card in the existing card style: each qualifying upgrade with its reason; or what's missing
  ("Add the loan program to check upgrades."); plus today's balance and value lines (4.3).
- **Charlie:**
  - `findClient` includes the program and the client's upgrades (lens, label, headline, reason).
  - A new read tool, `upgradesTool`, lists clients with upgrades in the user's scope, optionally filtered by kind ("drop
    insurance" = checks 1, 2 and 5; "streamline" = checks 3 and 4), capped and ordered as `targetRatesTool` does.
  - She says "looks like" for every upgrade; every figure must match the tool payload (the orchestrator's existing checks).
    Questions about program rules still hand off, as today (`guidelines.js`).
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
- The bundled home-price index file and its refresh script.
- Every place that lists client fields gets the new ones: `toClient` (both), `validateClient`, `createClientForUser` and the
  PUT's column lists, `HAND_KEPT`, the import's field list and synonyms, the form, and Charlie's `toClient`. Charlie's
  `addClientTool` is unchanged (non-goal).
- Validation (my call): program from the list or empty; MI 0 to 5,000; original amount and value > 0; ZIP exactly 5 digits;
  occupancy from the list or empty.

## 6. Constraints

- Refi math stays deterministic. No LLM computes a balance, value, insurance amount, LTV or saving.
- No new paid API calls: the index is a bundled public file.
- Approved layouts stay; new UI follows existing patterns (form fields, lens chips, cards). Screenshots to Bill before merge.
- Sample data only in tests and screenshots; no real client data.
- Charlie is she/her in all copy and comments.

## 7. What Bill needs to do

Nothing to build. After deploy, the broker re-imports the loan file to fill the new fields (existing clients show "Add the loan
program to check upgrades" until then). Merge, push and deploy each need Bill's go, and Bill runs `gcloud run deploy`.

## 8. Review focus: inputs a real broker will hit

1. An FHA client, 3.5% down in 2021, value grown 30%: today's LTV under 80% → FHA to conventional; the same client with no ZIP
   → no growth, likely no flag, and the "add the ZIP" line.
2. An FHA client whose score is the default 700 from an old import: no refi upgrade, "Add a credit score".
3. An FHA loan closed in 2012 with no MI typed: no MI flag (old rules).
4. A conventional loan with 10% down in 2019 at 78% of original value by schedule: PMI already gone on its own → no Drop PMI.
5. A VA loan closed 5 months ago: inside the waiting period → no IRRRL.
6. A product column reading "Conv 30 Fixed", "FHA 30YR", "VA IRRRL", "USDA RD 30", "Non-QM", "Jumbo ARM 7/1": conventional, FHA,
   VA, USDA, empty, jumbo (and the ARM still detected as today).
7. A broker types a new balance after extra payments: today's balance starts from it; the flag uses it.
8. An investment property: no upgrade flags.
9. A client flagged yesterday who no longer qualifies today (rates rose): the flag and "New" clear; it can alert again later.
10. A loan officer sees only their own clients' upgrades, in Sweeps and from Charlie.

## 9. Left to the builder

- Column and lens names (matching the existing style), the exact index file format and refresh script, the conventional PMI
  grid (from a published rate card, higher end), and the alert storage shape.
- Confirming every rule figure in 4.4 and 4.6 against its source before coding, with a test pinning each.
- Test structure.

**Rollout:** built on `feature/loan-upgrades` with tests, sample data only. Merge, push and deploy each need Bill's go.
