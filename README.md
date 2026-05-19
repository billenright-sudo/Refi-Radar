# RefiRadar — Broker Intelligence Platform

A SaaS platform for mortgage brokers to track past clients and identify refinancing opportunities using live market rates.

## Features

- **Persistent client database** — SQLite backend; clients survive server restarts
- **Full CRUD** — add, edit, and delete clients
- **Smart refi analysis** — live mortgage rates via Claude web search scored against every client's current loan
- **Search & filter** — search by name, email, or phone; filter by refi readiness
- **Treasury widget** — 10-year yield sparkline from FRED, with 30-day trend
- **Live vs estimated** — clear indicator when Claude rate fetch succeeds vs falls back to estimates

## Architecture

```
Browser → Cloud Run Container
              ├── Express server (serves React build + API)
              ├── POST /api/rates    → Anthropic Claude (web search for live rates)
              ├── GET  /api/treasury → FRED API (10-yr Treasury)
              └── /api/clients       → SQLite (full CRUD)
```

API keys live **on the server only** — never exposed to the browser.

---

## Local Development (without Docker)

### Prerequisites
- Node.js 20+
- Anthropic API key
- FRED API key (free at https://fred.stlouisfed.org/docs/api/api_key.html)

### Setup

```bash
# 1. Copy and fill in env vars
cp .env.example .env

# 2. Install server dependencies (includes better-sqlite3)
cd server && npm install && cd ..

# 3. Install and build the React frontend
cd client && npm install && npm run build && cd ..

# 4. Start the server
cd server && node index.js
# Visit http://localhost:8080
```

### Hot-reload dev mode

```bash
# Terminal 1 — Express server with nodemon
cd server && npm run dev

# Terminal 2 — Vite dev server (proxies /api to :8080)
cd client && npm run dev
# Visit http://localhost:5173
```

---

## Local Development (with Docker)

```bash
ANTHROPIC_API_KEY=sk-ant-... FRED_API_KEY=your-key docker compose up --build
# Visit http://localhost:8080
```

The database is stored in a named Docker volume (`refi-radar-data`) and persists between rebuilds.

---

## Deploy to Google Cloud Run

### One-time setup

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable secretmanager.googleapis.com
```

### Store API keys in Secret Manager

```bash
echo -n "sk-ant-your-key" | gcloud secrets create ANTHROPIC_API_KEY --data-file=-
echo -n "your-fred-key"   | gcloud secrets create FRED_API_KEY       --data-file=-

# Grant Cloud Run access
SA="YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding ANTHROPIC_API_KEY --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding FRED_API_KEY      --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
```

### Deploy with a Cloud Storage volume for SQLite persistence

Cloud Run instances are stateless — mount a GCS bucket as a FUSE volume so the SQLite file survives restarts and redeploys.

```bash
# Create a GCS bucket for the database
gcloud storage buckets create gs://refi-radar-db-YOUR_PROJECT_ID --location=us-central1

# Grant the Cloud Run service account access
gcloud storage buckets add-iam-policy-binding gs://refi-radar-db-YOUR_PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"

# Deploy with volume mount and secrets
gcloud run deploy refi-radar \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets="ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,FRED_API_KEY=FRED_API_KEY:latest" \
  --set-env-vars="DATA_DIR=/data" \
  --add-volume=name=db-vol,type=cloud-storage,bucket=refi-radar-db-YOUR_PROJECT_ID \
  --add-volume-mount=volume=db-vol,mount-path=/data \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 10
```

Cloud Run handles SSL, zero-downtime rolling deploys, and auto-scale to zero.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clients` | List all clients (sorted by name) |
| POST | `/api/clients` | Create a new client |
| PUT | `/api/clients/:id` | Update an existing client |
| DELETE | `/api/clients/:id` | Delete a client |
| POST | `/api/rates` | Fetch live mortgage rates via Claude |
| GET | `/api/treasury` | Fetch 10-yr Treasury from FRED |
| GET | `/health` | Health check + DB status |

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key for live rate fetching | Yes |
| `FRED_API_KEY` | FRED API key for Treasury data | Yes |
| `PORT` | Server port (Cloud Run sets automatically) | No (default: 8080) |
| `DATA_DIR` | Directory for SQLite database file | No (default: `./data`) |
| `CLAUDE_MODEL` | Override the Claude model used | No (default: `claude-sonnet-4-5`) |

---

## Project Structure

```
refi-radar/
├── Dockerfile              # Multi-stage build (Node 20, includes native deps for SQLite)
├── docker-compose.yml      # Local container testing with named volume
├── .env.example            # Environment variable template
├── .gitignore
├── README.md
├── server/
│   ├── package.json        # Deps: express, better-sqlite3, express-rate-limit, @anthropic-ai/sdk
│   ├── index.js            # Express server + SQLite CRUD + /api/rates + /api/treasury
│   └── data/               # SQLite DB created here locally (gitignored)
└── client/
    ├── package.json
    ├── vite.config.js      # Vite build + /api proxy for local dev
    ├── public/
    │   └── index.html
    └── src/
        ├── index.jsx
        └── App.jsx         # Full React app: dashboard, clients, rate watch, add/edit
```
