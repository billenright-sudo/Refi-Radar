# CLAUDE.md — Broker Radar (RefiRadar)

Guidance for working in this repo. Keep it current.

## What this is
**Broker Radar** (legacy name **RefiRadar**; the UI now says "Broker Radar", the
GCP service/repo keep `refi-radar`) is a broker-intelligence SaaS from **Ignite
Business Solutions**. It lets a mortgage broker/LO track a book of past-client
loans, pulls **live mortgage rates**, and flags **refinance opportunities**
(payment savings, break-even, priority). **"Sweeps"** is the AI opportunity engine
(rate-term + cash-out + ARM→fixed + term-swap lenses, a 6-month check-in cadence) —
live. **"Charli"** is the voice-first AI CRM co-pilot on top (v1 merged, not yet
deployed): she speaks the morning brief,
runs sweeps, looks up / adds clients and logs contacts by voice with
confirm-before-write, explains terms from a fixed glossary, and tailors coaching to
the user's career stage. **Plan B** (branch `feature/charli-google`, not merged, not
deployed) adds her calendar and client email: she reads the broker's Google Calendar,
books follow-ups on it after a confirm, and sets up client emails as compose links the
broker sends from their own mail app.

## Stack
- **Backend:** Node + Express, **better-sqlite3** (SQLite), JWT auth
  (`bcryptjs`, `jsonwebtoken`, `cookie-parser`), `express-rate-limit`,
  `nodemailer` (invites/alerts), `xlsx` + `multer` (import + voice upload),
  `@anthropic-ai/sdk` (Charli orchestration, rates fallback). ElevenLabs REST
  (TTS stream + Scribe STT) called with `fetch` through a server proxy — no SDK.
  CommonJS.
- **Frontend:** React 18 + **Vite** (one big `client/src/App.jsx`, inline styles
  via a `C` palette object; Charli lives in `client/src/charli/`, ESM `.mjs`
  modules with node:test). Build outputs to `build/`.
- **Container:** multi-stage `node:20-alpine` Dockerfile.
- **Node 20 required locally** (better-sqlite3 has prebuilt binaries for 20, not
  24). Portable Node 20 lives at `C:\Users\bille\dev\node20`.

## Folder structure
```
server/    index.js (entry, wires routes), db.js (SQLite schema + idempotent migrations), email.js,
           routes/{auth,clients,org,notifications,rates,import}.js,
           routes/assistant.js  /api/assistant/{turn,confirm,usage}  (Charli; /confirm = the only write path;
                                a calendar booking is confirmed here too, idempotently)
           routes/google.js     /api/google/{connect,callback,status,disconnect}  (per-user Google OAuth)
           routes/profile.js    /api/profile/{nmls,org-nmls}  (sender / company NMLS ID, printed on every email)
           routes/voice.js      /api/voice/{tts,stt}  (ElevenLabs proxy; key never leaves the server)
           lib/refi.js (deterministic sweep engine), lib/rateHistory.js (daily rate snapshots, movement "since <day>"),
           lib/assistant/{orchestrator,tools,prompt,coaching,glossary,speech,metering}.js
           lib/assistant/outreach.js  code-authored client-email templates + Gmail / Outlook / mailto compose links
           lib/google/{crypto,oauth,calendar,time,index}.js  crypto = AES-256-GCM token encryption; oauth = PKCE
                                flow, token store + refresh; calendar = Calendar REST (read a day, insert an event);
                                time = zone-aware date/time helpers; index = the per-user adapter the tools get as ctx.google
           lib/dateLabels.js    db-free month / weekday / ordinal labels (spoken dates are code-authored)
           middleware/ (auth: requireAuth/requireBroker, signToken)
client/    src/App.jsx (whole UI), src/index.jsx, index.html, vite.config.js
           src/charli/{session.mjs,vad.mjs,audio.js,CharliView.jsx,google.mjs} (+ *.test.mjs);
           google.mjs = the words of the Calendar & email card, no DOM
scripts/   seed-demo.js (fake demo broker + 12 fake clients),
           check-scoring.js (refi-math sanity check)
server/test/  node:test suites (refi math, rates, auth/permissions, sweeps, Charli orchestrator/API/voice/coaching)
docs/superpowers/{specs,plans}/  Charli design + implementation plan
Dockerfile, docker-compose.yml, .env.example, .gcloudignore, policy.json
```

## Hosting & deploy
- **Google Cloud Run**, project **`refi-radar-496318`**, region **`us-central1`**,
  service **`refi-radar`**, URL **https://refi-radar-194747178897.us-central1.run.app**
  (project number **194747178897** — do not typo it).
- SQLite file persists on a **GCS FUSE volume** (bucket
  `refi-radar-db-refi-radar-496318`) mounted at `/data` (`DATA_DIR=/data`).
- **Deploy:** `gcloud run deploy refi-radar --source . --region us-central1 --project refi-radar-496318`
  (Cloud Build rebuilds the client). gcloud auth tokens expire — if a deploy
  fails on "Reauthentication", Bill runs `gcloud auth login`.
- **Never deploy without Bill's explicit go** (one approval = one deploy).
- **Repo:** `github.com/billenright-sudo/Refi-Radar`. Working + deployed branch
  **`feature/accurate-refi-scoring`** (Charli v1 merged in 2026-10-26, not yet deployed);
  `main` is behind.
- **Charli Plan B deploy prerequisites** (on top of the list below; Bill's go):
  `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_KEY` in Secret Manager (`--update-secrets`);
  `GOOGLE_CLIENT_ID` and the production `GOOGLE_REDIRECT_URI`
  (`https://<cloud-run-host>/api/google/callback`) as env (`--update-env-vars`); that same
  redirect URI added to the OAuth client's authorized redirect URIs. `GOOGLE_REDIRECT_URI`'s
  host must be the host the user browses from — the OAuth flow cookie is host-scoped, so
  `localhost` vs `127.0.0.1` matters (a mismatch fails closed: `/?google=error`). Without all
  four, `/api/google/connect` answers 503 and Charli has no calendar. Before selling to other
  brokers: Google app verification for the sensitive `calendar.events` scope (public
  homepage, privacy policy, verified domain). Check the calendar 403 auth-reason mapping
  (`server/lib/google/calendar.js`) against a real account.
- **Charli deploy prerequisites:** `ELEVENLABS_API_KEY` in Secret Manager
  (`--update-secrets`: `--set-secrets` replaces every existing secret mapping — ANTHROPIC, FRED,
  JWT_SECRET, the GOOGLE_* ones — and without JWT_SECRET the server exits on start), the other
  `ELEVENLABS_*` + `CHARLI_TTS_DAILY_CHARS` (default 60000)
  + `CHARLI_TURN_DEADLINE_MS` (default 25000; accepted 2000–30000, else the default) as env;
  without them Charli falls back to text-only (503 on the voice routes).

## Data sources
- **FRED API** (`FRED_API_KEY`): `DGS10` 10-yr Treasury (the Treasury widget) +
  **Optimal Blue** daily mortgage indices (`OBMMIC30YF`, `OBMMIC15YF`, jumbo,
  FHA, **top-tier** `OBMMIC30YFLVLE80FGE740`) as the primary live-rate source.
- **Anthropic Claude** (`ANTHROPIC_API_KEY`, web search) for the 5/1 ARM rate and
  as the full fallback when FRED is down. Rates are cached in-memory for 6h.
  Last-resort is a hardcoded "Estimated" rate set so the UI never breaks.
- **ElevenLabs** (`ELEVENLABS_API_KEY`): Charli's voice **Bella**
  (`ELEVENLABS_VOICE_ID_CHARLI`, model `ELEVENLABS_TTS_MODEL`) and Scribe
  speech-to-text (`ELEVENLABS_STT_MODEL`). Receives only the broker's audio and
  Charli's reply text — never tool results.

## Branding
Dark **navy** background (`#15294f`, brightened from near-black 2026-10-15),
**amber** accents (`#f59e0b`), Georgia-serif **"Broker Radar™"** logo (inline
SVG, `RefiRadarLogo` component), subtitle "BROKER INTELLIGENCE PLATFORM",
footer "A Product of Ignite Business Solutions". **Layout is approved — do not
restyle without asking.**

## Secrets — names only, never values in the repo
Referenced by env var; stored in **Google Secret Manager** (`ANTHROPIC_API_KEY`,
`FRED_API_KEY`, `JWT_SECRET`, and on Charli's deploy `ELEVENLABS_API_KEY`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_KEY`) and Cloud Run env (`GOOGLE_CLIENT_ID`,
`GOOGLE_REDIRECT_URI`, `DATA_DIR`, `CLAUDE_MODEL` (the rates route's model),
`CHARLI_MODEL` (Charlie's model, default `claude-sonnet-5-5`), `ELEVENLABS_VOICE_ID_CHARLI`,
`ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`, `CHARLI_TTS_DAILY_CHARS`,
`CHARLI_TURN_DEADLINE_MS`); locally
in `server/.env` (git-ignored). Google (Charli Plan B): `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` = the OAuth "Web application" client; `GOOGLE_REDIRECT_URI` =
`<APP_URL>/api/google/callback`; `GOOGLE_TOKEN_KEY` = base64 of 32 random bytes, encrypts
the stored tokens (changing it makes every stored connection unreadable — users reconnect).
Others: `EMAIL_USER`, `EMAIL_PASS`, `APP_URL`,
`PORT`. `.env.example` holds names/placeholders only. **Never commit real secrets
or print them in logs/chat. Subagents and reviewers never read, cat or grep `.env`
files** (a repo-wide grep once echoed a key into a review transcript).

## Run / test
- **API:** `cd server && node index.js` (port 8080; reads `server/.env`; DB at `server/data/`).
- **UI (dev):** `cd client && npx vite` (5173, proxies `/api` → 8080).
- **Prod-like:** `cd client && npx vite build --outDir ../server/client/build --emptyOutDir`, then run the server (single URL on 8080).
- **Seed demo:** `node scripts/seed-demo.js http://localhost:8080` → `demo@refiradar.com` / `DemoPass123!`.
- **Tests:** `cd server && npm test` and `cd client && npm test` (node:test, **Node 20**); plus `node scripts/check-scoring.js`.
- **Charli locally:** needs the `ELEVENLABS_*` vars in `server/.env` for audio (text-only otherwise); Charlie is the **Home** page (the morning briefing), with a corner Charlie button on every other page. The calendar needs the four `GOOGLE_*` vars (names in `.env.example`); never read or print `server/.env`.
- **Logs:** `gcloud run services logs read refi-radar --region us-central1 --project refi-radar-496318 --limit N`.
- Always prepend portable Node 20 to PATH locally:
  `$env:Path = "C:\Users\bille\dev\node20;" + $env:Path`.

## Conventions & rules learned
- **Refi math stays deterministic** — rules + rate tables + LTV arithmetic. Never
  let an LLM compute a savings/payment/LTV number; LLM is for explanation/chat only.
- **Charli's laws:** retrieve-and-cite, never guess — every spoken figure must match a
  tool payload (the orchestrator checks); guideline questions hand off; no false "I
  logged it"; side effects only via `/confirm` after a code-authored read-back of every
  field that will be written; borrower PII (phone/email/notes) never reaches the model;
  the model never rounds — rates are rounded to 2 decimals at the tool boundary and
  movement is computed in code.
- **Orchestrator guards:** every rule is documented in prose directly above its regex
  and pinned in a regression table (`server/test/assistant-orchestrator.test.js`,
  `coaching.test.js`). Extend the tables; **never loosen a guard to make a row pass.**
  Code-authored text (the greeting, `CAREER_QUESTION`, "Just to confirm —", "Done —")
  anchors structural guards — change it only together with its guards.
- Refi scoring lives client-side in `App.jsx` `analyze()`; it anchors 30-yr pricing
  to the observed **top-tier** OBMMI rate + relative LLPA, and flags "good" when
  rateDelta ≥ 0.5, break-even ≤ 36 mo, savings > 0, LTV ≤ 95.
- **No auto-emails to clients.** Sweeps/alerts remind and can draft; the **broker
  sends**. Invite/alert email is broker-initiated.
- **Charli never sends (Plan B).** Client email = a code-authored template
  (`lib/assistant/outreach.js`; the model never writes email text and the recipient comes
  only from the client record) opened as a Gmail / Outlook / mailto compose link; the broker
  reads it and sends it from their own mail app. There is no send path and no Gmail scope.
  Templates quote no rate or dollar figure. Calendar bookings go on the broker's own primary
  calendar with **no attendees** and `sendUpdates=none` — no invites exist in v1. A booking is
  a confirmed side effect like any other: code-authored read-back, then `/api/assistant/confirm`,
  idempotent under the Google event id `"br" + confirmId`.
- **Every email carries the sender's NMLS ID** (and the company's when set) in the signature;
  **no NMLS ID on the user → no email** (set on the **Profile** page, `/api/profile/nmls`).
- **Google scopes, exactly:** `openid`, `email`, `calendar.events`. **Not** `gmail.compose`:
  Google classifies it as a restricted scope (restricted-scope verification + a paid
  third-party security assessment for outside customers), and Broker Radar is sold to other
  brokers. OAuth is per-user with PKCE and a browser-bound flow cookie; tokens are encrypted
  at rest, never logged, never in an API response or tool result. Nothing may depend on our
  own Google Workspace — every customer connects their own account.
- Clients are org-scoped: **brokers see the whole org's clients, LOs see their own.**
- Match the existing code style; keep changes small and in-idiom.
- For any large feature, write a short plan first (see PROGRESS.md) and share it.
