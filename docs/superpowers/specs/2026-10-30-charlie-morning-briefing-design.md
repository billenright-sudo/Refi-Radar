# Charlie as the assistant: the main page, the morning briefing, rate-drop pings, and call follow-ups

Date: 2026-10-30. Owner: Bill. Status: APPROVED by Bill 2026-10-30 (builder check done; team scope and Profile page decided by Bill).
Repo: `C:\Users\bille\dev\refi-radar`, branch `feature/accurate-refi-scoring` (Charlie personality merged at e897427).

## 1. Intent: why we're building this

Broker Radar's edge over Roomvu, Homebot and Total Expert is Charlie: a hands-free co-pilot who knows the broker's own book and
never makes up a number. Today Charlie hides behind a tab, and nothing brings the broker back each morning. Homebot and Total
Expert win with proactive alerts; Roomvu wins with automation.

This feature makes Charlie the broker's daily assistant:
- the broker opens Broker Radar to Charlie;
- Charlie briefs them on the market and who to call;
- their phone pings them when rates drop;
- Charlie follows up on the calls, so suggestions turn into logged calls and booked follow-ups.

Success: brokers open the briefing most weekday mornings, and calls on the call list get logged and followed up through
Charlie.

## 2. What Bill decided (his words or his yes, 2026-10-30)

1. **Charlie is the hero of the main page, not a tab.** Opening Broker Radar lands on Charlie. Other pages get a small Charlie
   button that opens the same conversation.
2. **The morning briefing is market first.** It is a market update that calls out a rate drop when there is one, then the call
   list (who to call and why), then today's calendar. Charlie acts as the broker's assistant.
3. **Rate drops reach the broker two ways:**
   - Charlie leads with the drop when the app is opened;
   - a phone ping fires when the drop happens.
4. **The ping is market news only, with no client names.** For example: "The national average thirty-year fell to 6.40
   percent. Want a sweep, or an update on your clients?" Client names never appear on a lock screen or in a text.
5. **A ping-worthy drop:** the 30-year fixed falls 0.125 (an eighth of a point) or more from the previous day. Each broker can
   change this.
6. **Version 1 uses the national average.** Charlie says "the national average", never "your rates". Tying in the broker's
   lender pricing comes later.
7. **Follow-up loop on calls:**
   - "How did the call with the Smiths go? Want me to log it and add any notes? Should I put a follow-up call with the
     Smiths on your calendar?"
   - **Charlie's own recommendations too:** "This morning I suggested calling Lucy. Were you able to reach her?"
8. **Team scope: each person's own clients.** Everyone's call list, follow-ups and calendar matching cover only the clients
   assigned to them, so a broker and an LO are never both told to call the same client.
   - A broker with LOs also gets one code-authored line about the team, with counts only and no names. For example: "Your loan
     officers have twelve opportunities open."
   - The office-wide view stays on the Sweeps page.
   - Calendar titles are matched only against the user's own clients, so a match is always one they can log.
9. **A Profile page** (§5.5) for name, email, calendar, tenure as an LO and NMLS IDs.
10. **The rest of the gaps list, which Bill accepted:**
   - per-broker settings: drop size, quiet hours, channel, on/off;
   - one ping per drop, nothing overnight or on weekends;
   - a short briefing on quiet days;
   - "as of" on every rate.

## 3. Goals

- **G1. Charlie home.** Charlie is the main page after login. The current dashboard numbers move to a slim strip under Charlie
  plus an "Overview" page (§5.1).
- **G2. Morning briefing.** It is spoken on a tap and written on screen. Every figure comes from the rate snapshots, the sweep or
  the calendar.
- **G3. Rate-drop ping.** It fires once per qualifying drop: market news only, within the broker's quiet hours and channel
  settings.
- **G4. Follow-up loop.**
  - It covers calls Charlie recommended and calls on the calendar.
  - Each call can be logged with notes, given a follow-up, retried, or answered with an email draft.
  - Every write is confirmed by the broker first.
- **G5. Profile page.** Each user sets up their name, email, calendar, tenure as an LO and NMLS IDs in one place. In phase 2
  it adds ping settings: on/off, drop size, quiet hours, weekdays only, channel, time zone.

## 4. Non-goals and anti-goals

**Non-goals (not in this feature):**
- lender or rate-sheet pricing (v2);
- SMS texts (later: carrier registration, cost);
- anything sent to clients;
- VA rates (no VA series in the data today);
- news or web lookups in the market update (rates come only from the rate data, never the web);
- Oliver.

**Anti-goals (a failure even if it works):**
- A ping that says rates dropped when they didn't, or that shows a stale or estimated rate as a drop.
- Any client name, figure or contact detail in a ping, a push payload or an email subject.
- Any number in the briefing that a tool didn't produce.
- Charlie claiming she logged or booked something the broker didn't confirm.
- Nagging: asking about the same call more than twice, pinging more than once per drop, pinging at night.
- The mic going live on page load.
- Any of the four Charlie locks loosening:
  - no invented book, client, loan, calendar or rate facts;
  - no claimed actions;
  - no guideline, legal or tax answers;
  - no client contact details read out.

## 5. How it works

### 5.1 Charlie home (main page)
- After login the app lands on Charlie, not the Dashboard. The left nav loses its "Charlie" item; its first item ("Home") is
  Charlie. The current dashboard content becomes an **Overview** page in the nav. Nothing is deleted.
- Centre of the page: Charlie's briefing, written out, with one large **Talk** button.
  - **Brief me**: the first tap of the day plays the briefing aloud. A tap is needed, because browsers block audio without
    one.
  - After the briefing, the conversation is hands-free, as Charlie is today.
  - The mic never starts on page load.
- A slim strip under Charlie shows:
  - the 30-year rate with its move and "as of" date;
  - the opportunity count;
  - check-ins due;
  - today's first calendar item.
  Each one opens its page.
- On every other page, a small Charlie button (bottom corner) opens the same conversation in a panel. The conversation is
  kept, as today's `keptSession` does.
- On a phone, the strip folds away and the page is Charlie plus the Talk button.
- Note: Bill's standing "don't restyle RefiRadar without asking" rule. His approval of this design covers this main-page
  change only.

### 5.2 The morning briefing (code-authored)
The briefing is built in code from tool data, the way today's greeting is (`buildGreeting`, no model call). That makes every
figure grounded by construction. The model takes over only when the broker replies.

**Order:**
1. **Opener.** The existing varied openers (`openerFor`), using the broker's first name.
2. **Market.**
   - The 30-year national average, its move between the latest two FRED observation dates (the same rule as the ping,
     §5.3, so the briefing never contradicts a ping), and "as of" the observation date. Example: "down 0.15 since Oct 28,
     as of Oct 29".
   - Charlie's existing market tool (`getMovement`) moves to the same observation-date rule. *My call:* one rule
     everywhere. The builder keeps its existing tests' intent: no move across providers, and never on an estimate.
   - Moves of 0.05 or more in the 15-year, FHA 30-year or jumbo 30-year, one short clause each.
   - A drop at or past the broker's threshold leads the market line ("Rates dropped: …"). *My call:* it leads only in the
     first briefing after that observation arrives. After that it is an ordinary market line, so a stale drop is never
     repeated as news.
   - The rate source's label is respected: an estimated set says "estimated" and never claims a move.
3. **Call list.** Three clients, each with one reason built from sweep fields only.
   - For example: "Owen Prescott, about $174,000 tappable to 80 percent LTV" or "Lucy Tran, saves about $574 a month,
     fifteen months since your last check-in".
   - If more are due: "plus N more check-ins".
   - *My call*, so the list doesn't repeat the same three every day:
     1. Clients the broker asked to put "on tomorrow's list" come first.
     2. The rest come in the sweep's order, alternating one refi-savings client and one cash-out client when both kinds
        exist. The engine ranks a cash-out dollar figure against a monthly saving, so cash-out would otherwise always win.
     3. Check-ins with no opportunity fill any slots left.
   - Left off: clients with a logged contact in the last 7 days, and clients recommended in the last 3 days whose
     follow-up is still open or was answered "not reached" (unless the broker asked for them tomorrow).
4. **Calendar.** Today's events from the connected Google calendar: count and first one or two, by title and time. Skipped if
   Google isn't connected.
5. **Open follow-ups** (§5.4): at most two.
   - The briefing names them ("I've also got two calls to check on with you") but asks only the first.
6. **One question at the end.** *My call:* the briefing ends with exactly one question, so a "yes" always answers one
   thing and the existing yes/no handling holds.
   - With open follow-ups, it's the first follow-up question. The next follow-up, then the close, come one at a time
     after it.
   - Without follow-ups, it's the close: "Want a full sweep, an update on a client, or should I get those calls on your
     calendar?"
   - Booking the list's calls means one read-back and one confirmation per call, through today's `/confirm`. There is no
     bulk booking.

**Length and wording:**
- It stays under about 45 seconds spoken.
- On a quiet day (no move ≥ 0.05 and nothing new), the market line is one sentence.
- All wording follows the existing rules: digits for tool figures, no figure words, no client contact details.

**When it's the briefing:**
- The first open of the broker's local day.
- From the morning (local 4 a.m.) until noon, it's "the morning briefing".
- At other times, the same structure runs as a shorter "catch-up", with no "good morning".
- Re-opening the same day shows the briefing text. It doesn't replay unless asked ("brief me again").

**Weekends:** no market move is claimed (rate data doesn't change). The briefing still runs if opened.

### 5.3 Rate-drop pings
**Rate check (new: the server has no scheduler today).**
- Cloud Scheduler calls a new internal route, e.g. `POST /internal/rate-check`, every 30 minutes, 6 a.m.–8 p.m. Eastern on
  weekdays.
- The route needs a shared secret header. Its env var name is `RATE_CHECK_SECRET`, stored in Secret Manager. Bill adds the
  secret and the scheduler job himself.
- The route fetches the FRED series only (the same series `POST /api/rates` uses), writes the `rate_snapshots` row, and runs
  the drop check. It never calls the paid Claude web-search fallback or the 5/1 ARM search.
- Because the route fetches rates itself, the server gains a current-rates accessor. Days nobody opens the app still get a
  snapshot.

**Drop rule.**
- A drop is measured between FRED **observation dates**, the `date` in the payload, not capture days. A weekend or a re-fetch
  of the same observation can never look like a new drop.
- The 30-year fixed (`rate_30yr_fixed`, Optimal Blue `OBMMIC30YF`) must fall by at least the broker's threshold (default
  0.125) from the previous observation.
- FRED data only: the Claude web-search fallback and the hard-coded estimate set never trigger a ping.

**Who gets pinged and how.**
- Each user with pings on gets at most one ping per observation date.
- A user in quiet hours or on a weekend is held and pinged at the start of their next allowed window, if the drop still
  stands.
- Pings to a user are de-duplicated in a new table (§6).

**Channels:**
- **Phone notification (web push, recommended default).**
  - Broker Radar becomes an installable web app: a manifest and a service worker.
  - Push uses VAPID keys, with env var names `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in Secret Manager.
  - On iPhone, the broker must add Broker Radar to the home screen first (iOS 16.4+). The settings page explains this
    in one step.
- **Email (fallback, opt-in).**
  - Uses the existing nodemailer setup to the broker's own address.
  - Subject and body carry market news only.
- Payload text is code-authored and contains no client data. For example: "Rates dropped. The national average thirty-year is
  6.40 percent, down 0.15 since yesterday (as of Oct 29). Open Charlie for a sweep."
- Tapping the ping opens Charlie home. The briefing leads with the drop and offers a sweep.

### 5.4 The follow-up loop
**Remembering what Charlie recommended (new).**
- Each client on a briefing call list, or named in a sweep reply Charlie gave, is stored as a recommendation:
  - user, client, day, reason code;
  - status: open, reached, not_reached, dismissed, expired.
- Only the client ID and a reason code are stored, not text.

**Calls on the calendar.**
- Today's and yesterday's events whose title names one of the user's own clients (§2.8) are matched, using the same client-name
  matching as the screens.
- Events Charlie booked (titled `Follow-up: <client>`) match exactly.
- Past events are read by a code-side `listDay` call for yesterday's date in the user's time zone. The model never works out
  dates.

**When Charlie asks.**
- The next time the broker opens Charlie after a recommended call's day has passed noon, or after a calendar call's end time.
- Anything still open appears once in the next morning briefing, then the item expires.
- At most two follow-up questions per briefing, and never in a ping.

**The questions are code-authored.** For example: "This morning I suggested calling Lucy Tran. Were you able to reach her?" or
"How did the call with the Smiths go?" The broker's answer goes to the model, which uses tools that propose changes. Every
change is read back and saved only on the broker's yes, as today's `/confirm` flow does:
- **Reached:** offer to log it with notes, then offer a follow-up call.
  - Logging uses `logContact`, extended with optional notes (§6).
  - The follow-up uses `createEvent` with the default title `Follow-up: <client>`.
  - Charlie suggests a day and time ("next Tuesday at 10?"), and the broker can change it.
- **Not reached:** offer to put the client on tomorrow's list, book a time to call, or draft a check-in email (`draftEmail`,
  NMLS-signed, sent by the broker from their own mail app).
- **"Skip" or "not now":** the item is dismissed and not asked again.

**Notes.** These follow the repo's standing rule that borrower PII, including phone, email and notes, never reaches the model.
- The broker speaks the notes in the conversation. Charlie's `logContact` proposal carries them, and they are saved only on
  confirm.
- The confirmation card shows the notes. The spoken read-back says only "with your notes", so a phone number or email in a
  note is never read aloud.
- Saved notes are never sent to the model. They appear on the client's page only.
- *My call:* in version 1 Charlie does not read stored notes back. Adding that later needs a code-side read-out with a
  contact-detail screen.
- Notes never ground a figure.
- A "not reached" outcome does not reset the client's six-month check-in date; only a "reached" log does.

### 5.5 Profile page
**Bill's decision (2026-10-30):** each user gets a **Profile** page to set up their name, email, calendar and their tenure as an
LO. *My call:* it is reached from a "Profile" item at the bottom of the left nav and from the user's name in the header. Bill's
approval of this design covers adding the page and that nav item.

The page gathers today's scattered setup in one place, and it is built in phase 1 because the briefing depends on it:
- **Name.** First and last name, the one Charlie uses in the briefing.
- **Email.** The login email. *My call:* changing it sends a confirmation link to the new address and only switches after it
  is clicked, since it is how the user signs in.
- **Calendar.** Today's Calendar & email card: connect or disconnect Google, plus the connected address.
- **Tenure as an LO.** Today's coaching-style setting (`career_stage`), which Charlie's coaching tone depends on. It is shown
  as plain choices of how long they've been a loan officer.
- **NMLS IDs.** Personal and company, moved here from the Charlie panel. Emails Charlie drafts are still signed with them.
- **Notifications** (phase 2), with the settings below.

The Notifications section has:
- pings on/off (default **off** until the broker turns them on and allows notifications);
- drop size (0.125 default; choices 0.125, 0.25, 0.375, 0.5);
- quiet hours (default 8 p.m.–7 a.m.);
- weekdays only (default on);
- channel (phone notification, email, or both);
- time zone (defaults to the connected Google calendar's zone, else the browser's).

## 6. Data changes (new tables and columns; nothing removed)
- `user_alert_settings`: user, enabled, threshold, quiet_start, quiet_end, weekdays_only, channels, time_zone.
- `push_subscriptions`: user, endpoint, keys, created_at. Several per user (phone and laptop). Dead endpoints are removed when
  the push service rejects them.
- `rate_alerts_sent`: user, observation_date, channel, sent_at. Unique on user and observation date.
- `charlie_recommendations`: user, client, day, source (briefing | sweep | calendar), reason_code, status, asked_at,
  resolved_at.
- `contact_log`: client, user, at, outcome (reached | not_reached), notes.
  - `clients.last_contact` stays and is updated as today.
  - The log adds history and notes.
- **Charlie's `logContact` change:** it gains an optional `notes` field, shown in the read-back and saved only on confirm.
  Today only the `last_contact` timestamp exists.

## 7. Constraints
- **Infrastructure.** The service is Cloud Run with SQLite on a GCS FUSE volume and one instance. No in-process timers: the
  scheduler calls a route. Bill runs every deploy, Secret Manager write and scheduler setup himself.
- **Secrets.** Referenced only by env var name (`RATE_CHECK_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`). Never in the repo
  or CLAUDE.md.
- **Charlie's locks and screens are unchanged.**
  - The briefing and follow-up questions are code-authored.
  - Everything the model says after them passes today's screens.
- **Every write is confirmed.** Nothing is logged, booked or emailed without the broker's yes.
- **No client data leaves the app** in a ping, a push payload, an email subject or a log line.
- **Cost:**
  - FRED is free;
  - pushes are free;
  - email uses the existing account;
  - the briefing's speech stays inside the existing daily speech cap (`CHARLI_TTS_DAILY_CHARS`).
- **Paid AI test runs need Bill's go**, as before.

## 8. Left to the builder
- How the nav, Home and Overview pages and the corner panel are built, within §5.1.
- Exact reason codes, briefing sentence templates and their variety, keeping to §5.2's order and limits.
- How the internal route authenticates beyond the shared secret, and how scheduler retries are handled (idempotent by
  observation date).
- The push library choice and the service worker's scope.
- How a calendar event title is matched to a client, reusing the existing client-name matching.
- Measuring success (briefing opened, list calls logged, follow-ups booked, ping opened). Keep it count-only, with no client data
  in metrics.

## 9. Suggested order (my recommendation; Bill decides)
1. **Charlie home + the Profile page + the morning briefing + the follow-up loop** (§5.1, 5.2, 5.4, §5.5 without
   Notifications, the contact log and recommendations). This works without any pings and is the daily habit.
2. **Rate check + pings + notification settings** (§5.3, §5.5 Notifications, push and the scheduler). This needs Bill's
   Secret Manager and Cloud Scheduler setup.
Each phase gets its own plan, tests, a paid eval run on Bill's go, and Bill's live check before merge.
