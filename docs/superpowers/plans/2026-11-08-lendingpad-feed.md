# LendingPad Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can connect LendingPad (as well as ARIVE) on the Connections card; a LendingPad Zap's funded loans land through the same
webhook, labelled `lendingpad`; the webhook accepts a loan officer's name and says when a loan fell back to the broker's book; the file
import recognises a LendingPad export.

**Architecture:** The key row carries its LOS (`integration_keys.los`). The webhook reads it at sign-in and hands it to the shared
`ingest()` as the `source`. Everything else (rules, matching, routing, answers) is the ARIVE feed's, unchanged. The card's per-LOS copy
moves into a pure, tested module (`connections.mjs`); the card renders it.

**Tech Stack:** Node 20 (`C:/Users/bille/dev/node20`), Express, better-sqlite3, `node --test`; React 18 + Vite, inline styles.

**Spec:** `docs/superpowers/specs/2026-11-08-lendingpad-feed-design.md` (APPROVED 2026-11-08). It builds on
`docs/superpowers/specs/2026-11-01-client-import-arive-design.md`. Read both.

## Global Constraints

- Worktree `C:\Users\bille\dev\refi-radar-lendingpad`, branch `feature/lendingpad`. No merge, push or deploy: each needs Bill's own go.
- Before Task 1, run `npm ci` in `server/` and in `client/`. The worktree has no `node_modules`.
- Never open, read or print `server/.env` or any `.env*` file. No new dependencies. Sample data only. No email, no paid API call, no network
  beyond the local test server.
- The LOS values are exactly `arive` and `lendingpad`. The labels are exactly `ARIVE` and `LendingPad`. The webhook URL stays
  `POST /api/integrations/loans`.
- The ARIVE design's anti-goals A1–A5 hold. Importing never contacts anyone, only `BODY_FIELDS` keys are read, an import never overwrites
  the broker's own work, a loan still in process never becomes a client, and no figure is made up.
- An existing ARIVE connection keeps working unchanged (G5): same key, same answers, and its clients stay `arive`.
- Do not restyle the Connections card. The LOS choice uses the card's existing `button()` helper and tokens.
- Keep the files' comment style: prose header comments that say what the code does. Update any comment that says "the ARIVE feed" where
  the code now serves both LOSes.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Done means `npm test` in `server/` and `client/` both pass with 0 failures, and `npm run build` in `client/` succeeds.

## Rulings made while planning (the spec leaves these open)

- **R1. Answer of `POST /api/integrations/key`** gains `los`: `{ success, key, webhookUrl, createdAt, los }`. The card shows the server's
  word, not its own guess.
- **R2. Which `los` values count as missing:** an absent `los`, `los: null`, or no JSON body at all. Anything else that isn't exactly
  `arive` or `lendingpad` is a 400: `""`, `"ARIVE"`, `7`, `true`, `["arive"]`. The answer is
  `{ success: false, error: "los must be arive or lendingpad" }`, and the old key is untouched. A body that isn't JSON is a 400
  `{ success: false, error: "The body must be a JSON object" }`.
- **R3. The key routes need their own JSON parser.** `POST /key` uses `express.json({ limit: "1kb" })`, because the router is mounted above
  the app-wide parser (R9 in the ARIVE design).
- **R4. `routed_to_you` quotes the loan officer value the Zap sent.** That is the one exception to "no answer echoes a value from the body".
  It goes back only to the key's owner, who sent it, and it isn't borrower data. Update the route's header comment to say so.
- **R5. The no-LOS fallback** in the client copy is ARIVE. Only a not-connected answer has `los: null`, and then the card uses the user's
  pick.
- **R6. Client error wording no longer names ARIVE:** "Couldn't check your connection. Try again." and "Couldn't disconnect. Try again."
- **R7. The LendingPad header fixture** (Task 3) is a best guess, as the ARIVE and Calyx ones are. It includes the trap column
  "Est. Closing Date", which must never be mapped.

## Review Focus

The spec's §9, plus the inputs most likely to hurt a real broker. Each one has a test in the task named.

1. **A funded LendingPad loan edited five times.** It is created once, then answered unchanged four times, and the notes a person wrote
   are untouched. (Task 2)
2. **A Zap with no Filter step.** Pipeline loans with no funded date are ignored, and so is one with a future date; no client is made.
   The guide's step 5 says plainly to never map the estimated closing date. (Task 2, Task 4)
3. **A broker's Zap sending loan officer names, one of them unknown.** Two loans go to their loan officers by name. The third goes to the
   broker, and the answer carries `routed_to_you`. A matched loan, or a loan officer's own key, never gets `routed_to_you`. (Task 2)
4. **An existing ARIVE connection after the deploy.** An old-schema key row reads `los = 'arive'` and keeps its hash. Its Zap's answers
   are unchanged, and its clients are still `arive`. A Regenerate with no `los` never turns a LendingPad user into an ARIVE one.
   (Task 1, Task 2)
5. **A LendingPad loan officer's refinance for another loan officer's client.** It is skipped, and the in-app note says "LendingPad feed".
   (Task 2)

---

### Task 1: The key carries its LOS

**Files:**
- Modify: `server/db.js` (the `integration_keys` block, about lines 102-110)
- Modify: `server/routes/integrations.js` (the header comment, `GET /key`, `POST /key`)
- Modify: `server/test/integrations-api.test.js`
- Create: `server/test/integration-keys-los-migration.test.js`

**Interfaces:**
- Produces: column `integration_keys.los TEXT NOT NULL DEFAULT 'arive'`.
- Produces: `GET /api/integrations/key` → `{ success, connected, createdAt, lastUsedAt, webhookUrl, los }`, where `los` is
  `"arive" | "lendingpad" | null` (null when not connected).
- Produces: `POST /api/integrations/key`, body `{ los? }` → `{ success, key, webhookUrl, createdAt, los }` (R1, R2).
- Produces: `const LOSES = Object.freeze(["arive", "lendingpad"])` in `integrations.js`, used again in Task 2.

- [ ] **Step 1: Write the failing migration test** in `server/test/integration-keys-los-migration.test.js`. Follow the subprocess
  pattern in `server/test/invite-hash-migration.test.js`: copy its old `organizations` and `users` schema, and add the current
  `integration_keys` CREATE (4 columns, no `los`) with one key row for user 1, hash `"cd".repeat(32)`. Load `db.js` twice. Test
  `"start-up gives an old key los 'arive' and keeps its hash, and running again changes nothing"` asserts:
  - the `los` column is in `PRAGMA table_info(integration_keys)`, with `notnull` 1 and `dflt_value` `"'arive'"`;
  - the row reads `{ user_id: 1, key_hash: "cd".repeat(32), los: "arive" }` after the first load and after the second;
  - the second load doesn't throw.

- [ ] **Step 2: Write the failing route tests** in `integrations-api.test.js`:
  - `"GET /key answers los: null before connecting, the key's LOS after"`: before → `los === null`. After a
    `POST {los:"lendingpad"}` → `los === "lendingpad"`.
  - `"POST /key stores the LOS it is given; with none it keeps the current one, or means arive"`:
    - with no key yet, `POST` with no body → `data.los === "arive"`, and the row's `los` is `arive`;
    - then `POST {los:"lendingpad"}` → `"lendingpad"`;
    - then `POST` with no body (a Regenerate from an old page) → still `"lendingpad"`, with a new `key_hash`;
    - then `POST {los:null}` → still `"lendingpad"`;
    - then `DELETE`, then `POST {los:"arive"}` → `"arive"` (switching is Disconnect, then Connect).
  - `"POST /key with any other los is a 400 and the old key keeps working"`. For each of `"calyx"`, `""`, `"ARIVE"`, `7`, `true`,
    `["arive"]`, the answer is `[400, { success: false, error: "los must be arive or lendingpad" }]`, and the row is unchanged
    (same `key_hash` and `los`). A body of `"{"` with `content-type: application/json` is
    `[400, { success: false, error: "The body must be a JSON object" }]`.
  - Extend the `as(userId)` helper so it can send a JSON body. Keep its existing calls working.

- [ ] **Step 3: Run the new tests and see them fail**

  Run: `cd server && node --test test/integration-keys-los-migration.test.js test/integrations-api.test.js`

  Expected: FAIL. There is no `los` column, and `los` is undefined in the answers.

- [ ] **Step 4: Implement it.**
  - In `db.js`, after the `CREATE TABLE IF NOT EXISTS integration_keys`, add the idempotent `PRAGMA table_info` check and
    `ALTER TABLE integration_keys ADD COLUMN los TEXT NOT NULL DEFAULT 'arive'`, as the other migrations do. Update the block's comment.
  - In `integrations.js`:
    - `GET /key` selects `los` and answers it.
    - `POST /key` gets `express.json({ limit: "1kb" })`, with a parse error answered as R2.
    - It reads the user's current `los`, works out the one to store (R2), and adds `los = excluded.los` to the upsert.
    - It answers R1.
    - Update the header comment's key-route lines.

- [ ] **Step 5: Run the server suite and see it pass**

  Run: `cd server && npm test`

  Expected: all pass, 0 fail. The existing lifecycle test still passes unchanged.

- [ ] **Step 6: Commit.** `feat(integrations): the key carries its LOS (arive | lendingpad)`

### Task 2: The webhook labels LendingPad, takes a loan officer's name, and says when a loan came to your book

**Files:**
- Modify: `server/lib/intake/ingest.js` (`SOURCES`, the `via` line in the loan-officer-key branch, the header comment)
- Modify: `server/lib/intake/owner.js` (export `ROUTED_PREFIX`)
- Modify: `server/routes/integrations.js` (`BODY_FIELDS`, `authenticate`, the `/loans` handler, the header comment)
- Modify: `server/test/intake-ingest.test.js`, `server/test/integrations-api.test.js`

**Interfaces:**
- Consumes: `integration_keys.los` and `LOSES` from Task 1.
- Produces: `SOURCES = ["import", "arive", "lendingpad"]` in `ingest.js`. Its feed labels are `{ arive: "ARIVE feed", lendingpad: "LendingPad feed" }`,
  and `import` keeps the word "import".
- Produces: `ROUTED_PREFIX = "routed to your book: "` exported from `owner.js`. The flag's text is unchanged.
- Produces: the body field `loan_officer` → `loanOfficer`. It wins over `loan_officer_email`, and a blank one leaves
  `loan_officer_email` in charge.
- Produces: a created answer `{ result: "created", routed_to_you: "no loan officer in your company matches \"<value>\"" }`, sent only
  when the created row carries the routing flag.

- [ ] **Step 1: Write the failing ingest tests** in `intake-ingest.test.js`:
  - `"the lendingpad source is recorded on a new client"`: `run([item(2)], { source: "lendingpad" })` → the client's `source` is
    `"lendingpad"`.
  - `"an unknown source is refused"`: `source: "calyx"` throws a `TypeError`.
  - `"a LendingPad loan officer's refinance for another loan officer's client is skipped, and the note says LendingPad feed"`
    (Review 5). Use the existing Bill 11/3 test's setup with `{ actor: userRow(lou), source: "lendingpad" }`. Assert the skip reason is
    the same as in that test. The one notification's message is exactly
    `"Lou Park's LendingPad feed sent a newer loan for John Smith (closed 2026-03-02). Nothing was changed, and John Smith stays in your book."`

- [ ] **Step 2: Write the failing webhook tests** in `integrations-api.test.js`. Give `giveKey` an optional second argument
  `los = "arive"`, written into the row.
  - `"a LendingPad key's clients are lendingpad; a key made before LendingPad still makes arive clients"`.
  - `"Review 1: a funded LendingPad loan sent five times is created once, then unchanged, and its notes are untouched"`. After the first
    `{ result: "created" }`, set the client's `notes` to `"Called 11/8, wants numbers"` with SQL. Then four more sends each answer
    exactly `{ result: "unchanged" }`. Assert the client count is 1, `notes` is unchanged, and `source` is `"lendingpad"`.
  - `"Review 2: with no Filter step, pipeline loans are ignored"`. Use a LendingPad key with `without(BODY, "closing_date")` and
    `status` each of `"Processing"`, `"Submitted"` and `"Approved"`. Each answers
    `[200, { result: "ignored", reason: "no closing date" }]`. A `closing_date` of `"2999-01-01"` answers
    `{ result: "ignored", reason: "closing date is in the future" }`. No client is made.
  - In Review 3 and the next test, each loan has its own `loan_id`, `borrower_name` and `email`, so none of them match each other.
  - `"Review 3: loan officers by name; an unknown one comes to the broker with routed_to_you"`. Ann's LendingPad key sends three loans:
    - `loan_officer: "Lou Park"` answers `{ result: "created" }` and goes to Lou;
    - `"Lia Chen"` answers `{ result: "created" }` and goes to Lia;
    - `"Sam Green"` answers `{ result: "created", routed_to_you: "no loan officer in your company matches \"Sam Green\"" }` and goes
      to Ann.
  - `"loan_officer wins over loan_officer_email, and a blank one leaves the email in charge"`:
    - `{ loan_officer: "Lia Chen", loan_officer_email: "lou@a.test" }` goes to Lia;
    - `{ loan_officer: "", loan_officer_email: "lou@a.test" }` (another loan) goes to Lou.
  - `"routed_to_you is only for a created client"`:
    - Create L1 for Lou by name. Replay the same body with `loan_officer: "Sam Green"`. The answer is exactly `{ result: "unchanged" }`,
      and the client stays with Lou.
    - Lou's own key sending `loan_officer: "Sam Green"` answers exactly `{ result: "created" }`, in Lou's book.
  - Update the existing `"a broker's key routes by loan_officer_email…"` test. L2 now expects
    `{ result: "created", routed_to_you: "no loan officer in your company matches \"nobody@a.test\"" }`, and L3 expects the same with
    `"bea@b.test"`.

- [ ] **Step 3: Run them and see them fail**

  Run: `cd server && node --test test/intake-ingest.test.js test/integrations-api.test.js`

  Expected: FAIL. `source must be one of import, arive` for `lendingpad`, and `routed_to_you` is missing.

- [ ] **Step 4: Implement it.**
  - In `ingest.js`, add `lendingpad` to `SOURCES`, and replace the two-way `via` with a label for each source.
  - In `owner.js`, build the flag from `ROUTED_PREFIX` and export it.
  - In `integrations.js`:
    - add `loan_officer: "loanOfficer"` to `BODY_FIELDS` so it wins;
    - have `authenticate` select `k.los` into `req.keyLos`;
    - have `/loans` pass `source: req.keyLos`;
    - add `routed_to_you` (the flag minus `ROUTED_PREFIX`) to a created answer;
    - update the header comment (R4, the `loan_officer` field, "ARIVE or LendingPad").

- [ ] **Step 5: Run the server suite and see it pass**

  Run: `cd server && npm test`

  Expected: all pass, 0 fail.

- [ ] **Step 6: Commit.** `feat(integrations): LendingPad feed label, loan_officer by name, routed_to_you`

### Task 3: The file import recognises a LendingPad export

**Files:**
- Modify: `server/lib/intake/fields.js` (`SYNONYMS`, the comments that name the LOSes)
- Modify: `server/test/intake-fields.test.js`

**Interfaces:** none new. `detectMapping()` keeps its signature.

- [ ] **Step 1: Write the failing test.**
  - Add this fixture beside `ARIVE` and `CALYX`:

    ```js
    const LENDINGPAD = ["Loan Number", "Borrower First Name", "Borrower Last Name", "Borrower Email", "Borrower Mobile Phone", "Interest Rate", "Total Loan Amount", "Loan Term", "Loan Program", "Appraised Value", "Purchase Price", "Funded Date", "Loan Status", "Loan Purpose", "First Payment Date", "Qualifying FICO", "Loan Officer", "Borrower SSN", "Est. Closing Date", "Base Loan Amount"];
    ```

  - Test `"a LendingPad funded-loans export maps with no picks; the SSN and the estimated closing date are never used"`:
    - `pick(detectMapping(LENDINGPAD), LOAN_IDS)` deep-equals `LOAN_COLUMNS`;
    - `m.closingDate === 11`;
    - none of the columns 17, 18 or 19 is in `Object.values(m)`.
  - Add `LENDINGPAD` to the "one field only" and `cleanMapping` loops.

- [ ] **Step 2: Run it and see it fail**

  Run: `cd server && node --test test/intake-fields.test.js`

  Expected: FAIL. `loanAmount` and `creditScore` are -1.

- [ ] **Step 3: Add the synonyms.**
  - `totalloanamount` goes first in `loanAmount`. The note amount includes any financed fee, so it beats the base amount.
  - `qualifyingfico`, `qualifyingcreditscore` and `representativecreditscore` go into `creditScore`.
  - Don't add `baseloanamount` or any `est…` date. Update the comments that list "ARIVE, Calyx Point" to name LendingPad, and keep
    "best guesses until a real export is seen".

- [ ] **Step 4: Run the server suite and see it pass**

  Run: `cd server && npm test`

  Expected: all pass, 0 fail.

- [ ] **Step 5: Commit.** `feat(import): recognise a LendingPad export (best-guess headers)`

### Task 4: The card's LOS copy, and the connection calls

**Files:**
- Create: `client/src/profile/connections.mjs`, `client/src/profile/connections.test.mjs` (`src/profile/` is already in the client test
  command)
- Modify: `client/src/profile/profile.mjs` (the connection wrappers and their header contract lines)
- Modify: `client/src/profile/profile.test.mjs`

**Interfaces:**
- Produces, in `profile.mjs`:
  - `connectLos(fetchFn, los: "arive"|"lendingpad")` → `POST /api/integrations/key` with body `{ los }`. It replaces `connectArive` and
    accepts the same answer.
  - `disconnectLos(fetchFn)` replaces `disconnectArive`.
  - `loadConnection` is unchanged except for its fallback (R6).
- Produces, in `connections.mjs`:
  - `LOS_CHOICES = [{ id: "arive", label: "ARIVE" }, { id: "lendingpad", label: "LendingPad" }]`;
  - `CARD_HINT`, `LOS_QUESTION`, `CHECKING`;
  - `connectionCopy(los, { isBroker })` → `{ label, connect, connected, disconnectConfirm, disconnected, steps, fields, sameLoan, routing }`.
    An unknown or null `los` gives ARIVE's copy (R5).

- [ ] **Step 1: Write the failing tests.**
  - In `profile.test.mjs`, rename the connection tests to `connectLos` and `disconnectLos`.
    - `connectLos(server.fetch, "lendingpad")`'s call list is `[["POST", KEY_URL, { los: "lendingpad" }]]`.
    - The fallback lines are `"Couldn't check your connection. Try again."` and `"Couldn't disconnect. Try again."`. The POST fallback
      stays `"Couldn't make a key. Try again."`.
  - In `connections.test.mjs`, pin the exact copy. `CARD_HINT` is
    `"Send funded loans from your LOS (ARIVE or LendingPad) straight into Broker Radar through Zapier."`, `LOS_QUESTION` is
    `"Which LOS do you use?"`, and `CHECKING` is `"Checking your connection…"`.
  - `connectionCopy("lendingpad", { isBroker: true })` deep-equals:

    ```js
    {
      label: "LendingPad",
      connect: "Connect LendingPad",
      connected: "Connected to LendingPad",
      disconnectConfirm: "Disconnect LendingPad? Your Zap will stop adding loans.",
      disconnected: "LendingPad is disconnected.",
      steps: [
        "In LendingPad, an admin makes an API key for Zapier (LendingPad's settings → API).",
        "In Zapier, make a Zap that starts with LendingPad, \"Loan Updated\", and connect it with that key.",
        "Add a Filter step: only continue when the loan status is your company's funded status. \"Loan Updated\" fires on every change to a loan, so this step is what keeps pipeline loans out.",
        "Add a \"Webhooks by Zapier\" action: POST, payload type JSON, to the URL above, with a header named Authorization whose value is Bearer, a space, then your key.",
        "Map LendingPad's fields to the names below. Map LendingPad's funded date, never its estimated closing date, to closing_date, and the loan number your LendingPad report shows (not an internal ID) to loan_id.",
        "Test the step. Zapier shows Broker Radar's answer: created, updated, unchanged, ambiguous or ignored.",
      ],
      fields: FIELDS_LIST,
      sameLoan: "Send the same loan number your import file uses as loan_id, and LendingPad's funded date as closing_date, so a loan from the Zap and the same loan in a file match.",
      routing: "Each loan goes to the loan officer named in loan_officer, by email, or by full name as it is in Broker Radar. Anything else comes to your book. Bring in your existing book first with Import Clients: the Zap only sends loans that change from now on.",
    }
    ```

  - `FIELDS_LIST` is the card's current `FIELDS`, with the last line changed to
    `"credit_score; loan_officer (email or full name); loan_purpose; status"`.
  - `connectionCopy("arive", { isBroker: true })`:
    - its `steps` and `sameLoan` are the card's current `STEPS` and `SAME_LOAN`, word for word;
    - `connected` is `"Connected to ARIVE"`;
    - `disconnectConfirm` is `"Disconnect ARIVE? Your Zap will stop adding loans."`;
    - `fields` and `routing` match LendingPad's.
  - `connectionCopy(x, { isBroker: false }).routing` is `"Loans you send go into your own book."` for both LOSes.
  - `connectionCopy(null, …)` and `connectionCopy("calyx", …)` deep-equal ARIVE's copy.
  - Review 2: the LendingPad `steps[4]` includes `"never its estimated closing date"`.

- [ ] **Step 2: Run them and see them fail**

  Run: `cd client && node --test src/profile/`

  Expected: FAIL. There is no `connections.mjs`, and `connectLos` is not exported.

- [ ] **Step 3: Implement it.**
  - Write `connections.mjs` as the exports above. The two LOSes share the Webhooks step, the Test step, the field list and the routing
    lines.
  - In `profile.mjs`, swap in the two wrappers and the R6 fallbacks, and update the header contract lines: the POST body is `{ los }`,
    and the answers carry `los`.

- [ ] **Step 4: Run the client suite and see it pass**

  Run: `cd client && npm test`

  Expected: all pass, 0 fail.

- [ ] **Step 5: Commit.** `feat(profile): per-LOS connection copy; connectLos / disconnectLos`

### Task 5: The card lets the user pick the LOS; the import page names LendingPad

**Files:**
- Modify: `client/src/profile/ConnectionsCard.jsx`
- Modify: `client/src/import/ImportView.jsx` (line 14 `UPLOAD_HINT`, the line-327 subtitle)
- Modify: `client/src/profile/ProfileView.jsx` (its header comment only: "ARIVE connection" becomes "LOS connection")

**Interfaces:**
- Consumes: `connectLos`, `disconnectLos`, `loadConnection` (Task 4); `LOS_CHOICES`, `CARD_HINT`, `LOS_QUESTION`, `CHECKING`,
  `connectionCopy` (Task 4); `los` in the GET and POST answers (Task 1).

- [ ] **Step 1: Rework the card**, removing its own copy constants except `KEY_ONCE`, `REGENERATE_CONFIRM` and `COPY_FAILED`.
  - **State:** add `choice`, starting at `"arive"`. The LOS shown is `conn.los` when connected, else `choice`. The copy is
    `connectionCopy(shownLos, { isBroker })`.
  - **Not connected:** under the Webhook URL, show `LOS_QUESTION` and one choice button per `LOS_CHOICES` entry, in a `role="radiogroup"`
    with `aria-checked`. Their testids are `connections-los-arive` and `connections-los-lendingpad`. The picked one uses
    `button(C, { primary: true })` and the other `button(C)`. Below them is the Connect button, labelled `copy.connect`. The guide below
    follows `choice`.
  - **Connected:** the status line is `` `${copy.connected} · ${usedLine(conn.lastUsedAt)}` ``. There is no choice. Regenerate calls
    `connectLos(fetch, conn.los || "arive")`, and Disconnect confirms with `copy.disconnectConfirm` and notes `copy.disconnected`.
  - **After Connect:** `setConn({ connected: true, …, los: res.data.los || choice })`.
  - Update the file's header comment.

- [ ] **Step 2: Name LendingPad on the import page.**
  - `UPLOAD_HINT` becomes
    `"Exports from ARIVE, LendingPad and Calyx Point are recognised; for any other file, pick the columns on the next step."`
  - The subtitle becomes `"Upload a CSV or Excel export from ARIVE, LendingPad, Calyx Point or your CRM"`.

- [ ] **Step 3: Run the client suite and build**

  Run: `cd client && npm test && npm run build`

  Expected: tests 0 fail, and the build succeeds with no new warnings.

- [ ] **Step 4: Commit.** `feat(profile): choose ARIVE or LendingPad on the Connections card; import names LendingPad`

- [ ] **Step 5 (controller, not the implementer): visual check.**
  - Run this worktree's API and client locally on free ports, against a throwaway `DATA_DIR` and a local test account. Nothing live.
  - Take screenshots of the Profile page at 1366×768 and at phone width:
    1. not connected, ARIVE picked;
    2. not connected, LendingPad picked;
    3. connected to LendingPad, with the key shown.
  - Send them to Bill.
