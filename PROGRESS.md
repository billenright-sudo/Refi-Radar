# PROGRESS — Broker Radar

Living status file. **Update at the end of every major task** so work resumes
cleanly after compaction / a new session. Newest notes at the top of each list.

_Last updated: 2026-10-25_

## Done
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
- Data gaps blocking Sweeps Phase 2: **loan program, MI status, and today's home
  value (AVM)** are not captured; only origination `propertyValue` exists.
- `scripts/import` xlsx flow has no automated test yet (see Next steps).
- gcloud auth tokens expire often → deploys intermittently need `gcloud auth login`.

## Next steps
1. **Bill's first spoken session with Charli** (mic + Bella, local dev servers): time
   end-of-speech → first audio; run the plan's Task 6 live check (greeting, "what are rates
   today", a sweep, "log a contact for the Chens" → spoken yes).
2. **Deploy on Bill's go** once the secrets/env above are set (Charli is on the deployed
   line now); then merge to `main`.
3. **Charli Plan B — Google Calendar + Gmail draft-and-approve** (design §7.3; per-user
   OAuth, draft-only email, general drafts without figures).
4. **Sweeps Phase 2:** add program/MI fields + an AVM feed → the **drop-MI** lens
   and accurate cash-out.
5. Add the import + fuller auth integration tests (needs a temp test DB harness).
6. Housekeeping when convenient: merge to `main`, fix org-1 name, sync one-pager
   math, PDF/PPTX deck exports.
