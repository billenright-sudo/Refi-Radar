# Charlie Morning Briefing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Charlie the main page of Broker Radar. Charlie gives a code-authored morning briefing (market, call list, calendar,
open follow-ups), follows up on calls with confirmed logs and notes, and sits beside a Profile page for name, email, calendar,
tenure and NMLS IDs.

**Architecture:**
- The briefing replaces today's code-authored greeting on `POST /api/assistant/turn {greeting:true}`. There is still no model
  call. A new `briefing.js` assembles it from existing tools plus new follow-up storage (`followups.js`).
- Follow-up answers go through the model with two extended or new side-effect tools (`logContactTool` with outcome and notes,
  `callListTool`). Both are confirmed through today's `/confirm`.
- The client lands on a Charlie home view, gets a corner Charlie panel on other pages, and a new Profile page. Logic lives in
  testable `.mjs` modules; JSX stays thin.

**Tech Stack:**
- Server: Node 20, Express, better-sqlite3, `node --test`.
- Client: React + Vite, `node --test` on `.mjs` modules.

**Spec:** `docs/superpowers/specs/2026-10-30-charlie-morning-briefing-design.md` (approved 2026-10-30). Phase 1 = §5.1, §5.2,
§5.4, and §5.5 without Notifications. Phase 2 (§5.3 pings, scheduler, push, notification settings) is NOT in this plan.

## Global Constraints

- **Node 20 only:** `export PATH="/c/Users/bille/dev/node20:$PATH"`.
- **Test commands:** server `cd server && npm test`; client `cd client && npm test`. Both stay fully green after every task.
- **No real API calls in tests.** Never read, print, cat or grep `server/.env` or any `.env*` file.
- **Charlie's four locks never loosen:**
  - no invented book, client, loan, calendar or rate facts or numbers;
  - no claimed actions without the broker's confirm;
  - no guideline, legal or tax answers;
  - no client contact details (phone, email) read out.

  The `classifyUngrounded` hard rule is unchanged.
- **The briefing and follow-up questions are code-authored** (no model call), like today's greeting. Figures are digits from
  tool data only. They contain no figure words and no phone numbers or emails, and exactly one `?` (the final question).
- **Borrower PII never reaches the model.** Stored call notes are never sent to the model, and the spoken read-back says
  "with your notes", never the notes.
- **Team scope:** the call list, follow-ups and calendar matching cover only clients with `clients.user_id = user.id`, for
  brokers too. A broker with LOs gets one count-only team line.
- **Every write is confirmed** through `/api/assistant/confirm`, one item per confirmation.
- **Rate moves are measured between FRED observation dates** (`rates.date`), never capture days. An estimated rate set never
  claims a move.
- **Drop-lead threshold in phase 1:** the constant `DROP_THRESHOLD = 0.125` (30-year fixed). Phase 2 makes it per user.
- **Call list rules (spec §5.2):**
  - 3 clients: carried ("tomorrow's list") first, then the sweep order alternating rate-term and cash-out when both exist, then
    check-ins with no opportunity.
  - Skip clients with a "reached" contact in the last 7 days.
  - Skip clients recommended in the last 3 days whose item is open or `not_reached`, unless carried.
- **Follow-ups:**
  - Asked at most twice in total (`ask_count < 2`), then expired.
  - At most two named per briefing, and only the first is asked.
  - Never in a ping.
- **UI scope:** no restyle beyond the spec. Charlie home replaces the Charlie tab, the old Dashboard becomes "Overview", and a
  Profile item is added at the bottom of the nav.
- **Commits:** one per task (or per step where marked). Every message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A calendar title containing a phone number or email** ("Call Lucy 555-201-0103") must never be read in the briefing.
   Such a title is replaced by "an event". Pinned in Task 5.
2. **Google not connected or expired, no rates, an empty book, or a sweep that throws:** the briefing still renders, skips
   that section silently, and still ends with exactly one question. Pinned in Task 6.
3. **Re-opening Charlie the same day, or a reload:** no duplicate recommendation rows, `ask_count` rises once per open, and
   a drop leads only the first briefing after its observation. Pinned in Tasks 2 and 6.
4. **A follow-up whose client was deleted or reassigned to another LO** is skipped, never asked, and never logged to the
   wrong book. Pinned in Task 2.
5. **A missing or bad `localDate` from the browser** (null, far off, malformed) falls back to the UTC date, and the
   briefing still works. Pinned in Task 6.

---

### Task 1: Rate movement by observation date

**Files:**
- Modify: `server/lib/rateHistory.js` (`getMovement` ~80-102, `sinceLabel` ~63-71)
- Test: `server/test/rate-history.test.js`

**Interfaces:**
- Produces:
  - `getMovement(rates, provider)` keeps its return shape `{ current, previous, deltas, hasHistory, since, sinceDate }`.
    `previous` is now the parsed `rates` JSON of the most recent snapshot whose stored `rates.date` (the FRED observation
    date) is strictly earlier than `rates.date`, with the same provider rules as today. `sinceDate` is that previous
    observation date, and `since = sinceLabel(prevObservationDate, rates.date)`.
  - `getMarketUpdate` (tools.js:66-85) needs no change beyond what flows through.

- [ ] **Step 1: Write the failing tests** (in `rate-history.test.js`, using its `beforeEach` that clears `rate_snapshots`):
  - `test("movement compares FRED observation dates, not capture days")`: store two snapshots captured on the SAME
    capture day key but with `rates.date` `"2026-10-28"` (30yr 6.55) and current `rates.date` `"2026-10-29"` (30yr 6.40).
    Assert `deltas.rate_30yr_fixed === -0.15` and `sinceDate === "2026-10-28"`.
  - `test("a re-fetch of the same observation shows no movement")`: a stored snapshot and the current set both have
    `date: "2026-10-29"`. Assert `hasHistory === false` and `previous === null`.
  - `test("since is labelled against the observation date")`: previous observation `"2026-10-23"` (a Friday), current
    `"2026-10-26"` (a Monday). Assert `since === "Friday"`.
  - Keep every existing test's intent (no move across providers, never on an estimate). Adjust only their fixture dates so
    `rates.date` drives them.
- [ ] **Step 2: Run** `cd server && node --test test/rate-history.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In `getMovement`, select prior snapshots for the provider, parse each `rates`, and pick the
  greatest `rates.date < current.date`. When the current set has no valid `date`, return no movement.
- [ ] **Step 4: Run the full server suite.** Expected: all green. Fix any `getMarketUpdate` or orchestrator test that pinned
  capture-day wording by updating its fixture dates only.
- [ ] **Step 5: Commit** `fix(rates): measure rate moves between FRED observation dates`.

### Task 2: Follow-up storage (`followups.js`) and the new tables

**Files:**
- Modify: `server/db.js` (new `CREATE TABLE IF NOT EXISTS` blocks after line ~193)
- Create: `server/lib/assistant/followups.js`
- Test: `server/test/followups.test.js` (new; same temp-`DATA_DIR` header as `rate-history.test.js`)

**Tables (exact):**
```sql
contact_log(id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), at TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT NOT NULL CHECK(outcome IN ('reached','not_reached')), notes TEXT NOT NULL DEFAULT '')
charlie_recommendations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, day TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('briefing','sweep','calendar','carry')), reason_code TEXT NOT NULL DEFAULT '',
  due_at TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reached','not_reached','expired')),
  ask_count INTEGER NOT NULL DEFAULT 0, asked_at TEXT, resolved_at TEXT, UNIQUE(user_id, client_id, day, source))
user_briefing_state(user_id INTEGER PRIMARY KEY REFERENCES users(id), last_drop_obs TEXT)
```

**Interfaces:**
- Produces (all synchronous, `db` is the better-sqlite3 handle, dates are `YYYY-MM-DD`, instants are SQLite UTC
  `YYYY-MM-DD HH:MM:SS`):
  - `recordRecommendations(db, userId, day, items)`. `items` is `[{ clientId, source, reasonCode, dueAt? }]`, upserted on
    `(user_id, client_id, day, source)` and never duplicated.
  - `openFollowUps(db, userId, { localDate, localHour, nowUtc })` returns `[{ id, clientId, name, source, day, dueAt }]`. Rows
    are `status='open'` and `ask_count < 2`. A row is due when:
    - `briefing` / `sweep` rows: `day < localDate`, or `day = localDate` and `localHour >= 12`;
    - `calendar` rows: `due_at <= nowUtc`.

    The client must still exist and have `user_id = userId`; anything else is skipped. Oldest first.
  - `markAsked(db, ids, nowUtc)` increments `ask_count` and sets `asked_at`. A row asked twice is no longer returned by
    `openFollowUps`.
  - `dismiss(db, userId, recId)` sets that row (only if it belongs to `userId`) to `status='expired'`, so it is never asked
    again.
  - `resolveForClient(db, userId, clientId, status, nowUtc)` sets every `open` row for that client to `status`.
  - `addCarry(db, userId, clientId, day)` inserts a `source='carry'` row for `day`.
  - `carriedIds(db, userId, localDate)` returns the client ids of open `carry` rows with `day < localDate`.
  - `logCall(db, { userId, clientId, outcome, notes, nowUtc })` inserts into `contact_log` and returns its id.
  - `reachedSince(db, userId, sinceUtc)` returns a `Set` of client ids with a `reached` contact at or after `sinceUtc`.
  - `recentlyRecommended(db, userId, sinceDay)` returns a `Set` of client ids with a row of `day >= sinceDay` whose status is
    `open` or `not_reached`, excluding `carry` rows.
  - `dropAlreadyLed(db, userId, obsDate)` returns a boolean.
  - `markDropLed(db, userId, obsDate)`.

- [ ] **Step 1: Write the failing tests** in `followups.test.js`:
  - `recordRecommendations` twice with the same item leaves one row.
  - `openFollowUps` returns a yesterday `briefing` row, hides today's row before noon and shows it after noon, and shows a
    `calendar` row only once `due_at` has passed.
  - **Review Focus 4:** a row whose client was deleted is not returned. Neither is a row whose client's `user_id` was changed
    to another user.
  - `markAsked` twice, then `openFollowUps` returns nothing.
  - `dismiss` removes a row from `openFollowUps`. `dismiss` with another user's `recId` changes nothing.
  - `resolveForClient(..., 'reached')` closes the open rows.
  - `logCall` with `outcome:'not_reached'` writes the row, and `reachedSince` does not include that client.
  - `carriedIds` returns a carry from yesterday but not one from today.
  - `markDropLed`, then `dropAlreadyLed` is true for that observation and false for a later one.
  - The migration is idempotent: requiring `db.js` twice in a subprocess on an old DB creates the tables (copy the pattern at
    `coaching.test.js:1016-1056`).
- [ ] **Step 2: Run** `node --test test/followups.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three tables in `db.js` and the functions in `followups.js`.
- [ ] **Step 4: Run the full server suite.** Expected: green.
- [ ] **Step 5: Commit** `feat(charlie): follow-up storage — contact log, recommendations, briefing state`.

### Task 3: Call-list selection (pure)

**Files:**
- Create: `server/lib/assistant/callList.js`
- Test: `server/test/call-list.test.js`

**Interfaces:**
- Consumes: a `runSweep` result (`server/lib/refi.js:205-216`; rows `{clientId, name, best, opportunities, checkIn}`; lens
  names `rate_term`, `cash_out`, `arm_to_fixed`, `term_swap`), and `PRIORITY_RANK`, `impact` from `refi.js`.
- Produces: `pickCallList({ sweep, ownClientIds, carriedIds, excludeIds, limit = 3 })` returns
  `[{ clientId, name, reasonCode, reason }]`.
  - `reasonCode` is one of `carry`, `rate_term`, `cash_out`, `arm_to_fixed`, `term_swap`, `check_in`.
  - `reason` is code-authored text from sweep fields only:
    - dollars formatted with commas;
    - `cashAvailable` rounded to the nearest 1,000 and said with "about";
    - `monthlySavings` rounded to whole dollars;
    - `monthsSince` as digits;
    - when the client's check-in is also due, a check-in clause such as "15 months since your last check-in" is appended.

    The builder writes the templates; each must contain the client's name and its figure.

- [ ] **Step 1: Write the failing tests:**
  - **Order:** carried client first, then alternating `rate_term` / `cash_out` by cross-client rank (sort like
    `orchestrator.js` `trimSweep`: `PRIORITY_RANK[best.priority]` desc, then `impact(best)` desc), then check-ins only.
  - **Alternation:** with 3 cash-out clients ranked above 2 rate-term clients, the result is cash-out, rate-term, cash-out.
  - `excludeIds` and clients not in `ownClientIds` never appear.
  - A cash-out reason contains `"$174,000"` for `cashAvailable: 174312`. A rate-term reason contains `"$574"` and `"a month"`.
  - **The no-figure-words rule:** no reason matches `/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|hundred|thousand|million)\b/i`.
  - No reason contains `"?"`.
  - Fewer than `limit` candidates returns fewer, without throwing.
- [ ] **Step 2: Run** `node --test test/call-list.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `pickCallList`.
- [ ] **Step 4: Run the suite.** Expected: green.
- [ ] **Step 5: Commit** `feat(charlie): morning call list selection`.

### Task 4: Calendar follow-up matching

**Files:**
- Modify: `server/lib/assistant/tools.js` (name matching ~385-533; add one export)
- Modify: `server/lib/google/calendar.js` (`listDay` ~75-108: add `endAt` epoch ms to each event object; the model-facing
  mapping in `getCalendarTool` stays unchanged)
- Create: `server/lib/assistant/calendarFollowUps.js`
- Test: `server/test/calendar-followups.test.js`; extend `server/test/google-calendar.test.js` for `endAt`

**Interfaces:**
- Produces:
  - `clientsInText(text, ownClients)` from `tools.js` returns `[{ id, name }]`. These are the user's own clients whose screened
    names (full name or surname, the same `screenedNames` rules as `namesClient`) appear in `text` as whole words. It is built
    on the existing trie code with client ids attached to name ends. It is linear-time like `textHasName`.
  - `collectCalendarFollowUps(ctx, { localDate, db, userId })` is async and returns the number of rows recorded.
    - It reads today's and yesterday's events (yesterday = `localDate` minus one day, computed in code) through the same
      `ctx.google` calendar interface `getCalendarTool` uses.
    - It matches each title with `clientsInText` against `SELECT id, name FROM clients WHERE user_id = ?`.
    - It records `source:'calendar'` recommendations with `day` = the event's date and `dueAt` = the event end as a UTC
      instant.
    - Not connected, or any Google error, returns 0 and never throws.

- [ ] **Step 1: Write the failing tests:**
  - `clientsInText("Follow-up: Lucy Tran", own)` gives Lucy.
  - A colleague's client in the title gives `[]` (team scope).
  - `"Tran"` alone matches by surname.
  - `"Lucy"` alone does NOT (first names are not screened).
  - A 4,000-character hyphen chain finishes in under 200 ms.
  - With a fake `ctx.google` returning yesterday's "Follow-up: Lucy Tran" ending 10:30 local, one calendar row is recorded with
    the right `due_at`.
  - Not connected returns 0.
  - `listDay` events carry a numeric `endAt`, and `getCalendarTool`'s `data.events` objects still have exactly
    `{title,start,end,allDay}`.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: green.
- [ ] **Step 5: Commit** `feat(charlie): match calendar calls to the user's own clients`.

### Task 5: The briefing builder

**Files:**
- Create: `server/lib/assistant/openers.js` (move `GREETING_OPENERS`, `WEEKDAY_KEYS`, `openerFor`, `stableHash`, `weekdayOf`,
  `partOfDay`, `hourOf` out of `routes/assistant.js` unchanged. `routes/assistant.js` re-exports `GREETING_OPENERS` and
  `openerFor`, so existing tests keep passing.)
- Create: `server/lib/assistant/briefing.js`
- Test: `server/test/briefing.test.js`

**Interfaces:**
- Consumes:
  - `getMarketUpdate`, `runSweepTool` (tools.js);
  - `pickCallList` (Task 3);
  - `followups.*` (Task 2);
  - `collectCalendarFollowUps` (Task 4);
  - `localToday` (`server/lib/google/time.js`);
  - `CAREER_QUESTION` (`coaching.js:90`), `stageById`.
- Produces: `buildBriefing({ user, ctx, db, localHour, localDate, nowMs = Date.now() })` is async and returns
  `{ reply, sources, kind, strip, followUp }`:
  - `kind` is `"morning"` when `localHour` is 4 to 11, else `"catch_up"`.
  - `strip` is `{ rate30, move30, asOf, opportunities, checkInsDue, nextEvent }`. Each is `null` when unknown. `nextEvent` is
    `{ title, start }` with the scrubbed title.
  - `followUp` is `{ recId, clientId, name, source }` (the one asked) or `null`.
  - `sources` are the citation strings used.

**Reply order** (spec §5.2):
1. `openerFor({localHour, localDate, name})`.
2. The market line from `getMarketUpdate`: 30-year, move vs `since`, "as of" the observation date; plus clauses for 15-year,
   FHA and jumbo moves ≥ 0.05.
   - A 30-year drop ≤ −`DROP_THRESHOLD` leads with "Rates dropped:" only if `!dropAlreadyLed(obs)`; then `markDropLed`.
   - An estimated set says "estimated" with no move.
   - Moves under 0.05 everywhere give one short sentence.
3. The call list: `pickCallList` over the sweep of `user_id = user.id` clients, with `excludeIds = reachedSince(7 days) ∪
   recentlyRecommended(3 days)` and `carriedIds`. Then `recordRecommendations(source:'briefing')`.
   - "plus N more check-ins" when more of the user's own check-ins are due than listed.
4. **Team line:** broker role only, and only if org clients with `user_id != user.id` have opportunities. "Your loan officers
   have N opportunities open."
5. **Calendar:** today's event count and the first one or two by title and time.
   - **Review Focus 1:** a title containing a digit run of 7 or more, an `@`, or `?` is replaced by "an event".
   - Skipped when not connected.
6. Open follow-ups: run `collectCalendarFollowUps`, then `openFollowUps`; take at most 2. With 2, say exactly "I've also got a
   couple of calls to check on with you." (no figure word). `markAsked` on the shown ids.
7. **Exactly one closing question:**
   - the first follow-up's question:
     - a `briefing` / `sweep` / `carry` row: `"<When> I suggested calling <name>. Were you able to reach them?"`, where
       `<When>` is "This morning" if `day === localDate`, "Yesterday" if it is the day before, else "Earlier". Always use
       "them" (no pronoun guessing);
     - a `calendar` row: `"How did the call with <name> go?"`;
   - else `CAREER_QUESTION` if `!stageById(user.career_stage)`;
   - else `"Want a full sweep, an update on a client, or should I get those calls on your calendar?"`.

- [ ] **Step 1: Write the failing tests** with a temp DB, seeded clients, fixed rates and a fake `ctx.google`:
  - **Order of sections:** market before call list before calendar before the question.
  - Exactly one `?` in `reply`.
  - **Drop lead:** with two snapshots 6.55 → 6.40, the reply starts its market line with "Rates dropped". A second
    `buildBriefing` the same day does not, and the move is still stated.
  - **Review Focus 1:** a calendar title "Call Lucy 555-201-0103" never appears; "an event" does. A title with an email
    behaves the same.
  - **Review Focus 2:** no Google, no rates (`ctx.rates` null), an empty book, and a sweep tool that throws each still give a
    reply ending in exactly one `?`, with no throw.
  - **Review Focus 3:** calling twice the same day leaves one `briefing` row per listed client, and `ask_count` goes 1 → 2,
    then the item expires.
  - **Team scope:** a broker's call list contains no LO client, and the team line says the LO count. An LO gets no team line.
  - With an open follow-up for Lucy from yesterday, the reply ends with `"Were you able to reach them?"` and
    `followUp.clientId` is Lucy's.
  - No reply contains a client email or phone from the seed rows.
  - `kind` is `"morning"` at `localHour` 8 and `"catch_up"` at 15.
- [ ] **Step 2: Run** `node --test test/briefing.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `openers.js` (a move only) and `briefing.js`.
- [ ] **Step 4: Run the full suite** (`coaching.test.js:397-481` opener tests must stay green via the re-export). Expected: green.
- [ ] **Step 5: Commit** `feat(charlie): code-authored morning briefing`.

### Task 6: Serve the briefing from the greeting turn

**Files:**
- Modify: `server/routes/assistant.js` (the greeting branch ~428-438; `buildGreeting` ~166-195 is removed and replaced by
  `buildBriefing`)
- Test: `server/test/assistant-api.test.js` (greeting tests ~339-520), `server/test/coaching.test.js` (~859-910)

**Interfaces:**
- Consumes: `buildBriefing` (Task 5); `userLocalDate` (`server/lib/assistant/live.js:82-89`).
- Produces: the greeting response is
  `{ reply, sources, turnId, briefing: { kind, strip, followUp } }`. The metering is unchanged (one zero-token 'turn' row, no
  model call). `ctx` gains `withTurnClientNames`.

- [ ] **Step 1: Update and add the tests:**
  - The existing greeting tests keep their contracts:
    - the model is never called;
    - there is one zero-usage row;
    - `sources` are citations;
    - there is exactly one `?` (`coaching.test.js:859-868`);
    - the career question appears when the stage is unset.
  - Replace exact-string assertions with structure assertions (opener first, the 30-year figure, the call-list names, the
    closing question).
  - **Review Focus 5:** `localDate` of `null`, `"2026-13-45"` and a date 5 days off each give a 200 with a briefing (the UTC
    date is used).
  - The response has `briefing.strip.rate30` equal to the request's `rate_30yr_fixed` rounded to 2 decimals.
- [ ] **Step 2: Run** `node --test test/assistant-api.test.js test/coaching.test.js`. Expected: the new assertions FAIL.
- [ ] **Step 3: Implement** the greeting branch with `buildBriefing({ user: req.user, ctx, db, localHour, localDate:
  userLocalDate(req.body.localDate) || new Date().toISOString().slice(0, 10) })`.
- [ ] **Step 4: Run the full suite.** Expected: green.
- [ ] **Step 5: Commit** `feat(charlie): the greeting is the morning briefing`.

### Task 7: Call outcomes, notes and tomorrow's list (tools + confirm)

**Files:**
- Modify: `server/lib/assistant/tools.js`:
  - `logContactTool` ~210-222 and its schema ~693-704;
  - a new `callListTool`;
  - `TOOL_SCHEMA`;
  - the `tools` export.
- Modify: `server/lib/assistant/orchestrator.js`:
  - `SIDE_EFFECT_TOOLS` ~51;
  - `readBack` ~1866-1889;
  - `changeDetails` ~1899-1931.
- Modify: `server/lib/assistant/prompt.js`: two sentences on answering a follow-up question.
  - Reached: offer to log it with `logContactTool` (outcome reached, with any notes the broker says), then offer a follow-up
    call on the calendar with `createEventTool`.
  - Not reached: offer tomorrow's list (`callListTool`), a time to call (`createEventTool`), or a check-in email
    (`draftEmailTool`).
- **Skip:** `POST /api/assistant/turn` accepts an optional `followUpRecId` (a positive integer). When it is present, belongs
  to the user, and the user's text is a decline by the orchestrator's existing `isDecline`, the server calls
  `followups.dismiss` and replies with the code-authored `No problem — I won't ask about <name> again.` There is no model call
  and no sideEffect.
- Modify: `server/routes/assistant.js`: `/confirm` ~510-587 and `confirmReply` ~230-238.
- Modify: `server/scripts/charlie-eval-cases.json` (two cases).
- Test: `server/test/assistant-tools.test.js`, `server/test/assistant-orchestrator.test.js`, `server/test/assistant-api.test.js`

**Interfaces:**
- Produces:
  - `logContactTool({ clientId, outcome = "reached", notes = "" }, ctx)`.
    - The schema adds `outcome` (enum `reached`/`not_reached`) and `notes` (string, max 1000).
    - The sideEffect is `{ type:"logContact", clientId, outcome, notes }`.
    - Invalid outcome gives `fail("(invalid input)", "outcome must be reached or not_reached")`. Notes are trimmed, control
      characters are stripped, and they are capped at 1000.
  - `callListTool({ clientId }, ctx)` returns `{ data:{ client:{ id, name } }, source:"client record", sideEffect:{
    type:"addToCallList", clientId, day: <ctx.localDate or UTC today> } }`.
    - It looks up only the user's OWN clients (`user_id = user.id`, brokers included, per team scope).
    - Any other client gives `fail("(not found)","no such client in your book")`.
  - **Read-backs (exact):**
    - reached with notes: `Just to confirm — log a call with <name>, with your notes?`
    - reached without notes: unchanged, `Just to confirm — log a contact for <name>?`
    - not reached: `Just to confirm — note that you couldn't reach <name>?`
    - addToCallList: `Just to confirm — put <name> on tomorrow's call list?`
  - **Card rows:**
    - logContact: `Client`, `Outcome` (`Reached` / `Couldn't reach`), `Notes` (the text, only when non-empty),
      `Contact date` (`Today`).
    - addToCallList: `Client`, `List` (`Tomorrow`).
  - **`/confirm`:**
    - `logContact` accepts the optional `outcome` and `notes` (same validation), then runs in one transaction:
      - `followups.logCall`;
      - when `reached`, `logContactForUser` (updates `last_contact`);
      - `followups.resolveForClient(status = outcome)`.
    - `addToCallList` validates `clientId` and a `day` matching YYYY-MM-DD within ±1 day of UTC, then calls `addCarry`. It
      returns 404 for an unknown client and 403 for any client whose `user_id` is not the caller (brokers included).
  - **`confirmReply`:**
    - `logContact` not reached: `Done — I noted that you couldn't reach <name>.`
    - `addToCallList`: `Done — <name> is on tomorrow's call list.`
    - Others are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - The tool rejects a bad outcome. The notes cap is 1000.
  - The orchestrator's read-back for reached with notes is exactly the string above and does NOT contain the notes text.
    `changeDetails` has a `Notes` row with the text.
  - `/confirm` reached + notes writes `contact_log`, updates `last_contact` and closes the open recommendation.
  - Not reached writes `contact_log` and leaves `last_contact` unchanged.
  - `addToCallList` creates a carry row. An LO, or a broker, adding a client assigned to someone else gets 403.
  - **Skip:** `/turn` with a `followUpRecId` and the text "skip it" replies `No problem — I won't ask about Lucy Tran again.`,
    makes no model call, and the row no longer appears in `openFollowUps`. A `followUpRecId` belonging to another user is
    ignored, and the turn goes to the model as usual.
  - A replayed `confirmId` writes nothing twice.
  - **Notes never reach the model:** a `/turn` after a confirmed log sends model requests whose JSON does not contain the
    saved notes text (use the scripted `fakeClient` and inspect its recorded calls).
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite** and `node scripts/charlie-eval.js --dry`. Expected: green, and the dry run is clean.
- [ ] **Step 5: Add eval cases:**
  - `followup-reached-notes`: a prior assistant follow-up question, then "Yeah I got her, she wants to wait until spring."
    Expect a `logContact` proposal with outcome reached.
  - `followup-tomorrow`: "No, I missed her. Put her on tomorrow's list." Expect an `addToCallList` proposal.

  Run `--dry` again.
- [ ] **Step 6: Commit** `feat(charlie): log call outcomes with notes and carry clients to tomorrow`.

### Task 8: Profile server (name, email change, tenure)

**Files:**
- Modify: `server/routes/profile.js`
- Modify: `server/db.js`: a new table
  `email_changes(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, new_email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL)`
- Modify: `server/email.js`: `sendEmailChange(to, link)` returns `Promise<boolean>` (false when `EMAIL_USER`/`EMAIL_PASS` are
  unset); export it.
- Move: `setCareerStageForUser` from `routes/assistant.js` (~242-247) to `server/lib/careerStage.js`; both routes import it.
- Test: `server/test/profile-api.test.js`

**Interfaces:**
- Produces:
  - `GET /api/profile` returns
    `{ firstName, lastName, email, pendingEmail, careerStage, nmlsId, orgNmlsId, canEditOrg }`.
  - `PUT /api/profile/name { firstName, lastName }`.
    - Each is trimmed. `firstName` is 1-50 chars, `lastName` 0-50, letters, spaces, `'` and `-` only.
    - It returns 400 `"Use letters only in your name"` otherwise.
    - It returns the profile.
  - `PUT /api/profile/career-stage { stage }` uses the valid ids from `coaching.js` via `setCareerStageForUser`, returning 400
    for an unknown stage.
  - `POST /api/profile/email { email }`:
    - The email is lowercased and trimmed, and must be a basic `x@y.z`.
    - It returns 400 if it is the same as the current email, 409 `"That email is already in use"` if taken.
    - It upserts `email_changes` with `crypto.randomBytes(32).toString("hex")` and a 48 h expiry, then sends
      `${APP_URL}/api/profile/email/confirm/<token>`.
    - If not sent, it deletes the row and returns 503 `"Email isn't set up yet"`. Otherwise `{ pendingEmail }`.
  - `GET /api/profile/email/confirm/:token` needs no auth.
    - The token must match `^[0-9a-f]{64}$`, not be expired, and the new email must still be free.
    - It then sets `users.email`, deletes the row, and 302s to `/?emailChanged=1`. Otherwise it 302s to `/?emailChanged=0`.
  - The existing `/nmls` routes stay.

- [ ] **Step 1: Write the failing tests** for each route:
  - success;
  - every 400/409/503 path (stub `sendEmailChange` via `app.set("sendEmailChange", fn)`, a seam read by the route, defaulting
    to `email.sendEmailChange`);
  - an expired token, a reused token, and a taken email at confirm time;
  - an LO cannot change another user (each route acts only on `req.user`);
  - login with the new email works after confirm, and the old email does not.
- [ ] **Step 2: Run** `node --test test/profile-api.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: green.
- [ ] **Step 5: Commit** `feat(profile): name, email change with confirmation link, and tenure`.

### Task 9: Client session — the briefing without autoplay, and "Brief me"

**Files:**
- Modify: `client/src/charli/session.mjs` (`createSession` ~215, `runGreeting` ~349-362, `open` ~366-382, the returned API
  ~513-530)
- Test: `client/src/charli/session.test.mjs`

**Interfaces:**
- Produces:
  - `createSession({ ..., speakGreeting = true })`. With `speakGreeting:false`, the briefing turn is added to history and shown
    but `onSpeak` is not called.
  - The new method `briefMe()` speaks the most recent briefing turn's text through `onSpeak`, whether or not it was already
    spoken.
  - The state gains `briefing: { kind, strip, followUp } | null` from the greeting response.
  - The first `/turn` after a briefing whose `followUp` is non-null carries `followUpRecId: followUp.recId`. Later turns do
    not.

- [ ] **Step 1: Write the failing tests** with `fakeServer`:
  - `open()` with `speakGreeting:false` never calls `onSpeak`, and `getState().briefing.strip.rate30` is set.
  - `briefMe()` calls `onSpeak` once with the briefing text.
  - After a briefing with `followUp.recId = 7`, the next turn's body includes `followUpRecId: 7`, and the turn after that does
    not.
  - The greeting request body still carries `{ greeting:true, rates, localHour, localDate }`.
  - Existing greeting tests (~152-240) stay green with the default `speakGreeting:true`.
- [ ] **Step 2: Run** `cd client && node --test src/charli/session.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd client && npm test`. Expected: green.
- [ ] **Step 5: Commit** `feat(charlie): briefing state and Brief me without autoplay`.

### Task 10: Profile page (client)

**Files:**
- Create: `client/src/profile/profile.mjs` (API calls and validators); `client/src/profile/ProfileView.jsx`
- Move: `CalendarEmailCard`, `NmlsField`, `StageCard` out of `client/src/charli/CharliView.jsx` (~97-327) into
  `client/src/profile/cards.jsx`, unchanged in behaviour. The NMLS fields render in their own Profile section, no longer
  inside the calendar card.
- Modify: `client/src/App.jsx`:
  - the `?google=` return handler (~2001-2008) sets the view to `"profile"`;
  - the sidebar user block (~440-451) becomes a button to `"profile"`.
- Test: `client/src/profile/profile.test.mjs`

**Interfaces:**
- Produces:
  - `validName(first, last)` returns `null` or an error string, with the same rules as Task 8.
  - `validEmail(s)` returns a boolean.
  - `loadProfile(fetch)`, `saveName(fetch, first, last)`, `requestEmailChange(fetch, email)`, `saveStage(fetch, stage)` wrap
    the Task 8 routes and return `{ ok, data | error }`.
  - `ProfileView({ user, ui, onUserChanged })` has these sections, in order:
    - Name;
    - Email (current, plus pending: "Check <new> for a confirmation link");
    - Calendar;
    - Tenure as a loan officer (StageCard);
    - NMLS IDs.

- [ ] **Step 1: Write the failing tests** for the validators (the same accept/reject table as the server tests) and the API
  wrappers (with a fake fetch: 400/409/503 come back as `{ok:false, error}` with the server's message).
- [ ] **Step 2: Run** `node --test src/profile/profile.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `profile.mjs`, `cards.jsx` (a move), and `ProfileView.jsx`.
- [ ] **Step 4: Run** `cd client && npm test`, then a `vite build` (`npx vite build`) to catch JSX errors. Expected: green, and
  the build succeeds.
- [ ] **Step 5: Commit** `feat(profile): profile page with name, email, calendar, tenure and NMLS`.

### Task 11: Charlie home, nav, Overview, strip and the corner panel

**Files:**
- Create: `client/src/nav.mjs`
- Modify: `client/src/App.jsx`:
  - `Sidebar` ~385-458 (use `navItems`);
  - the `view` default ~1987 (`"home"`);
  - the renders ~2160-2170 (`"home"` renders `CharliView mode="home"`, `"overview"` renders the existing `Dashboard`
    unchanged, `"profile"` renders `ProfileView`);
  - a corner Charlie button on every view except home, which opens a `CharliView mode="panel"` drawer.
- Modify: `client/src/charli/CharliView.jsx`:
  - a `mode` prop (`"home"` | `"panel"`);
  - home: briefing text in the centre, a large Talk button, a "Brief me" button (calls `session.briefMe()`), and a strip from
    `getState().briefing.strip`;
  - the session is created with `speakGreeting:false`;
  - the mic starts only on a Talk tap;
  - on narrow screens (< 640px) the strip is hidden.
- Test: `client/src/nav.test.mjs`

**Interfaces:**
- Produces: `navItems(role)` returns the ordered array of `{ id, label, icon }`:
  `home "Home", sweeps "Sweeps", clients "All Clients", rates "Rate Watch", overview "Overview", add "Add Client"`. For
  `role === "broker"` it also has `team`, `import`. The bottom item is `profile "Profile"`. There is no `charli` item.
  `DEFAULT_VIEW = "home"`.

- [ ] **Step 1: Write the failing tests:**
  - `navItems("lo")` has no `charli` and starts with `home`.
  - The last item is `profile`.
  - A broker gets `team` and `import`.
  - `DEFAULT_VIEW === "home"`.
- [ ] **Step 2: Run** `node --test src/nav.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `nav.mjs`, then the App and CharliView changes. The keep-session behaviour (`keep.mjs`) is
  unchanged: home and the panel share one session.
- [ ] **Step 4: Run** `cd client && npm test` and `npx vite build`. Expected: green, and the build succeeds.
- [ ] **Step 5: Manual check, recorded in the report** with the local previews `broker-radar-api-google` /
  `broker-radar-client-google` (or the main-checkout equivalents):
  - login lands on Home with the briefing text and no audio;
  - "Brief me" speaks;
  - the mic is idle until Talk is tapped;
  - the corner button on Sweeps opens the same conversation;
  - Overview shows the old dashboard;
  - Profile works.

  Attach screenshots.
- [ ] **Step 6: Commit** `feat(charlie): Charlie is the main page; Overview and the corner panel`.

---

## Done for phase 1

- All 11 tasks are complete, with the server and client suites green and `--dry` clean.
- Success counts (spec §8) need no new metric code in phase 1. They come from existing rows, with no client data in any metric:
  - briefings opened = greeting `turn` usage rows;
  - list calls logged = `contact_log` rows joined to resolved recommendations;
  - follow-ups booked = `assistant_confirmations` `createEvent` rows titled `Follow-up:`.
- A final whole-branch review on the most capable model.
- A paid eval run (Bill's go; it covers the new follow-up cases).
- Bill's local live check, then merge, push and deploy, each on Bill's go.
