# CLAUDE.md — Broker Radar (RefiRadar)

Guidance for working in this repo. Keep it current.

## What this is
**Broker Radar** (legacy name **RefiRadar**; the UI now says "Broker Radar", the
GCP service/repo keep `refi-radar`) is a broker-intelligence SaaS from **Ignite
Business Solutions**. It lets a mortgage broker/LO track a book of past-client
loans, pulls **live mortgage rates**, and flags **refinance opportunities**
(payment savings, break-even, priority). Next-up feature set is **"Sweeps"** — an
AI opportunity engine (rate-term + cash-out + ARM→fixed + drop-MI lenses, a
6-month check-in cadence, and a conversational "ask your book").

## Stack
- **Backend:** Node + Express, **better-sqlite3** (SQLite), JWT auth
  (`bcryptjs`, `jsonwebtoken`, `cookie-parser`), `express-rate-limit`,
  `nodemailer` (invites/alerts), `xlsx` + `multer` (import), `@anthropic-ai/sdk`.
  CommonJS.
- **Frontend:** React 18 + **Vite** (one big `client/src/App.jsx`, inline styles
  via a `C` palette object). Build outputs to `build/`.
- **Container:** multi-stage `node:20-alpine` Dockerfile.
- **Node 20 required locally** (better-sqlite3 has prebuilt binaries for 20, not
  24). Portable Node 20 lives at `C:\Users\bille\dev\node20`.

## Folder structure
```
server/    index.js (entry, wires routes), db.js (SQLite schema), email.js,
           routes/{auth,clients,org,notifications,rates,import}.js,
           middleware/ (auth: requireAuth/requireBroker, signToken)
client/    src/App.jsx (whole UI), src/index.jsx, index.html, vite.config.js
scripts/   seed-demo.js (fake demo broker + 12 fake clients),
           check-scoring.js (refi-math sanity check)
server/test/  node:test suites (refi math, rates-down fallback, auth/permissions)
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
- **Repo:** `github.com/billenright-sudo/Refi-Radar`. Active branch
  **`feature/accurate-refi-scoring`** (main is behind).

## Data sources
- **FRED API** (`FRED_API_KEY`): `DGS10` 10-yr Treasury (the Treasury widget) +
  **Optimal Blue** daily mortgage indices (`OBMMIC30YF`, `OBMMIC15YF`, jumbo,
  FHA, **top-tier** `OBMMIC30YFLVLE80FGE740`) as the primary live-rate source.
- **Anthropic Claude** (`ANTHROPIC_API_KEY`, web search) for the 5/1 ARM rate and
  as the full fallback when FRED is down. Rates are cached in-memory for 6h.
  Last-resort is a hardcoded "Estimated" rate set so the UI never breaks.

## Branding
Dark **navy** background (`#15294f`, brightened from near-black 2026-10-15),
**amber** accents (`#f59e0b`), Georgia-serif **"Broker Radar™"** logo (inline
SVG, `RefiRadarLogo` component), subtitle "BROKER INTELLIGENCE PLATFORM",
footer "A Product of Ignite Business Solutions". **Layout is approved — do not
restyle without asking.**

## Secrets — names only, never values in the repo
Referenced by env var; stored in **Google Secret Manager** (`ANTHROPIC_API_KEY`,
`FRED_API_KEY`, `JWT_SECRET`) and Cloud Run env (`DATA_DIR`, `CLAUDE_MODEL`);
locally in `server/.env` (git-ignored). Others: `EMAIL_USER`, `EMAIL_PASS`,
`APP_URL`, `PORT`. `.env.example` holds placeholders only. **Never commit real
secrets or print them in logs/chat.**

## Run / test
- **API:** `cd server && node index.js` (port 8080; reads `server/.env`; DB at `server/data/`).
- **UI (dev):** `cd client && npx vite` (5173, proxies `/api` → 8080).
- **Prod-like:** `cd client && npx vite build --outDir ../server/client/build --emptyOutDir`, then run the server (single URL on 8080).
- **Seed demo:** `node scripts/seed-demo.js http://localhost:8080` → `demo@refiradar.com` / `DemoPass123!`.
- **Tests:** `cd server && npm test` (node:test, **Node 20**); plus `node scripts/check-scoring.js`.
- **Logs:** `gcloud run services logs read refi-radar --region us-central1 --project refi-radar-496318 --limit N`.
- Always prepend portable Node 20 to PATH locally:
  `$env:Path = "C:\Users\bille\dev\node20;" + $env:Path`.

## Conventions & rules learned
- **Refi math stays deterministic** — rules + rate tables + LTV arithmetic. Never
  let an LLM compute a savings/payment/LTV number; LLM is for explanation/chat only.
- Refi scoring lives client-side in `App.jsx` `analyze()`; it anchors 30-yr pricing
  to the observed **top-tier** OBMMI rate + relative LLPA, and flags "good" when
  rateDelta ≥ 0.5, break-even ≤ 36 mo, savings > 0, LTV ≤ 95.
- **No auto-emails to clients.** Sweeps/alerts remind and can draft; the **broker
  sends**. Invite/alert email is broker-initiated.
- Clients are org-scoped: **brokers see the whole org's clients, LOs see their own.**
- Match the existing code style; keep changes small and in-idiom.
- For any large feature, write a short plan first (see PROGRESS.md) and share it.
