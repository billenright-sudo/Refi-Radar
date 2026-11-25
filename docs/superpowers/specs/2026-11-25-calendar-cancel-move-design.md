# Charlie cancels and moves calendar events: design

**Status:** Bill approved the feature on 2026-10-28 ("go on both": cancel and reschedule by voice). On 2026-11-25 he said
"keep going on builds", so the calls below are Sirius's and are listed for him at the merge step. Built on the side copy
`C:\Users\bille\dev\refi-radar-calchange`, branch `feature/calendar-cancel-move`, off `9c7f2bc`. Merge, push and deploy each
need Bill's own go.

## 1. What it is

Today Charlie reads the broker's Google Calendar and books an event after a read-back and a yes. Asked to cancel or move one,
she says a fixed line (`EVENT_CHANGE_UNSUPPORTED`). This change lets her:

- **cancel** one event, and
- **move** one event to a new start (same length),

on the signed-in broker's own primary calendar, after a code-written read-back and a yes (Confirm button or a spoken yes), the
same way a booking works. No new Google permission: `calendar.events` already covers it.

## 2. Rules that do not move

- Nothing changes on the calendar until the broker confirms. The read-back and the "Done —" line are written by code.
- Charlie never emails or notifies anyone. Every Google call uses `sendUpdates=none`.
- The model still sees only what it sees today for a calendar day (titles, spoken times, all-day flag). Event ids, etags,
  guest lists and organizer details stay in code and never reach the model.
- She never picks between two events. If more than one fits, code lists them and asks which one.
- No client record changes, no contact is logged, nothing is sent.
- The model may never say an event was cancelled or moved. Only the code-written Done line says so. The existing screens that
  stop false "it's on your calendar" claims are extended to cancel and move claims.

## 3. Finding the event

Two new tools, both packaging a change for confirmation (they change nothing):

- `cancelEventTool({ date, time?, title? })`
- `moveEventTool({ date, time?, title?, newDate?, newTime })` (`newDate` defaults to the same day; `newTime` is required)

`date`, `newDate`, `time` and `newTime` are resolved by code the way `createEventTool` resolves them. At least one of `time` or
`title` is required.

Code reads that day from Google (with the extra code-only fields it needs). Only events that START on that day (in the
calendar's zone) are matched: one that began on an earlier day is not found for this day. A day with more than one page of
events (over 50) is treated as unreadable. Then code matches:

1. If `time` is given and exactly one event starts at that time, that is the event (the read-back shows its real title, so a
   misheard title is visible before the yes).
2. Otherwise match on `title`, case and punctuation ignored, in two passes over the words the broker gave:
   - Pass 1: ignore `the a an my our your with for to on at and of`. Every remaining word must appear in the title.
   - Pass 2, only if pass 1 found nothing: also ignore `call meeting appointment appt event followup follow up`.
   If ignoring words would leave none, the words are kept as given. If `time` was also given, it must match too.
3. No match: the not-found line. More than one: the which-one line (up to four listed). Exactly one: go on.

## 4. Events she will not change

Each is a code-written line that names the reason and points to Google Calendar. Nothing is packaged for confirmation. They are
checked in this order: someone else's, not a regular event, guests, repeating, more than one day, already started, all-day move.
An overnight timed event shorter than 24 hours is an ordinary event on the day it starts.

| Case | Why |
|---|---|
| The event has guests (anyone besides the broker) | Guests would not be told, and she never emails guests |
| A repeating event (any instance of a series) | One-instance versus whole-series is not handled yet |
| Organized by someone else, or Google says it can't be edited | Not the broker's to change |
| Not a regular event (focus time, out of office, working location, from Gmail) | Not an ordinary event to change |
| Runs over more than one day (timed, 24 hours or more; all-day, more than one day) | Changing it would change the other days too |
| Already started or over | History stays as it is |
| All-day event, asked to move | Cancel is fine; moving all-day events is not handled yet |

## 5. Moving

- The new start must be in the future and must exist on the clock (same checks as a booking). The length stays the same.
  The zone is the calendar's zone.
- Same time as now: a code line says so; nothing to confirm.
- If the new slot overlaps another timed event that day, the read-back adds one sentence naming it. The move is still allowed.

## 6. At the yes

- **Cancel:** `events.delete` with `sendUpdates=none` and `If-Match: <etag>`.
- **Move:** `events.patch` (start and end only) with `sendUpdates=none` and `If-Match: <etag>`.
- Google answers "precondition failed" (the event changed after the read-back): nothing is changed, and she says the
  changed line. One exception keeps a repeated confirm harmless: on a move, read the event once, and if it already sits at
  the requested new time, answer with the Done line.
- Google answers "gone" or "not found": she says the already-off line (true whether a repeat of this confirm or the broker
  removed it by hand).
- Google refuses the token: the existing reconnect path. Any other refusal from Google (a 4xx): the could-not-change line.
- No answer, a timeout or a 5xx (the change may or may not have been made): read the event once. A cancel that is gone, or a
  move that sits at the new start, is Done. An event still there as it was is the could-not-change line. If that read fails
  too, the claim is given back and the answer is a retryable failure like a booking's, with no claim about what changed; the
  same confirm can then be tried again safely.
- The "how did the call go?" follow-up is brought in line after the Done line is sent, so it never delays it.
- A repeat of the same confirm must never change anything a second time, the same guarantee a booking has today.

## 7. The words (code-written; Bill checks these at merge)

`<zone>` is the calendar's zone name as bookings say it. Titles are cut at 80 characters, and a straight double quote in a
title is said as a single quote. Every read-back opens with `Just to confirm — `, as a booking's does.

- Read-back, cancel: `Just to confirm — cancel "<title>" on <day> at <time> <zone>?`
- Read-back, cancel, all-day: `Just to confirm — cancel "<title>", all day on <day>?`
- Read-back, move: `Just to confirm — move "<title>" from <day> at <time> to <new day> at <new time> <zone>?`
  plus, when it overlaps: ` Heads up: that overlaps "<other title>" at <time>.`
- Done, cancel: `Done — "<title>" on <day> is off your calendar.`
- Done, move: `Done — "<title>" is now <new day> at <new time> <zone>.`
- Not found: `I don't see that on your calendar for <day>.`
- Which one: `I see more than one that fits on <day>: "<A>" at <time>, "<B>" at <time>. Which one?` (an all-day one reads
  `"<A>", all day`)
- Has guests: `"<title>" has guests, and I never email guests. Open Google Calendar to change it so they're told.`
- Repeats: `"<title>" is a repeating event. I can't change those yet. Open Google Calendar.`
- Not the broker's: `"<title>" was set up by someone else, so I can't change it. Open Google Calendar.`
- Not a regular event: `"<title>" isn't a regular event, so I can't change it. Open Google Calendar.`
- More than one day: `"<title>" runs over more than one day. I can't change those yet. Open Google Calendar.`
- Already started: `"<title>" has already started, so I'll leave it alone.`
- All-day move: `"<title>" is an all-day event. I can cancel it, but I can't move those yet.`
- Same time: `"<title>" is already at that time.`
- Changed since the read-back: `That event changed after I read it to you, so I left it alone. Ask me again.`
- Already off: `That event is already off your calendar.`
- Could not change: `Google Calendar couldn't make that change. Nothing was changed.`
- Any other edit (rename, length, guests): `I can cancel or move an event. For any other change, open Google Calendar.`
  This replaces today's `EVENT_CHANGE_UNSUPPORTED` wording; the constant keeps its name.

The confirm tail follows the booking read-back, which has none.

Spoken answers: a bare "cancel" always means "don't", for every kind of change, a pending cancel included. With a cancel
pending, "cancel it", "yes cancel", "yes, cancel it (please)" and "go ahead and cancel (it)" confirm it; with a move pending,
"move it", "yes move it" and "go ahead and move it" do. "Keep it", "leave it", "never mind" and any negation are a no. On the
confirm card for a cancel only, the two buttons read `Yes, cancel it` and `Keep it`; every other card keeps Confirm and Cancel.

## 8. Knock-on effects to check

- The "how did the call go?" follow-up must not ask about an event Charlie cancelled, and must follow a moved event to its
  new end time.
- The morning briefing reads the live calendar, so it should need no change. Confirm that.
- The Charlie screen's confirm card must show the two new changes clearly (what, which event, when).
- `server/scripts/charlie-eval.js` lists the fixed lines by name: keep it in step. No paid run is part of this build.

## 9. Not in this change

Repeating events, events with guests, renaming, changing the length, adding guests, moving between calendars, undo, and
changing several events in one go.

## 10. To report back, not to edit

- Any place in `CLAUDE.md`, `README.md`, the Terms, the Privacy Policy, the Google connect screen or the landing copy that
  says what Charlie does with the calendar (for example "reads and adds events"). These need Bill's OK to change, and the
  Google sign-in review describes how the calendar permission is used.
