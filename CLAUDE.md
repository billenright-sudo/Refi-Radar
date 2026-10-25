# CLAUDE.md — Broker Radar (RefiRadar)

Guidance for working in this repo. Keep it current.

## What this is
**Broker Radar** (legacy name **RefiRadar**; the UI now says "Broker Radar", the
GCP service/repo keep `refi-radar`) is a broker-intelligence SaaS from **Ignite
Business Solutions**. It lets a mortgage broker/LO track a book of past-client
loans, pulls **live mortgage rates**, and flags **refinance opportunities**
(payment savings, break-even, priority). **"Sweeps"** is the AI opportunity engine
(rate-term + cash-out + ARM→fixed + term-swap lenses, a 6-month check-in cadence) —
live. **"Charli"** is the voice-first AI CRM co-pilot on top (v1 built on
`feature/teresa-voice-crm`, not yet merged/deployed): she speaks the morning brief,
runs sweeps, looks up / adds clients and logs contacts by voice with
confirm-before-write, explains terms from a fixed glossary, and tailors coaching to
the user's career stage.

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
           routes/assistant.js  /api/assistant/{turn,confirm,usage}  (Charli; /confirm = the only write path)
           routes/voice.js      /api/voice/{tts,stt}  (ElevenLabs proxy; key never leaves the server)
           lib/refi.js (deterministic sweep engine), lib/rateHistory.js (daily rate snapshots, movement "since <day>"),
           lib/assistant/{orchestrator,tools,prompt,coaching,glossary,speech,metering}.js
           middleware/ (auth: requireAuth/requireBroker, signToken)
client/    src/App.jsx (whole UI), src/index.jsx, index.html, vite.config.js
           src/charli/{session.mjs,vad.mjs,audio.js,CharliView.jsx} (+ *.test.mjs)
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
- **Repo:** `github.com/billenright-sudo/Refi-Radar`. Deployed branch
  **`feature/accurate-refi-scoring`**; Charli v1 on **`feature/teresa-voice-crm`**
  (awaiting Bill's merge decision); `main` is behind both.
- **Charli deploy prerequisites:** `ELEVENLABS_API_KEY` in Secret Manager
  (`--set-secrets`), the other `ELEVENLABS_*` + `CHARLI_TTS_DAILY_CHARS` as env;
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
`FRED_API_KEY`, `JWT_SECRET`, and on Charli's deploy `ELEVENLABS_API_KEY`) and Cloud
Run env (`DATA_DIR`, `CLAUDE_MODEL`, `ELEVENLABS_VOICE_ID_CHARLI`,
`ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`, `CHARLI_TTS_DAILY_CHARS`); locally
in `server/.env` (git-ignored). Others: `EMAIL_USER`, `EMAIL_PASS`, `APP_URL`,
`PORT`. `.env.example` holds names/placeholders only. **Never commit real secrets
or print them in logs/chat. Subagents and reviewers never read, cat or grep `.env`
files** (a repo-wide grep once echoed a key into a review transcript).

## Run / test
- **API:** `cd server && node index.js` (port 8080; reads `server/.env`; DB at `server/data/`).
- **UI (dev):** `cd client && npx vite` (5173, proxies `/api` → 8080).
- **Prod-like:** `cd client && npx vite build --outDir ../server/client/build --emptyOutDir`, then run the server (single URL on 8080).
- **Seed demo:** `node scripts/seed-demo.js http://localhost:8080` → `demo@refiradar.com` / `DemoPass123!`.
- **Tests:** `cd server && npm test` and `cd client && npm test` (node:test, **Node 20**); plus `node scripts/check-scoring.js`.
- **Charli locally:** needs the `ELEVENLABS_*` vars in `server/.env` for audio (text-only otherwise); open the **Charli** nav item.
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
- Clients are org-scoped: **brokers see the whole org's clients, LOs see their own.**
- Match the existing code style; keep changes small and in-idiom.
- For any large feature, write a short plan first (see PROGRESS.md) and share it.
