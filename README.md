# RefiRadar — Broker Intelligence Platform

A SaaS platform for mortgage brokers to track past clients and identify refinancing opportunities using live market rates.

## Architecture

```
Browser → Cloud Run Container
              ├── Express server (serves React build + API)
              └── POST /api/rates → Anthropic API (web search for live rates)
```

Your **API key lives on the server only** — never exposed to the browser.

---

## Local Development

### Prerequisites
- Node.js 20+
- Docker (for container testing)
- Anthropic API key

### Run locally (without Docker)

```bash
# 1. Install server dependencies
cd server && npm install && cd ..

# 2. Install and build React frontend
cd client && npm install && npm run build && cd ..

# 3. Set your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# 4. Start the server
cd server && node index.js
# Visit http://localhost:8080
```

### Run locally with Docker

```bash
# Build and start
ANTHROPIC_API_KEY=sk-ant-your-key docker compose up --build

# Visit http://localhost:8080
```

---

## Deploy to Google Cloud Run

### One-time setup

```bash
# Install Google Cloud CLI: https://cloud.google.com/sdk/docs/install

# Login and set your project
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable secretmanager.googleapis.com
```

### Store your API key securely (Secret Manager)

```bash
# Create the secret
echo -n "sk-ant-your-key-here" | gcloud secrets create ANTHROPIC_API_KEY --data-file=-

# Grant Cloud Run access to the secret
gcloud secrets add-iam-policy-binding ANTHROPIC_API_KEY \
  --member="serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Deploy

```bash
# Build and deploy in one command
gcloud run deploy refi-radar \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-secrets="ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest" \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 10
```

That's it. Cloud Run will:
- Build the Docker image via Cloud Build
- Deploy it to a managed HTTPS URL
- Auto-scale (including to zero when idle)
- Handle SSL certificates automatically

### Get your URL

```bash
gcloud run services describe refi-radar \
  --region us-central1 \
  --format="value(status.url)"
```

---

## Updating the app

```bash
# Make your changes, then redeploy:
gcloud run deploy refi-radar --source . --region us-central1
```

Cloud Run does zero-downtime rolling deploys automatically.

---

## Cost estimate (Cloud Run)

| Usage | Estimated monthly cost |
|-------|----------------------|
| 0–100 requests/day | ~$0 (free tier) |
| 1,000 requests/day | ~$2–5 |
| 10,000 requests/day | ~$15–30 |

Cloud Run charges only for actual request processing time. Idle = $0.

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Yes |
| `PORT` | Server port (Cloud Run sets this automatically) | No (default: 8080) |
| `NODE_ENV` | Set to `production` in container | No |

---

## Project Structure

```
refi-radar/
├── Dockerfile              # Multi-stage build (React + Node)
├── docker-compose.yml      # Local container testing
├── .env.example            # Environment variable template
├── .gitignore
├── README.md
├── server/
│   ├── package.json
│   └── index.js            # Express server + /api/rates endpoint
└── client/
    ├── package.json
    ├── public/
    │   └── index.html
    └── src/
        ├── index.js
        └── App.js           # Full React application
```
