"use strict";
const path = require("path");
const fs   = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH  = path.join(DATA_DIR, "refi-radar.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
// Use DELETE journal mode (not WAL) — GCS FUSE doesn't handle the separate -wal file reliably
db.pragma("journal_mode = DELETE");
db.pragma("foreign_keys = ON");

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    plan       TEXT    NOT NULL DEFAULT 'trial',
    trial_ends TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK(role IN ('broker','lo')),
    first_name  TEXT    NOT NULL,
    last_name   TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password_hash TEXT,
    invite_token  TEXT,
    invite_expires TEXT,
    invite_accepted INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT    NOT NULL,
    email          TEXT    DEFAULT '',
    phone          TEXT    DEFAULT '',
    loan_type      TEXT    NOT NULL DEFAULT '30yr_fixed',
    current_rate   REAL    NOT NULL,
    loan_balance   REAL    NOT NULL,
    property_value REAL    NOT NULL,
    close_date     TEXT    DEFAULT '',
    credit_score   INTEGER DEFAULT 700,
    notes          TEXT    DEFAULT '',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    message    TEXT    NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Migrations (idempotent) ──────────────────────────────────────────────────
const clientCols = db.prepare("PRAGMA table_info(clients)").all();
if (!clientCols.some((c) => c.name === "last_contact")) {
  db.exec("ALTER TABLE clients ADD COLUMN last_contact TEXT");
  // Seed last_contact from the close date so the 6-month cadence has a basis.
  db.exec("UPDATE clients SET last_contact = close_date WHERE (last_contact IS NULL OR last_contact = '') AND close_date <> ''");
}

// One row per UTC day of the market rates we served — the basis for "market movement".
db.exec(`
  CREATE TABLE IF NOT EXISTS rate_snapshots (
    day         TEXT PRIMARY KEY,
    rates       TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );
`);

// One row per Charli turn (including greetings and error turns): what the turn cost. tts_chars is the
// text sent to speech synthesis, filled by whichever code path synthesizes it.
db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turn_id       TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tts_chars     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_usage_user_created ON assistant_usage (user_id, created_at);
`);

// One row per confirmed voice action: POST /api/assistant/confirm records the confirmId it executed under, so
// a repeated confirm (a double tap, a retry) returns the stored result instead of writing again.
db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_confirmations (
    confirm_id  TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    result_json TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    action_type TEXT    NOT NULL DEFAULT '',
    target      TEXT    NOT NULL DEFAULT ''
  );
`);
// action_type and target bind a confirmId to the action it was issued for (a table made before they existed
// gets them added).
const confirmationCols = db.prepare("PRAGMA table_info(assistant_confirmations)").all();
for (const column of ["action_type", "target"]) {
  if (!confirmationCols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE assistant_confirmations ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
}

module.exports = db;
