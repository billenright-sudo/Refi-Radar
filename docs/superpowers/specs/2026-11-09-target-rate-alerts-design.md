# Target-rate alerts: "call me when rates hit 6%"

Date: 2026-11-09. Owner: Bill. Status: Bill 2026-11-09 "keep going" after the design handoff; plan at `docs/superpowers/plans/2026-11-09-target-rate-alerts.md`.
Repo: `C:\Users\bille\dev\refi-radar`. Branch `feature/target-rate-alerts` @ 0cfd1f4, off `feature/accurate-refi-scoring`, in the
worktree `C:\Users\bille\dev\refi-radar-target-rate`.
Builds on: `2026-10-30-charlie-morning-briefing-design.md` (the "briefing design") and the sweep engine (`server/lib/refi.js`,
`client/src/refiAnalysis.mjs`). Every rule in the briefing design still holds unless this document changes it.

## 1. Intent: why we're building this

The commonest thing a borrower tells a broker after closing is "call me if rates get to 6%." Today the broker writes it in the
notes and has to remember to look. Broker Radar already knows each client's loan and already works out the rate that client
could get today (the client page's **Est. Client Rate**). It just doesn't know the number the client asked for.

This round lets the broker record that number on the client. Broker Radar then watches it every day and tells the broker, once,
when the client's estimated rate reaches it. That is the call the broker promised to make, put in front of them on the day it
is due.

Success: a broker types 6.000 as Helen's target. On the first morning the daily rates put Helen's estimated rate at 6.000 or
lower, Charlie's briefing puts Helen at the top of the call list ("Helen Brandt is at her target"), her client page says
"Target reached November 12th", and the client list shows her as at target. Once the broker logs the call, Helen leaves the
call list. If rates rise and later fall back to her target, she comes back.

Competitors sell this as "rate alerts". It was roadmap item 1 (Bill, 2026-10-27), and the Optimal Blue pricing hookup later
builds on the targets this round stores.

## 2. What Bill decided

- **2026-10-27:** the roadmap after the voice CRM: "(1) client target-rate alerts" first.
- **2026-11-08:** "yes start the target-rate alerts design", then "go" (skip the questions; write it).
- So everything below marked "(my call)" is mine, for Bill to accept or change while reading.

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. A broker or loan officer can set, change and clear one target rate per client, on the client page and by telling Charlie.
- G2. Broker Radar checks every target against each new day of real rates, and marks a client "at target" when the client's
  estimated rate is at or below the target.
- G3. The broker hears about it once: the first morning briefing after the target is reached puts the client first on the
  call list, with the two rates. The client stays marked "at target" until the broker logs a contact.
- G4. The broker can see where every target stands: on the client page, in the client list, and in a short "Closest to
  target" list on Rate Watch.
- G5. Teams work as everywhere else: a loan officer sees and is told about their own clients; a broker sees everyone's, and
  the briefing's team line counts their loan officers' clients at target.

**Non-goals (this round)**
- **Phone notifications or email to the broker.** The briefing design's phase 2 ("pings": push and email, quiet hours, a
  scheduler that calls a route) is where those belong. Target hits will join those pings when phase 2 is built. Until then the
  briefing, which the broker opens every morning, is the alert (my call).
- **Anything sent to the borrower.** No email, text or notice goes to a client, ever, from this feature. The broker makes the
  call or sends one of the existing emails themselves.
- **Importing targets** from a file or the LOS feed. No ARIVE or LendingPad export has a target column; it is set by hand or
  by voice.
- **More than one target per client** (for example a rate for a cash-out and another for a rate-and-term), and targets for a
  product the client doesn't have today (a 30-year client who'd take a 15-year at 5.5%).
- **A new email template** ("rates hit your number"). The existing refinance-review email covers the call that follows.
- **A new Home tile.** The Home layout is approved and stays as it is; the briefing is how Home tells the broker.

**Anti-goals (would make this a failure even if it works)**
- A1. **An alert from a number we didn't observe.** A target is only ever reached on a real day of Optimal Blue rates (the
  FRED feed). An estimated rate set, or a day the FRED fetch failed and the web-search fallback filled in, never changes a
  target's state (my call: a web-searched figure is fine to show, not to act on).
- A2. **Nagging.** A client who sits at target for two weeks is announced once, not fourteen times. Rates that wobble around
  the target don't re-announce every other day.
- A3. **Contacting anyone.** As above: nothing reaches a borrower.
- A4. **Overstating it.** Every line says "estimated". The est. rate is Broker Radar's estimate from public rate indices and
  the client's credit and LTV, not a quote. Wording never says "rates hit 6%" when it was this client's estimate that did.

## 4. How it works

### 4.1 Setting a target

- **On the client page:** a "Target rate" field beside the loan figures, in the existing form style, with a "Clear" action.
  Empty means no target.
- **By voice:** "Charlie, Helen Brandt wants to refinance at 6 percent." Charlie reads it back ("Just to confirm — set Helen
  Brandt's target rate to 6.000%?") and saves it only on the broker's yes, like every other change Charlie makes. Clearing
  works the same way ("take Helen's target off"). Charlie can also answer "who's at their target?" and "how close is Helen
  to her target?" from the stored figures.
- **Valid targets** (my call): a number from 1.000 to 15.000, stored to three decimals (5.875 stays 5.875), and **below the
  client's current rate**. A target at or above what they pay today can never mean a refinance, so it is refused with:
  "A target has to be below Helen's current rate of 6.750%."
- Setting or changing a target re-arms it (4.3). Who set it and when is kept.

### 4.2 What "at target" means

- The figure compared is the client's **Est. Client Rate**, computed as the client page computes it (`client/src/refiAnalysis.mjs`
  `analyze`), but on the **latest real rate snapshot** (A1), not on whatever rates the page happens to be showing. For an ARM
  that is the 30-year fixed it would refinance into, as on the client page. Note: the server's `refi.analyze` prices an ARM at
  the ARM rate today, so the server must run the 30-year-fixed analysis for ARM clients to match the page. A snapshot without
  `rate_30yr_top_tier` is priced the way the page prices a rate set without it (the market-plus-adjustment path), so the same
  inputs always give the same number.
- **At target** = Est. Client Rate ≤ target rate, on a day of real rates (A1).
- **The date of a check** is the rates' **FRED observation date** (`rates.date`, the "as of" date the briefing already
  names), not the day the snapshot was captured. FRED repeats an observation over weekends and holidays; a repeated
  observation is not a new check and can neither reach nor re-arm a target (my call).
- A client whose current rate has dropped to or below their target (they refinanced, or the LOS feed corrected the rate)
  is never "at target". Their target stays, and the client page says "Their rate is already at or below this target." (my call).
- A client the sweep can't price (missing balance or value) shows "Can't estimate a rate for this client yet" and is never
  at target.

### 4.3 Once, not every day

Each target is in one of three states:
1. **Watching.** Not reached since it was set or re-armed.
2. **At target.** Reached. Broker Radar records the observation date of the rates that reached it, the estimated rate that
   day, and the moment it recorded the hit (UTC). The owner's first briefing after that announces it (4.5).
3. **Handled.** The broker **reached** the client after the hit was recorded: a contact logged as reached (one-tap
   "contacted", a logged call marked reached, or Charlie's logContact with outcome reached) at or after the recorded moment.
   A not-reached attempt (voicemail, no answer) does not handle it: the promised conversation hasn't happened yet, and the
   briefing's existing follow-ups already ask about unanswered calls (my call). The client leaves the call list but the page
   still says when the target was reached.

**Re-arming** (my call): a target that is At target or Handled goes back to Watching when the client's estimated rate rises
to **0.125 or more above the target** on a real day, or when the target is changed. So a 6.000 target reached at 5.990 and
then 6.010 the next day is still the same hit (A2); it takes a move to 6.125 to re-arm it.

### 4.4 When it's checked

There is no scheduler today. Rates come from FRED when the app asks for them (`POST /api/rates`), and each real day is stored
as a rate snapshot. So targets are checked whenever Broker Radar holds a real snapshot whose **observation date** is newer
than the last check: when the briefing is built, when the sweep runs, and when the client list or client page loads (my call).
The state change is recorded against that observation date, not the time someone opened the app, so a broker who opens the
app at noon gets the same answer as one who opened it at 7 a.m. A day nobody opens the app is checked the next time someone
does, against the newest snapshot (days in between are not replayed).

### 4.5 Where the broker sees it

- **Morning briefing.** Clients newly At target go to the top of the call list, after the clients the broker carried from
  yesterday, ahead of the sweep's picks. The reason line is code-written with digits, like the others: "Helen Brandt is at her
  target: estimated 5.875% against her 6.000%." They count toward the list's limit of three; if more than three are newly at
  target, the rest are "Plus N more clients at their target."
  - **At target overrides the sweep's own bar** (my call). A client at target is listed even when the sweep wouldn't pick
    them (a drop under 0.5, a break-even over 36 months): they asked for the call at that rate, so the broker makes it. Their
    reason line uses the target figures, never sweep figures.
  - **Announced once, per client** (my call). The announcement belongs to the client's owner (the loan officer, or the broker
    for the broker's own clients), whose briefing is the only one that lists the client. It is "announced" on the local date
    of the owner's first briefing built after the hit; every briefing that owner opens that same day uses the same wording
    (a rebuild doesn't drop it), and later days don't.
  - **After the announcement**, an At target client who isn't Handled follows the call list's existing rules like any pick:
    the same recent-recommendation exclusion (no re-listing for 3 days), the same follow-up questions. When listed again it
    ranks right after the newly announced ones, with "Helen Brandt is still at her target of 6.000% (since November 10th)."
- **Team line (brokers).** The count-only line about loan officers' open opportunities adds ", and N of their clients are at
  target" when N > 0.
- **Client list.** An "At target" badge on the client's row, in the list's existing badge style.
- **Client page.** Under the target field, one status line: "Watching: estimated 6.250% as of November 10th, 0.250 above
  target", "Target reached November 12th (estimated 5.875%)", or "Target reached November 12th · reached November 13th".
  These figures come from the same real snapshot the check used, so the line can never contradict the state. On a day the
  page shows web-searched rates, its Est. Client Rate tile may differ; the target line's "as of" date says which rates it
  used (my call).
- **Rate Watch.** A "Closest to target" list under the rates: up to 5 clients with a target, At target ones first, then the
  smallest gap. Each row: name, target, est. rate, gap, from the same real snapshot. Its scope is the client list's (a broker
  sees the whole company's, with the loan officer's name on their clients' rows; a loan officer sees their own) (my call).

### 4.6 Teams

Scope follows the clients already: a loan officer's targets, list and briefing cover their own clients; a broker sees and can
edit every client in the company. A broker's own briefing call list stays their own clients (as today), and their loan
officers' clients at target show up only as the team-line count (G5).

## 5. Data changes

- **`clients`**, new columns (idempotent migrations, like the others in `db.js`; existing clients get no target):
  - `target_rate` REAL, NULL = no target;
  - `target_set_by`, `target_set_at`;
  - `target_reached_on` (the FRED observation date, YYYY-MM-DD), `target_reached_rate` (the est. rate that day) and
    `target_reached_at` (the UTC moment the hit was recorded), NULL while Watching;
  - `target_announced_on` (the owner's local date of the announcing briefing), NULL until announced;
  - whatever else the builder needs to apply the re-arm rule (the last observation date checked).
- **Handled** is derived, not stored: a contact in `contact_log` with outcome `reached` at or after `target_reached_at`.
- An **import or the LOS feed never touches** these columns (they're not on the import whitelist, and a matched loan's update
  leaves them alone). A loan update that lowers `current_rate` to or below the target follows 4.2.
- **Charlie** gains the set/clear-target action (confirmed like logContact) and the target figures in its client lookups.

## 6. Constraints

- Cloud Run, one instance, SQLite; no in-process timers (briefing design §7). Nothing in this round needs a scheduler.
- Charlie's locks are unchanged: the briefing and the target lines are code-written; every write is read back and confirmed.
- No client data leaves the app. No new paid API calls (the target check is code, no model).
- The client list, client page, Rate Watch and briefing keep their approved look; new pieces use the existing styles.

## 7. What Bill needs to do

Nothing to build this round. Later, when phase 2 pings are built (phone/email to the broker), target hits are one more thing
they can announce; that needs the scheduler and push keys the briefing design lists.

## 8. Review focus: inputs a real broker will hit

1. **Rates wobble around the target** (5.990, 6.010, 5.995 over three days): announced once, never re-armed by a 0.010 move.
2. **A target typed above the current rate** (client at 6.750, target 7): refused with the message in 4.1.
3. **FRED is down and the web-search fallback fills in** a lower rate: no target changes state.
4. **The client refinanced elsewhere** and the LOS feed or an import lowers their current rate below the target: no alert,
   the page says so.
5. **A target set when the client is already there** (est. 5.875, target 6.000): it is At target on the next check and the
   next briefing announces it.
6. **A loan officer's client reaches target:** the LO's briefing announces it; the broker's team line counts it; the broker
   can open the client and see it.
7. **Four clients reach target the same morning:** three on the list, "Plus 1 more client at their target."
8. **The broker leaves a voicemail:** the client is not Handled; the follow-up asks about the call as it does today.
9. **A weekend:** Saturday's and Sunday's snapshots repeat Friday's observation; nothing is reached, re-armed or announced
   twice because of it.
10. **A client at target the sweep wouldn't pick** (current 6.250, target 6.100, drop under 0.5): still listed, with the
    target wording.

## 9. Left to the builder

- The field's exact placement on the client page and the badge's wording/colour within existing styles;
- how the hit is checked and recorded (a pure function over clients + snapshot is the obvious shape), and test structure;
- Charlie's tool names and read-back wording, following logContact's;
- the "Closest to target" list's layout on Rate Watch.

**Rollout:** built on `feature/target-rate-alerts` with tests, sample data only. Merge, push and deploy each need Bill's go,
and Bill runs `gcloud run deploy`.
