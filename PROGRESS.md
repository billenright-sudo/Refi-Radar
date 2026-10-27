# PROGRESS — Broker Radar

Living status file. **Update at the end of every major task** so work resumes
cleanly after compaction / a new session. Newest notes at the top of each list.

_Last updated: 2026-10-27_

## Done
- **Charli Plan B — Google Calendar + client email — BUILT 2026-10-27 on `feature/charli-google`
  (branched from `feature/accurate-refi-scoring` @ `b542904`), NOT merged, NOT deployed**
  (**server 642/642 + client 83/83 node:tests**, up from 415/64). Charli reads the broker's own
  Google Calendar ("what's on my calendar today?"), books follow-ups on it ("book a follow-up with
  the Chens Friday at 10": code-authored read-back → Confirm → `/api/assistant/confirm`, idempotent
  under the event id `"br"+confirmId`, no attendees, `sendUpdates=none`), and sets up client emails
  (check-in, refinance review) as code-authored templates — no rate or dollar figure, the sender's
  NMLS ID (and the company's) in the signature, no NMLS ID → no email — opened as Gmail / Outlook /
  mailto compose links the broker sends from their own mail app. **Nothing sends.** Google scope is
  `calendar.events` only (`gmail.compose` is restricted — see Key decisions). Per-user OAuth + PKCE
  with a browser-bound flow cookie, tokens AES-256-GCM-encrypted. New: `server/lib/google/{crypto,
  oauth,calendar,time,index}.js`, `server/lib/dateLabels.js`, `server/lib/assistant/outreach.js`,
  `server/routes/{google,profile}.js`, `client/src/charli/google.mjs` + the panel's Calendar & email
  card (Connect / Disconnect, NMLS fields, compose card). The orchestrator's guards now also cover
  calendar facts (day and time labels code-authored, grounded in the tool payload) and "I booked /
  I drafted" claims, including replies to an offer. Plan:
  `docs/superpowers/plans/2026-10-27-charli-google-calendar-gmail.md`. Whole-branch review and
  Bill's live check (needs his OAuth client + his own Google sign-in) still to come.
- **Charli v1 — BUILT + reviewed + MERGED into `feature/accurate-refi-scoring` 2026-10-26, NOT
  deployed** (53 commits fast-forwarded from `feature/teresa-voice-crm`, since deleted;
  **server 403/403 + client 52/52 node:tests** on the merged result; whole-branch
  Opus review 2026-10-25 "ready to merge with fixes" → 9-commit fix wave → scoped
  re-review → 9-commit round 2 → scoped re-review → one last gate fix `c541f2e`, confirmed
  clean). Voice-first AI CRM co-pilot:
  `POST /api/assistant/turn` (orchestrator: number-grounding against tool payloads,
  guideline hand-off, completion-claim + career-stage truth checks, action backstop;
  code-authored greeting from live sweep + market data), `POST /api/assistant/confirm`
  (the ONLY write path; idempotent `confirmId`; code-authored read-backs of every field
  written and "Done —" lines), `GET /api/assistant/usage`; `POST /api/voice/tts`
  (ElevenLabs streaming, voice **Bella**, `toSpeech` number-to-words, per-user daily
  character budget) + `/api/voice/stt` (Scribe v2); glossary `explainTerm`; career-stage
  coaching (new/developing/established/veteran — asked once, confirmed, never inferred;
  changes coaching style only); `rate_snapshots` with provider gating + "since <day>";
  `client/src/charli/` live-session UI (half-duplex mic, pending-change card with the
  fields, "Type instead", "unable to verify" chip). Typed path browser-verified;
  **the spoken path (mic + Bella) is Bill's first live session.** Design:
  `docs/superpowers/specs/2026-10-21-broker-radar-voice-crm-design.md`; plan:
  `docs/superpowers/plans/2026-10-21-teresa-voice-copilot-core.md`.
- **Sweeps Phase 1 — LIVE** (rev `refi-radar-00036-85j`, deployed 2026-10-21):
  `server/lib/refi.js` deterministic engine (rate-term, cash-out, ARM→fixed, term-swap
  lenses + 6-month check-in), `POST /api/sweeps` (org-scoped), `last_contact` migration
  + `POST /api/clients/:id/contact`. **19 node:tests pass.** Browser-verified locally
  and on prod: sweep auto-runs, all lenses fire, opportunity→client-detail nav works,
  "Log contact" persists `last_contact`. On prod Rate & Term = 2 (tuned demo rates);
  on the local seed it's 0 (milder rates vs 7.4% market — correct, parity with
  dashboard). _Temporary:_
  refi math is duplicated in `App.jsx analyze()` and `lib/refi.js` — matching tests
  guard drift until the dashboard migrates onto the shared engine.
- **Core app v2 live on Cloud Run** (rev `refi-radar-00035`): JWT auth, org/LO
  roles, client CRUD, notifications, rates, xlsx import, SQLite on GCS volume.
- **Accurate refi scoring** — LLPA credit/LTV pricing, 30-yr anchored to observed
  top-tier OBMMI rate, realistic closing costs ($2,500 + 1%). Deployed.
- **Live rates** — Optimal Blue daily indices via FRED (primary) + Claude for the
  5/1 ARM and full fallback + hardcoded "Estimated" last resort; 6h cache. Deployed.
- **UI rebrand RefiRadar → Broker Radar** (logo/titles/loading/copyright; commit
  `74be69c`) and **brighter navy background `#15294f`** (commit `afe0ad3`). Deployed.
- **Clean demo** — prod org "Premier Mortgage Group" (`demo@refiradar.com` /
  `DemoPass123!`) reseeded to 12 fake clients; 3 rates hand-tuned so the dashboard
  shows 4 strong opportunities at today's ~7.3% market.
- **UWM pitch assets** (private Artifacts): one-pager, 4 CRM screens, strategy
  brief, 5-slide deck. Deck + brief math anchored to UWM FY2025 public numbers
  ($70.3B refi, 1.16% margin). (One-pager still has the old illustrative math.)
- **Workflow setup (this task):** CLAUDE.md, PROGRESS.md, `tests/` with node:test
  suites (refi math, rates-down fallback, auth/permissions), `npm test` wired.

## Key decisions
- **Deterministic math, AI for the human layer only.** No LLM computes a
  savings/payment/LTV/break-even number — ever.
- **Charli's laws:** retrieve-and-cite, never guess — every spoken figure must match a
  tool payload; guideline questions hand off ("I can't verify guidelines yet"); no false
  "I logged it"; side effects only via `/confirm` after a code-authored read-back of every
  field that will be written; borrower PII (phone/email/notes) never reaches the model;
  ElevenLabs gets the broker's audio + Charli's reply text only; the model never rounds —
  rates are rounded to 2 decimals at the tool boundary, movement is computed in code and
  only between same-provider snapshots.
- **Charli's voice = ElevenLabs Bella** (`hpp4J3VqNfWAUOO0d1Us`, `eleven_v4_turbo`);
  HeyGen's Teresa voice was measured at 4.5–9 s of silence per reply and rejected.
- **Broker Radar is now our own product, sold to other brokers (2026-10-27)** — no longer a UWM
  build (the UWM pitch assets above are the history). Consequences: every broker connects their
  own Google account (nothing may depend on our Workspace), and anything that needs Google
  restricted-scope verification is out. That is why Plan B uses compose links, not Gmail drafts:
  `gmail.compose` is a restricted scope (restricted-scope verification + a paid third-party
  security assessment for outside customers), `calendar.events` is only sensitive.
- **Charli never sends.** Email is a code-authored template opened as a compose link the broker
  sends; calendar bookings go on the broker's own calendar with no attendees or invites. Every
  email carries the sender's NMLS ID (and the company's when set); no NMLS ID → no email.
- **"Sweeps"** = the AI opportunity engine; **Broker Radar** = the platform; **Charli**
  = the voice co-pilot on top of both.
- Sweeps works the book two ways: **opportunities** (refi/cash-out/MI-drop) **+
  relationships** (6-month check-ins). Sweeps reminds/drafts; **the broker sends.**
- Local dev runs on **Node 20** (better-sqlite3 prebuilds); Node 24 won't compile it.
- `feature/accurate-refi-scoring` is the working + deployed line (Charli v1 merged in,
  not yet deployed — the next approved deploy carries her, so set the `ELEVENLABS_*`
  secrets/env first or she runs text-only).

## Open issues
- **Charli deploy prerequisites (Bill's go):** `ELEVENLABS_API_KEY` → Secret Manager (a
  speech-only key with a character quota is preferred; the current key is unrestricted and
  one review subagent once echoed it into its own transcript — rotation is Bill's call);
  `ELEVENLABS_VOICE_ID_CHARLI`, `ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`,
  `CHARLI_TTS_DAILY_CHARS`, `CHARLI_TURN_DEADLINE_MS` as Cloud Run env (without the
  ElevenLabs ones Charli answers text-only);
  vendor data-retention terms (Anthropic API + ElevenLabs) to confirm; first real curl of
  `/api/voice/tts` and `/stt` against the service.
- **Charli Plan B deploy prerequisites (Bill's go, on top of the list above):**
  `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_KEY` → Secret Manager (`--update-secrets`);
  `GOOGLE_CLIENT_ID` and the production `GOOGLE_REDIRECT_URI`
  (`https://<cloud-run-host>/api/google/callback`) as Cloud Run env (`--update-env-vars`), and that
  redirect URI added to the OAuth client. `GOOGLE_REDIRECT_URI`'s host must match the host the user
  browses from (the OAuth flow cookie is host-scoped; `localhost` vs `127.0.0.1` matters — a mismatch
  fails closed to `/?google=error`). Without all four, Charli has no calendar (503 on connect).
  **Before selling to other brokers:** Google app verification for the sensitive `calendar.events`
  scope (needs a public homepage, a privacy policy, a verified domain). The calendar 403 auth-reason
  mapping (`server/lib/google/calendar.js`) still has to be checked against a real account.
- **Accepted claim-guard residual (Plan B, Ruling 42 — a design decision for Bill):** a model that
  skips the tool and phrases a done-claim inside a clarifying question ("…since it's on your
  calendar now — which Chen?"), or paraphrases a done-claim after an ambiguous reply, can still
  mislead in speech; the guards are word lists and no list covers every paraphrase. Nothing is
  written without a confirm, and no pending card appears, so the calendar and the mail are never
  changed by it. Proposed fix: code-authored clarifiers on action turns (built from tool
  results), or a small second model call that classifies "does this reply say something was
  done?" — as part of the orchestrator tidy (I6, below). The same holds for calendar facts on a
  turn with no calendar read (Ruling 62): the Ruling 49 screen needs an availability or calendar
  word, so about 5 in 20 paraphrases with none ("You've got nothing on Friday.", "You have a
  follow-up with the Chens this morning.") can still be spoken unchecked.
- **Charli follow-ups from the reviews** (the 25 s turn deadline, client timeouts, the
  session.mjs ↔ real-router test and the 429 note were done 2026-10-26 on
  `feature/charli-hardening`): orchestrator tidy into one `screenReply` decision
  function (replace shape regexes with a verb-presence rule); a `/confirm` that times out
  after the server wrote leaves "cancel" saying "I'll leave that" while the write stands;
  a model call aborted by the deadline is not metered (tokens unknown); `ttsFailureBody`
  has no time bound (a stalled error body holds the speech queue until Pause);
  `assistant_confirmations` 30-day prune; a completion claim after a mid-sentence "and"
  ("…and Chen marked as contacted") is not caught; `POST /api/clients` still writes 700 for
  an unusable credit score while the voice tool rejects it; talk-track tool for brand-new
  LOs (product call); glossary-only turns make a second model call; non-numeric inventions
  on tool turns ("the Chens are VA eligible") are not code-checked in v1. From the
  re-reviews (all fail closed): after a cancelled read-back "run that sweep again" / "show
  this week's check-ins" are held (that/this before a noun read as a pronoun); "I called the
  Chens, was a great call." no longer counts as a contact report (auxiliary-led clause);
  "Had a call with…" subject-drop forms aren't reports; paraphrased claims ("The Chens are
  current now.") rely on the prompt until the verb-presence rule; dated/active-voice
  narration ("Last contact logged January 1st, 2024.") is over-caught; the "since" label is a
  UTC day; the TTS 429 note can't tell the 15-minute limiter from the daily budget (pass the
  body through `onTtsError`); a stale rate set is still classified by its label; on a turn
  that cites the sweep, a fabricated count claim ("One follow-up added for Friday.") is still
  exempt (limit the "added" exemption to "added since / today / this week").
- `main` is behind both feature branches (not merged).
- Garbled org-1 name on Bill's real account (`wenright1@gmail.com`) — no org-rename
  API; needs a small DB fix.
- Data gaps blocking Sweeps Phase 2: **loan program, occupancy, MI status, and today's home
  value (AVM)** are not captured; only origination `propertyValue` exists.
- `scripts/import` xlsx flow has no automated test yet (see Next steps).
- gcloud auth tokens expire often → deploys intermittently need `gcloud auth login`.

## Next steps
1. **Bill's live check of Plan B** (needs his own OAuth client in Google Cloud Console and his
   own Google sign-in; Claude never types his password): restart the API, sign in to Google from
   the Charli panel, enter his NMLS ID, use a test client whose email is his own address; check
   "what's on my calendar today?", book a follow-up (read-back → Confirm → one event, no guests;
   Confirm again → no second event), and "draft <client> a check-in" → Open in Gmail shows the
   prefilled email, unsent. Then delete the test event.
2. **Bill's first spoken session with Charli** (mic + Bella, local dev servers): time
   end-of-speech → first audio; run the plan's Task 6 live check (greeting, "what are rates
   today", a sweep, "log a contact for the Chens" → spoken yes).
3. **Deploy on Bill's go** (Charli + Plan B) once the secrets/env above are set; merge
   `feature/charli-google` first; then merge to `main`.
4. **Client target-rate alerts.**
5. **Sweeps Phase 2:** capture **loan program, occupancy and MI status** (plus an AVM feed) → the
   **FHA streamline / VA IRRRL** and **drop-MI** lenses and accurate cash-out. Then: real pricing,
   multi-loan clients, referral partners, LOS import, texting with consent, automatic
   past-client touches, production reports.
6. Add the import + fuller auth integration tests (needs a temp test DB harness).
7. Housekeeping when convenient: merge to `main`, fix org-1 name, sync one-pager
   math, PDF/PPTX deck exports.
