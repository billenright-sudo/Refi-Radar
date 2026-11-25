# Rate-Drop Pings Implementation Plan (Charlie phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the FRED national-average 30-year falls by a broker's chosen drop size, Broker Radar sends that broker one
code-written, market-news-only ping (phone notification and/or email) outside their quiet hours, with the settings on the Profile
page.

**Architecture:** A Cloud Scheduler job calls `POST /internal/rate-check` (shared-secret header). The route fetches FRED only,
records the observation in `rate_snapshots`, computes the drop with the SAME rule and the SAME rounded numbers the briefing uses
(`server/lib/rateDrop.js`), and for each opted-in, unlocked user decides send / hold / skip in their own time zone; a per-user,
per-observation claim row makes every retry or double call a no-op. Web push goes through a service worker at `/sw.js` (scope `/`);
email goes through the existing Gmail sender. With the secrets unset everything answers "not available" and nothing else changes.

**Tech stack:** Node 20 (`C:/Users/bille/dev/node20`), Express 4, better-sqlite3, nodemailer, `node --test`; React 18 + Vite 5
(`client/public/` is copied to the build root as-is), `node --test` for `client/src/**/*.test.mjs`. One new server dependency only
if Bill says yes (Task 5).

**Spec:** `docs/superpowers/specs/2026-10-30-charlie-morning-briefing-design.md`: §2 items 3-6 and 10, G3, G5, §4 anti-goals, §5.2
(the drop line), §5.3, §5.5 Notifications, §6 (`user_alert_settings`, `push_subscriptions`, `rate_alerts_sent`), §7, §8.

**Worktree:** `C:\Users\bille\dev\refi-radar-pings`, branch `feature/rate-drop-pings`, off `9c7f2bc`. Before Task 1 run `npm ci` in
`server/` and `client/` with `PATH=/c/Users/bille/dev/node20:$PATH` (better-sqlite3 is built for Node 20; the system Node is 24).
Every command below runs with that PATH. Server tests: `cd server && node --test test/<file>`; client: `cd client && node --test src/<path>`.

## Global Constraints

- No LLM computes or writes any number or any ping text: ping text is code-written from FRED data.
- No client data in a ping, push payload, email subject or log line.
- Pings default OFF per user; only real FRED data triggers one; at most one per user per observation date; quiet hours / weekdays honoured in the user's chosen time zone.
- Every secret is referenced by env var name only; the builder generates throwaway VAPID keys inside tests only and never writes keys to disk in the repo.
- New npm dependency: only if truly needed (a web-push library). It is Bill's decision (Task 5); until he says yes, build against the injected `webpush` seam and leave `package.json` unchanged.
- Test-first tasks; all tests offline (injected fetch / fake push sender / fake clock); sample data only, no real people.
- No deploy steps are performed by the builder. The owner's go-live checklist is at the end; he runs it himself, one step at a time.
- Do not edit `CLAUDE.md`, Terms or Privacy text (`client/src/legal/*.mjs`): the sentences that need Bill's OK are listed at the end.

Repo rules this plan also carries:
- The ping and the briefing never contradict each other. One rule (`rateDrop.marketMove` + `rateDrop.isDrop`), one rounding (two
  decimals, as `tools.getMarketUpdate` gives the briefing), one "since" label (the previous observation's own date, never "since
  yesterday": `rateHistory.sinceLabel`, final review I6).
- Only a `fred` snapshot acts (`rate_snapshots.provider = 'fred'`, or `''` read by `providerOf`). The rate check never calls the
  Claude web search (neither the ARM search nor the fallback) and never stores the hard-coded estimate.
- A failure is logged by a fixed label and `errName(err)` or an HTTP status code only: never `err.message` from a push service,
  never an endpoint URL, a user email or a user id. The run log is one line of counts and market figures.
- Instants are SQLite UTC text `YYYY-MM-DD HH:MM:SS`; days are `YYYY-MM-DD`; compares are string compares.
- Migrations are idempotent `CREATE TABLE IF NOT EXISTS` in `server/db.js` (one instance, SQLite on GCS FUSE, `--max-instances 1`).
- Match the file's existing style (CommonJS server, ESM `.mjs` client logic with no DOM, React views thin). No restyle of approved
  layout: the Notifications card reuses the Profile page's existing card look.

## Review Focus

1. **Scheduler retry / double call.** Cloud Scheduler can retry, Bill can press "Force run", and two calls can overlap. Guarded twice:
   an in-process single-flight (second call answers 409 while one runs) and `rate_alerts_sent` claim-before-send (`INSERT OR IGNORE`,
   UNIQUE(user_id, observation_date)). A claim is released only when no channel delivered, so a transient failure is retried at the
   next run and a success is never repeated. Reviewer: try to find any path that sends before the claim or releases after a success.
2. **DST and quiet hours.** "Allowed now" is decided from the wall clock in the user's zone at the instant of each run (never a
   stored "next allowed" instant), so DST needs no special case; the tests pin both 2026-11-01 and 2027-03-14. The push TTL is the
   time left until the user's quiet hours start, so a phone that is offline cannot receive the ping at night.
3. **A FRED revision of yesterday's number, or a gap.** The drop is measured against OUR stored previous observation (that is what
   the briefing says). Before any ping, FRED's own previous 30-year observation must have the same date as the stored one and be
   within 0.005 of it; otherwise the drop is "unconfirmed" and nobody is pinged (the briefing still reports the move it can see).
   A same-day revision of the current observation re-records the snapshot; a ping already sent stays sent (it was true when sent).
4. **A dead push endpoint.** 404/410 from the push service deletes that subscription; 429/5xx/timeouts keep it and count as a
   failed channel. Endpoints are accepted only on an allowlist of push-service hosts, because the server POSTs to them (SSRF).
5. **Weekend or night hold, then the drop reverses.** Only the LATEST FRED observation can ping, and only while it still clears the
   user's threshold against the previous one, is no more than 4 days old, and the run's own FRED fetch succeeded. A Friday drop held
   to Monday is dropped silently if Monday's observation arrives first and is not itself a drop.

---

## Task 1: Tables and the per-user alert settings

**Files**
- Modify: `server/db.js` (three tables after `user_briefing_state`)
- Create: `server/lib/pings/settings.js`
- Test: `server/test/ping-settings.test.js`

**Interfaces**
- Consumes: `cleanTimeZone(value)` (`server/lib/timeZone.js`); `google_connections.time_zone`; `users.time_zone`.
- Produces:
  - tables: `user_alert_settings(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0,
    threshold REAL NOT NULL DEFAULT 0.125, quiet_start TEXT NOT NULL DEFAULT '20:00', quiet_end TEXT NOT NULL DEFAULT '07:00',
    weekdays_only INTEGER NOT NULL DEFAULT 1, channels TEXT NOT NULL DEFAULT 'push' CHECK(channels IN ('push','email','both')),
    time_zone TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`;
    `push_subscriptions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`;
    `rate_alerts_sent(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, observation_date TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('sending','sent')), sent_at TEXT NOT NULL,
    UNIQUE(user_id, observation_date))`.
  - `DEFAULTS = { enabled: false, threshold: 0.125, quietStart: "20:00", quietEnd: "07:00", weekdaysOnly: true, channels: "push", timeZone: null }`
  - `parseSettings(body) -> { value: Settings } | { error: string }`
  - `getSettings(db, userId) -> Settings` (stored row, else `DEFAULTS`; `timeZone` resolved: stored ?? Google's ?? `users.time_zone` ?? null)
  - `saveSettings(db, userId, value) -> Settings`
  - `zoneFor(db, userId) -> string` (as `getSettings(...).timeZone`, else `"America/New_York"`)
  - `thresholdFor(db, userId) -> number` (stored threshold, else 0.125; used by the briefing for every user, pings on or off)

**Steps**
- [ ] Write the failing tests (temp `DATA_DIR`, as `targets-api.test.js` sets it up):
  ```js
  test("a user with no row gets the defaults: off", () => {
    assert.deepEqual(S.getSettings(db, annId), { ...S.DEFAULTS, timeZone: null });
    assert.equal(S.thresholdFor(db, annId), 0.125);
    assert.equal(S.zoneFor(db, annId), "America/New_York");
  });
  test("the zone falls back to the Google calendar's, then the sign-up one", () => {
    db.prepare("UPDATE users SET time_zone = 'America/Denver' WHERE id = ?").run(annId);
    assert.equal(S.zoneFor(db, annId), "America/Denver");
    insertGoogle(annId, "America/Chicago");   // a google_connections row, fake tokens
    assert.equal(S.zoneFor(db, annId), "America/Chicago");
  });
  test("parseSettings accepts the four drop sizes only and checks every field", () => {
    const ok = { enabled: true, threshold: 0.25, quietStart: "21:30", quietEnd: "06:45", weekdaysOnly: false, channels: "both", timeZone: "america/los_angeles" };
    assert.deepEqual(S.parseSettings(ok).value, { ...ok, timeZone: "America/Los_Angeles" });
    assert.equal(S.parseSettings({ ...ok, threshold: 0.1 }).error, "Choose a drop size of 0.125, 0.25, 0.375 or 0.5.");
    assert.equal(S.parseSettings({ ...ok, quietStart: "9pm" }).error, "Quiet hours are times like 20:00.");
    assert.equal(S.parseSettings({ ...ok, quietEnd: "24:00" }).error, "Quiet hours are times like 20:00.");
    assert.equal(S.parseSettings({ ...ok, channels: "sms" }).error, "Choose phone, email or both.");
    assert.equal(S.parseSettings({ ...ok, timeZone: "+05:00" }).error, "Choose a time zone from the list.");
    assert.equal(S.parseSettings({ ...ok, enabled: "yes" }).error, "Something in these settings isn't valid.");
  });
  test("saveSettings round-trips and a second save replaces the first", () => { /* save ok, save {..., threshold: 0.5}; getSettings -> threshold 0.5, one row */ });
  test("rate_alerts_sent allows one row per user and observation date", () => {
    const ins = db.prepare("INSERT INTO rate_alerts_sent (user_id, observation_date, status, sent_at) VALUES (?, ?, 'sent', '2026-11-24 15:00:00')");
    ins.run(annId, "2026-11-24");
    assert.throws(() => ins.run(annId, "2026-11-24"), /UNIQUE/);
    ins.run(annId, "2026-11-25"); ins.run(bobId, "2026-11-24");
  });
  ```
- [ ] Run `node --test test/ping-settings.test.js`: fails with `Cannot find module '../lib/pings/settings'`.
- [ ] Implement: the three `CREATE TABLE IF NOT EXISTS` blocks with a comment each (house style); create `server/lib/rateDrop.js`
  now with only `DEFAULT_THRESHOLD = 0.125` and `THRESHOLDS = [0.125, 0.25, 0.375, 0.5]` (Task 2 adds its functions), and
  `settings.js` requiring them; `HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/`, booleans must be `typeof === "boolean"`, the zone through `cleanTimeZone` (null allowed).
- [ ] Run to pass; run the whole server suite (`node --test`) to see the migrations break nothing.
- [ ] Commit: `feat(pings): alert settings, push subscription and sent-ping tables`

## Task 2: One drop rule for the ping and the briefing

**Files**
- Modify: `server/lib/rateDrop.js` (Task 1 made it with the constants), `server/lib/assistant/briefing.js` (`marketSection` only)
- Test: `server/test/rate-drop.test.js`; extend `server/test/briefing.test.js`

**Interfaces**
- Consumes: `getMovement(rates, provider)` result shape (`server/lib/rateHistory.js`); `thresholdFor` (Task 1).
- Produces:
  - `DEFAULT_THRESHOLD = 0.125`, `THRESHOLDS = [0.125, 0.25, 0.375, 0.5]`
  - `marketMove(movement) -> { rate30, move30, obsDate, sinceDate } | null`: the 30-year and its move rounded to two decimals
    exactly as `tools.getMarketUpdate` rounds them (`Number(v.toFixed(2))`); null without history, a finite 30-year delta, or real
    `YYYY-MM-DD` dates.
  - `isDrop(move30, threshold) -> boolean`: `Number.isFinite(move30) && move30 <= -threshold`. On two-decimal moves this is exactly
    "fell by the threshold or more" for all four sizes (0.125 and 0.375 round half up to 0.13 / 0.38).
  - briefing: `DROP_THRESHOLD` stays exported (= `DEFAULT_THRESHOLD`) for its existing tests; the lead uses the user's threshold.

**Steps**
- [ ] Failing tests:
  ```js
  test("marketMove rounds as the briefing's market tool does", () => {
    const mv = { current: { rate_30yr_fixed: 6.402, date: "2026-11-24" }, deltas: { rate_30yr_fixed: -0.1531 }, hasHistory: true, sinceDate: "2026-11-21" };
    assert.deepEqual(D.marketMove(mv), { rate30: 6.4, move30: -0.15, obsDate: "2026-11-24", sinceDate: "2026-11-21" });
    assert.equal(D.marketMove({ ...mv, deltas: { rate_30yr_fixed: -0.125 } }).move30, -0.13);
    assert.equal(D.marketMove({ ...mv, hasHistory: false, deltas: null }), null);
    assert.equal(D.marketMove({ ...mv, current: { ...mv.current, date: "2026-02-30" } }), null);
  });
  test("isDrop: at or past the size, never a rise", () => {
    for (const [m, t, want] of [[-0.13, 0.125, true], [-0.12, 0.125, false], [-0.25, 0.25, true], [-0.37, 0.375, false],
      [-0.38, 0.375, true], [-0.5, 0.5, true], [0.2, 0.125, false], [null, 0.125, false]]) assert.equal(D.isDrop(m, t), want, `${m} vs ${t}`);
  });
  // briefing.test.js: snapshots fred 6.555 (obs 2026-11-21, capture 2026-11-21) and 6.402 (obs 2026-11-24, capture 2026-11-25)
  test("the drop lead follows the user's own drop size", async () => {
    const a = await buildBriefing({ user: ann, ctx: ctxWith(obs24), db, localHour: 8, localDate: "2026-11-25", nowMs: NOV25_13Z });
    assert.match(a.reply, /Rates dropped: the 30-year is at 6\.4%, down 0\.15 since November 21st, as of November 24th\./);
    saveSettings(db, bob.id, { ...DEFAULTS, threshold: 0.25 });
    const b = await buildBriefing({ user: bob, /* same */ });
    assert.doesNotMatch(b.reply, /Rates dropped/);
    assert.match(b.reply, /The 30-year is at 6\.4%, down 0\.15 since November 21st, as of November 24th\./);
  });
  ```
- [ ] Run: `rate-drop.test.js` fails on the missing module; the briefing case fails on Bob (lead still at 0.125).
- [ ] Implement `rateDrop.js`; in `marketSection` replace `move30 <= -DROP_THRESHOLD` with
  `isDrop(move30, pingSettings.thresholdFor(db, userId))` (a throw there falls back to `DEFAULT_THRESHOLD`; the section never fails on it).
- [ ] Run to pass, plus `briefing*.test.js` and `followups.test.js` unchanged.
- [ ] Commit: `feat(briefing): the drop lead uses the shared rule and the user's drop size`

## Task 3: FRED-only fetch, the rates cache, and recording an observation

**Files**
- Create: `server/lib/fred.js`, `server/lib/ratesCache.js`
- Modify: `server/routes/rates.js` (uses both; behaviour unchanged), `server/lib/rateHistory.js` (adds `recordFredObservation`)
- Test: `server/test/fred.test.js`; `server/test/rates.test.js` must pass unchanged, plus one cache case

**Interfaces**
- Produces:
  - `fetchFredObservations({ fredKey, fetchImpl = fetch, timeoutMs = 10000 }) -> Promise<{ obmmi: {[key]: {date, value}}, va: {date, value} | null, previous30: {date, value} | null }>`
    (the same five OBMMI series + VA as today; `previous30` = the second valid 30-year observation of the same `limit=5` reply;
    throws on any OBMMI failure, as today; VA failure gives `va: null`, as today)
  - `fredRateSet(obs, { arm, armSource }) -> rates` (the exact object `POST /api/rates` builds today, `source: "Optimal Blue lock data (<date>) · <armSource>"`)
  - `sameObservation(obs) -> boolean` (every OBMMI series carries the 30-year's date; a partial publish is false)
  - `ratesCache.get() / set(payload) / clear()` (the 6-hour, same-UTC-day cache moved out of the route as is)
  - `recordFredObservation(rates, nowMs) -> "new" | "revised" | "same" | "older"`: compares with `targets.latestRealSnapshot`;
    writes `recordSnapshot(rates, <UTC day of nowMs>, "fred")` only for "new" and "revised" ("same" keeps a stored web-searched ARM).

**Steps**
- [ ] Failing tests with a `fetchImpl` that answers FRED JSON per `series_id` and records every URL:
  ```js
  test("fetchFredObservations reads the latest two 30-year observations, skipping '.'", async () => {
    const obs = await F.fetchFredObservations({ fredKey: "k", fetchImpl: fakeFred({ OBMMIC30YF: [["2026-11-25", "."], ["2026-11-24", "6.402"], ["2026-11-21", "6.555"]] }) });
    assert.deepEqual(obs.obmmi.rate_30yr_fixed, { date: "2026-11-24", value: 6.402 });
    assert.deepEqual(obs.previous30, { date: "2026-11-21", value: 6.555 });
  });
  test("only api.stlouisfed.org is called", async () => { /* every recorded URL starts with https://api.stlouisfed.org/fred/ */ });
  test("a partial publish is not one observation", () => { assert.equal(F.sameObservation(withFifteenYearOn("2026-11-21")), false); });
  test("recordFredObservation: new, same, revised, older", () => {
    assert.equal(recordFredObservation(set("2026-11-24", 6.402), NOV25_15Z), "new");
    const before = snapshotRow("2026-11-25");
    assert.equal(recordFredObservation(set("2026-11-24", 6.402), NOV25_16Z), "same");
    assert.deepEqual(snapshotRow("2026-11-25"), before);
    assert.equal(recordFredObservation(set("2026-11-24", 6.39), NOV25_17Z), "revised");
    assert.equal(recordFredObservation(set("2026-11-21", 6.555), NOV25_18Z), "older");
    assert.equal(JSON.parse(snapshotRow("2026-11-25").rates).rate_30yr_fixed, 6.39);
  });
  // rates.test.js, added:
  test("a cleared cache is not served", async () => { ratesCache.set(PAYLOAD); /* POST -> cached: true */ ratesCache.clear(); /* POST -> no `cached` key */ });
  ```
- [ ] Run: fails on the missing modules.
- [ ] Implement by moving code out of `routes/rates.js` (no behaviour change there: same series, same ARM search, same fallback,
  same snapshot calls). "revised" = same observation date, any OBMMI number different.
- [ ] Run to pass with `rates.test.js`, `rate-history.test.js`, `targets*.test.js`.
- [ ] Commit: `refactor(rates): FRED fetch and the rates cache as modules; record one FRED observation`

## Task 4: When a ping may go, and its words (pure)

**Files**
- Create: `server/lib/pings/schedule.js`, `server/lib/pings/text.js`
- Modify: `server/lib/google/time.js` (export `wallClock(timeZone, ms) -> { date, minutes, weekday }` built on `wallParts`; weekday 0 = Sunday)
- Test: `server/test/ping-schedule.test.js`

**Interfaces**
- Consumes: `isDrop` (Task 2), `Settings` (Task 1), `sinceLabel(day, today)` (`rateHistory.js`).
- Produces:
  - `STALE_DAYS = 4`
  - `allowedNow(settings, zone, nowMs) -> boolean` (not in quiet hours, and not Sat/Sun when `weekdaysOnly`; quiet start inclusive,
    end exclusive; a window that wraps midnight; `quietStart === quietEnd` means no quiet hours)
  - `ttlSeconds(settings, zone, nowMs) -> number` (seconds to the next quiet start, clamped 60..43200)
  - `pingDecision({ settings, zone, drop, accessOk, nowMs }) -> "off" | "locked" | "below" | "stale" | "hold" | "send"` (in that order)
  - `pingText(drop, localDate) -> { title, body, url: "/", tag: "rate-drop" }`
  - `TEST_TEXT = { title: "Broker Radar", body: "Test notification: rate-drop pings will arrive on this device.", url: "/", tag: "rate-drop-test" }`

**Steps**
- [ ] Failing tests (NY unless said; `D = DEFAULTS` with `enabled: true`):
  ```js
  const drop = { rate30: 6.4, move30: -0.15, obsDate: "2026-11-24", sinceDate: "2026-11-21" };
  const at = (iso) => Date.parse(iso);
  test("quiet hours in the user's zone", () => {
    assert.equal(allowedNow(D, NY, at("2026-11-24T23:30:00Z")), true);    // Tue 18:30 EST
    assert.equal(allowedNow(D, NY, at("2026-11-25T01:00:00Z")), false);   // 20:00, start inclusive
    assert.equal(allowedNow(D, NY, at("2026-11-25T11:59:00Z")), false);   // 06:59
    assert.equal(allowedNow(D, NY, at("2026-11-25T12:00:00Z")), true);    // 07:00, end exclusive
    assert.equal(allowedNow(D, "America/Los_Angeles", at("2026-11-25T12:00:00Z")), false);  // 04:00 PST
    assert.equal(allowedNow({ ...D, quietStart: "12:00", quietEnd: "13:00" }, NY, at("2026-11-24T17:30:00Z")), false);
    assert.equal(allowedNow({ ...D, quietStart: "00:00", quietEnd: "00:00" }, NY, at("2026-11-25T08:00:00Z")), true);
  });
  test("DST: the same UTC instant is quiet before the change and allowed after", () => {
    assert.equal(allowedNow(D, NY, at("2027-03-12T11:30:00Z")), false);   // Fri 06:30 EST
    assert.equal(allowedNow(D, NY, at("2027-03-15T11:30:00Z")), true);    // Mon 07:30 EDT
    assert.equal(allowedNow(D, NY, at("2026-10-30T11:30:00Z")), true);    // Fri 07:30 EDT
    assert.equal(allowedNow(D, NY, at("2026-11-02T11:30:00Z")), false);   // Mon 06:30 EST
  });
  test("weekends", () => {
    assert.equal(allowedNow(D, NY, at("2026-11-28T15:00:00Z")), false);
    assert.equal(allowedNow({ ...D, weekdaysOnly: false }, NY, at("2026-11-28T15:00:00Z")), true);
  });
  test("ttlSeconds runs to the quiet start", () => { assert.equal(ttlSeconds(D, NY, at("2026-11-24T23:30:00Z")), 5400); });
  test("pingDecision order", () => {
    const now = at("2026-11-24T15:00:00Z");
    assert.equal(pingDecision({ settings: { ...D, enabled: false }, zone: NY, drop, accessOk: true, nowMs: now }), "off");
    assert.equal(pingDecision({ settings: D, zone: NY, drop, accessOk: false, nowMs: now }), "locked");
    assert.equal(pingDecision({ settings: { ...D, threshold: 0.25 }, zone: NY, drop, accessOk: true, nowMs: now }), "below");
    assert.equal(pingDecision({ settings: D, zone: NY, drop: { ...drop, obsDate: "2026-11-19" }, accessOk: true, nowMs: now }), "stale");
    assert.equal(pingDecision({ settings: D, zone: NY, drop: { ...drop, obsDate: "2026-11-20" }, accessOk: true, nowMs: now }), "send");
    assert.equal(pingDecision({ settings: D, zone: NY, drop, accessOk: true, nowMs: at("2026-11-25T02:00:00Z") }), "hold");
  });
  test("pingText: the briefing's numbers and dates, market news only", () => {
    assert.deepEqual(pingText(drop, "2026-11-25"), { title: "Rates dropped", url: "/", tag: "rate-drop",
      body: "The national average 30-year is 6.4%, down 0.15 since November 21st (as of November 24th). Open Charlie for a sweep." });
    assert.ok(JSON.stringify(pingText(drop, "2026-11-25")).length < 300);
  });
  ```
- [ ] Run: fails on the missing modules.
- [ ] Implement: decisions read only the wall clock at `nowMs`; "stale" = the UTC date of `nowMs` minus `obsDate` > `STALE_DAYS`
  days; `pingText` uses `sinceLabel(drop.sinceDate, localDate)` and `sinceLabel(drop.obsDate, localDate)` and `Math.abs(move30)`.
- [ ] Run to pass with `google-time.test.js`.
- [ ] Commit: `feat(pings): quiet hours, weekdays, staleness and the ping's words`

## Task 5: The channels: push sender, endpoint allowlist, email, VAPID key script

**Bill decides (before this task):** add `web-push@3.6.7` to `server/package.json` (exact pin, no caret; MIT; supports Node 16+, so
Node 20 is fine; it does the RFC 8291 payload encryption and the RFC 8292 VAPID JWT). Hand-rolling is worse because the parts that
break silently (aes128gcm record padding, ECDH/HKDF key derivation, the ES256 JWT's raw signature encoding, per-browser quirks)
produce pushes that the service accepts and the phone drops, with nothing in our logs. My recommendation: yes.
*No-dependency alternative:* implement `encrypt(payload, p256dh, auth)` and `vapidHeaders(endpoint)` with `node:crypto`
(`createECDH`, `hkdfSync`, `aes-128-gcm`, `sign` with `dsaEncoding: "ieee-p1363"`), pinned by the RFC 8291 Appendix A test
vector; about 120 lines, same `send` interface, so nothing else in this plan changes.

**Files**
- Create: `server/lib/pings/push.js`, `server/scripts/vapid-keys.js`
- Modify: `server/email.js` (adds `rateDropMessage`, `sendRateDrop`, `sendTestPing`), `server/package.json` (only on Bill's yes)
- Test: `server/test/ping-push.test.js`, `server/test/ping-email.test.js`

**Interfaces**
- Produces:
  - `pushConfig(env) -> { enabled, reason, publicKey, privateKey, subject }` (keys base64url: public 65 bytes starting 0x04, private
    32 bytes; subject = `APP_URL` when it is `https://`, else `mailto:<EMAIL_USER>` when set, else off). `reason` strings: `"VAPID keys not set"`,
    `"VAPID keys malformed"`, `"no https APP_URL or EMAIL_USER for the VAPID subject"`. Never includes a key.
  - `isPushEndpoint(url) -> boolean`: `https:` and host is `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
    `web.push.apple.com`, or ends with `.push.apple.com` / `.notify.windows.com`.
  - `createPushSender(config, { webpush }) -> { send(sub, payload, { ttlSeconds }) -> Promise<{ ok: true } | { ok: false, gone: boolean, status: number | null }> }`
    (`webpush` defaults to `require("web-push")`, required lazily inside the function; options passed: `vapidDetails`, `TTL`,
    `urgency: "normal"`, `topic: "rate-drop"`, `timeout: 10000`; 404/410 = gone)
  - `rateDropMessage({ drop, localDate, appUrl }) -> { subject, html }`, `sendRateDrop({ to, drop, localDate }) -> Promise<boolean>`,
    `sendTestPing({ to }) -> Promise<boolean>` (both through the existing deliver path: false when mail is unset or fails)
  - `makeVapidKeys() -> { publicKey, privateKey }` (CLI: private key to stdout only, public key to stderr only; nothing written to disk)

**Steps**
- [ ] Failing tests; VAPID keys are made in the test with `crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })` and JWK
  export, held in memory:
  ```js
  test("pushConfig is off without keys, on with good ones", () => {
    assert.deepEqual(pick(pushConfig({})), { enabled: false, reason: "VAPID keys not set" });
    assert.equal(pushConfig({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: keys.privateKey, APP_URL: "https://x.test" }).reason, "VAPID keys malformed");
    assert.equal(pushConfig({ ...good, APP_URL: "http://localhost:8080" }).reason, "no https APP_URL or EMAIL_USER for the VAPID subject");
    assert.equal(pushConfig({ ...good, APP_URL: "https://x.test" }).enabled, true);
  });
  test("only push-service hosts are endpoints", () => {
    assert.equal(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), true);
    assert.equal(isPushEndpoint("https://web.push.apple.com/QK1"), true);
    assert.equal(isPushEndpoint("http://fcm.googleapis.com/x"), false);
    assert.equal(isPushEndpoint("https://169.254.169.254/latest"), false);
    assert.equal(isPushEndpoint("https://push.apple.com.evil.test/x"), false);
  });
  test("send passes the TTL and topic; 410 is gone, 500 is not", async () => {
    const fake = fakeWebpush([201, 410, 500]);
    const s = createPushSender(cfg, { webpush: fake });
    assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 5400 }), { ok: true });
    assert.equal(fake.calls[0].options.TTL, 5400); assert.equal(fake.calls[0].options.topic, "rate-drop");
    assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: true, status: 410 });
    assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: false, status: 500 });
  });
  test("makeVapidKeys makes a P-256 pair that signs and verifies", () => { /* lengths 87 and 43, first byte 0x04, sign/verify via JWK */ });
  // ping-email.test.js
  test("the rate-drop email carries market news only", () => {
    const m = rateDropMessage({ drop, localDate: "2026-11-25", appUrl: "https://x.test" });
    assert.equal(m.subject, "Rates dropped: the national average 30-year is 6.4%");
    assert.match(m.html, /down 0\.15 since November 21st \(as of November 24th\)/);
    assert.match(m.html, /Turn these off on your Profile page/);
  });
  test("with mail unset, sendRateDrop resolves false and sends nothing", async () => { /* EMAIL_USER unset -> false */ });
  ```
- [ ] Run: fails on the missing modules / exports.
- [ ] Implement as the interfaces say; the email body reuses `pingText` words, escaped with `escapeHtml`, plus the Profile line and
  an `APP_URL` button; the push send logs nothing itself (the caller counts).
- [ ] Run to pass with `signup-email.test.js` and `password-reset-lib.test.js` (the shared deliver path).
- [ ] Commit: `feat(pings): push sender and endpoint allowlist, rate-drop email, VAPID key script`

## Task 6: The rate check (library)

**Files**
- Create: `server/lib/pings/rateCheck.js`
- Test: `server/test/rate-check.test.js`

**Interfaces**
- Consumes: Tasks 1-5; `getMovement(rates, "fred")`; `targets.latestRealSnapshot`; `accessFor`, `orgBilling` (`lib/billing/access.js`);
  `termsCurrent` (`lib/terms.js`); `ratesCache.clear`.
- Produces:
  - `runRateCheck({ db, env, nowMs, fetchImpl, push, mail, billingConfig, deadlineMs = 45000 }) -> Promise<Summary>` where
    `push` is `{ enabled, send }` (null when off), `mail` is `{ enabled, sendRateDrop }` and
    `Summary = { fetched, observation, recorded, drop, sent, held, skipped, failed }` (`drop`: `"none" | "yes" | "unconfirmed"`; counts are integers; nothing else)
  - `claimPing(db, userId, obsDate, nowUtc) -> boolean`, `finishPing(db, userId, obsDate, channel)`, `releasePing(db, userId, obsDate)`

**Algorithm** (not fixed by the signature):
1. `fetchFredObservations`; on a throw, or `!sameObservation`, return with `fetched: false` / `recorded: false` and send nothing.
2. `rates = fredRateSet(obs, { arm: round2(30yr - 0.10), armSource: "ARM estimated" })`; `recordFredObservation`; on "new"/"revised" `ratesCache.clear()`.
3. `movement = getMovement(latestRealSnapshot(db).rates, "fred")`; `drop = marketMove(movement)`. No `isDrop(drop.move30, 0.125)`
   (the smallest size) → `drop: "none"`, return.
4. Confirm: `obs.previous30.date === drop.sinceDate` and `|obs.previous30.value - movement.previous.rate_30yr_fixed| <= 0.005`,
   else `"unconfirmed"`, return.
5. Users: `enabled = 1`, `removed_at IS NULL`, `invite_accepted = 1`. For each, in id order, until `deadlineMs`: `pingDecision`;
   "send" → `claimPing` (false: count skipped) → channels (push to each subscription with `ttlSeconds`, delete `gone` ones; email to
   the user's own login email when `channels` has it and `mail.enabled`) → any channel ok: `finishPing(channel actually used)`, else
   `releasePing` and count failed.
6. One log line: `[pings] obs <obsDate> 30yr <rate30> move <move30>: sent N, held N, skipped N, failed N`.

**Steps**
- [ ] Failing tests (temp DB; snapshot obs 2026-11-21 at 6.555 stored; a FRED fake serving 6.402 for 2026-11-24 with previous
  2026-11-21 6.555; a fake push recording calls; Ann (broker, NY, pings on), her LO Lee (pings on), Bob (pings off); a client
  "Sample Client One" with email `sample.one@example.test` in Ann's book):
  ```js
  test("one drop, one ping per user, a second run sends nothing", async () => {
    const s1 = await run({ nowMs: at("2026-11-24T15:00:00Z") });
    assert.deepEqual(s1, { fetched: true, observation: "2026-11-24", recorded: true, drop: "yes", sent: 2, held: 0, skipped: 0, failed: 0 });
    const s2 = await run({ nowMs: at("2026-11-24T15:30:00Z") });
    assert.equal(s2.sent, 0); assert.equal(push.calls.length, 2);
    assert.deepEqual(sentRow(ann), { channel: "push", status: "sent" });
  });
  test("two overlapping runs still send once", async () => { await Promise.all([run(T), run(T)]); assert.equal(push.calls.length, 2); });
  test("held at night, sent at 07:00, if the drop still stands", async () => {
    assert.equal((await run({ nowMs: at("2026-11-25T02:00:00Z") })).held, 2);
    assert.equal((await run({ nowMs: at("2026-11-25T12:30:00Z") })).sent, 2);
  });
  test("held, then a newer observation that is no drop: nothing is sent", async () => {
    await run({ nowMs: at("2026-11-25T02:00:00Z") });
    fred.serve({ OBMMIC30YF: [["2026-11-25", "6.450"], ["2026-11-24", "6.402"]] });
    const s = await run({ nowMs: at("2026-11-25T21:00:00Z") });
    assert.equal(s.drop, "none"); assert.equal(push.calls.length, 0);
  });
  test("FRED revised the previous day, or skipped one: unconfirmed, nobody pinged", async () => { /* previous30 6.500 -> "unconfirmed"; previous30 date 2026-11-20 -> "unconfirmed" */ });
  test("FRED down: no ping from a stored or web-searched set, and no Claude call", async () => { /* fetchImpl rejects -> fetched false, sent 0; every URL is FRED */ });
  test("a gone endpoint is deleted, the other device still gets it", async () => { /* two subs for Ann: 410 + 201 -> one sub left, Ann's row 'sent' */ });
  test("every channel failing releases the claim, so the next run retries", async () => { /* 500s -> failed 2, no rows; next run with 201s -> sent 2 */ });
  test("a locked brokerage gets nothing", async () => { /* billingConfig { enabled: true }, org billing_status 'canceled' -> skipped 2, no calls */ });
  test("email channel goes to the user's own login email", async () => { /* Ann channels 'email' -> mail.calls[0].to === ann.email, no push call for Ann */ });
  test("no log line carries a client, a user email or an endpoint", async () => {
    const lines = captureConsole(() => run(T));
    for (const l of lines) for (const bad of ["Sample Client One", "sample.one@example.test", ann.email, SUB.endpoint]) assert.ok(!l.includes(bad));
  });
  test("the push payload is the ping text and nothing else", async () => {
    assert.deepEqual(push.calls[0].payload, pingText(drop, "2026-11-24"));
  });
  ```
- [ ] Run: fails on the missing module.
- [ ] Implement per the algorithm; `localDate` for the text is `wallClock(zone, nowMs).date`.
- [ ] Run to pass, then the whole server suite.
- [ ] Commit: `feat(pings): the rate check: FRED only, confirmed drops, claimed sends`

## Task 7: HTTP: the internal route, the Profile settings routes, start-up wiring

**Files**
- Create: `server/routes/internal.js`, `server/routes/alerts.js` (mounted at `/api/profile/alerts`)
- Modify: `server/index.js` (mount both; one start-up log line), `server/routes/profile.js` (GET adds nothing; keep it as is)
- Test: `server/test/internal-api.test.js`, `server/test/alerts-api.test.js`

**Interfaces**
- `POST /internal/rate-check`, header `X-Rate-Check-Secret`: `RATE_CHECK_SECRET` unset or shorter than 32 characters → 404
  `{ success: false, error: "not available" }`; wrong header → 403 `{ success: false }`; a run in flight → 409 `{ success: false, busy: true }`;
  else 200 `{ success: true, ...Summary }`. Compare with `crypto.timingSafeEqual` on SHA-256 digests. Limiter 10 a minute.
  Seams: `app.get("rateCheckEnv")`, `app.get("rateCheckDeps")` (`{ fetchImpl, push, mail, now }`) as `profileEnv` / `sendEmailChange`.
- Under `requireAuth` (not billing-gated, like the rest of Profile):
  - `GET /api/profile/alerts -> { settings, available: { push, email }, vapidPublicKey, devices }`
  - `PUT /api/profile/alerts { ...settings } -> same shape`; 400 with Task 1's messages; turning on a channel that is not available
    → 400 `"Phone notifications aren't available yet. Choose email."` / `"Email notifications aren't available yet."`
  - `POST /api/profile/alerts/devices { endpoint, keys: { p256dh, auth } } -> { devices }`; 400 `"That device can't get notifications."`
    unless `isPushEndpoint` and p256dh = 65 bytes / auth = 16 bytes base64url; an endpoint already stored moves to this user; at
    most 10 per user (the oldest goes).
  - `DELETE /api/profile/alerts/devices { endpoint } -> { devices }` (only the caller's own rows)
  - `POST /api/profile/alerts/test -> { sent }` (TEST_TEXT to the caller's devices and/or email per channels; 3 an hour per user;
    503 `"Notifications aren't available yet."` when neither channel is)
- Start-up line: `[pings] rate check on|off (<reason>), push on|off (<reason>), email on|off`. Reasons only, never values.
- `RATE_CHECK_SECRET`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are read with surrounding whitespace trimmed (as `mailPass` does
  for `EMAIL_PASS`): a secret piped in from a shell can end in a newline.

**Steps**
- [ ] Failing tests:
  ```js
  test("not available without the secret", async () => { assert.equal((await post("/internal/rate-check", {})).status, 404); });
  test("403 on a wrong secret, 200 with counts only on the right one", async () => {
    app.set("rateCheckEnv", { RATE_CHECK_SECRET: SECRET32 });
    assert.equal((await post("/internal/rate-check", { "x-rate-check-secret": "nope" })).status, 403);
    const r = await post("/internal/rate-check", { "x-rate-check-secret": SECRET32 });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["drop", "failed", "fetched", "held", "observation", "recorded", "sent", "skipped", "success"]);
  });
  test("a second call while one runs is 409", async () => { /* deps.fetchImpl waits on a gate; second post -> 409 busy */ });
  test("GET alerts: defaults off, push unavailable without keys", async () => {
    assert.deepEqual((await get("/api/profile/alerts")).body, { settings: { ...DEFAULTS, timeZone: null }, available: { push: false, email: false }, vapidPublicKey: null, devices: 0 });
  });
  test("PUT refuses a channel that is not available", async () => { /* push off: enabled + 'push' -> 400 exact message */ });
  test("devices: allowlist, ownership, cap of 10", async () => { /* bad host 400; 11 adds -> devices 10; Lee's DELETE of Ann's endpoint leaves Ann's */ });
  test("an unauthenticated call is 401", async () => { /* no cookie -> 401 on every alerts route */ });
  ```
- [ ] Run: fails (404s for the unmounted routes).
- [ ] Implement thin routes over Tasks 1, 5 and 6; `index.js` mounts `/internal` before the SPA fallback (it is POST-only, so the
  `app.get("*")` fallback is unaffected) and builds `push` / `mail` once at start from `pushConfig(process.env)` / `mailReady(process.env)`.
- [ ] Run to pass, then the whole server suite.
- [ ] Commit: `feat(pings): internal rate-check route, Profile alert routes, start-up wiring`

## Task 8: Client: service worker, manifest, push logic

**Files**
- Create: `client/public/sw.js` (classic script, served at `/sw.js`, scope `/`), `client/public/manifest.webmanifest`,
  `client/public/icon.svg` (the existing `RefiRadarLogo` mark on navy, pending Bill's artwork call), `client/src/push/push.mjs`,
  `client/src/push/push.test.mjs`, `client/src/push/sw.test.mjs`
- Modify: `client/index.html` (`<link rel="manifest" href="/manifest.webmanifest">`, `<meta name="theme-color" content="#15294f">`;
  leave the stray `client/public/index.html` alone), `client/package.json` (add `src/push/` to the `test` script),
  `server/index.js` (`express.static(CLIENT_BUILD, { setHeaders })`: `Cache-Control: no-cache` for `sw.js` and `manifest.webmanifest`)

**Interfaces**
- `sw.js`: `install` → `skipWaiting()`; `activate` → `clients.claim()`; `push` → `showNotification(title ≤ 60 chars, { body ≤ 240, tag, icon: "/icon.svg", data: { url: "/" } })`
  from the JSON payload (anything unreadable shows `"Broker Radar"` / `"Open Charlie for today's market update."`); the payload's
  `url` is ignored (always `/`: no open redirect); `notificationclick` → navigate an open window to `/` and focus it, else
  `openWindow("/")` (a reload, so the briefing is rebuilt with fresh rates and leads with the drop). No `fetch` handler, no caching.
- `push.mjs` (no DOM; every browser object injected):
  - `pushSupport({ navigator, window }) -> "ready" | "ios_home_screen" | "unsupported" | "blocked"`
  - `keyToBytes(base64url) -> Uint8Array`, `deviceBody(subscription) -> { endpoint, keys: { p256dh, auth } }`
  - `loadAlerts(fetchFn)`, `saveAlerts(fetchFn, settings)`, `addDevice(fetchFn, body)`, `removeDevice(fetchFn, endpoint)`, `sendTest(fetchFn)`
    (the `profile.mjs` answer pattern: `{ ok, data } | { error }`)
  - `enablePush({ navigator, Notification, vapidPublicKey, fetchFn }) -> { ok: true } | { error }` (asks permission: call it from a tap
    only; registers `/sw.js` with `{ scope: "/" }`; `subscribe({ userVisibleOnly: true, applicationServerKey })`; posts the device)
  - `resyncPush(...)`: on app load, only when permission is already `"granted"` and pings are on: re-posts the current subscription; never prompts.
  - copy: `IOS_STEP`, `BLOCKED`, `UNSUPPORTED`, `WHAT_YOU_GET` (Task 9 shows them; wording below).

**Steps**
- [ ] Failing tests:
  ```js
  // sw.test.mjs: runs public/sw.js in node:vm with a fake `self`
  test("push shows the ping and always opens /", async () => {
    await fire("push", { json: () => ({ title: "Rates dropped", body: "The national average 30-year is 6.4%…", url: "https://evil.example/", tag: "rate-drop" }) });
    assert.deepEqual(shown[0], ["Rates dropped", { body: "The national average 30-year is 6.4%…", tag: "rate-drop", icon: "/icon.svg", data: { url: "/" } }]);
  });
  test("an unreadable push still shows the generic notice", async () => { /* json throws -> ["Broker Radar", { body: "Open Charlie for today's market update.", ... }] */ });
  test("click reuses an open window, else opens one", async () => { /* one client -> navigate('/') then focus; none -> openWindow('/') */ });
  // push.test.mjs
  test("pushSupport", () => {
    assert.equal(pushSupport(env({ ua: IPHONE_SAFARI, standalone: false })), "ios_home_screen");
    assert.equal(pushSupport(env({ ua: IPHONE_SAFARI, standalone: true, push: true, permission: "default" })), "ready");
    assert.equal(pushSupport(env({ ua: ANDROID_CHROME, push: true, permission: "denied" })), "blocked");
    assert.equal(pushSupport(env({ ua: OLD_BROWSER, push: false })), "unsupported");
  });
  test("deviceBody takes only the endpoint and the two keys", () => { /* toJSON with expirationTime + extra -> exactly { endpoint, keys: { p256dh, auth } } */ });
  test("resyncPush never asks for permission", async () => { /* permission 'default' -> requestPermission not called, no POST */ });
  ```
- [ ] Run `node --test src/push/`: fails on the missing files.
- [ ] Implement; after `npx vite build`, check that `build/sw.js`, `build/manifest.webmanifest` exist and `build/index.html` has the manifest link.
- [ ] Run to pass, then `npm test` in `client/`.
- [ ] Commit: `feat(client): service worker, manifest and push logic for rate-drop pings`

## Task 9: Client: the Notifications card on the Profile page

**Files**
- Create: `client/src/profile/NotificationsCard.jsx`, `client/src/profile/notifications.mjs`, `client/src/profile/notifications.test.mjs`
- Modify: `client/src/profile/ProfileView.jsx` (render the card after `ConnectionsCard`), `client/src/App.jsx` (one effect after
  sign-in that calls `resyncPush`; nothing else)

**Interfaces**
- `notifications.mjs`: `cardState({ alerts, support }) -> { channelChoices, showIosStep, note, canTest }`,
  `formToSettings(form, browserZone) -> Settings` (a null zone becomes the browser's), `zoneChoices(current, browserZone) -> string[]`.
- The card: on/off, drop size (0.125, 0.25, 0.375, 0.5 shown as "0.125 (an eighth)" etc.), quiet hours (two time inputs), weekdays
  only, channel (only the available ones), time zone (select), "Send a test" when on, and the copy below. Turning on with the phone
  channel calls `enablePush` from that tap.
- Copy, verbatim (Bill may change it):
  - `WHAT_YOU_GET`: "Market news only: a note when the national average 30-year falls by your drop size. Never a client's name. At most one per rate update, and never in your quiet hours."
  - `IOS_STEP`: "On iPhone or iPad, phone notifications work only after you add Broker Radar to your Home Screen: tap Share, then Add to Home Screen (iOS 16.4 or later). Open Broker Radar from that icon and turn notifications on here. Until then you can choose email."
  - `BLOCKED`: "Notifications are blocked for Broker Radar in this browser's settings. Allow them there, or choose email."
  - `UNSUPPORTED`: "This browser can't show phone notifications. You can choose email instead."
  - not available at all: "Rate-drop notifications aren't switched on for Broker Radar yet."

**Steps**
- [ ] Failing tests:
  ```js
  test("iOS in Safari: the one-step note, and only email offered", () => {
    const s = cardState({ alerts: alerts({ push: true, email: true }), support: "ios_home_screen" });
    assert.deepEqual(s.channelChoices, ["email"]); assert.equal(s.showIosStep, true);
  });
  test("nothing available: the card says so and offers nothing", () => {
    assert.deepEqual(cardState({ alerts: alerts({ push: false, email: false }), support: "ready" }),
      { channelChoices: [], showIosStep: false, note: "Rate-drop notifications aren't switched on for Broker Radar yet.", canTest: false });
  });
  test("formToSettings fills the browser's zone and keeps the rest", () => {
    assert.equal(formToSettings({ ...DEFAULT_FORM, timeZone: null }, "America/Phoenix").timeZone, "America/Phoenix");
  });
  ```
- [ ] Run: fails on the missing module.
- [ ] Implement; the view only renders `cardState` and calls Task 8's functions. Look: the existing `cards.jsx` card style and `ui.C`.
- [ ] Run to pass, `npm test` in `client/`, `npx vite build`.
- [ ] Commit: `feat(client): Notifications card on the Profile page`

---

## Where this plan departs from the 10/30 design (today's code, or the design was silent)

- Ping wording names the previous observation's date ("since November 21st"), not "since yesterday" (§5.3's example): the code
  rule since final review I6. "%" not "percent" (the ping is read, not spoken).
- The rate check writes a snapshot only for a new or revised observation, with the ARM as the estimate, and clears the 6-hour rates
  cache so the next `/api/rates` (and so the briefing the ping opens) carries the same observation. Without this the cache could
  show yesterday's rate for up to 6 hours after a ping.
- Pings need a confirmed drop (FRED's own previous observation matches the stored one) and a fetch in the same run; a partial
  publish (series on different dates) records nothing.
- The scheduler runs every day 6 a.m.-8:30 p.m. Eastern, not weekdays only, so a user who turns "weekdays only" off gets a held
  Friday ping on Saturday; FRED is free and a weekend run with no new observation sends only held pings.
- No in-app notification row: `notifications` is user-to-user (`from_user NOT NULL`); the briefing's "Rates dropped:" lead is the
  in-app channel. A test-notification button is added (needed to check iPhone set-up).
- Push TTL ends at the user's quiet start; endpoints are host-allowlisted; at most 10 devices per user.

## Self-review against the design

- **Coverage.** G3 / §5.3: Tasks 3, 6, 7 (FRED only, observation dates, one ping per observation, hold, dedupe), channels Task 5, tap
  opens Charlie home Task 8. G5 / §5.5 Notifications: Tasks 1, 7, 9 (all six settings, defaults off / 0.125 / 20:00-07:00 /
  weekdays on / zone from Google else browser). §6 tables: Task 1. §7 secrets by name, scheduler not timers: Tasks 5, 7 and the
  checklist. §4 anti-goals: no stale/estimated/web-search ping (Task 6 steps 1-4, STALE_DAYS), no client data (Task 6 log and payload
  tests), one per drop (claims), nothing at night (quiet hours + TTL). §5.2 "same rule as the ping": Task 2. §8 left to the builder:
  auth = shared secret + limiter + single-flight; retries = claims; library = Bill's call; scope = `/`. Count-only metrics: the run
  summary is the only metric in this phase ("ping opened" is not measured: it would need a click beacon; left for later).
- **Type consistency.** `Settings` (Task 1) is what `pingDecision` (4), the routes (7) and `formToSettings` (9) use; `drop =
  { rate30, move30, obsDate, sinceDate }` from `marketMove` (2) is what `pingDecision`, `pingText` (4), `rateDropMessage` (5) and
  `runRateCheck` (6) take; `send` returns `{ ok, gone, status }` (5) as Task 6 reads it; `Summary` keys (6) are what Task 7's test pins.
- **No step that decides nothing.** Every implementation step names its signature and rule; the only open choice (the push library)
  is isolated behind `createPushSender`'s `webpush` seam so either answer leaves Tasks 6-9 unchanged.

## Sentences that need Bill's OK (not edited by the builder)

- Privacy, "What we collect", new item: "Notification settings, and if a user turns on phone notifications, the push address each of
  their devices gives us."
- Privacy, "Why we use it", the emails sentence gains: "... and the rate-drop notifications a user turns on."
- Privacy, "Who it goes to", new item: "If a user turns on phone notifications, their browser's push service (such as Apple, Google or
  Mozilla) delivers them. It receives an encrypted message with market news only, never client information."
- Terms (new sentence, where the Terms describe rates): "Rate notifications report a public national average and can be late or
  missed. They are not a rate quote, a lock or advice."
- `CLAUDE.md` (for Bill to add on merge): the `/internal/rate-check` route and its Cloud Scheduler job; `RATE_CHECK_SECRET`,
  `VAPID_PRIVATE_KEY` (Secret Manager) and `VAPID_PUBLIC_KEY` (env) in the secrets list; "pings default off; no client data in any ping".

## Go-live checklist for the owner (Bill runs each step himself, one at a time, after merge)

Run steps 1, 2 and 5 in Git Bash (PowerShell 5.1 re-encodes piped text). Before step 5, note: the header value is kept in the
scheduler job's settings, visible to anyone with Cloud Scheduler view rights on the project.

1. Make the VAPID keys straight into Secret Manager (the private key is never shown or saved), from the repo root:
   `node server/scripts/vapid-keys.js 2> ~/vapid-public.txt | gcloud secrets create VAPID_PRIVATE_KEY --data-file=- --project refi-radar-496318`
   Check: `gcloud secrets versions list VAPID_PRIVATE_KEY --project refi-radar-496318` shows version 1. (`~/vapid-public.txt` holds the public key; it is not secret, and it is outside the repo.)
2. Make the rate-check secret: `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | gcloud secrets create RATE_CHECK_SECRET --data-file=- --project refi-radar-496318`
   Check: the same `versions list` shows version 1.
3. Let the service read both: `gcloud secrets add-iam-policy-binding <NAME> --member serviceAccount:<the service's runtime account> --role roles/secretmanager.secretAccessor --project refi-radar-496318` (once per secret, the same account the existing secrets use).
4. Deploy (adds, never replaces, mappings):
   `gcloud run deploy refi-radar --source . --region us-central1 --project refi-radar-496318 --max-instances 1 --update-secrets RATE_CHECK_SECRET=RATE_CHECK_SECRET:latest,VAPID_PRIVATE_KEY=VAPID_PRIVATE_KEY:latest --update-env-vars VAPID_PUBLIC_KEY=<the key in ~/vapid-public.txt>`
   Check: the log shows `[pings] rate check on, push on, email on|off`.
5. Create the scheduler job (the header value is read from Secret Manager, never typed):
   `gcloud scheduler jobs create http refi-radar-rate-check --location us-central1 --project refi-radar-496318 --schedule "*/30 6-20 * * *" --time-zone "America/New_York" --uri "https://refi-radar-194747178897.us-central1.run.app/internal/rate-check" --http-method POST --headers "X-Rate-Check-Secret=$(gcloud secrets versions access latest --secret RATE_CHECK_SECRET --project refi-radar-496318)" --attempt-deadline 60s --max-retry-attempts 0`
   Check: `gcloud scheduler jobs run refi-radar-rate-check --location us-central1 --project refi-radar-496318`, then the logs show one `[pings] obs ...` line.
6. On your own phone: Profile → Notifications → turn on → "Send a test". On iPhone first add Broker Radar to the Home Screen and open it from there.
