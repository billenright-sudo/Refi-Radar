# Charli Voice Co-pilot (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broker opens Broker Radar, is greeted by Charli in her real voice, and runs their book hands-free — market update, live sweep by name, pull up / add a client, log a contact — with every spoken fact traced to a source and nothing guessed.

**Architecture:** Browser captures the broker's speech and chunks it on silence; a server route transcribes it (ElevenLabs Scribe), a server-side orchestrator asks Claude to pick one of a fixed set of deterministic tools (which wrap the existing engine + CRM), executes it, and returns Charli's narrated reply + its source; another route turns that reply into audio via Charli's ElevenLabs voice. Borrower data and all reasoning stay on our server; ElevenLabs only receives audio and reply text, never a third-party LLM making decisions. Side-effecting actions (add client, log contact) are read back and confirmed before they run.

**Tech Stack:** Node 20 + Express + better-sqlite3; `@anthropic-ai/sdk` (already a dependency); ElevenLabs REST API (TTS + Scribe STT) via server proxy; React 18 + Vite (existing `client/src/App.jsx`); node:test.

**Spec:** `docs/superpowers/specs/2026-10-21-broker-radar-voice-crm-design.md`

## Global Constraints

- **Node 20** locally (better-sqlite3 prebuilds; Node 24 won't compile it).
- **Deterministic math only:** every number comes from `server/lib/refi.js` or the rates engine. No LLM computes or guesses a number, fact, or guideline. When no tool answers, the reply is an explicit "I can't verify that," never a generated answer.
- **Data stays on our infra:** Claude orchestration runs server-side; borrower NPI never flows to a third-party conversational model. STT uses **ElevenLabs Scribe via our server proxy** (not the browser's Google-backed Web Speech API, which would send spoken client names to Google).
- **Side effects are confirmed:** `addClient`, `logContact`, and `setCareerStage` return a pending action that runs only after an explicit confirm; Charli reads back exactly what will be written first.
- **Career stage changes coaching style only** — never the numbers, the tools, the no-guess law, or the confirm rule. Stage is self-set (voice, confirmed) or broker-set for their LOs; it is never inferred from behavior.
- **Execution order:** Tasks 1, 2, 3, 4, **7**, 5, 6 — Task 7 was added mid-build and must precede Task 6, whose UI includes the career-stage selector.
- **Secrets by env var only**, never in the repo: `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (existing), new `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID_CHARLI`. Confirm they are in `server/.env` locally and Google Secret Manager for Cloud Run.
- **No deploy without Bill's explicit go.** This plan builds and verifies locally only.
- All new server code is CommonJS `"use strict";`, matching the existing server.

## Review Focus

- **Ambiguous or mis-heard client name on a side-effecting action** → Charli must read the matched name back and require a confirm; if the query matches 0 or >1 clients she asks which, never acts on a guess. _(Task 2 tests `findClient`; Task 3 tests the confirm gate.)_
- **Claude tries to answer a factual/quantitative question without calling a tool** → the orchestrator must not surface model-authored facts; the turn resolves to "I can't verify that." _(Task 3 test with a stubbed model that returns prose instead of a tool call.)_
- **A question in the deferred loan-guideline domain** (e.g. a Fannie reserve rule) → Charli gives the hand-off line ("I can't verify that yet"), no hallucinated guideline. _(Task 3 test.)_
- **ElevenLabs or Claude API failure mid-session** → the turn returns a clean error turn, the session stays usable, and no partial side effect is committed. _(Task 4 tests the route's error path; Task 5 tests the voice proxy error path.)_
- **"Movement" requested with fewer than two daily snapshots** → states today's rates and explicitly makes no movement claim. _(Task 1 test.)_
- **Same question from a brand-new LO and a 20-year veteran** → identical tool calls, data, and sources; only the coaching style in the system prompt differs. A user with no stage set is asked once and never assigned a guessed stage. _(Task 7 tests.)_

---

### Task 1: Daily rate snapshot + movement

**Files:**
- Modify: `server/db.js` (add idempotent `rate_snapshots` migration next to the `last_contact` one)
- Create: `server/lib/rateHistory.js`
- Modify: `server/routes/rates.js` (capture-on-fetch after a successful rate resolve)
- Test: `server/test/rate-history.test.js`

**Interfaces:**
- Produces: `recordSnapshot(rates, day?) -> void` (upserts one row per `YYYY-MM-DD`); `getMovement(rates) -> { current: object, previous: object|null, deltas: {key:number}|null, hasHistory: boolean }` where `deltas` is `null` until a prior-day snapshot exists.
- `rate_snapshots` schema: `day TEXT PRIMARY KEY, rates TEXT (JSON), captured_at TEXT`.

- [ ] **Step 1: Write the failing test** in `server/test/rate-history.test.js` on a temp `DATA_DIR`:
  - `recordSnapshot` writes one row; calling it twice the same day leaves one row (upsert).
  - `getMovement` returns `hasHistory:false, deltas:null` with only today's snapshot.
  - After seeding a prior-day snapshot (30yr 7.50) then today's (30yr 7.40), `getMovement` returns `deltas.rate_30yr_fixed === -0.10` (±1e-9) and `hasHistory:true`.

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test` → FAIL (module/table missing).

- [ ] **Step 3: Implement** the `rate_snapshots` migration in `server/db.js` and `recordSnapshot` / `getMovement` in `server/lib/rateHistory.js` (day key via `toISOString().slice(0,10)`; previous = most recent `day < today`).

- [ ] **Step 4: Wire capture** in `server/routes/rates.js`: after a successful live/fallback rate resolve (not the hardcoded last-resort), call `recordSnapshot(rates)`.

- [ ] **Step 5: Run to verify it passes** — `cd server && npm test` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: persist daily rate snapshots for market movement"`

---

### Task 2: Assistant tool layer

**Files:**
- Create: `server/lib/assistant/tools.js`
- Test: `server/test/assistant-tools.test.js`

**Interfaces:**
- Consumes: `server/lib/refi.js` (`runSweep`), `server/db.js`, `server/lib/rateHistory.js` (`getMovement`), the rates passed in by the caller.
- Produces a map of tool fns, each `(args, ctx) -> { data, source, sideEffect? }` where `ctx = { user, rates, db }` and `source` is a short citation string:
  - `getMarketUpdate(_, ctx)` → `{ data: {rates, deltas, hasHistory}, source: "live rates <date>" }`
  - `runSweepTool(_, ctx)` → `{ data: runSweep(orgClients, ctx.rates), source: "sweep engine" }` (org-scoped like `routes/sweeps.js`)
  - `findClient({query}, ctx)` → `{ data: {matches:[{id,name,...}]}, source: "client record" }` — case-insensitive name contains; returns all matches (caller disambiguates)
  - `addClientTool(fields, ctx)` → `{ data:{preview:fields}, source:"(unsaved)", sideEffect:{type:"addClient", fields} }` (does NOT write)
  - `logContactTool({clientId}, ctx)` → `{ data:{client}, source:"client record", sideEffect:{type:"logContact", clientId} }` (does NOT write)
- Produces `TOOL_SCHEMA` — the Anthropic tool-definition array describing the read tools + the two side-effect tools.

**Canonical engine (spec §5):** these tools use the **server** `server/lib/refi.js` as the single math source. The drift guard against the dashboard's `client/src/App.jsx analyze()` is the shared known-answer fixtures already pinned in `server/test/refi-math.test.js` (client `analyze`) and `server/test/sweeps.test.js` (server `refi.js`) — identical expected numbers, so a divergence fails one suite. This task's test adds the same known-answer assertion for `runSweepTool`, keeping all three on one fixture.

- [ ] **Step 1: Write the failing test** in `server/test/assistant-tools.test.js` (temp DATA_DIR, seed one org + 2 clients "Robert & Linda Chen", "Carlos & Maria Reyes", one high-rate):
  - `getMarketUpdate` returns `data.rates.rate_30yr_fixed` a number and a non-empty `source`.
  - `runSweepTool` returns `data.counts.total === 2` and at least one opportunity.
  - `findClient({query:"chen"})` returns exactly one match named "Robert & Linda Chen".
  - `findClient({query:"a"})` returns >1 match (disambiguation case).
  - `logContactTool({clientId})` returns a `sideEffect.type === "logContact"` and does **not** change `last_contact` in the DB.
  - `TOOL_SCHEMA` is a non-empty array and every entry has `name` + `input_schema`.

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test` → FAIL.

- [ ] **Step 3: Implement** `server/lib/assistant/tools.js` (read tools query the DB/engine; side-effect tools only package the intent). Reuse the org/LO scoping from `server/routes/sweeps.js:19-21`.

- [ ] **Step 4: Run to verify it passes** — `cd server && npm test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: assistant tool layer over engine + CRM (no side effects)"`

---

### Task 3: Charli prompt + Claude orchestrator

**Files:**
- Create: `server/lib/assistant/prompt.js` (exports `CHARLI_SYSTEM` string)
- Create: `server/lib/assistant/orchestrator.js`
- Test: `server/test/assistant-orchestrator.test.js`

**Interfaces:**
- Consumes: `TOOL_SCHEMA` + tool fns (Task 2), `CHARLI_SYSTEM`.
- Produces: `runTurn({ messages, ctx, client }) -> { reply, sources:[string], sideEffect?:{...}, usage:{inputTokens,outputTokens} }`. `client` is an injected Anthropic-like client with `messages.create()` — **injected so tests use a fake**; production passes the real `@anthropic-ai/sdk` client built from `ANTHROPIC_API_KEY`/`CLAUDE_MODEL`.
- Contract enforced: the model may only produce facts by calling a tool. `runTurn` executes the requested tool, feeds the result back, and returns the model's narration. If the model answers a factual ask with no tool call, `runTurn` returns the fixed `reply: "I can't verify that from what I have, so I won't guess."` A side-effect tool call is **not executed**; it is returned in `sideEffect` for confirmation (Task 4).

**`CHARLI_SYSTEM` must encode:** the warm "Charli" persona + morning greeting intent; the retrieve-and-cite law (answer only from tool results; otherwise say she can't verify); the confirmation rule for side effects; PII minimization (never read back full SSNs/account numbers); and the hand-off line for the deferred loan-guideline domain.

- [ ] **Step 1: Write the failing test** in `server/test/assistant-orchestrator.test.js` using a **fake client** whose `messages.create()` is scripted per case:
  - Fake returns a `getMarketUpdate` tool_use → `runTurn` reply contains the real rate number and `sources` includes the market source.
  - Fake returns a text answer with no tool_use to "what's today's rate" → reply is the fixed "can't verify / won't guess" string, `sources` empty.
  - Fake returns a `logContactTool` tool_use → `runTurn` returns `sideEffect.type === "logContact"` and the reply reads the client name back; DB `last_contact` unchanged.
  - Fake returns a text answer to a loan-guideline question → reply is the deferred-domain hand-off line.

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test` → FAIL.

- [ ] **Step 3: Implement** `prompt.js` and `orchestrator.js` (standard Anthropic tool-use loop: send messages+tools; on `tool_use` run the tool; append `tool_result`; re-call for narration; cap at a small tool-call limit). Side-effect tool calls short-circuit to `sideEffect` without executing.

- [ ] **Step 4: Run to verify it passes** — `cd server && npm test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Charli orchestrator enforces retrieve-and-cite, gates side effects"`

---

### Task 4: Assistant routes + confirm + cost metering

**Files:**
- Create: `server/routes/assistant.js`
- Create: `server/lib/assistant/metering.js`
- Modify: `server/db.js` (add `assistant_usage` migration), `server/index.js` (mount `/api/assistant`)
- Test: `server/test/assistant-api.test.js`

**Interfaces:**
- `POST /api/assistant/turn` (requireAuth) body `{ messages, rates }` → `{ reply, sources, sideEffect?, turnId }`. Builds `ctx` from `req.user` + `rates`, calls `runTurn` with the real Anthropic client.
- `POST /api/assistant/confirm` (requireAuth) body `{ sideEffect }` → executes the packaged side effect (`addClient` via existing client-create logic; `logContact` via the existing `last_contact` update), returns `{ success, result }`. This is the only path that mutates from a voice action.
- `recordUsage({userId, inputTokens, outputTokens, ttsChars}) -> void` → row in `assistant_usage` (`id, user_id, input_tokens, output_tokens, tts_chars, created_at`).
- Guards: `turn` 400 without `rates.rate_30yr_fixed` (mirrors `routes/sweeps.js`); a Claude/tool error returns 200 with a clean error turn (`{ reply: "<spoken apology>", error:true }`), never 500-crashes the session.

- [ ] **Step 1: Write the failing test** in `server/test/assistant-api.test.js` (register a broker, seed clients, fake/stub the Anthropic client via an env/DI seam):
  - `turn` without rates → 400.
  - anonymous `turn` → 401.
  - `turn` that yields a `logContact` sideEffect → 200 with `sideEffect`; DB unchanged.
  - `confirm` with that sideEffect → 200 and `last_contact` now set.
  - `recordUsage` writes a row with the given token/char counts.

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test` → FAIL.

- [ ] **Step 3: Implement** the routes, metering, migration, and mount. Reuse the existing client-create and `last_contact` update code paths (don't duplicate SQL). Record usage at the end of each `turn`.

- [ ] **Step 4: Run to verify it passes** — `cd server && npm test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: /api/assistant turn+confirm routes with cost metering"`

---

### Task 5: ElevenLabs voice proxy (TTS + Scribe STT)

**Files:**
- Create: `server/routes/voice.js`
- Modify: `server/index.js` (mount `/api/voice`)
- Test: `server/test/voice-api.test.js`

**Interfaces:**
- `POST /api/voice/tts` (requireAuth) body `{ text }` → streams `audio/mpeg` from ElevenLabs using `ELEVENLABS_VOICE_ID_CHARLI` and the Flash/Turbo model id; 400 if `text` missing/empty; counts `text.length` into `recordUsage` (ttsChars). API key stays server-side.
- `POST /api/voice/stt` (requireAuth) multipart audio blob → `{ text }` via ElevenLabs Scribe; 400 if no audio.
- The outbound ElevenLabs call is made through an injectable `fetch`-like fn (module default = global `fetch`) so tests stub it; an ElevenLabs non-2xx returns 502 with `{ error }`, not a crash.

- [ ] **Step 1: Write the failing test** in `server/test/voice-api.test.js` with a stubbed fetch:
  - `tts` with no `text` → 400.
  - `tts` with `text:"Good morning, Bill."` → stub asserts the request URL/body carry the configured voice id and model; route responds 200 with the stubbed audio bytes.
  - `tts` when the stub returns a 401 → route responds 502 `{ error }`.
  - anonymous `tts` → 401.

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test` → FAIL.

- [ ] **Step 3: Implement** `server/routes/voice.js` (TTS via `POST /v1/text-to-speech/{voiceId}`; STT via the Scribe endpoint; inject fetch; read `ELEVENLABS_*` from env). Add the two vars to `server/.env.example` by name only.

- [ ] **Step 4: Run to verify it passes** — `cd server && npm test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: server-side ElevenLabs voice proxy (Charli TTS + Scribe STT)"`

---

### Task 6: Charli live-session voice UI

**Files:**
- Modify: `client/src/App.jsx` (add `CharliView` component + nav item + render-switch; greet-on-open hook)
- Verify: browser preview (this task is UI/audio — verified in the Browser pane, not node:test)

**Interfaces:**
- Consumes: `POST /api/assistant/turn`, `POST /api/assistant/confirm`, `POST /api/voice/tts`, `POST /api/voice/stt` (same-origin cookie auth).
- `CharliView` behavior:
  - On open, posts a greeting turn (or a canned greeting) and plays it via `/api/voice/tts`; the login/open click is the audio-autoplay gesture.
  - **Live loop:** capture mic (`getUserMedia`) → detect end-of-utterance by a simple silence timer (VAD-lite) → POST the audio to `/api/voice/stt` → send the transcript + running `messages` to `/api/assistant/turn` → render Charli's reply with its **source**, play it via `/api/voice/tts`, then reopen the mic. **Pause/Mute** control stops the loop.
  - **Side-effect confirmation:** when a turn returns `sideEffect`, show the read-back + a Confirm/Cancel; Confirm calls `/api/assistant/confirm`, Cancel discards.
  - Transcript list shows each turn with its source; a turn flagged `error:true` renders as a recoverable error, session continues.
  - **Career-stage selector** (New / Developing / Established / Veteran — labels from Task 7's `CAREER_STAGES`) in the Charli panel, showing the user's current stage; choosing one posts `{ sideEffect: { type: "setCareerStage", stage } }` to `/api/assistant/confirm` (the click is the confirmation).
  - Reuses module-scope `C`, `card`, `mono`, `Icon`, `$c`; matches the Sweeps view's styling.

- [ ] **Step 1: Add** `CharliView` + a `{ id:"charli", label:"Charli", icon:"mic" }` nav item (after `sweeps`) + the render-switch line, following the `SweepsView` pattern already in `App.jsx`.

- [ ] **Step 2: Build the client** — `cd client && npx vite build` → exit 0.

- [ ] **Step 3: Browser-verify** (per the harness verification workflow): start the server (Node 20) + vite, log in as `demo@refiradar.com`, open **Charli**; confirm greeting plays, a spoken "what are rates today" is transcribed → market update spoken with a visible source, "run a sweep" names an opportunity, "log contact for the Chens" shows a read-back + Confirm and only writes on Confirm. Capture a screenshot. (Requires `ELEVENLABS_*` and `ANTHROPIC_API_KEY` in `server/.env`.)

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: Charli live-session voice UI"`

---

### Task 7: Experience-aware coaching (career stage)

_Added mid-build (2026-10-22). Runs after Task 4, before Task 5._

**Files:**
- Modify: `server/db.js` (idempotent migration: `users.career_stage TEXT` nullable)
- Modify: `server/middleware/auth.js` (`requireAuth` SELECT adds `career_stage`, so `req.user` / `ctx.user` carry it)
- Create: `server/lib/assistant/coaching.js`
- Modify: `server/lib/assistant/prompt.js`, `server/lib/assistant/orchestrator.js`, `server/lib/assistant/tools.js`, `server/routes/assistant.js`, `server/routes/org.js`
- Test: `server/test/coaching.test.js`

**Interfaces:**
- Consumes: `runTurn`, `CHARLI_SYSTEM` (Task 3); the tools map + `TOOL_SCHEMA` (Task 2); `/api/assistant/confirm` side-effect executor (Task 4).
- Produces: `CAREER_STAGES` — ordered `[{ id:"new", label:"New (under 1 year)" }, { id:"developing", label:"Developing (1–3 years)" }, { id:"established", label:"Established (3–10 years)" }, { id:"veteran", label:"Veteran (10+ years)" }]`; `coachingStyle(stageId|null) -> string`; `buildCharliSystem(user) -> string` (= `CHARLI_SYSTEM` + `coachingStyle(user.career_stage)`); `setCareerStageTool({ stage }, ctx) -> { data:{ stage, label }, source:"(unsaved)", sideEffect:{ type:"setCareerStage", stage } }` (invalid stage → `(invalid input)`, no `sideEffect`); `PATCH /api/org/los/:id/stage` body `{ stage }`.
- `runTurn` sends `buildCharliSystem(ctx.user)` as `system`. Read-back for this side effect is code-authored: `Just to confirm — set your career stage to <label>?`. `/api/assistant/confirm` executes `setCareerStage` as `UPDATE users SET career_stage = ? WHERE id = req.user.id` only.

**Coaching style by stage (the content `coachingStyle` encodes):**
- **new** — explain each figure in plain words the first time it comes up (what LTV, break-even, a rate-and-term refi mean); suggest one concrete next step at a time; offer a short talk track; remind that outreach is approved before sending and drafts stay general; encouraging.
- **developing** — brief explanations only for less common terms; suggest next steps; offer talk tracks, don't push them.
- **established** — concise; ranked actions; explain only when asked.
- **veteran** — numbers first, terse, no definitions, ranked list, fastest path to action.
- **null (unknown)** — balanced like *developing*; after greeting, ask once how long they've been originating, map the answer to a stage, and call `setCareerStageTool`. Never assume a stage.
- **Every stage:** same tools, same numbers, same retrieve-and-cite law, same confirm rule.

- [ ] **Step 1: Write the failing test** in `server/test/coaching.test.js` (temp DATA_DIR seed pattern):
  - `buildCharliSystem` returns four distinct prompts for the four stages and a fifth for `null`; every one contains `CHARLI_SYSTEM` verbatim.
  - The `null` prompt contains the ask-once instruction; the four staged prompts do not.
  - `setCareerStageTool({ stage:"veteran" })` → `sideEffect.type === "setCareerStage"`, DB unchanged; `{ stage:"guru" }` → `(invalid input)`, no `sideEffect`.
  - `runTurn` with one scripted fake client, run once as a `new` user and once as a `veteran` user: the tool calls, tool args, `sources`, and returned data are identical; only the `system` param sent to the client differs.
  - A fake `setCareerStageTool` tool_use → reply `Just to confirm — set your career stage to Veteran (10+ years)?` + `sideEffect`, not executed.
  - `/confirm` with `setCareerStage` writes `career_stage` for the caller only.
  - `PATCH /api/org/los/:id/stage`: broker, same-org LO → 200 + written; LO caller → 403; LO in another org → 404; invalid stage → 400.

- [ ] **Step 2: Run to verify it fails** — `cd server && npm test` → FAIL.

- [ ] **Step 3: Implement** the migration, `requireAuth` column, `coaching.js`, `buildCharliSystem`, the orchestrator `system` switch, `setCareerStageTool` + its `TOOL_SCHEMA` entry, the `/confirm` executor branch, and the broker `PATCH` route (reuse `requireBroker` and the org-scoping already in `routes/org.js`).

- [ ] **Step 4: Run to verify it passes** — `cd server && npm test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: Charli tailors coaching to the user's career stage"`

---

## Prerequisites (Bill / setup, before Task 5–6 verification)

- `ELEVENLABS_API_KEY` in `server/.env` (+ Secret Manager before any deploy).
- `ELEVENLABS_VOICE_ID_CHARLI` = `hpp4J3VqNfWAUOO0d1Us` (Bella, chosen by Bill 2026-10-25 from an audition; already set in `server/.env`). Teresa is a HeyGen voice and measured too slow for live replies (4.5–9 s). Also set: `ELEVENLABS_TTS_MODEL=eleven_v4_turbo`, `ELEVENLABS_STT_MODEL=scribe_v2` (both verified live against Bill's account).
- `ANTHROPIC_API_KEY` already present (used by the existing app).

## Out of scope (this plan)

Google calendar + Gmail draft-and-approve (Plan B), marketing-ideas, inbound-email reading, "Hey Charli" wake word, Outlook, multi-broker onboarding, and the loan-guideline corpus module.
