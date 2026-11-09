# Target-Rate Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broker records one target rate per client; Broker Radar checks it against each new real (FRED) rate observation, marks the client "at target" once, announces it in Charlie's briefing, and shows it on the client page, the client list and Rate Watch.

**Architecture:** One server module, `server/lib/targets.js`, owns the math and the state machine: it prices a client the way the client page does on the latest real snapshot, applies the Watching → At target → re-arm rules once per new observation date, and derives the view every screen and Charlie read. Routes call `checkTargets` before they read clients, so the stored state is always current to the newest observation. The briefing and Charlie only read views; the client renders them.

**Tech Stack:** Node 20 (`C:/Users/bille/dev/node20`), Express, better-sqlite3, `node --test`; React 18 + Vite, inline styles.

**Spec:** `docs/superpowers/specs/2026-11-09-target-rate-alerts-design.md` (read it first; this plan argues from it).

**Worktree:** `C:\Users\bille\dev\refi-radar-target-rate`, branch `feature/target-rate-alerts`. Before Task 1 the controller runs
`npm ci` in `server/` and `client/` with `PATH=/c/Users/bille/dev/node20:$PATH` (better-sqlite3 is built for Node 20; the system
Node is 24). Every command below runs with that PATH.

## Global Constraints

- No scheduler, no timers, no new paid API call, no new dependency. The check is code (spec §6).
- Only a `fred` snapshot acts (spec A1): `rate_snapshots.provider = 'fred'`, or `''` with `providerOf(rates) === 'fred'`. A
  `claude` or estimated set never changes a target's state.
- The date of a check is the snapshot's FRED observation date (`rates.date`, via `rateHistory.observationDate`), never the
  capture day.
- Rates are compared and stored rounded to three decimals: `round3 = (x) => Math.round(x * 1000) / 1000`. Shown with
  `toFixed(3)` ("6.000%").
- Instants are SQLite UTC text `YYYY-MM-DD HH:MM:SS` (as `contact_log.at`); days are `YYYY-MM-DD`. Compares are string compares.
- The check never touches `clients.updated_at` (it is not an edit).
- Import and the LOS feed never write the target columns (they are not in `lib/intake`'s column list; keep it so).
- Nothing reaches a borrower. No email, text or notice.
- Wording is pronoun-free (we don't know a client's pronouns; the spec's "her" was Helen's example). Exact copy, verbatim:
  - error, not below: `A target has to be below ${name}'s current rate of ${current.toFixed(3)}%.`
  - error, range: `A target rate is a number from 1.000 to 15.000.`
  - briefing, newly at target: `${name} is at target, estimated ${est}% against a ${target}% target`
  - briefing, still at target: `${name} is still at a ${target}% target, since ${spokenDate(reachedOn)}`
  - briefing overflow: `Plus ${n} more client at their target.` / `Plus ${n} more clients at their target.`
  - team line: `Your loan officers have ${n} opportunities open, and ${k} of their clients are at target.` (`1 of their clients
    is at target`); with no opportunities: `${k} of your loan officers' clients are at target.` (`1 of your loan officers'
    clients is at target.`)
  - client page: `Watching: estimated ${est}% as of ${date}, ${gap} above target` · `Target reached ${date} (estimated ${est}%)`
    · `Target reached ${date} · client reached ${date}` · `Their rate is already at or below this target.` ·
    `Can't estimate a rate for this client yet` · `Waiting for the first day of live rates`
  - Charlie read-back: `Just to confirm — set ${name}'s target rate to ${target}%?` · `Just to confirm — take ${name}'s target
    rate off?`; Done line: `Done — ${name}'s target rate is ${target}%.` · `Done — ${name}'s target rate is off.`
  - client list badge `At target`; Rate Watch card title `Closest to target`.
  (`${est}`, `${target}` are `toFixed(3)`; `${gap}` is `toFixed(3)` of est − target; `${date}` is "November 12th", with the
  year when it is not this year.)
- Approved looks stay (client list, client page, Rate Watch, Home, Connections card): new pieces reuse the existing `card`,
  pill and `inputStyle` styles in `client/src/App.jsx`. No Home change.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Weekend repeats** (Sat/Sun snapshots carry Friday's observation): nothing is reached, re-armed or announced twice. → Task 1
   `repeated observation is not a new check`, Task 3 `a weekend reopen announces nothing new`.
2. **A web-search day newer than the last FRED day, with lower rates**: no state change, and the page's "as of" stays the FRED
   day. → Task 1 `a claude snapshot never acts`.
3. **The client refinanced and an import lowers `current_rate` below the target after a hit**: no badge, no briefing line, the
   page says so; the next check clears the stored hit. → Task 1 `current rate at or below target clears a hit`, Task 3
   `already below is never listed`.
4. **Four clients newly at target**: three named, "Plus 1 more client at their target.", and the fourth is named (as newly at
   target) the next morning. → Task 3 `four at once`.
5. **Voicemail after a hit**: still at target, not Handled; listed again after the 3-day exclusion as "still at …". → Task 1
   `a not-reached call does not handle it`, Task 3 `still at target after three days`.

---

### Task 1: Target engine and data

**Files:**
- Modify: `server/db.js` (migrations after the `do_not_email` block)
- Modify: `server/lib/rateHistory.js` (export `observationDate`)
- Create: `server/lib/targets.js`
- Test: `server/test/targets.test.js`

**Interfaces:**
- Produces (all in `server/lib/targets.js`, CommonJS):
  - `TARGET_MIN = 1`, `TARGET_MAX = 15`, `REARM_MARGIN = 0.125`, `round3(x) -> number`
  - `parseTarget(raw) -> { rate: number|null } | { error: string }` — `null`/`undefined`/`""` → `{ rate: null }` (clear); a
    finite number or a plain decimal string (`/^\d+(\.\d+)?$/`) in [1, 15] → `{ rate: round3(n) }`; else the range error.
  - `notBelowError(name, currentRate) -> string` — the "has to be below" copy.
  - `estimateRate(row, rates) -> number|null` — `round3` of `refi.analyze(...).effRate` on the normalized client, with a
    `5_1_arm` priced as `{ ...client, loanType: "30yr_fixed" }`; null when `current_rate`, `loan_balance` or `property_value`
    is not > 0, or analyze returns null.
  - `latestRealSnapshot(db) -> { rates, obsDate } | null`
  - `nextTargetFields(row, est, obsDate, nowUtc) -> object|null` (pure; the patch to write)
  - `checkTargets(db, orgId, nowMs = Date.now()) -> { rates, obsDate } | null`
  - `handledAtFor(db, rows) -> Map<clientId, atUtc>`
  - `targetView(row, snapshot, handledAt) -> View|null` (pure)
  - `viewsFor(db, rows, snapshot, viewerId) -> Map<clientId, View>`
  - `View = { rate, state, estRate, gap, asOf, reachedOn, reachedRate, handledAt, setAt, ownerName? }`, `state` one of
    `watching | at_target | handled | already_below | unpriceable | no_rates`. `estRate`/`gap`/`asOf` are null unless state is
    `watching` (at_target/handled show `reachedRate`/`reachedOn`). `ownerName` ("First Last") only when `row.user_id !==
    viewerId`.
- New `clients` columns (all nullable, no default): `target_rate REAL`, `target_set_by INTEGER`, `target_set_at TEXT`,
  `target_reached_on TEXT`, `target_reached_rate REAL`, `target_reached_at TEXT`, `target_announced_on TEXT`,
  `target_checked_on TEXT`.

- [ ] **Step 1: Write the failing tests** in `server/test/targets.test.js` (throwaway `DATA_DIR`, as `briefing.test.js`; seed
  snapshots with `recordSnapshot(rates, day, "fred" | "claude")`):
  - `migration adds the eight target columns, nullable` — `PRAGMA table_info(clients)` has each name; an existing row reads null.
  - `parseTarget` — `6` → 6; `"5.875"` → 5.875; `5.87549` → 5.875; `null`/`""` → `{rate:null}`; `0.5`, `15.5`, `"6%"`, `"1e1"`,
    `NaN` → `{ error: "A target rate is a number from 1.000 to 15.000." }`.
  - `estimateRate matches the client page` — a 30yr 760/80% client on `{rate_30yr_fixed:6.52, rate_15yr_fixed:5.91,
    rate_5_1_arm:5.81, rate_30yr_top_tier:6.461}` equals `round3(refi.analyze(norm,…).effRate)`; a `5_1_arm` client equals the
    same client as `30yr_fixed` (not the ARM rate); a set without `rate_30yr_top_tier` uses the market path; balance 0 → null.
  - `latestRealSnapshot` — greatest observation date among fred rows wins over capture day order; `a claude snapshot never
    acts` (a later-day claude row with a newer date is ignored); none → null.
  - `nextTargetFields`, with target 6.000, current 6.750:
    - est 5.990 on obs D1 → `{ target_reached_on: D1, target_reached_rate: 5.99, target_reached_at: now, target_announced_on:
      null, target_checked_on: D1 }`;
    - `wobble`: then 6.010 on D2 and 5.995 on D3 → only `target_checked_on` changes (hit kept from D1);
    - 6.125 on D4 → hit fields and `target_announced_on` all null (re-armed); 6.124 → not re-armed;
    - `repeated observation is not a new check`: obsDate equal to `target_checked_on` → null;
    - `current rate at or below target clears a hit`: current 5.900 with a stored hit → hit cleared, never set;
    - est null (unpriceable) → only `target_checked_on`; no target → null;
    - `already there when set`: checked_on null, est 5.875 → hit on the latest obs.
  - `checkTargets` — writes patches only for the org's clients with a target whose `target_checked_on` is null or older;
    another org untouched; `updated_at` unchanged; returns the snapshot; no fred snapshot → null and no writes.
  - `targetView` states — each of the six, with the figures in the Interfaces block; `a not-reached call does not handle it`
    (only a `reached` contact at or after `target_reached_at` gives `handled` + `handledAt`; one before the hit doesn't).
  - `viewsFor` — `ownerName` on a teammate's client only.

- [ ] **Step 2: Run, verify they fail**
  Run: `cd server && node --test test/targets.test.js` — Expected: FAIL (`Cannot find module '../lib/targets'`).

- [ ] **Step 3: Implement** the migrations (one `if (!clientCols.some(...))` per column, as the others) and `lib/targets.js`.
  `checkTargets` runs its updates in one `db.transaction`. `estimateRate` reuses `refi.analyze` (export `norm` from
  `lib/refi.js` if needed; do not copy the math). `latestRealSnapshot` scans `rate_snapshots ORDER BY day DESC LIMIT 400` as
  `getMovement` does; on a tie in observation date the later capture wins. Re-arm: `round3(est - target) >= REARM_MARGIN`.

- [ ] **Step 4: Run, verify they pass** — `node --test test/targets.test.js` PASS; then `npm test` (whole server suite) PASS.

- [ ] **Step 5: Commit** — `feat(targets): target columns and the check engine`.

### Task 2: Client routes

**Files:**
- Modify: `server/routes/clients.js`, `server/routes/sweeps.js`
- Test: `server/test/targets-api.test.js` (pattern: `clients-api.test.js`)

**Interfaces:**
- Consumes: Task 1 (`checkTargets`, `viewsFor`, `parseTarget`, `notBelowError`, `round3`).
- Produces (exported from `routes/clients.js`):
  - `presentClients(db, user, rows, nowMs = Date.now()) -> client[]` — runs `checkTargets(db, user.org_id, nowMs)`, re-reads
    the rows by id (keeping `rows`' order) and returns `toClient(row)` plus `target: View|null`.
  - `setTargetForUser(db, user, id, raw, nowMs = Date.now()) -> { status: 200, client, receipt } | { status: 400, error } |
    { status: 403|404, error }` — `clientInReach`, then `parseTarget`, then `rate >= round3(current_rate)` → 400 with
    `notBelowError`. A new value sets `target_rate`, `target_set_by = user.id`, `target_set_at = now` and nulls the five
    state columns; the same value as stored changes nothing; `null` nulls all eight. `receipt = { id, name, targetRate }`.
- Routes: `PUT /api/clients/:id/target` body `{ targetRate }` → `{ success, client }` or `{ success:false, error }` with the
  status above. `GET /`, `PUT /:id`, `POST /:id/contact` answer through `presentClients`. `POST /api/sweeps` calls
  `checkTargets` before reading rows (spec 4.4).

- [ ] **Step 1: Write the failing tests**:
  - `GET /api/clients carries target` — `target: null` without one; a set target's `state`/`estRate` from the latest fred
    snapshot, and the stored hit after a newer observation.
  - `PUT target` — 6 on a 6.750 client → 200 and `client.target.rate === 6`, `target_set_by` the caller; 7 →
    400 `A target has to be below <name>'s current rate of 6.750%.`; `"abc"` → 400 range copy; `null` → cleared (all eight
    null); LO on a teammate's client → 403; another org → 403; unknown id → 404.
  - `re-setting the same value keeps the hit` and `a new value re-arms it` (state columns null, next GET re-checks against
    the latest snapshot even on the same observation date).
  - `a broker sets a target on an LO's client` — 200; the LO's `GET` sees it.
  - `logging a contact handles it` — `POST /:id/contact` after a hit → response `target.state === "handled"`.
  - `an import of the matched loan leaves the target` — `ingest(db, { actor, source: "import", items:[{ same loan_number, new
    current_rate }], ... })` from `lib/intake/ingest` keeps all eight target columns.

- [ ] **Step 2: Run, verify they fail** — `node --test test/targets-api.test.js` FAIL (no `target` key / 404 route).

- [ ] **Step 3: Implement** `presentClients`, `setTargetForUser` and the route, using `express.json` as the router already does.

- [ ] **Step 4: Run** — that file PASS, `npm test` PASS.

- [ ] **Step 5: Commit** — `feat(targets): client routes carry the target and set it`.

### Task 3: The briefing

**Files:**
- Modify: `server/lib/assistant/callList.js`, `server/lib/assistant/briefing.js`
- Test: `server/test/briefing-targets.test.js` (pattern and helpers: `briefing.test.js`); add one ordering case to
  `server/test/call-list.test.js`.

**Interfaces:**
- Consumes: Task 1 (`checkTargets`, `viewsFor`); `rateHistory.sinceLabel`-style dates via briefing's `spokenDate`.
- Produces: `pickCallList({ ..., targets })` — `targets: [{ clientId, name, reason, reasonCode }]`, placed after carried
  clients in the given order, own clients only, skipping ids already picked, NOT filtered by `excludeIds` (the caller has
  already applied the right exclusions). `reasonCode` is `"target"` (newly) or `"target_still"`. Every existing caller that
  omits `targets` behaves exactly as before.

- [ ] **Step 1: Write the failing tests**:
  - `newly at target leads after carried, ahead of the sweep, with the target wording` — "Today's calls: Helen Brandt is at
    target, estimated 5.875% against a 6.000% target; …".
  - `at target overrides the sweep bar` — current 6.250, target 6.100, est ≤ 6.100: listed though the sweep has no
    opportunity for them.
  - `announced once` — first briefing of the day sets `target_announced_on` to the local date; a same-day rebuild keeps the
    "is at target" wording; the next day it is not newly announced (excluded as recently recommended).
  - `still at target after three days` — not handled, a not-reached call logged → on day 4: "… is still at a 6.000% target,
    since November 10th", ranked after newly-at-target clients and before sweep picks.
  - `handled is never listed` — a reached contact after the hit → absent.
  - `already below is never listed` — current_rate lowered to 5.900 after a hit → absent, no overflow count.
  - `four at once` — 3 named + "Plus 1 more client at their target."; only the three get `target_announced_on`; the fourth is
    named as newly at target the next day.
  - `bypasses the 7-day and 3-day exclusions` — a client reached 2 days before the hit is still announced.
  - `a follow-up client is deferred` — a client the briefing asks "were you able to reach …" about is not listed and not
    announced that day.
  - `a carried client stays carried` — a carried client newly at target is listed with the carry reason and not marked announced.
  - `LO's client: LO is told, broker counts it` — the LO's briefing lists them; the broker's own list doesn't; the broker's team
    line ends ", and 1 of their clients is at target."; with no opportunities: "1 of your loan officers' clients is at target."
  - `a weekend reopen announces nothing new` — Saturday snapshot repeating Friday's observation: no new hit, no re-announce.
  - `rates no real snapshot` — only estimated/claude sets stored: no target lines, briefing otherwise unchanged.
  - call-list unit: `targets go after carried and before the sweep, and skip ids already used`.

- [ ] **Step 2: Run, verify they fail** — `node --test test/briefing-targets.test.js test/call-list.test.js` FAIL.

- [ ] **Step 3: Implement.** In `buildBriefing`, run `targets.checkTargets(db, user.org_id, nowMs)` before `ownRows` is read
  (its own `try`/`skip("targets", …)`; a failure leaves targets out and the rest unchanged). In `callListSection` build the
  two lists from `viewsFor` over `speakableRows`, state `at_target` only:
  - newly = `target_announced_on` null or equal to `localDate`, not in `followUpClientIds`, ordered by `target_reached_at` then
    name;
  - still = `target_announced_on < localDate` and not in `excludeIds`.
  Overflow = newly ones not picked; its line goes after the call list line and before the check-ins line. After the list is
  recorded (same transaction as `recordRecommendations`, with the picks' `reasonCode`), set `target_announced_on = localDate`
  where the pick's `reasonCode === "target"` and it is still null. `teamSection` counts the LO clients whose view is
  `at_target` (works with no rates too).

- [ ] **Step 4: Run** — those files PASS, `npm test` PASS.

- [ ] **Step 5: Commit** — `feat(targets): the briefing announces a client at target once`.

### Task 4: Charlie

**Files:**
- Modify: `server/lib/assistant/tools.js`, `server/lib/assistant/orchestrator.js` (`SIDE_EFFECT_TOOLS`, `readBack`,
  `changeDetails`), `server/lib/assistant/prompt.js` (confirmation rule + one targets line), `server/routes/assistant.js`
  (`/confirm` branch, `confirmReply`)
- Test: `server/test/assistant-tools.test.js`, `server/test/assistant-api.test.js`, `server/test/assistant-orchestrator.test.js`
  (add cases; follow each file's patterns, scripted model only, no live model)

**Interfaces:**
- Consumes: Task 1 (`parseTarget`, `notBelowError`, `checkTargets`, `viewsFor`), Task 2 (`setTargetForUser`).
- Produces:
  - `setTargetRateTool({ clientId, targetRate }, ctx)` — `targetRate` a number, or null to clear. Scoped like
    `logContactTool`. Bad input or not-below → `fail("(invalid input)", <the copy>)` so Charlie says why. Else `{ data: {
    client: { id, name, currentRate }, targetRate }, source: "client record", sideEffect: { type: "setTargetRate", clientId,
    targetRate } }`.
  - `targetRatesTool(_args, ctx)` — `{ data: { clients: [{ id, name, ownerName?, target: View }] }, source: "client record" }`,
    the caller's scope, clients with a target only, at_target first (by `reachedOn`), then by `gap`, at most 15.
  - `findClient` matches gain `target: View|null` (runs `checkTargets` first).
  - TOOL_SCHEMA entries for both; `/confirm` type `"setTargetRate"`: `clientId` positive integer, `targetRate` null or finite
    number, else 400; confirmId required; `target = "<id>:<toFixed(3)|clear>"`; executes `setTargetForUser`.

- [ ] **Step 1: Write the failing tests**:
  - tools: `setTargetRateTool` packages `{type:"setTargetRate", clientId, targetRate: 6}`; 7 on a 6.750 client → fail with
    the not-below copy; LO can't package a teammate's client ("no such client in your book"); `targetRatesTool` order and
    scope; `findClient` carries `target`.
  - orchestrator: read-back `Just to confirm — set Helen Brandt's target rate to 6.000%?` and the clear form; card rows
    `[{label:"Client",…},{label:"Target rate", value:"6.000%" | "None"}]`; a reply "Helen Brandt's target is 6.000% and she's
    estimated at 5.875%" passes the figure check after `findClient`.
  - `/confirm`: sets it, reply `Done — Helen Brandt's target rate is 6.000%.`; clear → `… is off.`; duplicate confirmId → same
    reply, no second write; bad `targetRate` → 400; not-below → 400 with the copy.

- [ ] **Step 2: Run, verify they fail** — the three files FAIL on the new cases.

- [ ] **Step 3: Implement.** The prompt line names both tools and says to call `targetRatesTool` for "who's at their target",
  `findClient` for one client, and to call every estimated rate "estimated". Do not run `scripts/charlie-eval.js` (paid model;
  Bill's go only).

- [ ] **Step 4: Run** — those files PASS, `npm test` PASS.

- [ ] **Step 5: Commit** — `feat(targets): Charlie sets, clears and reads targets`.

### Task 5: The screens

**Files:**
- Create: `client/src/targets.mjs`, `client/src/targets.test.mjs`
- Modify: `client/package.json` (add `src/targets.test.mjs` to `"test"`), `client/src/App.jsx` (`ClientRow`, `ClientDetail`,
  `RateWatch`, the App wiring), `client/src/charli/session.mjs` + `CharliView.jsx` (refresh hook)
- Test: `client/src/targets.test.mjs`, `client/src/charli/session.test.mjs` (one case)

**Interfaces:**
- Consumes: the `target` View on every client from Task 2; `PUT /api/clients/:id/target`.
- Produces (`client/src/targets.mjs`, ESM): `dayLabel(ymd, today = new Date()) -> "November 12th"` (year when not this
  year); `targetStatusLine(target, today) -> string|null` (the client-page copy per state; `handledAt` UTC text shown as the
  local date); `closestToTarget(clients, limit = 5) -> client[]` (with a target, at_target first, then smallest `gap`,
  handled/already_below/unpriceable/no_rates last); `isAtTarget(target) -> boolean`.
- `createSession({ ..., onClientsChanged })` calls it after a successful `/confirm` of `setTargetRate`.

- [ ] **Step 1: Write the failing tests** (`targets.test.mjs`): every status line verbatim for each state; `dayLabel` with and
  without the year; `closestToTarget` order and the limit of 5; `isAtTarget` true only for `at_target`. Session: a confirmed
  `setTargetRate` calls `onClientsChanged` once; other types don't.

- [ ] **Step 2: Run, verify they fail** — `cd client && npm test` FAIL (no module).

- [ ] **Step 3: Implement.**
  - `ClientDetail`: a "Target rate" card after "Current Loan Details": one input (`inputStyle`, three decimals), Save and
    Clear buttons, the server's error under it, `targetStatusLine` below. Saving calls the route and hands the returned client
    to a new `onUpdated(client)` prop, which App wires to update `clients` and `selected`.
  - `ClientRow`: an `At target` pill beside `PriorityBadge` when `isAtTarget(c.target)`.
  - `RateWatch`: a new `clients` prop; under the rates card, a `card` titled `Closest to target` listing `closestToTarget`:
    name (+ `ownerName` when present), target, est. (or "At target"), gap. Hidden when no client has a target.
  - App passes `onClientsChanged` (re-fetch `/api/clients`) through to `createSession`.

- [ ] **Step 4: Run** — `npm test` PASS and `npm run build` succeeds.

- [ ] **Step 5: Commit** — `feat(targets): target field, badge and Rate Watch list`.

**After Task 5 (controller):** whole-branch review, then the visual check with the scratchpad tooling (throwaway DB copy,
paid services blanked): client page in each state, list badge, Rate Watch list, a briefing with a target line. Screenshots go to
Bill. Merge, push and deploy each wait for Bill's go.
