require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const rateLimit = require("express-rate-limit");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "refi-radar.db");
const CLIENT_BUILD = path.join(__dirname, "client/build");

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    DEFAULT '',
    phone       TEXT    DEFAULT '',
    loan_type   TEXT    NOT NULL DEFAULT '30yr_fixed',
    current_rate  REAL  NOT NULL,
    loan_balance  REAL  NOT NULL,
    property_value REAL NOT NULL,
    close_date  TEXT    DEFAULT '',
    credit_score INTEGER DEFAULT 700,
    notes       TEXT    DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// Seed sample data if the table is empty
const { n } = db.prepare("SELECT COUNT(*) AS n FROM clients").get();
if (n === 0) {
  const ins = db.prepare(`
    INSERT INTO clients (name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes)
    VALUES (@name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes)
  `);
  const seedMany = db.transaction((rows) => { for (const r of rows) ins.run(r); });
  seedMany([
    { name: "Robert & Linda Chen",      email: "rchen@email.com",       phone: "(555) 010-1234", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, close_date: "2022-08-15", credit_score: 760, notes: "Referred by James at Title Co." },
    { name: "Marcus Williams",           email: "mwilliams@email.com",   phone: "(555) 010-2345", loan_type: "30yr_fixed", current_rate: 7.25, loan_balance: 320000, property_value: 420000, close_date: "2023-02-20", credit_score: 740, notes: "" },
    { name: "Sarah & Tom Patel",         email: "spatel@email.com",      phone: "(555) 010-3456", loan_type: "15yr_fixed", current_rate: 6.90, loan_balance: 215000, property_value: 380000, close_date: "2023-06-10", credit_score: 800, notes: "Self-employed — may need extra docs" },
    { name: "Jennifer & Carlos Lopez",   email: "jlopez@email.com",      phone: "(555) 010-4567", loan_type: "5_1_arm",   current_rate: 8.25, loan_balance: 560000, property_value: 720000, close_date: "2022-11-30", credit_score: 720, notes: "ARM adjusting soon — high priority" },
    { name: "David & Amy Kowalski",      email: "dkowalski@email.com",   phone: "(555) 010-5678", loan_type: "30yr_fixed", current_rate: 6.50, loan_balance: 185000, property_value: 290000, close_date: "2023-09-05", credit_score: 785, notes: "" },
    { name: "Michael Thompson",          email: "mthompson@email.com",   phone: "(555) 010-6789", loan_type: "30yr_fixed", current_rate: 8.10, loan_balance: 425000, property_value: 580000, close_date: "2022-06-18", credit_score: 755, notes: "Phone contact only" },
    { name: "Aisha Johnson",             email: "ajohnson@email.com",    phone: "(555) 010-7890", loan_type: "15yr_fixed", current_rate: 7.40, loan_balance: 178000, property_value: 310000, close_date: "2023-01-12", credit_score: 810, notes: "" },
    { name: "Carlos & Maria Reyes",      email: "creyes@email.com",      phone: "(555) 010-8901", loan_type: "30yr_fixed", current_rate: 7.65, loan_balance: 390000, property_value: 510000, close_date: "2022-09-22", credit_score: 748, notes: "Interested in cash-out refi" },
  ]);
  console.log("Database seeded with 8 sample clients.");
}

// Map DB snake_case row → camelCase client object
function toClient(row) {
  return {
    id:            row.id,
    name:          row.name,
    email:         row.email,
    phone:         row.phone,
    loanType:      row.loan_type,
    currentRate:   row.current_rate,
    loanBalance:   row.loan_balance,
    propertyValue: row.property_value,
    closeDate:     row.close_date,
    creditScore:   row.credit_score,
    notes:         row.notes,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

function validateClient(body) {
  const errors = {};
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) errors.name = "Name is required";
  const rate = parseFloat(body.currentRate);
  if (isNaN(rate) || rate < 0 || rate > 30) errors.currentRate = "Valid rate required (0–30%)";
  const bal = parseFloat(body.loanBalance);
  if (isNaN(bal) || bal <= 0) errors.loanBalance = "Valid balance required";
  const val = parseFloat(body.propertyValue);
  if (isNaN(val) || val <= 0) errors.propertyValue = "Valid property value required";
  const validTypes = ["30yr_fixed", "15yr_fixed", "5_1_arm"];
  if (!validTypes.includes(body.loanType)) errors.loanType = "Invalid loan type";
  return errors;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(CLIENT_BUILD));

// Rate limit: max 10 live-rate refreshes per minute per IP
const rateLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", db: DB_PATH, clients: db.prepare("SELECT COUNT(*) AS n FROM clients").get().n });
});

// ---------------------------------------------------------------------------
// Clients CRUD
// ---------------------------------------------------------------------------

// GET /api/clients — list all, sorted by name
app.get("/api/clients", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM clients ORDER BY name ASC").all();
    res.json({ success: true, clients: rows.map(toClient) });
  } catch (err) {
    console.error("GET /api/clients error:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// POST /api/clients — create
app.post("/api/clients", (req, res) => {
  const errors = validateClient(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });
  try {
    const info = db.prepare(`
      INSERT INTO clients (name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes)
      VALUES (@name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes)
    `).run({
      name:           req.body.name.trim(),
      email:          (req.body.email || "").trim(),
      phone:          (req.body.phone || "").trim(),
      loan_type:      req.body.loanType,
      current_rate:   parseFloat(req.body.currentRate),
      loan_balance:   parseFloat(req.body.loanBalance),
      property_value: parseFloat(req.body.propertyValue),
      close_date:     req.body.closeDate || "",
      credit_score:   parseInt(req.body.creditScore) || 700,
      notes:          (req.body.notes || "").trim(),
    });
    const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ success: true, client: toClient(row) });
  } catch (err) {
    console.error("POST /api/clients error:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// PUT /api/clients/:id — update
app.put("/api/clients/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: "Invalid ID" });
  const existing = db.prepare("SELECT id FROM clients WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ success: false, error: "Client not found" });
  const errors = validateClient(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });
  try {
    db.prepare(`
      UPDATE clients SET
        name           = @name,
        email          = @email,
        phone          = @phone,
        loan_type      = @loan_type,
        current_rate   = @current_rate,
        loan_balance   = @loan_balance,
        property_value = @property_value,
        close_date     = @close_date,
        credit_score   = @credit_score,
        notes          = @notes,
        updated_at     = datetime('now')
      WHERE id = @id
    `).run({
      id,
      name:           req.body.name.trim(),
      email:          (req.body.email || "").trim(),
      phone:          (req.body.phone || "").trim(),
      loan_type:      req.body.loanType,
      current_rate:   parseFloat(req.body.currentRate),
      loan_balance:   parseFloat(req.body.loanBalance),
      property_value: parseFloat(req.body.propertyValue),
      close_date:     req.body.closeDate || "",
      credit_score:   parseInt(req.body.creditScore) || 700,
      notes:          (req.body.notes || "").trim(),
    });
    const row = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    res.json({ success: true, client: toClient(row) });
  } catch (err) {
    console.error("PUT /api/clients/:id error:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// DELETE /api/clients/:id
app.delete("/api/clients/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: "Invalid ID" });
  const existing = db.prepare("SELECT id FROM clients WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ success: false, error: "Client not found" });
  try {
    db.prepare("DELETE FROM clients WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/clients/:id error:", err.message);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// ---------------------------------------------------------------------------
// Live mortgage rates via Claude web search
// ---------------------------------------------------------------------------
app.post("/api/rates", rateLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 15_000);

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: [
          "Search for today's current average US mortgage rates from Mortgage News Daily or Freddie Mac.",
          "Return ONLY a raw JSON object — no markdown, no explanation, no code fences.",
          'Format exactly: {"rate_30yr_fixed": 6.85, "rate_15yr_fixed": 6.12, "rate_5_1_arm": 6.45, "date": "2026-05-19", "source": "Mortgage News Daily"}'
        ].join(" ")
      }]
    }, { signal: ac.signal });

    clearTimeout(timeout);

    const textBlock = message.content?.find(b => b.type === "text");
    if (!textBlock?.text) throw new Error("No text response from Claude");

    // Extract the first JSON object (greedy to handle nested)
    const match = textBlock.text.match(/\{[^{}]*\}/);
    if (!match) throw new Error("Could not parse rate JSON from response");

    const rates = JSON.parse(match[0]);
    // Validate expected keys
    if (typeof rates.rate_30yr_fixed !== "number") throw new Error("Unexpected rate format");

    res.json({ success: true, rates });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      console.error("Rates timeout after 15s");
    } else {
      console.error("Rates error:", err.message);
    }
    // Fallback to estimated rates with clear label
    res.json({
      success: false,
      error: err.name === "AbortError" ? "Rate fetch timed out" : err.message,
      rates: {
        rate_30yr_fixed: 6.87,
        rate_15yr_fixed: 6.18,
        rate_5_1_arm:    6.52,
        date:   new Date().toISOString().split("T")[0],
        source: "Estimated — live fetch unavailable",
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 10-Year Treasury yield via FRED
// ---------------------------------------------------------------------------
app.get("/api/treasury", async (req, res) => {
  const fredKey = process.env.FRED_API_KEY;
  if (!fredKey) return res.status(500).json({ error: "FRED_API_KEY not configured" });

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 8_000);

  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${fredKey}&file_type=json&sort_order=desc&limit=30`;
    const response = await fetch(url, { signal: ac.signal });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`FRED returned HTTP ${response.status}`);
    const data = await response.json();

    const valid = (data.observations || [])
      .filter(o => o.value !== ".")
      .map(o => ({ date: o.date, value: parseFloat(o.value) }));

    if (!valid.length) throw new Error("No treasury data from FRED");
    res.json({ success: true, current: valid[0], previous: valid[1], history: valid.slice(0, 30).reverse() });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === "AbortError" ? "FRED API timed out" : err.message;
    console.error("Treasury error:", msg);
    res.status(502).json({ success: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// SPA catch-all
// ---------------------------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_BUILD, "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`RefiRadar running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Model: ${MODEL}`);
});
