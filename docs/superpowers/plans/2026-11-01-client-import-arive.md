# Client Import + ARIVE Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broker imports an ARIVE, Calyx Point or any CSV/Excel book with no duplicates and today's balances, and funded ARIVE
loans arrive on their own through a Zapier webhook. One shared intake module serves both.

**Architecture:** A new `server/lib/intake/` module holds the steps: value parsing, loan math, header mapping, one record per
row, matching, owner routing, and `ingest()`, which writes inside one SQLite transaction. The review is the same `ingest()` run
with `dryRun: true`, which rolls the transaction back. Two front doors call it: `routes/import.js` (the file, broker only) and
`routes/integrations.js` (the Bearer-key webhook and its key management). The client gets `client/src/import/` (replacing
`ImportClients` in `App.jsx`) and a Connections card on the Profile page.

**Tech Stack:** Node 20, Express 4, better-sqlite3, multer, xlsx 0.18, express-rate-limit 7, `node:crypto`; React 18 + Vite.
Tests use `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-01-client-import-arive-design.md` (approved 2026-11-01). Sections are cited as A1–A9
and B1–B4.

## Global Constraints

- Node 20 only. Every shell starts with `export PATH="/c/Users/bille/dev/node20:$PATH"`.
- Server tests: `cd server && npm test` (1066 pass before this plan). Client tests: `cd client && npm test` (200 pass).
- Never read, print or edit `server/.env` or any `.env*` file. Refer to secrets by env-var name only.
- No new npm dependencies.
- A1. **Importing never contacts anyone.** No email, text or calendar event, ever. `lib/intake/` and `routes/integrations.js`
  never require `email.js`. In-app `notifications` rows (A6a) are the only message.
- A2. **The whitelist only.** Only the fields in `FIELDS` (Task 3) are ever read from a row or a webhook body. Never SSN, date of
  birth, income, assets, employer, credit report details or account numbers. Headers matching
  `/ssn|social|dob|birth|income|salary|asset|employ|account/` (on the header key, Task 1) are never offered or read.
- A3. **Never touched by an import:** `clients.name`, `clients.notes` (on a match), `clients.last_contact`, `contact_log`,
  and Charlie's recommendations and carries. The one exception is A6a: the old owner's *open* rows close as `expired`.
- A4. **Funded only.** A5. **No figure made up.** An original amount used as the balance is always flagged.
- **The webhook payload is never logged.** Log only a result word or an error's `.name`.
- "today" is the UTC date (`YYYY-MM-DD`) and "nowUtc" is SQLite UTC text (`YYYY-MM-DD HH:MM:SS`) for both front doors.
- Match the surrounding code: CommonJS with `"use strict"` on the server, ESM `.mjs`/`.jsx` on the client, plain-English
  comments at the density of `routes/profile.js` and `lib/assistant/followups.js`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Nothing is pushed, merged or deployed by this plan.

## Rulings (where the spec is silent or a detail had to give)

- R1. `/api/import/*` requires `requireBroker` on the server (403 for a loan officer). A1 says the page is a broker's page, and
  org-wide matching and routing make it unsafe to leave open.
- R2. The index is `(org_id, loan_number)`, not the spec's `(user_id, loan_number)`, because matching is org-wide (A6).
- R3. **One side has a loan number, the other doesn't:** it's the same loan when the closing dates are equal or either is
  missing; otherwise the "loan numbers differ" rules apply. **Both present and different, with a closing date missing on
  either side:** a refinance, unless the purpose is purchase.
- R4. **Name-alone step:** two or more clients with the name, any of them bare, is `ambiguous` (not a new duplicate).
- R5. An update writes `loan_type` only when the row gave a term or an amortization (`record.loanTypeGiven`). A file with no
  such column never turns a 15-year into a 30-year.
- R6. **Review = import.** Both run `ingest()`; the review rolls back. The review returns `reviewHash`. Confirm sends it back,
  and if the fresh run's hash differs, confirm rolls back and answers 409 with the new review. That is the spec's "applies
  exactly what the review showed".
- R7. **Webhook closing date:** missing or future → `200 ignored`. Present but unreadable → `400`.
- R8. **Parsing:** a CSV is parsed as plain text (`raw: true`), so loan number `000123` keeps its zeros. A workbook is
  recognised by its signature (`PK` zip or `D0 CF 11 E0`), not by the browser's mimetype.
- R9. `/api/integrations` is mounted in `index.js` **before** the app-wide `express.json({ limit: "20mb" })`, so its own
  32 KB parser is the one that runs.
- R10. The key is `br_` + 64 hex characters. A 401 answers `{ error: "Unauthorized" }`. An oversized body answers 413.
- R11. In the file review, ambiguous rows count as skipped ("ambiguous: skipped"). The webhook keeps `ambiguous` as its own
  result.

## Review Focus

1. **A CSV saved by Excel with a UTF-8 BOM** before the first header: the name column is still detected (Task 3 test).
2. **Names exported "Last, First"** ("Smith, John"): stored and matched as "John Smith", so a re-import or a Zap doesn't
   duplicate a client entered by hand (Task 1 test).
3. **Cells holding "N/A", "-" or stray spaces in money, rate and date columns:** read as missing, so the row is skipped with
   its reason; nothing crashes and nothing is stored as 0 (Tasks 1 and 4 tests).
4. **Zapier sending `""` for an unmapped field and numbers as strings** (`"current_balance": ""`, `"note_rate": "6.5"`): an
   empty string is absent, never 0 (Task 8 test).
5. **The same loan listed twice in one export** (identical rows): one client is created, and the second row is "unchanged"
   (Task 6 test).

---

### Task 1: Value parsers

**Files:**
- Create: `server/lib/intake/normalize.js`
- Test: `server/test/intake-normalize.test.js`

**Interfaces:**
- Produces (all pure; a non-string, non-number input reads as missing):
  - `parseNumber(v) -> number|null`: strips `$`, `,`, `%` and spaces. `""`, `N/A`, `n/a`, `none`, `null`, `-` and `(…)` → null.
  - `parseRate(v) -> number|null`: like parseNumber, but `0 < n < 1` is a fraction × 100, rounded to 4 decimals.
  - `parseMoney(v) -> number|null`: parseNumber.
  - `parseDate(v) -> "YYYY-MM-DD"|null`:
    - Excel serials: a number, or an all-digit string, from 20000 to 80000, counted as days since 1899-12-30 UTC.
    - `M/D/YYYY` and `M/D/YY` (YY < 70 → 20YY, else 19YY).
    - `YYYY-MM-DD`, optionally followed by `T…`.
    - Impossible dates → null.
  - `parseTermMonths(v) -> number|null`:
    - a "month"/"mo" word → months; a "yr"/"year" word → years × 12;
    - a bare number ≤ 50 → years × 12, > 50 → months;
    - ≤ 0 → null.
  - `fullName({ name, first, last }) -> string`:
    - `name`, else `first + " " + last`;
    - exactly one comma with text on both sides flips "Last, First" to "First Last";
    - whitespace collapsed, at most 120 characters.
  - `nameKey(name) -> string`: lowercase, whitespace collapsed (for matching).
  - `phoneDigits(v) -> string`: digits only; 11 digits starting with 1 drop the 1.
  - `cleanEmail(v) -> string`: trimmed and lowercased, `""` unless it looks like `x@y.z`, at most 254 characters.
  - `cleanText(v, max) -> string`: trimmed and cut to `max`.
  - `headerKey(h) -> string`: lowercase, BOM removed, every character except `a-z 0-9 #` removed.
  - `isProtectedHeader(h) -> boolean`: the A2 regex on `headerKey(h)`.

- [ ] **Step 1: Write the failing tests** in `server/test/intake-normalize.test.js` (pure, no DB):

```js
test("parseRate reads 6.5, '6.500%', '0.065' and 0.065 as 6.5; blanks, N/A and junk are null", () => {
  for (const v of [6.5, "6.5", "6.500%", " 6.5 % ", "0.065", 0.065]) assert.equal(parseRate(v), 6.5);
  for (const v of ["", "N/A", "n/a", "-", null, undefined, {}, [], "abc"]) assert.equal(parseRate(v), null);
});
test("parseMoney strips $ and commas; N/A, blanks and (negatives) are null", () => {
  assert.equal(parseMoney("$412,500.00 "), 412500);
  assert.equal(parseMoney(412500), 412500);
  for (const v of ["N/A", "", "  ", "(1,000)", "none"]) assert.equal(parseMoney(v), null);
});
test("parseDate: Excel serials, M/D/YYYY, M/D/YY, ISO dates and timestamps; impossible dates are null", () => {
  assert.equal(parseDate(45365), "2024-03-14");
  assert.equal(parseDate("45365"), "2024-03-14");
  assert.equal(parseDate("3/14/2024"), "2024-03-14");
  assert.equal(parseDate("03/14/24"), "2024-03-14");
  assert.equal(parseDate("2024-03-14"), "2024-03-14");
  assert.equal(parseDate("2024-03-14T00:00:00Z"), "2024-03-14");
  for (const v of ["", "TBD", "2/30/2024", "13/01/2024", "2024-02-30", 12, null]) assert.equal(parseDate(v), null);
});
test("parseTermMonths: 360, '30', '30 yr', '30 Years', '180 months', '15'", () => {
  for (const [v, m] of [[360, 360], ["360", 360], ["30", 360], ["30 yr", 360], ["30 Years", 360], ["180 months", 180], ["15", 180]]) assert.equal(parseTermMonths(v), m);
  for (const v of ["", "0", "N/A", null]) assert.equal(parseTermMonths(v), null);
});
test("fullName joins first + last, flips 'Last, First', collapses spaces", () => {
  assert.equal(fullName({ name: "Smith, John" }), "John Smith");
  assert.equal(fullName({ name: "  John   Smith " }), "John Smith");
  assert.equal(fullName({ first: "John", last: "Smith" }), "John Smith");
  assert.equal(fullName({ first: "Cher" }), "Cher");
  assert.equal(fullName({ name: "Smith, John, Jr" }), "Smith, John, Jr");
  assert.equal(fullName({}), "");
  assert.equal(fullName({ name: "x".repeat(200) }).length, 120);
});
test("phoneDigits, cleanEmail, nameKey", () => {
  assert.equal(phoneDigits("(555) 123-4567"), "5551234567");
  assert.equal(phoneDigits("+1 555 123 4567"), "5551234567");
  assert.equal(phoneDigits(5551234567), "5551234567");
  assert.equal(cleanEmail(" Ann@Example.COM "), "ann@example.com");
  assert.equal(cleanEmail("not an email"), "");
  assert.equal(nameKey("  John   SMITH "), "john smith");
});
test("headerKey strips a BOM and punctuation; isProtectedHeader catches SSN/DOB/income/assets/employer/account headers", () => {
  assert.equal(headerKey("﻿Borrower Name"), "borrowername");
  assert.equal(headerKey("Loan #"), "loan#");
  for (const h of ["Borrower SSN", "Social Security #", "DOB", "Date of Birth", "Monthly Income", "Base Salary", "Total Assets", "Employer Name", "Account Number"]) assert.equal(isProtectedHeader(h), true, h);
  for (const h of ["Loan Number", "Borrower Name", "Note Rate", "Closing Date", "Loan Status"]) assert.equal(isProtectedHeader(h), false, h);
});
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd server && node --test test/intake-normalize.test.js`. Expected: FAIL, because `../lib/intake/normalize` is not found.
- [ ] **Step 3: Implement `server/lib/intake/normalize.js`** with the exports above. Start the file with a header comment saying
  these read what a file or a Zap sends, and that missing is always null, never 0.
- [ ] **Step 4: Run them and watch them pass.** Run: `node --test test/intake-normalize.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/lib/intake/normalize.js server/test/intake-normalize.test.js && git commit -m "feat(intake): value parsers for imported loans"`

### Task 2: Loan math (balance estimate, loan type)

**Files:**
- Create: `server/lib/intake/loan.js`
- Test: `server/test/intake-loan.test.js`

**Interfaces:**
- Consumes: nothing. The callers pass already-parsed values.
- Produces:
  - `firstPaymentFromClosing(closeDate) -> "YYYY-MM-DD"|null`: the 1st of the second month after closing.
  - `paymentsMade(firstPayment, today) -> number`: the payment dates `firstPayment + k months` that are ≤ today.
  - `estimateBalance({ currentBalance, loanAmount, rate, termMonths, firstPaymentDate, closeDate, today }) -> { balance, basis } | null`.
    `basis` is one of:
    - `"current"`: currentBalance > 0, used as given.
    - `"estimated"`: loanAmount > 0, rate > 0, termMonths > 0 and a start date (firstPaymentDate, else from closeDate). The
      payments are capped at the term. Standard amortization, rounded to the dollar, never below 0.
    - `"original"`: loanAmount > 0.
    - Otherwise the result is `null`.
  - `mapLoanType({ termMonths, amortization }) -> { loanType, given, flag }`:
    - **ARM:** `/\barm\b|adjustable|variable|\b\d{1,2}\s*\/\s*\d{1,2}\b/i` gives `5_1_arm`. It is flagged when the first number
      of an `x/y` isn't 5.
    - **The term:** the term column, else a term read from the amortization text (`"30 Yr Fixed"`).
    - **Fixed:** term ≤ 180 → `15yr_fixed`; anything else, or no term, → `30yr_fixed`.
    - **`given`:** true when an ARM or a term was found, or the text says "fixed".
    - **`flag`:** `"<Y>-year fixed priced as a 15-year"` or `"…as a 30-year"` when the term isn't 180 or 360, with
      Y = round(term / 12). For an ARM: `"<x>/<y> ARM priced as a 5/1"`. Otherwise null.

- [ ] **Step 1: Write the failing tests** in `server/test/intake-loan.test.js`:

```js
test("firstPaymentFromClosing: 3/14 → 5/1, across a year end", () => {
  assert.equal(firstPaymentFromClosing("2024-03-14"), "2024-05-01");
  assert.equal(firstPaymentFromClosing("2024-11-30"), "2025-01-01");
  assert.equal(firstPaymentFromClosing("2024-12-05"), "2025-02-01");
  assert.equal(firstPaymentFromClosing(""), null);
});
test("paymentsMade counts the first payment once it is due", () => {
  assert.equal(paymentsMade("2024-05-01", "2026-11-01"), 31);
  assert.equal(paymentsMade("2024-05-01", "2026-10-31"), 30);
  assert.equal(paymentsMade("2024-05-01", "2024-04-30"), 0);
  assert.equal(paymentsMade("2024-05-15", "2024-06-14"), 1);
});
test("estimateBalance: current wins, then the schedule, then the original amount", () => {
  const base = { loanAmount: 400000, rate: 6.5, termMonths: 360, today: "2026-11-01" };
  assert.deepStrictEqual(estimateBalance({ ...base, currentBalance: 391002.5 }), { balance: 391002.5, basis: "current" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "2024-05-01" }), { balance: 387830, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "2024-05-01", today: "2026-10-31" }), { balance: 388255, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, closeDate: "2024-03-14" }), { balance: 387830, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "2026-12-01" }), { balance: 400000, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ ...base, firstPaymentDate: "1990-01-01" }), { balance: 0, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ loanAmount: 300000, rate: 5.875, termMonths: 180, firstPaymentDate: "2025-11-01", today: "2026-10-01" }), { balance: 287146, basis: "estimated" });
  assert.deepStrictEqual(estimateBalance({ loanAmount: 400000, rate: 6.5, today: "2026-11-01" }), { balance: 400000, basis: "original" });
  assert.equal(estimateBalance({ rate: 6.5, today: "2026-11-01" }), null);
});
test("mapLoanType maps term + amortization to the three priced types and flags what it rounds", () => {
  const t = (x) => mapLoanType(x);
  assert.deepStrictEqual(t({ amortization: "5/1 ARM" }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "ARM" }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "7/1 ARM" }), { loanType: "5_1_arm", given: true, flag: "7/1 ARM priced as a 5/1" });
  assert.deepStrictEqual(t({ amortization: "Adjustable", termMonths: 360 }), { loanType: "5_1_arm", given: true, flag: null });
  assert.deepStrictEqual(t({ termMonths: 180, amortization: "Fixed" }), { loanType: "15yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ termMonths: 120 }), { loanType: "15yr_fixed", given: true, flag: "10-year fixed priced as a 15-year" });
  assert.deepStrictEqual(t({ termMonths: 240 }), { loanType: "30yr_fixed", given: true, flag: "20-year fixed priced as a 30-year" });
  assert.deepStrictEqual(t({ termMonths: 300 }), { loanType: "30yr_fixed", given: true, flag: "25-year fixed priced as a 30-year" });
  assert.deepStrictEqual(t({ amortization: "30 Yr Fixed" }), { loanType: "30yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "15 Year Fixed" }), { loanType: "15yr_fixed", given: true, flag: null });
  assert.deepStrictEqual(t({ amortization: "Conventional" }), { loanType: "30yr_fixed", given: false, flag: null });
  assert.deepStrictEqual(t({}), { loanType: "30yr_fixed", given: false, flag: null });
});
```

- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/intake-loan.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `server/lib/intake/loan.js`.** Do the date math on UTC `Date`s. The balance after n payments is
  `P(1+r)^n − pmt·((1+r)^n − 1)/r`, where `r = rate/1200` and `pmt = P·r/(1 − (1+r)^−N)`.
- [ ] **Step 4: Run them and watch them pass.** Run: `node --test test/intake-loan.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/lib/intake/loan.js server/test/intake-loan.test.js && git commit -m "feat(intake): today's balance and loan type from the loan's terms"`

### Task 3: The whitelist and header mapping

**Files:**
- Create: `server/lib/intake/fields.js`
- Test: `server/test/intake-fields.test.js`

**Interfaces:**
- Consumes: `headerKey` and `isProtectedHeader` (Task 1).
- Produces:
  - **`FIELDS`:** an ordered `[{ id, label }]`, the whole whitelist, in this order: `borrowerName` "Borrower name",
    `firstName` "First name", `lastName` "Last name", `email` "Email", `phone` "Phone", `loanNumber` "Loan number",
    `noteRate` "Note rate", `currentBalance` "Current balance", `loanAmount` "Original loan amount", `term` "Loan term",
    `amortization` "Amortization / product", `propertyValue` "Property value", `appraisedValue` "Appraised value",
    `purchasePrice` "Purchase price", `closingDate` "Closing / funding date", `status` "Loan status", `purpose`
    "Loan purpose", `firstPaymentDate` "First payment date", `creditScore` "Credit score", `loanOfficer`
    "Loan officer (email or name)", `notes` "Notes".
  - **`detectMapping(headers: string[]) -> { [fieldId]: number }`:** every field id present, -1 when not found.
    - Matching is exact, on `headerKey`, against each field's synonym list in priority order, walking `FIELDS` in order.
    - A header is used at most once, and protected or blank headers are never used.
  - **`offeredHeaders(headers) -> [{ index, header }]`:** the non-blank, non-protected headers.
  - **`cleanMapping(mapping, headers) -> { [fieldId]: number }`:** the browser's mapping made safe.
    - Unknown ids are dropped, and any value that isn't the integer index of an offered header becomes -1.
    - An index claimed by two fields stays only on the first in `FIELDS` order.
  - **`readFields(row: any[], mapping) -> { [fieldId]: any }`:** only the mapped fields, as raw cell values. It never reads any
    other cell.
- **Synonyms** (the minimum; the builder may add more):
  - Generic: `name fullname clientname borrowername client` → borrowerName; `balance loanbalance remainingbalance
    outstandingbalance principal currentbalance unpaidprincipalbalance upb principalbalance` → currentBalance; `loanamount
    amount loanamt originalloanamount` → loanAmount. **"Loan Amount" is never the current balance.**
  - ARIVE (best guess, spec A2): the headers in the test below.
  - Calyx Point (best guess): the headers in the test below.

- [ ] **Step 1: Write the failing tests.** The guessed preset headers are fixtures here:

```js
const ARIVE = ["Loan Number", "Borrower First Name", "Borrower Last Name", "Borrower Email", "Borrower Cell Phone", "Note Rate", "Loan Amount", "Loan Term", "Amortization Type", "Appraised Value", "Purchase Price", "Funded Date", "Loan Status", "Loan Purpose", "First Payment Date", "Credit Score", "Loan Officer Email", "Borrower SSN"];
const CALYX = ["Loan #", "Borr First Name", "Borr Last Name", "Borr Email", "Borr Home Phone", "Interest Rate", "Loan Amt", "Term", "Amort Type", "Appraised Value", "Sales Price", "Closing Date", "Loan Status", "Purpose of Loan", "1st Pmt Date", "FICO", "Loan Officer", "Date of Birth"];
const GENERIC = ["Name", "Email", "Phone", "Rate", "Balance", "Property Value", "Loan Type", "Close Date", "Credit Score", "Notes"];
const pick = (m, ids) => Object.fromEntries(ids.map((id) => [id, m[id]]));

test("an ARIVE funded-loans export maps with no picks, and the SSN column is not used", () => {
  const m = detectMapping(ARIVE);
  assert.deepStrictEqual(pick(m, ["loanNumber","firstName","lastName","email","phone","noteRate","loanAmount","term","amortization","appraisedValue","purchasePrice","closingDate","status","purpose","firstPaymentDate","creditScore","loanOfficer"]),
    { loanNumber: 0, firstName: 1, lastName: 2, email: 3, phone: 4, noteRate: 5, loanAmount: 6, term: 7, amortization: 8, appraisedValue: 9, purchasePrice: 10, closingDate: 11, status: 12, purpose: 13, firstPaymentDate: 14, creditScore: 15, loanOfficer: 16 });
  assert.deepStrictEqual(pick(m, ["borrowerName","currentBalance","propertyValue","notes"]), { borrowerName: -1, currentBalance: -1, propertyValue: -1, notes: -1 });
  assert.ok(!Object.values(m).includes(17));
});
test("a Calyx Point export maps with no picks", () => {
  const m = detectMapping(CALYX);
  assert.deepStrictEqual(pick(m, ["loanNumber","firstName","lastName","email","phone","noteRate","loanAmount","term","amortization","appraisedValue","purchasePrice","closingDate","status","purpose","firstPaymentDate","creditScore","loanOfficer"]),
    { loanNumber: 0, firstName: 1, lastName: 2, email: 3, phone: 4, noteRate: 5, loanAmount: 6, term: 7, amortization: 8, appraisedValue: 9, purchasePrice: 10, closingDate: 11, status: 12, purpose: 13, firstPaymentDate: 14, creditScore: 15, loanOfficer: 16 });
});
test("a generic CRM file still maps as today; 'Loan Amount' is the original amount, never the balance", () => {
  assert.deepStrictEqual(pick(detectMapping(GENERIC), ["borrowerName","email","phone","noteRate","currentBalance","propertyValue","amortization","closingDate","creditScore","notes"]),
    { borrowerName: 0, email: 1, phone: 2, noteRate: 3, currentBalance: 4, propertyValue: 5, amortization: 6, closingDate: 7, creditScore: 8, notes: 9 });
  const m = detectMapping(["Name", "Loan Amount", "Rate"]);
  assert.equal(m.loanAmount, 1); assert.equal(m.currentBalance, -1);
});
test("a BOM on the first header, duplicate headers and blank headers", () => {
  assert.equal(detectMapping(["﻿Name", "Rate"]).borrowerName, 0);
  assert.equal(detectMapping(["Phone", "Phone"]).phone, 0);
  assert.deepStrictEqual(offeredHeaders(["Name", "", "  ", "Borrower SSN", "Rate"]), [{ index: 0, header: "Name" }, { index: 4, header: "Rate" }]);
});
test("cleanMapping refuses protected, out-of-range, non-integer and doubled picks", () => {
  const headers = ["Name", "Account Number", "Rate"];
  const m = cleanMapping({ borrowerName: 0, loanNumber: 1, noteRate: "2", email: 9, phone: 0, bogus: 2 }, headers);
  assert.equal(m.borrowerName, 0); assert.equal(m.loanNumber, -1); assert.equal(m.noteRate, -1);
  assert.equal(m.email, -1); assert.equal(m.phone, -1); assert.ok(!("bogus" in m));
  assert.deepStrictEqual(Object.keys(m).sort(), FIELDS.map((f) => f.id).sort());
});
test("readFields reads only mapped cells", () => {
  const out = readFields(["Ann Lee", "123-45-6789", "6.5"], { ...cleanMapping({}, ["a","b","c"]), borrowerName: 0, noteRate: 2 });
  assert.deepStrictEqual(out, { borrowerName: "Ann Lee", noteRate: "6.5" });
});
```

- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/intake-fields.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `server/lib/intake/fields.js`.**
- [ ] **Step 4: Run them and watch them pass.** Run: `node --test test/intake-fields.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/lib/intake/fields.js server/test/intake-fields.test.js && git commit -m "feat(intake): field whitelist and header presets for ARIVE, Calyx Point and CRM files"`

### Task 4: One record per row

**Files:**
- Create: `server/lib/intake/record.js`
- Test: `server/test/intake-record.test.js`

**Interfaces:**
- Consumes: Task 1 parsers, plus `estimateBalance` and `mapLoanType` (Task 2).
- Produces:
  - `toRecord(fields, { today, requireClosingDate }) -> { ok: true, record, flags: string[] } | { ok: false, code }`.
    `fields` is keyed by `FIELDS` ids, as from `readFields` or the webhook (Task 8).
  - `record = { name, email, phone, loanNumber, rate, balance, balanceBasis, propertyValue, loanType, loanTypeGiven, closeDate, creditScore, purpose, loanOfficer, notes }`:
    - `phone` is as given, trimmed, at most 40 characters.
    - `loanNumber` is `cleanText(…, 64)` uppercased, or `""`.
    - `closeDate` is `""` when absent.
    - `creditScore` is an integer from 300 to 850, else null.
    - `purpose` is `"purchase"` (/purchase/i), `"refinance"` (/refi/i) or `""`.
    - `loanOfficer` is cut to 254 characters, and `notes` to 2000.
  - **Checks, in this order:**
    - `no_name`;
    - `bad_rate` (missing, ≤ 0 or > 20);
    - `no_balance` (no estimate, or a balance ≤ 0);
    - `no_value` (the first > 0 of propertyValue, appraisedValue, purchasePrice);
    - then the closing date: `future_closing_date` whenever a present date is after today; when `requireClosingDate`, also
      `no_closing_date` (blank) and `bad_closing_date` (present but unreadable). Without `requireClosingDate`, an unreadable
      date reads as `""`.
  - **`flags`, in this order:**
    - `"balance estimated from the loan schedule"` (estimated), or
      `"balance = original loan amount (no rate/term/date to estimate from)"` (original);
    - then the loan-type flag, when there is one.
  - `REASONS`: `{ no_name: "no name", bad_rate: "no note rate between 0 and 20", no_balance: "no balance or loan amount", no_value: "no property value", no_closing_date: "not funded yet", bad_closing_date: "not funded yet", future_closing_date: "not funded yet" }`.

- [ ] **Step 1: Write the failing tests:**

```js
const TODAY = "2026-11-01";
const ROW = { firstName: "John", lastName: "Smith", email: "John@X.com", phone: "(555) 123-4567", loanNumber: "a100", noteRate: "6.500%", loanAmount: "$400,000", term: "360", amortization: "Fixed", appraisedValue: "520000", closingDate: "3/14/2024", purpose: "Refinance", creditScore: "742", loanOfficer: "lou@a.test", notes: " met at open house " };
test("a full row becomes a record with today's estimated balance", () => {
  const r = toRecord(ROW, { today: TODAY, requireClosingDate: true });
  assert.deepStrictEqual(r, { ok: true, flags: ["balance estimated from the loan schedule"], record: {
    name: "John Smith", email: "john@x.com", phone: "(555) 123-4567", loanNumber: "A100", rate: 6.5, balance: 387830, balanceBasis: "estimated",
    propertyValue: 520000, loanType: "30yr_fixed", loanTypeGiven: true, closeDate: "2024-03-14", creditScore: 742, purpose: "refinance",
    loanOfficer: "lou@a.test", notes: "met at open house" } });
});
test("a current balance wins; an amount with no term is the original amount, flagged", () => {
  assert.equal(toRecord({ ...ROW, currentBalance: "391,002.50" }, { today: TODAY }).record.balance, 391002.5);
  const o = toRecord({ ...ROW, term: "", amortization: "" }, { today: TODAY });
  assert.equal(o.record.balance, 400000); assert.equal(o.record.balanceBasis, "original"); assert.equal(o.record.loanTypeGiven, false);
  assert.deepStrictEqual(o.flags, ["balance = original loan amount (no rate/term/date to estimate from)"]);
});
test("a 20-year fixed is flagged after the balance flag; property value falls back to appraised, then purchase price", () => {
  assert.deepStrictEqual(toRecord({ ...ROW, term: "240" }, { today: TODAY }).flags, ["balance estimated from the loan schedule", "20-year fixed priced as a 30-year"]);
  assert.equal(toRecord({ ...ROW, appraisedValue: "N/A", purchasePrice: "500000" }, { today: TODAY }).record.propertyValue, 500000);
  assert.equal(toRecord({ ...ROW, propertyValue: "610000" }, { today: TODAY }).record.propertyValue, 610000);
});
test("each failure has its code, checked in order", () => {
  const code = (patch, opts = {}) => toRecord({ ...ROW, ...patch }, { today: TODAY, ...opts }).code;
  assert.equal(code({ firstName: "", lastName: "" }), "no_name");
  assert.equal(code({ noteRate: "N/A" }), "bad_rate");
  assert.equal(code({ noteRate: "25" }), "bad_rate");
  assert.equal(code({ loanAmount: "" }), "no_balance");
  assert.equal(code({ appraisedValue: "0" }), "no_value");
  assert.equal(code({ closingDate: "" }, { requireClosingDate: true }), "no_closing_date");
  assert.equal(code({ closingDate: "TBD" }, { requireClosingDate: true }), "bad_closing_date");
  assert.equal(code({ closingDate: "2026-11-02" }), "future_closing_date");
  assert.equal(toRecord({ ...ROW, closingDate: "2026-11-01" }, { today: TODAY, requireClosingDate: true }).ok, true);
  assert.equal(toRecord({ ...ROW, closingDate: "TBD" }, { today: TODAY }).record.closeDate, "");
});
test("'Smith, John', a bad credit score and an over-long note", () => {
  const r = toRecord({ ...ROW, firstName: undefined, lastName: undefined, borrowerName: "Smith, John", creditScore: "905", notes: "n".repeat(3000) }, { today: TODAY }).record;
  assert.equal(r.name, "John Smith"); assert.equal(r.creditScore, null); assert.equal(r.notes.length, 2000);
});
```

- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/intake-record.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `server/lib/intake/record.js`.**
- [ ] **Step 4: Run them and watch them pass.** Run: `node --test test/intake-record.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/lib/intake/record.js server/test/intake-record.test.js && git commit -m "feat(intake): validate and shape one imported loan"`

### Task 5: Schema, matching and owner routing

**Files:**
- Modify: `server/db.js` (the migrations block, after the `clients.last_contact` migration)
- Create: `server/lib/intake/match.js`, `server/lib/intake/owner.js`
- Test: `server/test/intake-match.test.js` (DB, using the `DATA_DIR` temp-dir header of `test/clients-api.test.js`)

**Interfaces:**
- **Migrations (idempotent, in the style already in `db.js`):**
  - `clients.loan_number TEXT NOT NULL DEFAULT ''`;
  - `clients.source TEXT NOT NULL DEFAULT 'manual'`;
  - `CREATE INDEX IF NOT EXISTS idx_clients_org_loan ON clients (org_id, loan_number)` (R2);
  - `CREATE TABLE IF NOT EXISTS integration_keys (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT)`.
- **`findMatch(db, orgId, record) -> { kind: "none" } | { kind: "one", client } | { kind: "ambiguous", count }`.**
  - `client` is the full `clients` row.
  - The steps run in A6's order, and the first step that finds any client decides:
    1. loan number (non-empty, equal);
    2. email (non-empty, case-insensitive);
    3. `nameKey` equal and `phoneDigits` equal (both non-empty);
    4. the name alone. Exactly one candidate, and it is bare (no email, phone or loan number) → one. Two or more with any one
       bare → ambiguous (R4).
  - Only `org_id = orgId` is ever searched. A name compares through `lower(trim(name))` against `nameKey(record.name)`.
- **`relation(client, record) -> "same" | "refinance" | "second_property" | "older"`:**
  - Both loan numbers equal, or both blank → `same`.
  - Exactly one blank → `same` when the closing dates are equal or either is missing; otherwise as "differ" (R3).
  - **Differ:**
    - the incoming closing date is the same or later, or either is missing → `refinance`, or `second_property` when
      `record.purpose === "purchase"`;
    - the incoming one is earlier → `older`.
- **`resolveOwner(db, actor, loanOfficer) -> { id, name, named, flag }`:**
  - `actor` is a `users` row with `id, org_id, role, first_name, last_name`. `name` is `"First Last"`, trimmed.
  - A loan officer actor → themselves, `named: true`, whatever `loanOfficer` says.
  - A broker with `""` → themselves, `named: false`, `flag: null`.
  - A value containing `@` → the org user with that email (case-insensitive). Otherwise → the org user whose full name
    matches it uniquely (case-insensitive, spaces collapsed). Either gives `named: true`.
  - No match, or a non-unique name → the broker, `named: false`,
    `flag: 'routed to your book: no loan officer in your company matches "<value>"'`.

- [ ] **Step 1: Write the failing tests.**
  - **Fixtures:**
    - org A: Ann Lee (broker), Lou Park (lo, lou@a.test), Lia Chen (lo, lia@a.test), and two users named Sam Lee;
    - org B: Bea (broker), with a client "John Smith" whose email is john@x.com.
    - `rec(patch)` builds a record with `name: "John Smith"` and blank email, phone and loan number; `addClient` takes
      `{ email, phone, loan_number, close_date }`.
  - **Tests:**
  - `"migrations add loan_number ('') and source ('manual'), the org/loan index and integration_keys"`: insert a client without
    the new columns and read back `loan_number === ""` and `source === "manual"`; `PRAGMA index_list(clients)` includes
    `idx_clients_org_loan`; `integration_keys` exists with the four columns.
  - `"findMatch: loan number, then email, then name + phone, then a bare name; never another org"`: one assertion per step:
    - loan_number "A100" → one;
    - `rec({ email: "JOHN@X.COM" })` finds org A's john@x.com and never org B's;
    - stored "John Smith", phone "(555) 123-4567" matches `rec({ phone: "5551234567" })`;
    - a bare "Mary Jones" matches `rec({ name: "mary  jones" })`;
    - a "Mary Jones" with a phone does not match by name alone (→ none).
  - `"findMatch: two at the first step that finds any is ambiguous; two same-name clients with one bare is ambiguous"`:
    - two clients with loan_number "B200" → `{ kind: "ambiguous", count: 2 }`;
    - two "Pat Kim" (one bare, one with an email) and a nameless record → `{ kind: "ambiguous", count: 2 }`.
  - `"relation: same, refinance, second property, older, and the one-sided loan number rule"`, each with literal close dates:
    - A100 vs A100 → same; both blank → same;
    - stored blank, close 2021-05-01 vs incoming B1 2021-05-01 → same;
    - stored blank 2021-05-01 vs B1 2024-02-01 → refinance;
    - A100 2021 vs B1 2024 → refinance; the same with purpose purchase → second_property;
    - A100 2024 vs B1 2021 → older;
    - A100 2021 vs B1 with no close date → refinance.
  - `"resolveOwner: email, unique full name, fallback with a flag, other org, LO actor"`:
    - `""` → `{ id: ann, name: "Ann Lee", named: false, flag: null }`;
    - `"LOU@A.TEST"` → lou, named;
    - `"lia  chen"` → lia, named;
    - `"Nobody"` → ann, `named: false`, `flag: 'routed to your book: no loan officer in your company matches "Nobody"'`;
    - Bea's email → ann, unnamed;
    - `"Sam Lee"` → ann, unnamed;
    - Lou as actor with `"lia@a.test"` → lou, named.
- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/intake-match.test.js`. Expected: FAIL (module not
  found / no such column).
- [ ] **Step 3: Add the migrations to `server/db.js`, then implement `match.js` and `owner.js`.**
- [ ] **Step 4: Run them, then the whole server suite.** Run: `node --test test/intake-match.test.js && npm test`. Expected:
  PASS, and the existing 1066 still pass.
- [ ] **Step 5: Commit.**
  `git add server/db.js server/lib/intake/match.js server/lib/intake/owner.js server/test/intake-match.test.js && git commit -m "feat(intake): loan number/source columns, integration keys, org-wide matching and loan officer routing"`

### Task 6: `ingest()`: the shared write, with the A6a move

**Files:**
- Create: `server/lib/intake/ingest.js`
- Test: `server/test/intake-ingest.test.js` (DB)

**Interfaces:**
- Consumes:
  - `toRecord` and `REASONS` (Task 4);
  - `findMatch`, `relation` and `resolveOwner` (Task 5);
  - `followups.resolveForClient(db, userId, clientId, "expired", nowUtc)` from `lib/assistant/followups.js`, called as
    `followups.x()`.
- **Produces:** `ingest(db, { actor, source, items, today, nowUtc, requireClosingDate, dryRun }) -> { results, counts, reviewHash }`.
  - **Inputs:** `source` is `"import"` or `"arive"`. `items` is `[{ row: number, fields, skip?: string }]`, where `skip` is a
    reason the front door already decided (e.g. `"not funded"`).
  - **`Result`:** `{ row, outcome, name, reason, note, flags, owner, movedFrom }`.
    - `outcome` is one of `created | updated | unchanged | ambiguous | skipped`.
    - `reason` is set for skipped (`REASONS[code]` or the item's `skip`) and for ambiguous (`"matched N clients"`).
    - `note` is `"older loan"`, `"second property"` or null. `flags` are the record's flags plus the owner flag.
    - `owner` is `{ id, name }` of the book the row ends in, for created/updated/unchanged; null otherwise.
    - `movedFrom` is the old owner's name, or null.
    - Results come back sorted by `row`.
  - **`counts`:** `{ created, updated, unchanged, ambiguous, skipped, moved, byOwner: [{ id, name, rows }] }`. `byOwner` is
    sorted by name.
  - **`reviewHash`:** the SHA-256 hex of `JSON.stringify(results.map(r => [r.row, r.outcome, r.reason, r.note, r.owner && r.owner.id, r.movedFrom]))`.
- **Algorithm:**
  - One `db.transaction`. Valid records are processed oldest closing date first (blank first; ties by row), so a refinance
    listed beside its original ends up on the client. With `dryRun`, throw a private sentinel at the end of the transaction to
    roll back, and return what was built.
  - **No match →** INSERT with:
    - `org_id = actor.org_id`, `user_id = owner.id`, `source`, `loan_number`, `credit_score ?? 700`;
    - the notes (new clients only);
    - `last_contact` left NULL (A9).
  - **`second_property` →** INSERT the same way.
  - **`older` →** `unchanged` with note `"older loan"`.
  - **`same` / `refinance` → an UPDATE**, with each column written only when it changes:
    - **Loan fields:**
      - always `current_rate` and `property_value`;
      - `loan_type` only when `loanTypeGiven` (R5);
      - `close_date` only when the record has one;
      - `credit_score` only when it isn't null;
      - `loan_number` only when non-empty.
    - **The balance**, only when `balanceBasis === "current"`, or the relation is `refinance`, or the rate differs, or both
      closing dates are present and differ.
    - **Contact details:** `email` and `phone` only where the client's are blank.
    - **The A6a move:** when `owner.named`, `owner.id !== client.user_id` and the relation is same or refinance, also set
      `user_id`. Then:
      - close the old owner's open rows for the client;
      - insert `notifications (org_id, from_user = actor.id, to_user = old owner, client_id, message)`, unless the old owner
        is `actor.id`. The message is exactly
        `` `${client.name} moved to ${owner.name}'s book: their new loan came in under ${owner first name}.` ``;
      - count the row in `moved`.
    - **Nothing to write** and no move → `unchanged`. Otherwise `updated`, with `updated_at = datetime('now')`. Compare
      numbers with a 1e-9 tolerance.
  - **Never written:** `name`, `notes` and `last_contact` on a match; `contact_log`; any other recommendations.

- [ ] **Step 1: Write the failing tests.**
  - **Fixtures:**
    - org A: Ann Lee (broker), Lou Park (lo, lou@a.test), Lia Chen (lo, lia@a.test).
    - `run(items, opts)` calls `ingest` with `actor` = Ann's row, `source: "import"`, `today: "2026-11-01"`,
      `nowUtc: "2026-11-01 15:00:00"`, `requireClosingDate: true`, `dryRun: false`.
    - `item(row, patch)` builds `{ row, fields: { ...ROW, ...patch } }`. Copy `ROW` from `server/test/intake-record.test.js`:
      John Smith, john@x.com, loan A100, 6.5%, $400,000 over 360 months, closing 3/14/2024, `loanOfficer: "lou@a.test"`.
    - Unless a test says otherwise, a seeded "John Smith" client has ROW's email, so the rows match it.
  - **Tests:**
  - `"a new loan creates a client in the routed book, with source, loan number and notes, and no last contact"`: the row with
    `loanOfficer: "lou@a.test"` → created in Lou's book with `loan_number "A100"`, `source "import"`, `notes`,
    `last_contact === null` and `loan_balance 387830`; `counts.byOwner` is `[{ id: lou, name: "Lou Park", rows: 1 }]`.
  - `"the same file again is all unchanged and writes nothing"`: snapshot every `clients` row and `updated_at`, run again →
    every outcome is unchanged and the rows are deep-equal to the snapshot.
  - `"a refinance replaces the loan, keeps the client, and never touches name, notes, last contact or the call log"`:
    - seed a client with loan A100 2021-05-01 at 3.0%, notes "VIP", last_contact "2026-09-01" and one contact_log row;
    - item B200, close 2026-03-02, 6.25%, purpose Refinance;
    - → updated: same id; rate 6.25, loan_number "B200", close_date "2026-03-02", the balance re-estimated; notes, name,
      last_contact and the contact_log row unchanged.
  - `"the same loan: an estimate never overwrites a stored balance; a current balance does"`:
    - client A100 with balance 380000 and the row's rate and close date; the row without currentBalance → unchanged, balance
      still 380000;
    - with `currentBalance: "379,500"` → updated to 379500.
  - `"email and phone are filled only where blank; loan type is kept when the row gives none"`:
    - a client with an email "old@x.com", no phone, 15yr_fixed, loan A100;
    - the row with email "new@x.com", phone, no term or amortization → email still old@x.com, phone filled, loan_type still
      15yr_fixed.
  - `"an older loan is unchanged with the note; a purchase with a different loan number is a second client"`:
    - seed John Smith with loan A100, close 2024-03-14;
    - item A050, close 2019-01-01 → `{ outcome: "unchanged", note: "older loan" }`;
    - item C300, close 2026-04-01, purpose Purchase → created with note "second property", two clients named John Smith.
  - `"a refinance listed beside its original in one file: one client, holding the newer loan"`:
    - row 2: B200, 2024-02-01, 6.0%; row 3: A100, 2020-01-01, 3.0%; same email;
    - → one client with B200 and 6.0%; results by row: row 2 updated, row 3 created.
  - `"the same loan listed twice in one export: one client, the second row unchanged"` (Review Focus 5): two identical items →
    created + unchanged, one client.
  - `"ambiguous rows write nothing; front-door skips and record failures are skipped with their reason"`:
    - two clients with ROW's email and no loan number → `{ outcome: "ambiguous", reason: "matched 2 clients" }`;
    - `skip: "not funded"` → skipped with "not funded";
    - noteRate "N/A" → skipped "no note rate between 0 and 20";
    - closingDate "" → skipped "not funded yet".
  - `"a dry run returns exactly what the real run does, with the same reviewHash, and writes nothing"`:
    - counts of `clients`, `notifications` and `charlie_recommendations` are unchanged after the dry run;
    - a real run gives deep-equal results and an equal hash.
  - `"A6a: a refinance under a different named loan officer moves the client, closes the old owner's open follow-ups and tells them in-app"`:
    - **Seed:** a client in Lia's book, plus for Lia an open briefing rec and an open carry, a reached rec, and a contact_log
      row by Lia.
    - **Run:** a refinance row with `loanOfficer: "lou@a.test"`.
    - **Expect:**
      - `user_id = lou`; `outcome: "updated"`, `movedFrom: "Lia Chen"`, `counts.moved === 1`;
      - both of Lia's open rows are `expired` with `resolved_at "2026-11-01 15:00:00"`; the reached rec is untouched;
      - the contact_log row still has `user_id = lia`;
      - one notification with `from_user = ann`, `to_user = lia` and message exactly
        `"John Smith moved to Lou Park's book: their new loan came in under Lou."`.
  - `"A6a: no move on a fallback, an older loan, or a second property; a same-loan reassignment moves; no notice to the actor"`:
    - a row with no `loanOfficer` → stays with Lia;
    - an older loan naming Lou → stays;
    - a purchase naming Lou → a new client for Lou, the original stays with Lia;
    - the same loan A100 naming Lou → moves (updated);
    - a client in Ann's book with a row naming Lou → moves, and no notification row.
  - `"A6a: an LO actor (their own key) takes their refinance over from another LO"`: `actor` = Lou, `source: "arive"`, the row
    naming nobody → moved from Lia, and a notification from Lou to Lia.
- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/intake-ingest.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `server/lib/intake/ingest.js`.**
- [ ] **Step 4: Run them, then the suite.** Run: `node --test test/intake-ingest.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/lib/intake/ingest.js server/test/intake-ingest.test.js && git commit -m "feat(intake): ingest() with dry-run review, no duplicates, and a client moving to the LO on their new loan"`

### Task 7: The file import routes

**Files:**
- Modify: `server/routes/import.js` (replace the body; keep the file)
- Test: `server/test/import-api.test.js` (DB; the real router behind a signed `rr_token` cookie, as in `clients-api.test.js`)

**Interfaces:**
- Consumes: `detectMapping`, `offeredHeaders`, `cleanMapping`, `readFields` and `FIELDS` (Task 3); `ingest` (Task 6).
- **Produces:** `router.use(requireAuth, requireBroker)` (R1), and three routes. `/review` and `/confirm` each use
  `express.json({ limit: "20mb" })`, as `/confirm` does today, because the file's base64 rides in the body.
  - **`POST /api/import/preview`:** multipart `file`. Detects the mapping and answers a `Review`.
  - **`POST /api/import/review`:** JSON `{ fileData, mimetype, mapping, fundedStatuses }`. `cleanMapping`, then a `Review`.
  - **`POST /api/import/confirm`:** JSON `{ fileData, mimetype, mapping, fundedStatuses, reviewHash }`.
    - It runs `ingest(..., dryRun: false)` inside its own check: if the hash differs, it rolls back and answers 409
      `{ success: false, error: "Something changed since the review. Check it again.", review }`.
    - Otherwise: `200 { success: true, results, counts }`.
- **`Review`:** `{ success: true, fields: FIELDS, headers: offeredHeaders, mapping, statuses, everyRowFunded, totalRows, results, counts, reviewHash, fileData, mimetype }`.
  - **`statuses`:** null when status isn't mapped. Otherwise `[{ value, label, count, funded }]`, in first-seen order:
    - `value` is the lowercased, trimmed status, and `label` its first spelling, or `"(blank)"`.
    - `funded` is true when `value` is in `fundedStatuses`, or, when that's omitted, when it matches
      `/funded|closed|completed|purchased/`.
    - A row whose status isn't funded becomes an item with `skip: "not funded"`.
  - **`requireClosingDate`** is `mapping.closingDate >= 0`.
  - **`everyRowFunded`** is true when neither status nor closingDate is mapped.
- **Parsing (R8):** `XLSX.read(buffer, { type: "buffer", raw: true })` for CSV; workbooks by signature. Rows are the first sheet,
  `sheet_to_json(ws, { header: 1, defval: "" })`, with blank rows dropped. `row` numbers are file line numbers (header = 1).
- **Errors (each `{ success: false, error }`):**
  - an empty file → 400 `"File appears to be empty"`;
  - more than 5000 data rows → 400 `"This file has more than 5,000 rows. Split it and import each part."`;
  - multer `LIMIT_FILE_SIZE` → 400 `"The file is over 10 MB."`;
  - a parse failure → 400 `"Could not read that file. Save it as .csv or .xlsx and try again."` (never echo `err.message`);
  - a database error → 500 `"Import failed"`, logging `err.name` only.

- [ ] **Step 1: Write the failing tests.**
  - **Fixtures:**
    - users: Ann Lee (broker), Lou Park (lo, lou@a.test), Lia Chen (lo);
    - `ARIVE_CSV` uses the `ARIVE` header list from `server/test/intake-fields.test.js`, and holds three complete loans for
      three different borrowers with different emails:
      - row 2: funded, John Smith, SSN "123-45-6789";
      - row 3: status "In Process";
      - row 4: funded, loan number "000123".
  - **Tests:**
  - `"a loan officer cannot use the import routes"`: Lou → 403 on all three.
  - `"preview of an ARIVE export: detected mapping, statuses with defaults, a review, nothing written"`:
    - mapping.loanNumber is 0, and offered headers exclude "Borrower SSN";
    - statuses are `[{ value: "funded", label: "Funded", count: 2, funded: true }, { value: "in process", label: "In Process", count: 1, funded: false }]`;
    - row 3 is `{ outcome: "skipped", reason: "not funded" }`; counts.created 2; `everyRowFunded: false`; the clients count
      is still 0.
  - `"the SSN never comes back and is never stored"`:
    - `JSON.stringify({ ...data, fileData: undefined })` does not include "123-45-6789";
    - after confirm, `JSON.stringify(db.prepare("SELECT * FROM clients").all())` does not include it.
  - `"review re-runs with the broker's picks and ticked statuses"`:
    - ticking "in process" via `fundedStatuses: ["funded", "in process"]` makes row 3 created;
    - `mapping` with status -1 and closingDate -1 → `everyRowFunded: true` and `statuses: null`.
  - `"confirm writes what the review showed; the same confirm again is all unchanged"`: equal counts; then the second confirm
    gives counts.unchanged 2.
  - `"confirm answers 409 with a fresh review when something changed, and writes nothing"`: preview, add a matching client by
    hand, confirm with the old hash → 409 with `review.reviewHash !== old`, and the clients count is the hand-added one only.
  - `"a CSV keeps a loan number's leading zeros; an .xlsx with serial dates and fraction rates reads the same"`:
    - row 4 stores `loan_number "000123"`;
    - an .xlsx built in the test with `XLSX.utils.aoa_to_sheet` (date cell 45365, rate 0.065) previews with
      `closeDate 2024-03-14` and rate 6.5.
  - `"limits: empty, over 5,000 rows, over 10 MB, unreadable"`: each exact 400 message above.
- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/import-api.test.js`. Expected: FAIL (old routes, no
  `/review`, no 403).
- [ ] **Step 3: Rewrite `server/routes/import.js`.** Keep the header comment style of `routes/profile.js`, listing the three
  routes and their answers.
- [ ] **Step 4: Run them, then the suite.** Run: `node --test test/import-api.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/routes/import.js server/test/import-api.test.js && git commit -m "feat(import): review-before-import with column picks, funded statuses and no duplicates"`

### Task 8: The webhook and its key

**Files:**
- Create: `server/routes/integrations.js`
- Modify: `server/index.js` (require it; mount `app.use("/api/integrations", integrationRoutes)` **above**
  `app.use(express.json({ limit: "20mb" }))`, R9)
- Test: `server/test/integrations-api.test.js` (DB)

**Interfaces:**
- Consumes: `toRecord`/`REASONS` (Task 4), `ingest` (Task 6), `integration_keys` (Task 5), `APP_URL` from `email.js`. Requiring
  only that constant is fine; nothing here sends mail.
- **Produces:** `createIntegrationsRouter({ limiter = {} } = {})`, built like `createGoogleRouter`. The default export is
  `createIntegrationsRouter()`.
- **Key routes** (`requireAuth`, any role, `Cache-Control: no-store`):
  - **`GET /key`** → `{ success, connected, createdAt, lastUsedAt, webhookUrl }`. `webhookUrl` is
    `` `${APP_URL}/api/integrations/loans` ``.
  - **`POST /key`** makes a new key (replacing any old one) → `{ success, key, webhookUrl, createdAt }`. The key is
    `"br_" + crypto.randomBytes(32).toString("hex")`, stored as the SHA-256 hex only.
  - **`DELETE /key`** → `{ success: true, connected: false }`.
- **`POST /loans`:**
  - **Auth:** `Authorization: Bearer <key>`, with the key matching `/^br_[0-9a-f]{64}$/` and its hash in the table. Anything
    else is 401 `{ error: "Unauthorized" }`. A cookie is never read here.
  - **Then:** `last_used_at = nowUtc`, and a rate limit of 60 a minute keyed `key:${userId}`. Over it: 429
    `{ error: "Too many requests: at most 60 a minute" }`.
  - **Body:** `express.json({ limit: "32kb" })`. Over the limit → 413 `{ error: "The body is over 32 KB" }`. A parse failure
    or a non-object body → 400 `{ error: "The body must be a JSON object" }`.
  - **Body → fields:**
    - names: `loan_id`→loanNumber, `borrower_name`→borrowerName, `borrower_first_name`→firstName,
      `borrower_last_name`→lastName, `email`, `phone`;
    - loan: `note_rate`→noteRate, `current_balance`→currentBalance, `loan_amount`→loanAmount, `term_months`→term,
      `amortization_type`→amortization, `first_payment_date`→firstPaymentDate;
    - values: `property_value`, `appraised_value`, `purchase_price` (camelCase ids);
    - `closing_date ?? funding_date`→closingDate, `credit_score`→creditScore, `loan_officer_email`→loanOfficer,
      `loan_purpose`→purpose.
    - Only a string or a number is copied; `""` counts as absent. Every other key is ignored.
  - **Order of answers:**
    1. `loan_id` missing → 400 `"loan_id is required"`; longer than 64 → 400 `"loan_id is too long"`.
    2. `status` matching `/denied|withdrawn|cancel|adverse|archiv/i` → 200 `{ result: "ignored", reason: "status is not funded" }`.
    3. `toRecord(fields, { today, requireClosingDate: true })` failures:
       - `no_name` → 400 `"borrower_name (or borrower_first_name and borrower_last_name) is required"`;
       - `bad_rate` → 400 `"note_rate is missing or not between 0 and 20"`;
       - `no_balance` → 400 `"current_balance or loan_amount is required"`;
       - `no_value` → 400 `"property_value, appraised_value or purchase_price is required"`;
       - `bad_closing_date` → 400 `"closing_date is not a date"`;
       - `no_closing_date` → 200 `{ result: "ignored", reason: "no closing date" }`;
       - `future_closing_date` → 200 `{ result: "ignored", reason: "closing date is in the future" }`.
    4. Otherwise `ingest(db, { actor: key user, source: "arive", items: [{ row: 1, fields }], today, nowUtc, requireClosingDate: true, dryRun: false })`
       → 200 `{ result: outcome }`. A moved row adds `moved_from`. An ambiguous row answers `{ result: "ambiguous" }`.
  - **No answer ever echoes a value.** Errors log `err.name` only.

- [ ] **Step 1: Write the failing tests.**
  - **Setup:** mount `createIntegrationsRouter({ limiter: { max: 3 } })` at `/api/integrations` **before**
    `app.use(express.json({ limit: "20mb" }))` in the test app.
  - **Fixtures:**
    - org A: Ann Lee (broker), Lou Park (lo, lou@a.test), Lia Chen (lo, lia@a.test); org B: Bea (broker);
    - `BODY` is a full funded loan for John Smith (`loan_id "L1"`, closing_date "2026-03-02"), with `ssn: "123-45-6789"`
      and `dob: "1980-01-01"` added;
    - `post(key, body)` posts to `/api/integrations/loans`.
  - **Tests:**
  - `"key lifecycle: connect, use, regenerate, disconnect"`:
    - GET → `connected: false`, and webhookUrl ends `/api/integrations/loans`;
    - POST → key matches `/^br_[0-9a-f]{64}$/`; the DB `key_hash` equals `sha256(key)`, and no column holds the key itself;
    - a webhook call → GET shows `lastUsedAt` set;
    - POST again → the old key 401, the new one 200;
    - DELETE → 401, and GET `connected: false`.
  - `"401 for no header, a non-Bearer header, a malformed or unknown key, and a cookie alone"`: each answers
    `{ error: "Unauthorized" }`.
  - `"a broker's key routes by loan_officer_email; an LO's key always fills their own book"`.
  - `"created, then unchanged on replay, updated on a rate change, ambiguous on two matches"`.
  - `"A6a over the webhook: moved_from names the old loan officer"`: `{ result: "updated", moved_from: "Lia Chen" }`.
  - `"ignored: no closing date, a future one, a dead status"`: each exact reason above.
  - `"400s name the field and never echo the value"`:
    - each exact message above;
    - for `note_rate: "abc123"`, the response text does not include "abc123".
  - `"empty strings are absent and numbers may come as strings"` (Review Focus 4):
    - `current_balance: ""`, `note_rate: "6.5"`, `loan_amount: "400000"`, `term_months: "360"` → created, with an estimated
      balance (not 0);
    - `current_balance: 0` alone → 400 `"current_balance or loan_amount is required"`.
  - `"unknown fields are never stored"`: no `clients` column contains "123-45-6789" or "1980-01-01".
  - `"bodies: over 32 KB is 413; an array or bad JSON is 400"`.
  - `"over 60 a minute is 429, counted per key"`: with `max: 3`, the 4th call → 429, and another user's key → 200.
  - `"the payload is never logged"`: wrap `console.log`, `console.error` and `console.warn` during a created call, a 400 and a
    forced DB error (swap `db.prepare` to throw once). None of the captured text includes "John Smith", "123-45-6789" or
    "L1".
  - `"index.js mounts /api/integrations before the app-wide JSON parser"`: read `server/index.js` as text. The index of
    `app.use("/api/integrations"` must be less than the index of `app.use(express.json(`.
- [ ] **Step 2: Run them and watch them fail.** Run: `node --test test/integrations-api.test.js`. Expected: FAIL (module not
  found).
- [ ] **Step 3: Implement `server/routes/integrations.js` and mount it in `server/index.js` (R9).**
- [ ] **Step 4: Run them, then the suite.** Run: `node --test test/integrations-api.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add server/routes/integrations.js server/index.js server/test/integrations-api.test.js && git commit -m "feat(integrations): ARIVE-via-Zapier webhook with a per-user key"`

### Task 9: The Import page module

**Files:**
- Create: `client/src/import/importer.mjs`, `client/src/import/importer.test.mjs`, `client/src/import/ImportView.jsx`
- Modify:
  - `client/src/App.jsx`: delete `ImportClients` (lines ~1746–1903) and import `ImportView`. Render it for `view === "import"`
    with `ui={{ C, card, mono, Icon, $c }}`, `onImported` (re-fetches `/api/clients` into `setClients`, as today) and
    `onDone={() => setView("clients")}`.
  - `client/package.json`: add `src/import/` to the `test` script.

**Interfaces:**
- Consumes: the Task 7 routes and their `Review` shape.
- **Produces, in `importer.mjs`.** Every server call takes an injected `fetchFn` and resolves to `{ ok: true, data }` or
  `{ ok: false, error }`:
  - **The calls:**
    - `uploadFile(fetchFn, file)` posts multipart to `/api/import/preview`;
    - `reviewAgain(fetchFn, review, { mapping, fundedStatuses })`;
    - `confirmImport(fetchFn, review)` sends `fileData, mimetype, mapping, fundedStatuses, reviewHash`. A 409 resolves to
      `{ ok: false, changed: true, error, review }`.
  - **Errors:**
    - network → `"Couldn't reach the server. Check your connection and try again."`;
    - 403 → `"Only a broker can import clients."`;
    - otherwise the server's `error`, else `"That didn't work. Try again."`.
  - **`fundedStatusesOf(statuses) -> string[] | null`:** the ticked values.
  - **`outcomeText(result) -> string`:**
    - `"New"`, or `"New (second property)"`;
    - `"Updated"`, or `"Updated: moves from Lia Chen to Lou Park"` (uses `movedFrom` and `owner.name`);
    - `"Unchanged"`, or `"Older loan: unchanged"`;
    - `"Ambiguous: matched 2 clients, skipped"`; `"Skipped: not funded yet"`.
  - **`summaryText(counts) -> string`:** `"3 new · 1 updated · 2 unchanged · 1 skipped"`, adding `" · 1 moved"` when moved > 0.
    Ambiguous rows count in skipped (R11).
  - **`pageOf(items, page, size = 50) -> { items, page, pages }`:** page clamped to `1..pages`, and `pages ≥ 1`.
- **`ImportView.jsx`** (the layout is the builder's; these are fixed):
  - **Steps:** upload → review → import → result.
  - **Mapping:** a dropdown per `FIELDS` entry, offering `headers` plus `"— not in this file —"` (-1). Changing one calls
    `reviewAgain`.
  - **Statuses:** a "counts as funded" checkbox per status. Changing one calls `reviewAgain`.
  - **The `everyRowFunded` banner text:** `"Every row is treated as a funded loan: no loan status or closing date column is picked."`
  - **Summary:** `summaryText`, plus one line per `byOwner` entry ("Lou Park: 12").
  - **Rows:** 50 a page, showing `outcomeText`, the name and the flags.
  - **The "Import" button** is disabled while busy or when `created + updated === 0`.
  - **On 409:** show the error and swap in the fresh review.
  - **The result screen:** `summaryText`, plus "Go to All Clients" (`onDone`).
  - **Upload hint:** "Exports from ARIVE and Calyx Point are recognised; for any other file, pick the columns on the next step."
  - **data-testids:** `import-drop`, `import-summary`, `import-banner`, `import-confirm`, `import-row`.

- [ ] **Step 1: Write the failing tests** in `client/src/import/importer.test.mjs`, using a `fakeServer` like
  `profile/profile.test.mjs`'s:
  - `"uploadFile posts the file as multipart and returns the review"`;
  - `"reviewAgain sends the mapping and ticked statuses with the file data"`: assert the exact JSON body keys;
  - `"confirmImport: 200 → ok; 409 → changed with the fresh review; 403 → the broker-only message; a network throw → the connection message"`;
  - `"outcomeText for every outcome and note"`: each exact string above;
  - `"summaryText counts ambiguous as skipped and shows moved only when > 0"`;
  - `"pageOf clamps and pages by 50"`: 120 items → 3 pages; page 9 → page 3 with 20 items; an empty list → page 1 of 1.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd client && node --test src/import/`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `importer.mjs` and `ImportView.jsx`; swap them into `App.jsx`; update `package.json`.**
- [ ] **Step 4: Run them, then the client suite and a build.** Run: `node --test src/import/ && npm test && npm run build`.
  Expected: PASS, and the build succeeds.
- [ ] **Step 5: Commit.**
  `git add client/src/import client/src/App.jsx client/package.json && git commit -m "feat(import): review page with column picks, funded statuses and paged rows"`

### Task 10: The Connections card on Profile

**Files:**
- Modify: `client/src/profile/profile.mjs`, `client/src/profile/profile.test.mjs`, `client/src/profile/ProfileView.jsx` (render
  it after `NmlsCard`, outside the `profile &&` gate, like `CalendarCard`)
- Create: `client/src/profile/ConnectionsCard.jsx`

**Interfaces:**
- Consumes: the Task 8 key routes.
- **Produces, in `profile.mjs`** (each takes `fetchFn` and resolves to `{ ok: true, data }` or `{ ok: false, error }`, through
  the file's existing `answer()` helper):
  - `loadConnection(fetchFn)` (GET `/api/integrations/key`);
  - `connectArive(fetchFn)` (POST): used for both Connect and Regenerate;
  - `disconnectArive(fetchFn)` (DELETE).
- **`ConnectionsCard({ ui, isBroker })`** (the layout is the builder's; the copy is fixed):
  - **Title and hint:** "Connections". Hint: "Send funded loans from ARIVE straight into Broker Radar through Zapier."
  - **Not connected:** a "Connect ARIVE" button.
  - **Just connected or regenerated:**
    - the webhook URL and the key, each with a Copy button (`navigator.clipboard.writeText`);
    - the line "Copy your key now. It won't be shown again."
  - **Connected:** the webhook URL, "Connected" plus the last used time (or "Not used yet"), and "Regenerate" and "Disconnect"
    buttons.
    - Regenerate confirms first: "Make a new key? The old one stops working right away, so update your Zap."
    - Disconnect confirms first: "Disconnect ARIVE? Your Zap will stop adding loans."
  - **The setup guide** (a numbered list, always shown):
    1. Ask ARIVE for its Zapier invite. The ARIVE app on Zapier is invite-only and needs ARIVE Pro or above.
    2. In Zapier, make a Zap that starts with ARIVE, "Loan Status Updated".
    3. Add a Filter step: only continue when the status is your company's funded status.
    4. Add a "Webhooks by Zapier" action: POST, payload type JSON, to the URL above, with a header named Authorization whose
       value is Bearer, a space, then your key.
    5. Map ARIVE's fields to the names below.
    6. Test the step. Zapier shows Broker Radar's answer: created, updated, unchanged, ambiguous or ignored.
  - **The field list:**
    - loan_id (required);
    - borrower_name, or borrower_first_name and borrower_last_name (required);
    - email; phone;
    - note_rate (required);
    - current_balance; loan_amount; term_months; amortization_type; first_payment_date;
    - property_value, appraised_value or purchase_price (one required);
    - closing_date or funding_date (required);
    - credit_score; loan_officer_email; loan_purpose; status.
  - **Routing line:**
    - for a broker: "Each loan goes to the loan officer whose email is in loan_officer_email. Anything else comes to your
      book. Bring in your existing book first with Import Clients: the Zap only sends loans that change from now on."
    - for a loan officer: "Loans you send go into your own book."
  - **data-testids:** `connections-card`, `connections-connect`, `connections-key`.

- [ ] **Step 1: Write the failing tests** in `profile.test.mjs`:
  - `"loadConnection reads the key status"`;
  - `"connectArive returns the new key once"`: the data has `key` and `webhookUrl`;
  - `"disconnectArive deletes the key"`;
  - `"connection calls map a 401 to the session-ended message and a network throw to the no-server message"`: reuse the file's
    existing constants.
- [ ] **Step 2: Run them and watch them fail.** Run: `cd client && node --test src/profile/`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement the three calls, `ConnectionsCard.jsx`, and the `ProfileView` slot** (pass
  `isBroker={user && user.role === "broker"}`).
- [ ] **Step 4: Run them, then the client suite and a build.** Run: `node --test src/profile/ && npm test && npm run build`.
  Expected: PASS, and the build succeeds.
- [ ] **Step 5: Commit.**
  `git add client/src/profile && git commit -m "feat(profile): Connections card with the ARIVE key and Zapier setup guide"`

### Task 11: The live check in the preview (controller, no new code)

- [ ] **Step 1:** Run the full suites: `cd server && npm test` and `cd client && npm test`. Expected: all pass. Record both
  counts in the ledger.
- [ ] **Step 2:** Write a sample file with fake borrowers, `scratchpad/arive_sample.csv`, with the Task 3 ARIVE headers and
  8 rows:
  - 5 funded;
  - 1 "In Process";
  - 1 refinance of another row;
  - 1 naming an unknown loan officer.
- [ ] **Step 3:** `preview_start` `broker-radar-api` and `broker-radar-client`, and open `http://localhost:5173`.
  - If the pane isn't signed in, stop. Bill, I need you to sign in to the preview pane as a broker. Claude never types
    passwords.
- [ ] **Step 4:** Import the sample. Check:
  - the summary;
  - the "In Process" row skipped, and passing once its box is ticked;
  - the refinance landing on one client;
  - the unknown loan officer flagged;
  - then Import, and the clients list.
- [ ] **Step 5:** On Profile, Connect ARIVE.
  - Send one recorded Zapier-style request with curl to `http://localhost:8080/api/integrations/loans`, using that key and a
    fake loan. Expect `{"result":"created"}`.
  - Disconnect afterwards.
- [ ] **Step 6:** Screenshot the review, the result and the Connections card, and send them to Bill with SendUserFile.
