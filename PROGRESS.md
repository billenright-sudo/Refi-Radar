# PROGRESS — Broker Radar

Living status file. **Update at the end of every major task** so work resumes
cleanly after compaction / a new session. Newest notes at the top of each list.

_Last updated: 2026-10-21_

## Done
- **Sweeps Phase 1 — server + tests** (built, **not yet deployed**): `server/lib/refi.js`
  deterministic engine (rate-term, cash-out, ARM→fixed, term-swap lenses + 6-month
  check-in), `POST /api/sweeps` (org-scoped), `last_contact` migration + `POST
  /api/clients/:id/contact`. **19 node:tests pass.** Client UI pending. _Temporary:_
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
- **"Sweeps"** = the AI opportunity engine; **Broker Radar** = the platform.
- Sweeps works the book two ways: **opportunities** (refi/cash-out/MI-drop) **+
  relationships** (6-month check-ins). Sweeps reminds/drafts; **the broker sends.**
- Local dev runs on **Node 20** (better-sqlite3 prebuilds); Node 24 won't compile it.
- `feature/accurate-refi-scoring` is the working + deployed line.

## Open issues
- `main` is behind `feature/accurate-refi-scoring` (not merged).
- Garbled org-1 name on Bill's real account (`wenright1@gmail.com`) — no org-rename
  API; needs a small DB fix.
- Data gaps blocking Sweeps Phase 2: **loan program, MI status, and today's home
  value (AVM)** are not captured; only origination `propertyValue` exists.
- `scripts/import` xlsx flow has no automated test yet (see Next steps).
- gcloud auth tokens expire often → deploys intermittently need `gcloud auth login`.

## Next steps
1. **Sweeps Phase 1 — CLIENT UI** (server done): a "Sweeps" nav item + "Run a Sweep"
   that POSTs the current rates to `/api/sweeps`, results grouped by lens with
   reason-code tags, and "Log contact" on check-ins. Then local verify → deploy on go.
2. **Sweeps Phase 2:** add program/MI fields + an AVM feed → the **drop-MI** lens
   and accurate cash-out.
3. **Sweeps Phase 3:** "Talk to Sweeps" chat + morning briefing + draft outreach
   (reuses `ANTHROPIC_API_KEY`; keep math deterministic).
4. Add the import + fuller auth integration tests (needs a temp test DB harness).
5. Housekeeping when convenient: merge to `main`, fix org-1 name, sync one-pager
   math, PDF/PPTX deck exports.
