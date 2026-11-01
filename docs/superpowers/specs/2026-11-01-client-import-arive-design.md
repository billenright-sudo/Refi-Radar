# Getting a broker's book in: a smarter file import, and a live ARIVE feed through Zapier

Date: 2026-11-01. Owner: Bill. Status: APPROVED by Bill 2026-11-01.
Repo: `C:\Users\bille\dev\refi-radar`, base branch `feature/accurate-refi-scoring` @ f64f860.

## 1. Intent: why we're building this

Broker Radar is only as good as the book inside it. Sweeps, Charlie's call list and the follow-ups all run on the client records,
and today those records get in through a basic spreadsheet upload that guesses columns and gets several things wrong:

- it treats the **original loan amount as today's balance**, so every LTV, payment and savings figure for an older loan is
  overstated;
- it only knows three loan types and silently calls everything else a 30-year;
- it **duplicates** a client every time a file is imported again;
- it has no way to fix a wrong column guess, and no way to put a loan officer's clients in that loan officer's book;
- nothing arrives on its own: a loan that funds in the broker's LOS never shows up unless someone re-exports and re-imports.

This feature makes getting the book in a one-time, five-minute job, and keeps it current after that:
1. a file import that understands real LOS exports (ARIVE and Calyx Point first), estimates today's balance, updates
   existing clients instead of duplicating them, and shows every decision before anything is saved;
2. a live feed from ARIVE: when a loan funds, it lands in Broker Radar as a client within a minute, via Zapier.

Success: a broker with an ARIVE account can export their funded loans, import them cleanly the first time, connect the Zap,
and from then on every funded loan appears in Broker Radar with no re-import.

## 2. What Bill decided

- **2026-10-30 ("go with your gut" on the import roadmap):** in order, (1) the importer upgrade, meaning ARIVE/Calyx report
  presets, an amortized current balance, and a MISMO 3.4 / FNM batch import with a field whitelist (never store SSN, date of
  birth or income); (2) an ARIVE live feed via a Zapier webhook (the broker needs ARIVE Pro, Zapier Premium and an ARIVE
  invite); (3) the Encompass partner program only when a bigger shop asks; (4) Optimal Blue / Loansifter pricing belongs to
  rate alerts v2, not to clients.
- **2026-11-01:** "just draft the design". Everything below that is not in the list above is **my call**, marked "(my call)",
  for Bill to accept or change while reading.
- **2026-11-01, after reading the draft:** "move them to Lou, approved". A client moves to the loan officer on their new loan
  (A6a), and the design is approved as written.

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. A broker can import an ARIVE or Calyx Point export with no manual column work, and any other CSV/Excel file with a few
  dropdown picks.
- G2. Every imported balance is today's estimate, not the original loan amount, whenever the file gives enough to work it out.
- G3. Importing the same loans again updates them; it never duplicates a client.
- G4. A broker's file or Zap can carry the whole company's loans, and each loan lands in its loan officer's book.
- G5. A funded loan in ARIVE reaches Broker Radar on its own once the Zap is on.
- G6. The broker sees, before saving, exactly what will be created, updated or skipped, and why.

**Non-goals (this round)**
- **MISMO 3.4 / FNM batch import: moved to the next round (my call).** A report export covers a whole book in one file, while
  FNM/MISMO is one file per loan and carries the full application (SSN, income, assets). The file import's dropdowns make any
  report work. The whitelist rule stands for when we do it.
- Encompass, LendingPad, Calyx Path or any other live feed. The webhook in Part B is written so another LOS's Zap can use it,
  but only ARIVE gets a setup guide.
- New loan programs or lenses (FHA/VA/jumbo, MI, streamline). That is the separate "loan program / MI fields" item; the import
  does not add fields the engine can't use.
- A Charlie briefing line about new arrivals ("2 new clients came in from ARIVE"). It is a natural next step and is listed in
  section 9.
- Two-way sync. Nothing is ever written back to ARIVE.

**Anti-goals (a failure even if it works)**
- A1. **Importing never contacts anyone.** No email, text or calendar event is ever sent or made because a client was imported
  or arrived from ARIVE.
- A2. **No borrower data beyond the whitelist is stored**, whatever the file or the Zap sends: never SSN, date of birth, income,
  assets, employer, credit report details or account numbers.
- A3. **An import never overwrites the broker's own work**: notes, last contact, the contact log, Charlie's follow-ups and
  carries stay as they are.
- A4. **A loan still in process never becomes a client.** Only funded/closed loans do; a pipeline loan's rate isn't final.
- A5. **No figure is made up.** A balance the file can't support is labelled as the original amount, never quietly treated as
  current.

## 4. Part A: the file import

### A1. Who imports, and where

- As today, the Import Clients page is a broker's page (nav.mjs shows it to brokers only).
- **(My call)** The page becomes its own module, like `client/src/profile/`, instead of growing inside `App.jsx`.
- The steps are: upload → review (mapping + row-by-row outcome) → import → result.

### A2. Columns: presets, then the broker's own picks

- Auto-detect stays, with header synonyms extended for **ARIVE** and **Calyx Point** report exports, and kept for generic CRM
  files.
- **The review step gets a dropdown per Broker Radar field** listing the file's headers, so the broker can fix any wrong guess
  or pick a column the guess missed. Changing a dropdown re-runs the review.
- **(My call)** We have no real ARIVE or Calyx export to read headers from: ARIVE's help center is behind a login. The presets
  are best guesses until Bill gets a sample (section 8); the dropdowns are the safety net.

**The Broker Radar fields a column can fill (the whitelist; nothing else is ever read):**

| Field | Notes |
|---|---|
| Borrower name, or first + last name | Two columns are joined "First Last". Required. |
| Email, phone | Optional. |
| Loan number | Optional; the matching key in A6. |
| Note rate | Required. "6.5", "6.500%" and "0.065" all read as 6.5. |
| Current / unpaid principal balance | Optional; wins over the estimate. |
| Original loan amount | Used for the estimate in A3. |
| Loan term (months or years) | 360, "30", "30 yr" … |
| Amortization type / product | "Fixed", "ARM", "5/1 ARM", "30 Yr Fixed" … |
| Property value, appraised value, or purchase price | Property value first, then appraised, then purchase price. Required. |
| Closing / funding date | Normalised to YYYY-MM-DD, including Excel serial dates. |
| Loan status | Optional; decides which rows count as funded (A5). |
| Loan purpose | Optional; "purchase" vs "refinance" (A6). |
| First payment date | Optional; used by the estimate. |
| Credit score | Optional; defaults to 700 as today. |
| Loan officer (email or name) | Optional; routing in A7. |
| Notes | New clients only (see A6). |

Headers that look like protected data (SSN, social, DOB, birth, income, salary, assets, employer, account) are never offered
in a dropdown and never read.

### A3. Today's balance

In order:
1. **A current/unpaid balance column with a number:** use it.
2. **Else, original amount + note rate + term + a start date:** amortize to today on the standard schedule.
   - The start date is the first payment date. Failing that, it is the first day of the second month after closing (closing
     3/14 → first payment 5/1).
   - The months paid are the whole months from the first payment date to today, inclusive of the first payment once it is
     due.
   - The result is rounded to the dollar and never below zero.
3. **Else, the original amount as is**, and the review row says "balance = original loan amount (no rate/term/date to estimate
   from)".

The estimate assumes no extra payments, so it can only run high. **(My call)** It is worked out once, at import, and stored in
`loan_balance`. It is not recomputed monthly; a re-import refreshes it.

### A4. Loan type

Term plus amortization map to the three types the engine prices:
- **ARM** (any "ARM", "5/1", "7/1", "10/1", "variable"): `5_1_arm`.
- **Fixed, term ≤ 15 years:** `15yr_fixed`.
- **Fixed, term > 15 years, or no term:** `30yr_fixed`.

A 10-, 20- or 25-year fixed, or a 7/1 or 10/1 ARM, is flagged in the review ("20-year fixed priced as a 30-year"). That is the
engine's limit today, made visible instead of silent (my call).

### A5. What makes a row importable

- **Required:** a name, a note rate between 0 and 20, a balance (from A3) above 0, and a property value above 0.
- **Skipped**, with its reason, when any of those is missing.
- **Funded only** (anti-goal A4; my call):
  - **Status column mapped:** the review lists the file's distinct status values, each with a "counts as funded" checkbox.
    Values containing funded, closed, completed or purchased are ticked to start with; rows with an unticked status are
    skipped as "not funded".
  - **Closing date column mapped:** a row with a blank or future closing date is skipped as "not funded yet". A pipeline
    report with past *estimated* closing dates is the case the status checkboxes exist for.
  - **Neither mapped** (a plain CRM list of past clients): every row is treated as a funded loan, and the review says so in a
    banner above the rows.
- **Row limit:** at most 5,000 rows and 10 MB per file (my call; the 10 MB is today's limit).

### A6. Matching existing clients (no duplicates)

**Where it looks (my call):** the whole organisation, not just the book the row is routed to (A7). A refinance often funds
under a different loan officer than the one who has the client. Matching only one book would make a second client and leave
the old-rate one being pitched a refi they already did. Who keeps a matched client: **A6a** (Bill's decision).

**How it matches**, in this order:
1. **Same loan number** (when both have one).
2. **Same email** (case-insensitive, when both have one).
3. **Same name and same phone digits.**
4. **Same name alone (my call)**, only when exactly one client in the organisation has that name and that client has no email,
   phone or loan number. That catches clients the old importer brought in bare, without guessing between two.

**When more than one client matches** at the first step that finds any, nothing is updated. The row is "ambiguous: skipped",
showing how many clients it matched, so the broker can fix it by hand (my call).

**Is it the same loan, a refinance, or another property? (my call)**
- **Same loan number**, or neither side has one: the same loan, so its fields are refreshed.
- **Loan numbers differ:**
  - the incoming closing date is the same or later: a **refinance**, and the client's loan is replaced. That is right because
    the client now has the new loan. If the row says its purpose is a purchase, it is instead a **second property**, which
    becomes a new client named the same.
  - the incoming loan is older than the one Broker Radar holds: **"older loan: unchanged"**, and nothing is written.

**What an update writes:**
- **Loan fields:** rate, property value, loan type, closing date, credit score (when given) and loan number.
- **The balance only when** the row gives a real current balance, or the loan itself changed (a refinance, or a different
  rate or closing date). An *estimated* balance never overwrites a stored one for the same loan. That keeps an exact or
  hand-corrected balance safe, and makes a replayed Zap "unchanged" in any month (my call).
- **Email and phone** are filled in only where the client has none.
- **Never touched:** name, notes, last contact, the contact log, Charlie's recommendations and carries.
- A match where nothing would change is "unchanged".

**Rows that don't match** create a client.

**Repeats within one file:** two rows that match each other (a refinance listed beside the old loan) are handled oldest first,
so the newer loan ends up on the client.

### A6a. A new loan under a different loan officer (Bill, 2026-11-01)

The client belongs to the loan officer on their current loan. When a matched row names a loan officer other than the one who
has the client, the client **moves to the named loan officer**:
- **"Names a loan officer"** means the row was routed to a user by A7 (the loan officer column's email or full name) or by B2
  (an LO's own key, or the `loan_officer_email` a broker's key sends). A row that fell back to the importing broker's own book
  never moves anyone (my call): otherwise a file with no loan officer column would pull every matched client into the
  broker's book.
- **When:** the same loan (the LOS reassigned it) or a refinance. Never for "older loan: unchanged" (that loan isn't their
  current one), "ambiguous" or skipped rows. A second property is a new client in the named loan officer's book, and the
  original stays where it is.
- **What goes with them:** the client record, with its notes. The call history follows on its own, because it is read by
  client, and each call still shows who made it.
- **The old loan officer's open follow-ups** for that client (Charlie's open recommendations and carries) are closed as
  expired. The new loan officer starts with none.
- **Who is told:**
  - the review row says "moves from Ann Lee to Lou Park", and the summary counts the moves;
  - the webhook's answer adds `moved_from` with the old loan officer's name;
  - the old loan officer gets an in-app notification: "<client> moved to Lou Park's book: their new loan came in under Lou."
    (my call). It is in-app only, never an email, and skipped when the old loan officer is the user who ran the import or
    owns the key.
- **Outcome:** a move is a change, so a same-loan row that would otherwise be "unchanged" is "updated" (my call).

### A7. Which book a row goes into

- With no loan officer column, every row goes into the importing broker's own book, as today.
- With one, a row goes into the book of the user **in the broker's own organisation** whose email matches. Failing that, it
  goes to the user whose full name matches exactly once.
- No match, or a match outside the organisation, goes to the broker's own book, and the review row says so.

### A8. The review step (before anything is saved)

- **Summary counts:** new, updated, unchanged, skipped, moved (A6a), and how many rows are going to each loan officer.
- **The rows** with their outcome and flags (balance estimated / original amount, loan type mapped, routed to the broker), with
  skip reasons. A long file is shown a page at a time; every row is reviewable, not just the first 5 as today.
- **Nothing is written until "Import"**, and the import applies exactly what the review showed. The file is re-checked on
  confirm the way it is today, so a change in between can't sneak in.
- **The result** repeats the counts.

### A9. Not changed

- The file is never stored on the server, as today.
- Imports set no "last contact". The check-in cadence already falls back to the closing date (lib/refi.js).

## 5. Part B: the live ARIVE feed (via Zapier)

### B1. How it works

```
ARIVE (loan status updated) → Zapier filter (status is Funded) → Webhooks by Zapier: POST → Broker Radar → client created/updated
```

Broker Radar exposes one webhook. The broker's Zap maps ARIVE's fields onto Broker Radar's field names inside Zapier, so we
never depend on ARIVE's internal field names, which we can't see. Another LOS's Zap could use the same webhook later.

**What the broker needs (from the 10/30 research):**
- ARIVE Pro or above;
- ARIVE's Zapier invite: the ARIVE connection is invite-only;
- a Zapier plan that includes Webhooks by Zapier (a premium app).

A company-level ARIVE connection sends every loan; a user-level one sends only that user's loans.

### B2. The connection key

- **A new "Connections" section on the Profile page:**
  - "Connect ARIVE" shows the webhook URL and a key (shown once; copy buttons for both), plus a short setup guide with the
    field list.
  - "Regenerate" replaces the key, and the old one stops working at once. "Disconnect" removes it.
  - Profile is where both brokers and loan officers can reach it (my call: the Import page is broker-only).
- **One key per user.** It is stored only as a SHA-256 hash, and its last-used time is shown.
- **A loan officer's key** puts loans in their own book only.
- **A broker's key** routes by the loan officer email the Zap sends, exactly as in A7.

### B3. The webhook

`POST /api/integrations/loans`, header `Authorization: Bearer <key>`, JSON body of at most 32 KB. Every field is optional
except as noted:

| Field | Meaning |
|---|---|
| `loan_id` | **Required.** The LOS loan number/ID; the matching key. |
| `borrower_name`, or `borrower_first_name` + `borrower_last_name` | **Required**, one form or the other. |
| `email`, `phone` | |
| `note_rate` | **Required.** |
| `current_balance`, `loan_amount`, `term_months`, `amortization_type`, `first_payment_date` | For A3/A4. |
| `property_value`, `appraised_value`, `purchase_price` | At least one **required**. |
| `closing_date` (or `funding_date`) | **Required**; must not be in the future. |
| `credit_score`, `loan_officer_email`, `loan_purpose` | |
| `status` | Optional. A dead status (denied, withdrawn, cancelled, adverse, archived) is "ignored"; anything else still needs the closing date. The Zap's filter is the funded gate; the date is the backstop (my call). |

It is the same whitelist, validation, balance estimate, loan-type mapping, matching (A6) and routing (A7) as the file import:
**one shared module, two front doors** (my call). Unknown fields are ignored and never stored.

**Answers** (shown in Zapier's task history, so the broker can see what happened):
- `200 { result: "created" | "updated" | "unchanged" | "ambiguous" }`; "ambiguous" means it matched several clients, so
  nothing was written. An "updated" that moved the client (A6a) adds `moved_from` with the old loan officer's name.
- `200 { result: "ignored", reason }` when the loan isn't funded: no closing date, or one in the future. Status isn't trusted
  alone, because ARIVE's status names vary by company.
- `400 { error }` naming the missing or invalid field, never echoing the value.
- `401` with no detail for a missing, wrong or revoked key.
- `429` over 60 requests a minute per key.

**Safety:**
- **The payload is never logged:** only the result and an error's name, the same rule as the briefing's logs.
- The webhook doesn't use the app's cookie sign-in; the key is its only way in.
- A replayed or repeated Zap run is harmless, because the matching makes it "unchanged".

### B4. Setup guide (on the Connections section)

Numbered steps for the broker:
1. Request ARIVE's Zapier invite.
2. Make a Zap: trigger ARIVE "Loan Status Updated".
3. Add a filter: status = your company's funded status.
4. Add the action: Webhooks by Zapier, POST, JSON, to the URL, with the header `Authorization: Bearer <key>`.
5. Map ARIVE's fields to the names in the B3 table.
6. Test, and check the result in Zapier.

Plus "Bring in your existing book first with Import Clients", for brokers, since the Zap only sends loans that change from now
on.

## 6. Data changes

- **`clients`, new columns:**
  - `loan_number TEXT NOT NULL DEFAULT ''`;
  - `source TEXT NOT NULL DEFAULT 'manual'`, one of `manual`, `import` or `arive`, set when the client is created and never
    changed.
  - An index on `(user_id, loan_number)` speeds up matching. It is not unique, because older rows have none.
- **New table `integration_keys`:** `user_id` (primary key), `key_hash`, `created_at`, `last_used_at`.
- **Migrations** are idempotent, like the existing ones in `db.js`.

## 7. Review focus: inputs a real broker will hit

1. A file with a refinance and the original loan for the same borrower: one client, holding the newer loan.
2. A file re-imported a week later with a few new rows: new rows created, the rest unchanged, and no one's notes or last
   contact touched.
3. Dates as Excel serials, "3/14/2024", "2024-03-14" and blanks; rates as "6.5", "6.500%" and "0.065".
4. A broker's company file whose loan officer column has emails for two LOs, one unknown: three books, with the unknown routed
   to the broker and flagged.
5. A Zap that fires on every status change of one loan: one "created" when it funds, then "unchanged" or "updated"; nothing
   before it funds.
6. A file with SSN and income columns: never offered, never read, never stored.
7. Ann has the Smiths, and Lou's file row or Lou's Zap brings their refinance: the Smiths move to Lou with their notes and call
   history, Ann's open follow-ups for them are closed, and she gets an in-app note. A broker's file with no loan officer
   column moves nobody.

## 8. What Bill needs to do (when we get there)

Bill, I need you to get two things from a broker who uses ARIVE (or your own account if you have one):
1. A **funded-loans report export** (CSV or Excel) with fake or blanked borrower names. Its headers make the ARIVE preset
   exact.
2. Later, for the live check, an ARIVE account with **Pro + the Zapier invite**, and a Zapier plan with Webhooks.

Neither blocks the build: the dropdowns cover a wrong preset, and the webhook is tested with recorded Zapier-style requests.
Calyx Point: the same ask, one report export, if a Calyx broker is handy.

## 9. Left to the builder, and what comes next

**Left to the builder:**
- the module layout;
- the review step's paging;
- the exact synonym lists;
- how the import UI module is split out of `App.jsx`;
- the setup guide's wording (plain and short, in the house style);
- test structure.

**Rollout:** built on a branch with tests, sample data only. No deploy without Bill's go (Bill runs `gcloud run deploy`).

**Next, after this ships:**
- Charlie's briefing mentions new arrivals;
- MISMO 3.4 / FNM batch import with the whitelist;
- the loan program / MI fields;
- a monthly balance refresh.

## 10. Decided after the draft

**Who keeps a client when a new loan for them comes in under a different loan officer?** Bill, 2026-11-01: they move to the
loan officer on the new loan, as set out in A6a. The borrower's current relationship is with whoever did their latest loan,
and that's who should get the next refi call.
