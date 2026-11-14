# Loan Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each client's loan program, mortgage insurance, originals, ZIP and occupancy; estimate today's balance and value; flag five
"upgrades" (FHA → Conventional, Drop PMI, FHA Streamline, VA IRRRL, USDA → Conventional) in Sweeps, on the client page, to Charlie and as a
once-only alert.

**Architecture:** Four new pure server modules (`hpi.js`, `equity.js`, `mortgageInsurance.js`, `upgrades.js`) compute everything
deterministically; `refi.js` calls `upgrades.js` from `sweepClient`. A new `upgradeAlerts.js` keeps a `client_upgrades` table (first seen,
announced) and builds per-client views, wired in wherever `targets.safeCheck` runs today. Import, the clients API, the call list,
Charlie's tools and three screens in `App.jsx` gain the new fields and lenses.

**Tech Stack:** Node 20 (CommonJS server, `node --test`), Express, better-sqlite3, `xlsx` (already a server dependency), React 18 + Vite
(inline styles, `C` palette), ESM `.mjs` client helpers with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-13-loan-upgrades-design.md` (APPROVED by Bill 2026-11-13). Read it before your task; section
numbers below (§4.4 etc.) point into it.

## Global Constraints

- Node 20 only: prefix every command with `export PATH="/c/Users/bille/dev/node20:$PATH"` (bash). Server tests `cd server && npm test`;
  client tests `cd client && npm test`; client build `cd client && npm run build`; scoring check `node scripts/check-scoring.js` (from the
  repo root, after Task 5).
- Never read, cat, grep or print any `.env*` file.
- Refi math stays deterministic: no LLM computes a balance, value, insurance amount, LTV or saving.
- No new paid API calls. The VA rate comes from the FRED source already used; the home-price index is a bundled file.
- Every estimated figure shown or spoken is labelled "about" or "est." (§3 A2). The model never writes a figure that isn't a JSON number
  in a tool payload (the orchestrator's `ungroundedNumbers` check).
- Orchestrator/briefing guards: extend the regression tables; **never loosen a guard to make a row pass**.
- Approved layout: new UI reuses existing patterns (the `field` helper, lens chips, list rows, `card` style, existing `C` colours). No new
  colours, fonts or restyles.
- Sample data only in tests, fixtures and screenshots. No real client data.
- Charlie is she/her in all copy and comments; clients are "they".
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Dates are `"YYYY-MM-DD"` strings (UTC day); `today` in pure functions is a parameter, never `new Date()` inside them.
- Lens ids, labels (verbatim): `fha_to_conv` "FHA → Conventional", `drop_pmi` "Drop PMI", `fha_streamline` "FHA Streamline",
  `va_irrrl` "VA IRRRL", `usda_to_conv` "USDA → Conventional".
- Gap lines (verbatim, §3.3/§4): `Add the loan program to check upgrades.` · `Add a credit score to check upgrades.` ·
  `Add the property ZIP to check home value growth.` · `Add the monthly mortgage insurance to check whether PMI can be dropped.` ·
  `Add the original close date to check upgrades.` · `Investment property: upgrades aren't checked.`

## Review Focus

1. A client with **no loan program** gets exactly today's lenses and figures (no regression for every existing client) — test in Task 5.
2. **Re-import over hand-edited new fields** (program, MI, ZIP…) keeps the broker's values — test in Task 6.
3. A **loan officer** sees only their own clients' upgrades (client list views and `upgradesTool`) — tests in Tasks 7 and 9.
4. **Fallback rate set** (no `rate_30yr_fha`/`rate_30yr_va`): no streamline flags, FHA → Conventional still runs — test in Task 4.
5. An upgrade that **disappears and comes back** alerts again ("New" re-arms) — test in Task 7.

## File Structure

| File | Responsibility |
|---|---|
| `server/db.js` (modify) | new `clients` columns + backfills; `client_upgrades` table |
| `server/routes/clients.js` (modify) | new fields in/out, validation, as-of dates, `credit_score_known`; `upgrades` view on each client |
| `server/lib/intake/handEdits.js` (modify) | `HAND_KEPT` gains the new hand-editable columns |
| `server/lib/hpi.js` + `server/lib/hpiData.json` (create) | home-price index lookup over a bundled snapshot |
| `server/scripts/update-hpi.js` (create) | builds `hpiData.json` from FHFA's 3-digit-ZIP quarterly XLSX |
| `server/lib/equity.js` (create) | today's balance and today's value (with basis) |
| `server/lib/mortgageInsurance.js` (create) | current monthly insurance (typed or estimated) and when it ends |
| `server/lib/upgrades.js` (create) | the five checks, gap lines, the "today" block |
| `server/routes/rates.js` (modify) | `rate_30yr_va` series |
| `server/lib/refi.js` (modify) | `norm` new fields; `sweepClient`/`runSweep` upgrades; government-program gating |
| `scripts/check-scoring.js` (modify) | repoint at `server/lib/refi.js`; upgrade fixtures |
| `server/lib/intake/{fields,record,ingest}.js`, `server/routes/integrations.js` (modify) | import of the new fields |
| `server/lib/upgradeAlerts.js` (create) | alert table upkeep, per-client views, announce/newly picks |
| `server/routes/sweeps.js` (modify) | `isNew` on upgrade rows |
| `server/lib/assistant/{callList,briefing,tools,prompt,orchestrator}.js` (modify) | phrases, briefing picks, `findClient`/`upgradesTool`, sweep trimming |
| `client/src/upgrades.mjs` (create) | pure UI helpers (labels, badge, lines) |
| `client/src/App.jsx` (modify) | form fields, Sweeps "Upgrades" section, client page "Upgrades" card |

---

### Task 1: Client columns, backfills and the clients API

**Files:**
- Modify: `server/db.js` (clients migrations, after the `target_*` loop ~L100-110)
- Modify: `server/routes/clients.js` (`toClient` L16-25, `validateClient` L47-57, `createClientForUser` L66-84, PUT L163-202)
- Modify: `server/lib/intake/handEdits.js` (`HAND_KEPT`, `LABELS`)
- Test: `server/test/clients-upgrade-fields.test.js` (create; use the `DATA_DIR = mkdtempSync` prologue and HTTP harness from `server/test/clients-api.test.js`)

**Interfaces:**
- Produces columns: `loan_program TEXT NOT NULL DEFAULT ''`, `monthly_mi REAL` (NULL = unknown), `original_amount REAL`,
  `original_value REAL`, `property_zip TEXT NOT NULL DEFAULT ''`, `occupancy TEXT NOT NULL DEFAULT ''`, `balance_as_of TEXT`,
  `value_as_of TEXT`, `credit_score_known INTEGER NOT NULL DEFAULT 0`.
- Produces API fields (camelCase, in `toClient`): `loanProgram, monthlyMi, originalAmount, originalValue, propertyZip, occupancy,
  balanceAsOf, valueAsOf, creditScoreKnown` (boolean).
- Produces `HAND_KEPT = ["current_rate","property_value","credit_score","loan_program","monthly_mi","original_amount","original_value","property_zip","occupancy"]`
  (order = mark-string order; `LABELS` gains readable names: "loan program", "mortgage insurance", "original loan amount",
  "original home value", "property ZIP", "occupancy").
- Produces `PROGRAMS = ["conventional","fha","va","usda","jumbo"]`, `OCCUPANCIES = ["primary","second_home","investment"]` exported from
  `server/routes/clients.js` (attach to the router like `validateClient`).

- [ ] **Step 1: Write the failing tests** in `server/test/clients-upgrade-fields.test.js`:
  - `migration backfills as-of dates and credit_score_known`: open a fresh DB whose `clients` table predates the columns (create the old
    table by hand in a temp `DATA_DIR`, insert rows with `credit_score` 700 / 742 / 700 + `edited_by_hand='credit_score'`, `updated_at`
    `'2025-04-02 10:00:00'`), then `require("../db")`; assert `credit_score_known` = 0 / 1 / 1, `balance_as_of` = `value_as_of` =
    `'2025-04-02'`, and `loan_program`/`property_zip`/`occupancy` = `''`, `monthly_mi` IS NULL.
  - `POST stores the new fields`: body adds `loanProgram:"fha", monthlyMi:"212.5", originalAmount:"289500", originalValue:"300000",
    propertyZip:"85016", occupancy:"primary", creditScore:"688"` → response client has those values as numbers/strings,
    `creditScoreKnown: true`, `balanceAsOf` and `valueAsOf` = today's UTC date.
  - `POST with a blank credit score stores 700 and creditScoreKnown false`.
  - `validation`: `loanProgram:"nonqm"` → `errors.loanProgram === "Invalid loan program"`; `monthlyMi:"6000"` →
    `"Mortgage insurance is a monthly amount from 0 to 5,000"`; `originalAmount:"-1"` → `"Valid original loan amount required"`;
    `originalValue:"0"` → `"Valid original home value required"`; `propertyZip:"8501"` → `"ZIP is 5 digits"`; `occupancy:"rental"` →
    `"Invalid occupancy"`. Blank values for all six are valid (stored as `''`/NULL).
  - `PUT moves as-of dates only when the figure changes`: create with balance 300000, set `balance_as_of`/`value_as_of` to `'2024-01-01'`
    directly in the DB, PUT the same balance and value → both stay `'2024-01-01'`; PUT a new balance → `balance_as_of` = today,
    `value_as_of` unchanged; PUT a new value → `value_as_of` = today.
  - `PUT marks hand edits on the new columns`: PUT a changed `loanProgram` → `edited_by_hand` includes `loan_program`.
  - `PUT with a new credit score sets creditScoreKnown true; PUT with a blank one sets it false`.

- [ ] **Step 2: Run them to make sure they fail**
  Run: `cd server && node --test test/clients-upgrade-fields.test.js` — Expected: FAIL (unknown columns / missing fields).

- [ ] **Step 3: Implement**
  - `db.js`: add each column with the existing `clientCols.some(...)` guard. Backfills run **only inside the guard that adds the column**:
    `balance_as_of` and `value_as_of` ← `date(updated_at)` (fallback `date(created_at)`); `credit_score_known` ←
    `CASE WHEN credit_score != 700 OR instr(edited_by_hand,'credit_score') > 0 THEN 1 ELSE 0 END`.
  - `clients.js`: `toClient` adds the fields; `validateClient` adds the six checks (blank = valid; `monthlyMi` 0..5000 inclusive;
    `propertyZip` `/^\d{5}$/`); create and PUT write them (`''` for blank text, NULL for blank numbers); `credit_score_known` = 1 when
    `creditScore` is a non-blank parseable integer, else 0; on create `balance_as_of = value_as_of = today`; on PUT set
    `balance_as_of = today` only when `loan_balance` changes and `value_as_of = today` only when `property_value` changes.
  - `handEdits.js`: extend `HAND_KEPT`/`LABELS` as above.

- [ ] **Step 4: Run the new tests, then the whole server suite**
  Run: `cd server && node --test test/clients-upgrade-fields.test.js && npm test` — Expected: all pass (fix any existing test that pins
  `HAND_KEPT` or `toClient`'s key list by extending it, not by weakening it).

- [ ] **Step 5: Commit** — `git commit -m "feat(clients): loan program, mortgage insurance, originals, ZIP, occupancy, as-of dates"`

---

### Task 2: Home-price index and today's balance and value

**Files:**
- Create: `server/lib/hpi.js`, `server/lib/hpiData.json`, `server/scripts/update-hpi.js`, `server/lib/equity.js`
- Test: `server/test/hpi.test.js`, `server/test/equity.test.js`

**Interfaces:**
- Consumes: `firstPaymentFromClosing(closeDate)` from `server/lib/intake/loan.js`; `calcPayment` from `server/lib/refi.js`.
- Produces `hpi.js`:
  - `createIndex(data) -> { growth(zip, fromDate, toDate) -> { factor, area, fromQuarter, toQuarter } | null, latestQuarter: string|null }`
    where `data = { source, start: "2000Q1", end: "2026Q2", zip3: { "850": [number, ...] } }` (array index 0 = `start`).
  - `defaultIndex` = `createIndex(require("./hpiData.json"))`.
  - `quarterOf("2021-06-30") === "2021Q2"`.
- Produces `equity.js`:
  - `balanceToday(c, today) -> { balance, asOf, basis: "rolled" | "stored" }`
  - `valueToday(c, today, index = hpi.defaultIndex) -> { value, cautious, asOf, basis: "typed" | "grown" | "flat", growthPct: number|null, area: string|null }`
  - constants `CAUTION_CUT = 0.10`, `TYPED_FRESH_MONTHS = 12`.
  - `c` is the normalized client from Task 5's `refi.norm` (fields `loanType, currentRate, loanBalance, propertyValue, closeDate,
    propertyZip, balanceAsOf, valueAsOf, editedByHand`). Until Task 5 lands, tests pass plain objects with these camelCase names.

- [ ] **Step 1: Write the failing tests**
  - `hpi.test.js`: with `createIndex({ start:"2021Q1", end:"2026Q2", zip3:{ "850":[...22 values where 2021Q2 = 100 and 2026Q2 = 129] } })`:
    `growth("85016","2021-06-30","2026-11-13")` → `factor` 1.29 (±1e-9), `area` "850", `fromQuarter` "2021Q2", `toQuarter` "2026Q2";
    a ZIP whose 3 digits aren't in the index → null; a `fromDate` before `start` → null; a `fromDate` in or after `end` → factor 1;
    `"8501"` / `""` → null. `quarterOf` cases: Jan→Q1, Mar 31→Q1, Apr 1→Q2, Dec→Q4. The shipped `hpiData.json` loads and
    `defaultIndex.latestQuarter` is a string or null.
  - `equity.test.js`:
    - `rolls the balance forward`: 30yr fixed, 6.0%, balance 300000, close `2024-01-15`, `balanceAsOf "2024-03-01"`, today `"2025-03-01"`
      → basis "rolled", `|balance − 296316| ≤ 1`.
    - `no close date keeps the stored balance` → basis "stored", balance 300000.
    - `as-of today keeps the stored balance` (0 months) → 300000.
    - `grows an untyped value and cuts 10%`: value 355000, `valueAsOf "2021-06-30"`, ZIP 85016, the index above, today `"2026-11-13"` →
      basis "grown", value 457950, cautious 412155, growthPct 29.
    - `typed within 12 months is used as is`: `editedByHand "property_value"`, `valueAsOf` 3 months ago → basis "typed",
      value = cautious = 355000.
    - `typed 13 months ago is grown and cut` → basis "grown".
    - `no ZIP: flat, still cut 10%` → basis "flat", value 355000, cautious 319500, growthPct null.
    - `a falling index lowers the value` (factor 0.9 → value 319500, cautious 287550).

- [ ] **Step 2: Run to verify they fail** — `cd server && node --test test/hpi.test.js test/equity.test.js` — FAIL (modules missing).

- [ ] **Step 3: Implement**
  - `hpiData.json`: ship a valid empty snapshot `{ "source": "FHFA HPI 3-digit ZIP (not yet loaded)", "start": null, "end": null, "zip3": {} }`
    (every lookup → null → values stay flat). The real data is loaded later by the controller with `update-hpi.js` on Bill's go.
  - Ruling (plan vs spec §4.3): 3-digit ZIP only, no state fallback. FHFA already substitutes its metro index inside the ZIP3 file where a
    ZIP3 is thin, and a ZIP3 missing from the file means no growth (the cautious reading). Mapping ZIPs to states would need another table.
  - `update-hpi.js <path-to-fhfa-zip3.xlsx>`: reads FHFA's "Three-Digit ZIP Codes (Developmental Index; Not Seasonally Adjusted)" XLSX
    with `xlsx`, keeps quarters from 2000Q1, writes `server/lib/hpiData.json` in the shape above (values rounded to 2 decimals), prints
    the ZIP3 count and the end quarter. It takes a local path only (no network). Detect the columns by header text (3-digit ZIP, year,
    quarter, index); exit 1 with a clear message if they aren't found.
  - `balanceToday`: remaining months at `asOf` = term months (180 for `15yr_fixed`, else 360) − whole months from the first payment date
    to `asOf` (min 1); payment from `calcPayment(balance, rate, remaining/12)`; roll forward k = whole months from `asOf` to `today`
    (k ≥ 0) with the closed-form amortization; floor at 0; round to whole dollars. Missing close date, rate or `asOf` → "stored".
  - `valueToday`: typed = `editedByHand` contains `property_value`; typed and `asOf` within `TYPED_FRESH_MONTHS` → as is. Otherwise
    `index.growth(zip, asOf, today)`; null → flat. `cautious = round(value × (1 − CAUTION_CUT))`; `growthPct = round((factor − 1) × 100)`.

- [ ] **Step 4: Run tests** — the two files, then `npm test` — all pass.

- [ ] **Step 5: Commit** — `git commit -m "feat(equity): home-price index, today's balance and value"`

---

### Task 3: Mortgage insurance (current amount and end date)

**Files:**
- Create: `server/lib/mortgageInsurance.js`
- Test: `server/test/mortgage-insurance.test.js`

**Interfaces:**
- Consumes: `calcPayment` (`refi.js`), `firstPaymentFromClosing` (`intake/loan.js`).
- Produces `currentMi(c, balance, today) -> { monthly: number|null, annualRate: number|null, basis: "typed"|"estimated"|"none"|"unknown", endsOn: "YYYY-MM-DD"|null, endsReason: "11_years"|"78_percent"|null, originalLtv: number|null }`
  - `monthly` is rounded to cents; `annualRate` is a percent (0.5 = 0.50%); for a typed amount `annualRate = monthly × 12 / balance × 100`.
  - `endsOn: null` means it doesn't end on its own (or the date can't be known).
- Produces `endsWithinMonths(mi, today, months) -> boolean`.

- [ ] **Step 0: Confirm the figures.** Before coding, check each rate and date below against the source named in spec §4.4 (HUD ML
  2023-05 / 2015-01 / 2013-04 and Handbook 4000.1; USDA HB-1-3555; Fannie Servicing Guide B-8.1-04; the Homeowners Protection Act).
  If a source disagrees, **implement the figure below anyway** and list the difference under "Concerns" in your report for Bill.

- [ ] **Step 1: Write the failing tests** (balance 300000 unless stated; `today "2026-11-13"`):
  - FHA 30yr, closed `2024-05-01`, no MI typed, originals unknown → monthly 125.00, annualRate 0.5, basis "estimated", endsOn null.
  - FHA 30yr closed `2016-07-01` → 200.00 (0.80%); closed `2014-03-01` → 325.00 (1.30%).
  - Band edge (within 90 days after a boundary, lower figure wins): closed `2023-04-15` → 125.00; closed `2015-02-10` → 200.00.
  - FHA `15yr_fixed` closed `2024-05-01`, LTV unknown → 37.50 (0.15%); closed `2018-01-01` → 112.50 (0.45%).
  - FHA closed `2012-06-01` or `2013-08-01`, no MI typed → monthly null, basis "unknown"; FHA with no close date → "unknown".
  - FHA with originals 270000 / 300000 (90.0%) closed `2016-07-01` → endsOn `"2027-07-01"`, endsReason "11_years"; originals 289500 / 300000
    → endsOn null.
  - FHA with `monthlyMi` 212.5 typed → monthly 212.5, basis "typed", annualRate 0.85.
  - USDA closed `2018-01-01` → 87.50 (0.35%); `2012-03-01` → 75.00 (0.30%); `2013-01-15` → 100.00 (0.40%); `2015-06-01` → 125.00 (0.50%);
    `2016-11-01` → 87.50 (band edge, lower wins); `2010-05-01` → monthly 0, basis "none".
  - VA → monthly 0, basis "none". Conventional or jumbo with no `monthlyMi` → monthly null, basis "none".
  - Conventional with `monthlyMi` 95 typed, originals 285000 / 300000, 6.5% 30yr, closed `2019-05-01` → basis "typed", endsOn = the first
    payment date on which the scheduled balance (from the original amount at the note rate) is ≤ 78% of 300000 (assert with the same
    formula computed in the test), endsReason "78_percent".
  - `endsWithinMonths`: endsOn `"2027-07-01"`, today `"2026-11-13"`, 12 → true; endsOn null → false.

- [ ] **Step 2: Run to verify they fail** — `node --test test/mortgage-insurance.test.js` — FAIL.

- [ ] **Step 3: Implement `currentMi`** with a band table per program (FHA `>15yr` and `≤15yr` lower-tier rates by era: 2013-06-03 /
  2015-01-26 / 2023-03-20; USDA by fiscal year: 2011-10-01 0.30, 2012-10-01 0.40, 2013-10-01 0.50, 2016-10-01 0.35). Within 90 days after a
  boundary use the lower of the two bands' figures. FHA closed before `2013-09-01` → "unknown" unless typed. FHA end date: original LTV
  known and ≤ 90 → close + 11 years; else null. Conventional/jumbo end date only with a typed amount and both originals.

- [ ] **Step 4: Run tests** — the file, then `npm test` — all pass.

- [ ] **Step 5: Commit** — `git commit -m "feat(mi): current mortgage insurance and when it ends"`

---

### Task 4: The five upgrade checks (+ VA rate)

**Files:**
- Create: `server/lib/upgrades.js`
- Modify: `server/routes/rates.js` (`OBMMI_SERIES` L14-20)
- Test: `server/test/upgrades.test.js`; extend the rates test that pins the series map (find it with `grep -rn OBMMIFHA30YF server/test`)

**Interfaces:**
- Consumes: Task 2 `balanceToday`, `valueToday`; Task 3 `currentMi`, `endsWithinMonths`; `refi.analyze`, `refi.calcPayment`,
  `refi.estClosingCosts`, `refi.PRIORITY_RANK`, `refi.impact`; `firstPaymentFromClosing`.
- Produces `upgradesFor(c, rates, today, { index } = {}) -> { lenses: Lens[], gaps: string[], today: Today, mi }`
  - `Lens = { lens, label, priority: "high"|"medium"|"low", headline: number, unit: "$/mo", detail: string, monthlySavings?: number, breakEven?: number, effRate?: number, ltv: number, miMonthly?: number, path?: "original"|"current" }`
    (`detail` is the reason line; every figure in it also appears as a number field).
  - `Today = { balance, balanceFrom, balanceAsOf, balanceBasis, value, valueFrom, cautiousValue, valueAsOf, valueBasis, growthPct, ltv }`
    (`balanceFrom`/`valueFrom` = the stored figures the estimate started from; `ltv` = balance / cautiousValue × 100, 1 decimal).
  - `lenses` sorted by `PRIORITY_RANK` then `impact`, both descending.
  - `rates` may be null (only Drop PMI can run).
- Produces constants exported for tests: `CONV_MIN_SCORE = 620`, `STREAMLINE_MIN_SCORE = 580`, `MAX_BREAK_EVEN = 36`,
  `HIGH_SAVINGS = 200`, `NTB_MIN_DROP = 0.5`, `FHA_UFMIP = 0.0175`, `FHA_NEW_ANNUAL_MIP = 0.55`, `VA_FUNDING_FEE = 0.005`,
  `MI_ENDING_SOON_MONTHS = 12`, `CONV_MAX_LTV = 80`, `WAITING_DAYS = 210`.
- Produces rates key `rate_30yr_va` (FRED series `OBMMIVA30YF`).

Rules (spec §4.6, verbatim values):
- Every check needs a known program (else gap 1, no lenses); `occupancy === "investment"` → no lenses, gap 6; no close date → no lenses,
  gap 5 (every check needs it: insurance era, waiting periods, years since closing, the balance roll-forward).
- Credit gates: refi checks need `creditScoreKnown`; else gap 2. Conventional targets need ≥ 620; streamlines ≥ 580.
- ZIP missing (program known) → gap 3 (checks still run on the flat cautious value).
- `fha_to_conv` / `usda_to_conv`: MI monthly > 0 (estimated or typed); not `endsWithinMonths(mi, today, 12)`; `today.ltv ≤ 80`;
  `analyze({ loanType: c.loanType === "15yr_fixed" ? "15yr_fixed" : "30yr_fixed", currentRate, loanBalance: today.balance, propertyValue: today.cautiousValue, creditScore }, rates)`;
  savings = `curPmt + mi.monthly − newPmt`; costs = `estClosingCosts(balance)`; break-even = `ceil(costs / savings)`; pass when savings > 0
  and break-even ≤ 36; priority high when savings ≥ 200, else medium. Detail:
  `FHA, about ${ltv}% of value, insurance about $${mi}/mo; conventional at ${effRate}% saves about $${savings}/mo, break-even ${be} mo`
  (USDA: `USDA, … fee about $${mi}/mo; …`).
- `fha_streamline`: program fha, `loanType === "30yr_fixed"`; eligible on `max(close + 210 days, firstPayment + 6 months)`; score ≥ 580;
  `rates.rate_30yr_fha` a number; old MI rate = `mi.annualRate ?? 0` (unknown leans low); HUD test
  `(currentRate + oldMiRate) − (fhaRate + 0.55) ≥ 0.5`; old payment = 30yr P&I at the current rate + `mi.monthly ?? 0`; new = 30yr P&I at
  the FHA rate + `balance × 0.0055 / 12`; costs = `estClosingCosts(balance) + 0.0175 × balance`; savings > 0, break-even ≤ 36. Detail:
  `FHA ${currentRate}% → about ${fhaRate}% FHA, saves about $${savings}/mo, break-even ${be} mo (upfront FHA insurance counted)`.
- `va_irrrl`: program va, `loanType === "30yr_fixed"`; eligible on `max(firstPayment + 210 days, firstPayment + 5 months)`; score ≥ 580;
  `rates.rate_30yr_va` a number; drop ≥ 0.5; costs = `estClosingCosts(balance) + 0.005 × balance`; savings > 0, break-even ≤ 36; priority
  as above. Detail: `VA ${currentRate}% → about ${vaRate}% VA, saves about $${savings}/mo, break-even ${be} mo`.
- `drop_pmi`: program conventional or jumbo; `c.monthlyMi > 0` (typed/imported only; else gap 4 when original LTV is > 80 or unknown);
  not when `mi.endsOn` exists and is ≤ today (ended on its own); path "original" when `originalValue` known and `balance ≤ 0.80 ×
  originalValue`; else path "current" when years since closing ≥ 2 and < 5 and `today.ltv ≤ 75`, or ≥ 5 and `today.ltv ≤ 80`. Priority
  "low"; headline = `round(monthlyMi)`. Detail: `Conventional, about ${ltv}% of value, PMI $${mi}/mo: they can ask their lender to remove it`
  (path original: `about ${pct}% of the original value`). Rates not needed.
- Money in details: whole dollars with thousands commas; rates 2 decimals; LTV 1 decimal → integer when shown as "about N%" (round).

- [ ] **Step 1: Write the failing tests** — one `describe`-style group per lens with a flagging client and one non-flagging client per
  guard. Required cases (build each from a `base` client helper; rates `{ rate_30yr_fixed: 6.25, rate_15yr_fixed: 5.6, rate_5_1_arm: 6.1, rate_30yr_top_tier: 6.1, rate_30yr_fha: 5.9, rate_30yr_va: 5.8 }`; index injected via `{ index }`):
  1. FHA 3.5% down 2021 (rate 6.9, originals 289500/300000, value 300000 as of close, ZIP with factor 1.40, score 720 known, today
     `"2026-11-13"`) → `fha_to_conv` present, `ltv ≤ 80`, detail matches the format, `monthlySavings` equals the recomputed value.
  2. Same client, no ZIP → no `fha_to_conv` (flat value keeps LTV > 80) and gaps include the ZIP line.
  3. Same client, `creditScoreKnown false` → no refi lenses, gap 2. Score 600 known → no `fha_to_conv`.
  4. FHA closed `2012-06-01`, no MI typed → no `fha_to_conv` (MI unknown).
  5. FHA with originals ≤ 90% LTV whose 11-year end is 6 months away → no `fha_to_conv`.
  6. `fha_streamline` flags for a 7.75% FHA loan closed 2023; the same closed 150 days ago → none; `rate_30yr_fha` missing → none (Review
     Focus 4: with fallback rates `{rate_30yr_fixed, rate_15yr_fixed, rate_5_1_arm}` only, `fha_to_conv` still runs for case 1).
  7. `va_irrrl` flags for a 7.25% VA loan closed 2023; first payment 5 months ago → none; drop 0.4 → none; no `rate_30yr_va` → none.
  8. `drop_pmi` path original (balance ≤ 80% of original value, MI 95 typed) and path current (4 years, LTV 74 → flag; LTV 76 → none;
     6 years, LTV 79 → flag); MI not typed → none + gap 4; MI typed but scheduled balance already ≤ 78% → none.
  9. `usda_to_conv` flags with the USDA fee; USDA closed 2010 (no fee) → none.
  10. Investment property → `lenses` empty, gaps = [line 6]. No program → `lenses` empty, gaps = [line 1].
  11. Lenses come back sorted (a client qualifying for both `fha_to_conv` and `fha_streamline` → the larger saver first).
  - Rates test: `OBMMI_SERIES.rate_30yr_va === "OBMMIVA30YF"` (or however the existing test asserts the map).

- [ ] **Step 2: Run to verify they fail** — `node --test test/upgrades.test.js` — FAIL.

- [ ] **Step 3: Implement `upgrades.js`** per the rules above, and add `rate_30yr_va: "OBMMIVA30YF"` to `OBMMI_SERIES` (it flows into the
  rates object, snapshots and `rateHistory` automatically; the fallback sets stay without it).

- [ ] **Step 4: Run tests** — the files, then `npm test` — all pass.

- [ ] **Step 5: Commit** — `git commit -m "feat(upgrades): five upgrade checks and the VA rate series"`

---

### Task 5: Upgrades in the sweep, and the scoring check

**Files:**
- Modify: `server/lib/refi.js` (`norm` L52-65, `sweepClient` L196-202, `runSweep` L205-218)
- Modify: `scripts/check-scoring.js` (repoint; add fixtures)
- Test: extend `server/test/sweeps.test.js`

**Interfaces:**
- Consumes: Task 4 `upgradesFor`.
- Produces `norm(c)` additionally returning `loanProgram, monthlyMi (number|null), originalAmount (number|null), originalValue (number|null),
  propertyZip, occupancy, balanceAsOf, valueAsOf, creditScoreKnown (boolean), editedByHand (string)` from camel or snake input
  (`Number(null)` must not become 0: null/""/undefined → null).
- Produces `sweepClient(raw, rates, now, opts = {})` → existing shape plus `upgrades: Lens[]`, `bestUpgrade: Lens|null`, `upgradeGaps: string[]`.
  `opts.index` passes through to `upgradesFor`.
- Produces `runSweep(clients, rates, now, opts = {})` → existing shape plus `upgrades` (rows with a `bestUpgrade`, ordered like
  `opportunities` but by `bestUpgrade`, name breaking ties) and `counts.withUpgrade`; `byLens` counts upgrade lenses too.
- Government gating: when `loanProgram` is `fha`, `va` or `usda`, `opportunities` lenses = `[cashOut(c)]` only (filter nulls).

- [ ] **Step 1: Write the failing tests** in `sweeps.test.js`:
  - `no-program client: identical to before` (Review Focus 1): for three fixture clients with no program (rate-term, ARM, 15yr), deep-equal
    `best`, `opportunities` and `checkIn` against the values the current code returns (capture them by running the test against
    `HEAD` first and pasting the literals), and `upgrades: []`, `bestUpgrade: null`.
  - `an FHA client gets cash-out only from the old lenses plus its upgrades`.
  - `runSweep lists upgrades separately and counts them`: two upgrade clients + one rate-term client → `upgrades.length === 2`,
    `counts.withUpgrade === 2`, `opportunities` unchanged for the rate-term client, `byLens.fha_to_conv` counted.
  - `norm keeps null monthly MI as null`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** the `norm`, `sweepClient`, `runSweep` changes. Then fix `scripts/check-scoring.js`: replace the App.jsx
  `eval` slice with `require("../server/lib/refi.js")` (`analyze`), keep every existing case and invariant, and add an "Upgrades" block
  that runs `upgradesFor` on one flagging and one must-not-flag fixture per lens (reuse Task 4's fixtures by value), failing the script
  on any mismatch.

- [ ] **Step 4: Verify** — `cd server && npm test` passes; `node scripts/check-scoring.js` (repo root) exits 0 and prints the upgrade block.

- [ ] **Step 5: Commit** — `git commit -m "feat(sweeps): upgrades in the sweep; government programs skip conventional lenses; scoring check repointed"`

---

### Task 6: Import the new fields

**Files:**
- Modify: `server/lib/intake/fields.js`, `server/lib/intake/record.js`, `server/lib/intake/ingest.js`, `server/routes/integrations.js`
- Test: extend `server/test/intake-*.test.js` (the fields/record/ingest files) and the integrations test

**Interfaces:**
- Consumes: Task 1 columns and `HAND_KEPT`.
- Produces `FIELDS` gaining (placed right after `amortization`) `loanProgram` "Loan program", then after `creditScore`: `monthlyMi` "Monthly
  mortgage insurance", `propertyZip` "Property ZIP", `occupancy` "Occupancy".
- Produces `SYNONYMS`:
  - `amortization: ["amortizationtype","amorttype","amortization","loanproduct","product"]`
  - `loanProgram: ["loanprogram","program","loantype","mortgagetype","producttype","agency"]`
  - `monthlyMi: ["monthlymi","mipayment","monthlymortgageinsurance","mortgageinsurance","monthlypmi","pmi","mip","mi"]`
  - `propertyZip: ["propertyzip","subjectzip","propertyzipcode","subjectpropertyzip","zip","zipcode","postalcode"]`
  - `occupancy: ["occupancy","occupancytype","propertyusage","occupancystatus","propertyuse"]`
- Produces `toRecord` record additions: `loanProgram` (""|program), `monthlyMi` (number|null, 0..5000), `propertyZip` (5 digits or ""),
  `occupancy` (""|value), `originalAmount` (number|null), `originalValue` (number|null), `valueBasis` ("current"|"origination"),
  `balanceAsOf` ("YYYY-MM-DD").
- Produces `BODY_FIELDS.loan_program = "loanProgram"` (optional feed key).

Rules (spec §4.5):
- Program text (from `loanProgram`, else the `amortization` text): whole-word, case-insensitive: `FHA` → fha; `VA` → va;
  `USDA|RD|Rural` → usda; `Jumbo` → jumbo; `Conventional|Conforming|Fannie|Freddie|FNMA|FHLMC|Conv` → conventional; else "".
- ARM/term detection reads the `amortization` text, else the `loanProgram` text (so a lone "Loan Type: 5/1 ARM" column still sets the ARM).
- Occupancy text: `invest|non.?owner|rental` → investment; `second|vacation` → second_home; `primary|owner|principal` → primary; else "".
- ZIP: first 5 digits of a 5- or 9-digit value (`85016-1234` → `85016`), else "".
- `originalValue`: purpose purchase → the lesser of purchase price and appraised value present; refinance → appraised value (else purchase
  price); unknown purpose → the lesser of those present.
- `valueBasis`: "current" when the value came from the `propertyValue` column, else "origination". `value_as_of` = import date for
  "current", close date (or import date when none) for "origination".
- `balanceAsOf`: close date when `estimateBalance` basis is "original" and a close date exists, else the import date.
- `credit_score_known = 1` whenever the record has a credit score.
- `ingest`: INSERT writes the new columns; the update path (`loanChanges`) treats the new columns like the existing ones: unchanged →
  skipped; hand-kept (`kept`) → held; otherwise changed. Writing `loan_balance` also writes `balance_as_of`; writing `property_value` also
  writes `value_as_of`. Blank incoming values never overwrite stored ones.

- [ ] **Step 1: Write the failing tests**
  - `detectMapping`: headers `["Loan Type","Amortization Type"]` → `loanProgram` = col 0, `amortization` = col 1; `["Product"]` →
    `amortization` only; `["Property Zip","Zip"]` → `propertyZip` = col 0.
  - `toRecord` program table (Review Focus spec §8.6): `"Conv 30 Fixed"`→conventional, `"FHA 30YR"`→fha, `"VA IRRRL"`→va,
    `"USDA RD 30"`→usda, `"Non-QM"`→"", `"Jumbo ARM 7/1"`→jumbo with `loanType "5_1_arm"`; `"Evan"`-style text containing "va" inside a
    word → "".
  - `toRecord` original value: purchase 350000/appraised 355000 purchase → 350000; refinance → 355000.
  - occupancy and ZIP parsing cases; MI `"$212.50"` → 212.5; `"6000"` → null.
  - `ingest` re-import (Review Focus 2): a client with hand-edited `loan_program` "va" and `property_zip` "85016" keeps both when the file
    says FHA / 85020, and the result lists them as held; an unedited client takes the file's values; a blank file cell leaves stored values.
  - `ingest` sets `balance_as_of`/`value_as_of`/`credit_score_known` per the rules.
  - integrations: a feed body with `loan_program: "FHA"` stores `fha`; without it, `amortization_type: "FHA 30 Fixed"` stores `fha`.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** per the rules.
- [ ] **Step 4: Run** the intake/integration tests, then `npm test` — all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(import): loan program, MI, ZIP, occupancy and originals from loan files and the feed"`

---

### Task 7: Upgrade alerts and per-client views

**Files:**
- Create: `server/lib/upgradeAlerts.js`
- Modify: `server/db.js` (table), `server/lib/targets.js` (export `latestRealSnapshot`), `server/routes/clients.js` (`presentClients`),
  `server/routes/sweeps.js`
- Test: `server/test/upgrade-alerts.test.js`; extend `server/test/sweeps-api.test.js` and `server/test/clients-api.test.js`

**Interfaces:**
- Consumes: Task 4 `upgradesFor`; Task 5 `norm`; `targets.latestRealSnapshot(db)`, `targets.handledAtFor` pattern (reached contact
  at/after a time).
- Produces table `client_upgrades (client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, lens TEXT NOT NULL, first_seen_on TEXT NOT NULL, first_seen_at TEXT NOT NULL, announced_on TEXT, PRIMARY KEY (client_id, lens))`.
- Produces in `upgradeAlerts.js`:
  - `checkUpgrades(db, orgId, nowMs) -> { rates, obsDate, today, results: Map<clientId, UpgradesResult> } | null` — null without a FRED
    snapshot. For every org client with a program: compute `upgradesFor`; insert a row per newly qualifying lens (`first_seen_on = obsDate`,
    `first_seen_at` = now ISO); delete rows whose lens no longer qualifies (re-arm). Writes only differences; never touches `updated_at`.
  - `safeCheckUpgrades(db, orgId, nowMs)` — try/catch → null, logs only the error name (as `targets.safeCheck`).
  - `upgradeViewsFor(db, rows, check, nowMs) -> Map<clientId, View>` with
    `View = { lenses: (Lens & { isNew: boolean })[], gaps, today, newLenses: string[] }`; rows without a result are computed with
    `check?.rates ?? null`. `isNew` = an alert row exists and there's no `contact_log` `reached` entry at/after its `first_seen_at`.
  - `newlyQualified(db, rows, views, localDate) -> [{ clientId, name, lens }]` — alert rows with `announced_on` null or = `localDate` and
    `isNew`.
  - `announceUpgrades(db, pairs, localDate)` — `UPDATE client_upgrades SET announced_on = ? WHERE client_id = ? AND lens = ? AND announced_on IS NULL`.
- Produces `presentClients` output `{ ...toClient(row), target, upgrades: View|null }` (runs `safeCheckUpgrades` beside `safeCheck`).
- Produces `POST /api/sweeps` response rows in `upgrades` with `isNew: boolean` on each row's `bestUpgrade` and lenses.

- [ ] **Step 1: Write the failing tests**
  - `first check records a newly qualifying lens with the snapshot day`; `a second check the same day writes nothing`.
  - `a lens that stops qualifying is deleted, and comes back as new` (Review Focus 5: qualify → rates rise → gone → rates fall → new row
    with the later `first_seen_on`, `isNew` true again).
  - `a reached contact after first_seen_at clears isNew; one before doesn't`.
  - `no FRED snapshot → checkUpgrades null and views still carry gaps`.
  - `newlyQualified / announceUpgrades`: announced once; the same day still listed; the next day not.
  - API: `GET /api/clients` items carry `upgrades`; a loan officer's list has views only for their own clients (Review Focus 3).
  - API: `POST /api/sweeps` upgrade rows carry `isNew`.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement**; wire `safeCheckUpgrades` into `presentClients` and the sweeps route next to the existing `safeCheck` calls.
- [ ] **Step 4: Run** the new and touched tests, then `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(alerts): upgrade alerts and per-client upgrade views"`

---

### Task 8: Upgrades in the call list and the morning briefing

**Files:**
- Modify: `server/lib/assistant/callList.js` (`opportunityPhrase` L53, `describe` L101, `pickCallList` row gathering), `server/lib/assistant/briefing.js` (`targetPicks` ~L249, `callListSection` L268, the announce step ~L332, the target check ~L392)
- Test: extend `server/test/call-list.test.js` (or the existing callList test file) and `server/test/briefing*.test.js`

**Interfaces:**
- Consumes: Task 5 sweep rows (`bestUpgrade`, `upgrades` list); Task 7 `checkUpgrades`, `upgradeViewsFor`, `newlyQualified`,
  `announceUpgrades`.
- Produces upgrade phrases (verbatim; `$X` = `money(Math.round(headline))`):
  - `fha_to_conv`: `looks like they could leave FHA for a conventional loan and save about $X a month`
  - `usda_to_conv`: `looks like they could leave USDA for a conventional loan and save about $X a month`
  - `fha_streamline`: `looks like they could do an FHA streamline and save about $X a month`
  - `va_irrrl`: `looks like they could do a VA streamline and save about $X a month`
  - `drop_pmi`: `looks like they could ask their lender to drop about $X a month of PMI`
- Produces: `pickCallList` gathers rows from `sweep.upgrades` too; `describe` uses whichever of `row.best` / `row.bestUpgrade` ranks higher
  (`PRIORITY_RANK`, then `impact`) as the client's lead.
- Produces briefing picks for newly qualified upgrades: `{ clientId, name, reasonCode: "upgrade", reason: `${name} now ${phrase}` }`, passed
  to `pickCallList` as `targets: [...newly, ...upgradeNewly, ...still]`, then `announceUpgrades` for the picked ones (alongside
  `announceTargets`). The briefing calls `checkUpgrades` directly (as it calls `targets.checkTargets`, inside its try/skip).

- [ ] **Step 1: Write the failing tests**: each phrase verbatim; an upgrade-only client appears in the call list with its phrase; a client
  with a medium rate-term and a high `fha_to_conv` leads with the upgrade; a newly qualified client is named once in today's briefing with
  reasonCode "upgrade" and `announced_on` set, and not as "now" on the next day; every figure in the briefing text is a JSON number in its
  payload (run the existing grounding assertion helper the briefing tests use).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched suites, then `npm test` (orchestrator/briefing guard tables must stay green without loosening).
- [ ] **Step 5: Commit** — `git commit -m "feat(charlie): upgrades in the call list and the morning briefing"`

---

### Task 9: Charlie's tools

**Files:**
- Modify: `server/lib/assistant/tools.js` (`findClient` L112, new `upgradesTool`, the `tools` object ~L812, `TOOL_SCHEMA` ~L823),
  `server/lib/assistant/prompt.js` (Charlie's rules near the Screens rule ~L188), `server/lib/assistant/orchestrator.js` (`trimSweep`: keep
  `upgrades` in the model's sweep payload, top 5, same row shape as opportunities)
- Test: `server/test/assistant-tools.test.js` (incl. the 1:1 name list at ~L1114), `server/test/assistant-orchestrator.test.js` (guideline
  table ~L186-199)

**Interfaces:**
- Consumes: Task 7 `safeCheckUpgrades`, `upgradeViewsFor`.
- Produces `findClient` matches with `program` (= `loanProgram`) and `upgrades: [{ lens, label, headline, unit, detail, isNew }]` (no gaps,
  no PII).
- Produces `upgradesTool({ kind } = {}, ctx) -> { data: { clients: [{ id, name, [ownerName], upgrades: [...] }] }, source: "client record" }`;
  `kind` `"drop_insurance"` = `fha_to_conv|drop_pmi|usda_to_conv`, `"streamline"` = `fha_streamline|va_irrrl`, absent = all; scope =
  `scopedClients(ctx)`; order: clients with an `isNew` upgrade first, then best upgrade by priority then headline, name ties; cap 15
  (`MAX_UPGRADES_SHOWN`). Schema: `{ name: "upgradesTool", description: "Clients who look like they qualify for an upgrade: leaving FHA or USDA for conventional, dropping PMI, or an FHA/VA streamline. Optional kind filters to drop_insurance or streamline.", input_schema: { type: "object", properties: { kind: { type: "string", enum: ["drop_insurance","streamline"] } }, additionalProperties: false } }`.
- Produces the prompt sentence (verbatim): `Upgrades: when the user asks who could drop mortgage insurance, leave FHA or USDA, or do a streamline, call upgradesTool; say each client "looks like" they qualify and use only the figures it returns. Eligibility rules for a program are still a guideline question.`

- [ ] **Step 1: Write the failing tests**: `upgradesTool` returns only in-scope clients for a loan officer (Review Focus 3); `kind` filters;
  cap and order; payload numbers present for every figure in `detail`; `findClient` includes `program` and `upgrades`; TOOL_SCHEMA 1:1 list
  gains `upgradesTool` (16 names); orchestrator table rows: `"Is Chen eligible for an FHA streamline?"` stays `GUIDELINE_HANDOFF`;
  `"Who could drop their mortgage insurance?"` and `"Does Chen have any upgrades?"` are **not** guideline questions; `trimSweep` keeps
  `upgrades`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — all pass (the prompt-snapshot test, if any, is updated to include the new sentence verbatim).
- [ ] **Step 5: Commit** — `git commit -m "feat(charlie): upgradesTool and upgrades in findClient"`

---

### Task 10: Screens — form fields, Sweeps "Upgrades", client page card

**Files:**
- Create: `client/src/upgrades.mjs`, `client/src/upgrades.test.mjs`
- Modify: `client/src/App.jsx` (`EMPTY_FORM` L1872, `clientToForm` L1874, `ClientForm` grid L1923-1940, AddClient/EditClient payloads,
  `ClientDetail` after the refi card ~L1644-1690, `LENS_META` L2343, `PRI_BADGE` usage, `SweepsView` L2357-2484)

**Interfaces:**
- Consumes: API fields from Task 1; `client.upgrades` view from Task 7; sweep `upgrades` rows with `isNew` from Tasks 5/7.
- Produces `upgrades.mjs` (pure, tested):
  - `PROGRAM_OPTIONS = [["", "Not set"], ["conventional","Conventional"], ["fha","FHA"], ["va","VA"], ["usda","USDA"], ["jumbo","Jumbo"]]`
  - `OCCUPANCY_OPTIONS = [["", "Not set"], ["primary","Primary"], ["second_home","Second home"], ["investment","Investment"]]`
  - `UPGRADE_LENSES` = the five ids in order `fha_to_conv, fha_streamline, va_irrrl, usda_to_conv, drop_pmi`
  - `badgeFor(lens) -> { label, tone }`: `drop_pmi` → label "Goodwill" (tone `low`); others use the priority badge.
  - `balanceLine(today) -> string`: `Balance about $286,400 (rolled forward from $301,000 in May 2024)` (estimate rounded to the nearest
    $100; month and year of `balanceAsOf`); basis "stored" → `Balance $301,000 (as entered)`.
  - `valueLine(today) -> string` (estimates rounded to the nearest $1,000; year of `valueAsOf`): grown →
    `Value about $412,000 (from $355,000 in 2021, area prices up 29%, less 10% for caution)`; typed → `Value $355,000 (you entered it)`;
    flat → `Value about $320,000 ($355,000 less 10% for caution)`.

UI rules:
- Form: after the loan-type select add a Loan Program select, then `field(...)` inputs for Monthly Mortgage Insurance (placeholder
  "leave blank if you don't know"), Original Loan Amount, Original Home Value, Property ZIP, and an Occupancy select; the Property Value
  label gains the hint "today's value, if you know it". Same `field` helper and select styling as the loan-type select.
- Sweeps: `LENS_META` gains the five lenses using existing palette colours (no new colours); the chip row shows them after the existing
  four. A new `<h2>` "Upgrades ({data.counts.withUpgrade})" section between "Opportunities" and "Check-ins due", rows in the existing
  opportunity row markup showing `bestUpgrade` (label chip, name with "+N more", `detail`, headline, badge via `badgeFor`) and a small
  "New" chip (existing amber chip style) when `isNew`. Empty state: "No upgrades at today's rates."
- Client page: an "Upgrades" card (existing `card` style) after the refi analysis card: each lens with label, `detail`, "New" chip; then
  every gap line; then `balanceLine` and `valueLine`. Hidden only when `client.upgrades` is null.

- [ ] **Step 1: Write the failing tests** for `upgrades.mjs` (every line format above verbatim, `badgeFor`, option lists).
- [ ] **Step 2: Run to verify they fail** — `cd client && node --test src/upgrades.test.mjs`.
- [ ] **Step 3: Implement** `upgrades.mjs` and the three screen changes.
- [ ] **Step 4: Verify** — `cd client && npm test && npm run build` — all pass, build clean; server `npm test` still green.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): loan program fields, Sweeps Upgrades section, client Upgrades card"`

---

## After the tasks (controller)

- Final whole-branch review; one fix wave.
- Browser check on a throwaway demo DB with sample clients covering each lens and each gap, laptop and phone; screenshots to Bill.
- Ask Bill's go to download FHFA's public 3-digit-ZIP quarterly XLSX (name, source, size stated), run
  `node server/scripts/update-hpi.js <path>`, commit the generated `hpiData.json`, re-run the suites.
- Update `CLAUDE.md` (Data sources: FHFA HPI, `rate_30yr_va`; Sweeps lenses) and `PROGRESS.md`.
- Merge, push and deploy each need Bill's go.
