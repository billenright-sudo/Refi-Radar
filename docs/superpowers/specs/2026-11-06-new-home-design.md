# New Home: the Overview with Charlie docked beside it — design

Status: **APPROVED by Bill, 2026-11-06** ("perfect", then "Yes" to building it this way with a hands-free switch).
Mockup (approved): `docs/superpowers/specs/assets/2026-11-06-new-home/mockup.png` (desktop left, phone right). The amber
"CLEARER" / "WAS LIVE" tags in the mockup are review notes, not product.

## Why

Brokers expect Charlie to be on the page, and Bill wants the first screen to be the useful one: the numbers (today's
Overview) with Charlie right there, bigger, so they can see her. Today Home is a Charlie-only page and the Overview is a
separate nav item; opening Charlie elsewhere slides a drawer over the numbers. Field use also showed that the always-open
microphone picks up side conversations in the room, and Charlie answers them.

## Goals

1. **Home = Overview + Charlie.** One screen: the Overview content on the left, Charlie in a docked column on the right
   (wide screens). Charlie's separate page and the separate "Overview" nav item go away; "Home" is this screen.
2. **A bigger Charlie.** A head-and-shoulders portrait card (4:5 on wide screens, square when stacked) instead of the small
   circle, with her name and a status tag over the picture. Same avatar and same footage as today (no new HeyGen render).
3. **Tap to talk by default.** One question per tap: the mic opens on the tap, closes after her answer starts, and does not
   reopen by itself. A **Hands-free** switch restores today's continuous listening, off by default, remembered per device.
4. **Numbers that don't contradict Charlie.** Overview tiles say exactly what they count: "Refi-ready today" (rate refis
   that pass the break-even test) next to a new "All opportunities" tile (everything the sweep counts, Charlie's number).
5. **Fix the leftover "LIVE RATES"** label on the Overview's rate strip (it must say "DAILY RATES"; "ESTIMATED RATES" stays
   for estimated rates).
6. **Easy on batteries.** Her clips pause while the browser tab is hidden; reduced motion shows the still only (already so).

## Non-goals

- No change to Charlie's brain, tools, prompts, voice, or the server's assistant routes.
- No new HeyGen render, no live-video avatar, no running cost.
- No change to the slide-in drawer's behaviour on other pages, other than using the new portrait clips (below).
- No change to billing, auth, import, sweeps logic or the client page.
- The desktop look of every other page stays as it is (owner-approved layout).

## Anti-goals (would make this a failure even if it works)

- The numbers getting cramped or unreadable on a 13–14" laptop because Charlie's column eats the space.
- Charlie reacting to room conversation in the default mode.
- Two different Charlie conversations (Home column vs. drawer) — it must stay the one kept conversation (keep.mjs).
- Any page scrolling sideways on a phone.

## The approved wording (Bill, 2026-11-06)

- Overview tile: **"Refi-ready today"**, sub-line **"Rate refis that pay back their closing costs within 3 years"**.
- Overview tile (new): **"All opportunities"**, sub-line **"Includes cash-out, ARM-to-fixed and term options"**.
- Overview tile: "Potential monthly savings", sub-line **"Across refi-ready clients"**.
- Rate strip heading: **"DAILY RATES"** (and "ESTIMATED RATES" when the rates are estimated, as today).
- Under Talk: **"One question per tap. The mic closes after each answer."**
- The switch: **"Hands-free"** (on = she keeps listening, as today).
- Talk button: **"Tap to talk"** (and "Listening…" while the mic is open for that one question; "Stop listening" in
  hands-free mode while live, as today).

## What the screen is

### Wide screens (viewport ≥ 1350 px)
- Left: today's Overview content, unchanged except for the tiles/labels above. It keeps its greeting header
  ("Good evening, {first} 👋", date, Refresh rates), shop overview (broker only), Treasury card, stat tiles, equity tiles,
  rate strip, and the "Top refi opportunities" list below (everything the Overview shows today).
- Right: a docked Charlie column, 408 px wide, full height under the top bar, its own scroll:
  1. header row: mic icon + "Charlie" title, Pause button;
  2. the portrait card (4:5, max ~318 px tall, rounded 18 px, thin amber border + soft glow), with a bottom shade and,
     over it, "Charlie" + a status tag: "Speaking…" (blue dot), "Listening" (green dot, mic open), "Thinking…" (amber),
     otherwise no tag or a neutral "Ready";
  3. the briefing card (her greeting text + source tags) — what the Charlie page shows today in its briefing card;
  4. Tap to talk (wide amber) + Brief me, the one-line note, and the Hands-free switch;
  5. the conversation transcript (newest at the bottom) and any pending read-back card;
  6. "Type instead…" + Send at the bottom.
  The column never covers the Overview.

### Laptop widths (1024–1349 px)
- Same two columns; Charlie's column is 340 px; the Overview's 4-across tile rows become 2-across so nothing is cramped.

### Tablet and phone (< 1024 px)
- Stacked: Charlie's card first (square portrait, full width up to ~420 px, centred), with the briefing, Tap to talk,
  Brief me, note and Hands-free under it, then the transcript/type box, then the Overview content with tiles 2-across.
- Below 768 px the existing phone rules apply (drawer nav, 16 px gutters, no sideways scroll).

### The drawer on other pages
- Unchanged behaviour (corner button with her thumbnail opens it). Its face becomes the new portrait clip in a small
  4:5 card (about 168 px wide) instead of the circle, so one set of clips serves both places.

### Charlie's former page
- Removed. Navigating to "home" shows the new Home. Anything that pointed at the "overview" view now points at "home".
  The "Overview" nav item is removed; Home's icon may become the dashboard icon (builder's call).

## Behaviour details

- **One conversation:** the docked column and the drawer are both CharliView over the same kept session (keep.mjs), so
  leaving Home and coming back shows the same conversation and never greets twice — keep that.
- **Greeting/briefing:** unchanged — she greets on first open of the day as now; later visits show the conversation.
- **Tap to talk (default):** tap → mic starts → her VAD/utterance flow captures ONE utterance → it is sent → the mic stops
  (mic state back to "off") and does not restart after her reply. Tapping while the mic is open for that question cancels
  it (mic off, nothing sent). Pause/Resume behave as today.
- **Hands-free (switch on):** exactly today's behaviour (Talk starts continuous half-duplex listening; tap again stops).
- The switch's value is stored per device (localStorage, read with try/catch; default off when storage is unavailable).
- **Clips:** two new portrait loops (talking, listening) and a portrait still, cut from the same sources and seams as the
  current loops but cropped 1080×1350 at (0, 80) of the 1080×1920 frame and scaled to 480×600:
  talking = `charlie_t3.mp4` 3.04–10.60 s with a 0.12 s seam blend; listening = HeyGen render
  `7cad92568d86805391c0b5c74462f3e1` 4.44–10.44 s with a 0.2 s pre-roll blend. The mockup folder already has these
  (`Downloads\broker_radar_home_mockup\portrait-talk.mp4`, `portrait-idle.mp4`); the build adds webm versions and a still.
  The square (stacked) portrait uses the same 4:5 files with `object-fit: cover` and an upper object-position.
  The circle clips (`charlie-talk.*`, `charlie-idle.*`) are removed once nothing uses them; `charlie-thumb.jpg` (corner
  button) and the still stay.
- **Battery:** all of her clips pause on `visibilitychange` to hidden and resume on visible (only the one that should be
  playing). Reduced motion: still only (unchanged).
- **Overview "All opportunities":** the count is the server sweep's `counts.withOpportunity` for the user's book (the same
  number Charlie uses). Use the existing POST /api/sweeps with the page's rates, or the greeting briefing if that is simpler
  and always present — builder's call, but it must match what Charlie says.
- **Loan officers:** their Home shows their own book (as the Overview does today), no shop overview.
- **Profile-first landing and billing gates:** unchanged (profile-first still lands on Profile when the profile is missing).

## Constraints

- Node 20 (`export PATH="/c/Users/bille/dev/node20:$PATH"`), React 18 + Vite, inline-style codebase; follow its patterns
  (`ph(isPhone, …)` style additions; `useIsPhone`). No new npm dependencies.
- Tests: `cd client && npm test` (node --test on listed files — add new test files to the script) and `npm run build`;
  `cd server && npm test` must stay green. TDD for pure helpers (layout choice from width, talk-mode storage, label/count
  helpers).
- Bill invisible (no "Bill"/"Enright" in product). Charlie is she/her. No paid API calls in tests.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No merge, push or deploy without Bill's go.

## Builder questions — resolved (Sirius's calls, 2026-11-06; none needed Bill)

1. **"All opportunities" source:** POST /api/sweeps with the page's rates. It is read-only (routes/sweeps.js runs
   `refi.runSweep` and answers; no writes) and already scoped (broker = whole org, loan officer = own clients), which is
   exactly Charlie's number. Call it when Home's rates arrive; show "—" while loading or on failure (like the other tiles).
2. **"Refi-ready today" is a pure rename** of today's "Refi Opportunities" tile. The rule is unchanged
   (`analyze().good`: rate gap ≥ 0.5, break-even ≤ 36 months, savings > 0, LTV ≤ 95), which the approved sub-line describes.
   The sidebar badge and "Top refi opportunities" list are unchanged.
3. **CharliView gets a third mode, "dock"**, with a `stacked` boolean for < 1024 px. The old full-page "home" mode is
   removed. The drawer stays unmounted on Home (today's `view !== "home" && panelOpen`), so only one CharliView is live at a
   time: one mic, one greeting. Both read the same kept session.
4. **Tap to talk, exactly:** tap → mic starts → the FIRST captured utterance is sent and the mic stops right then (state
   "off"); it does not restart after her reply. No speech within 8 s of the mic going live → mic stops, nothing sent, no new
   text (the button returns to "Tap to talk"). Tapping while it is open → mic stops, nothing sent. Pause while open → as
   Pause does today (mic off). Errors leave the mic off. While open the status tag shows "Listening" (green).
5. **Hands-free switch:** it takes effect immediately. Turning it off while live stops the mic, and turning it on does not
   start it (the next tap does). One setting per device, shared by the dock and the drawer. The drawer shows the same
   small switch and also defaults to tap to talk.
6. **Phone/stacked Overview:** keep ALL of today's Overview sections (the mockup's phone view was abbreviated). Below
   1350 px, every 4-across tile row (stat tiles and equity tiles) goes 2-across.
7. **Scroll:** if the page shell isn't a fixed-height flex layout, the dock is `position: sticky` under the top bar with
   `height: calc(100vh - top bar)` and its own `overflow-y: auto`. The Overview scrolls with the page.
8. **Assets:** already committed in this worktree at `client/public/charlie/charlie-portrait-{talk,idle}.{mp4,webm}` and
   `charlie-portrait.jpg` (cut with ffmpeg as described above). Nothing more needs to be rendered or cut.

## Left to the builder

- Exact component split (e.g. a `HomeView` that composes the Overview body and `CharliView mode="dock"`).
- The status-tag text when idle ("Ready" or none), icon choice for Home in the nav.
- Whether "All opportunities" comes from /api/sweeps or the greeting briefing (must equal Charlie's count).
- Breakpoint plumbing (a small pure `homeLayout(width)` helper + a resize hook is suggested).
