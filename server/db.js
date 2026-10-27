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

// How Charli coaches a user: new / developing / established / veteran (lib/assistant/coaching.js). NULL until the
// user answers the greeting's question or their broker sets it; nothing assumes a stage.
const userCols = db.prepare("PRAGMA table_info(users)").all();
if (!userCols.some((c) => c.name === "career_stage")) {
  db.exec("ALTER TABLE users ADD COLUMN career_stage TEXT");
}

// One row per UTC day of the market rates we served — the basis for "market movement". `provider` (fred / claude) is where
// that day's set came from (lib/rateHistory.js): a move is only ever computed between two sets from the same provider.
db.exec(`
  CREATE TABLE IF NOT EXISTS rate_snapshots (
    day         TEXT PRIMARY KEY,
    rates       TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    provider    TEXT NOT NULL DEFAULT ''
  );
`);
// provider arrived after the table did (an older row keeps '' and is read by its stored source label).
const snapshotCols = db.prepare("PRAGMA table_info(rate_snapshots)").all();
if (!snapshotCols.some((c) => c.name === "provider")) {
  db.exec("ALTER TABLE rate_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
}

// What Charli cost: one 'turn' row per turn (including greetings and error turns), plus a row of its own for
// each spoken reply ('tts', tts_chars = the text sent to speech synthesis) and each recording ('stt',
// stt_seconds = the audio sent to transcription), written by the voice proxy (routes/voice.js). `kind` keeps
// the three apart, so a spoken exchange counts as one turn and not three.
db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL DEFAULT 'turn',
    turn_id       TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    tts_chars     INTEGER NOT NULL DEFAULT 0,
    stt_seconds   REAL    NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_usage_user_created ON assistant_usage (user_id, created_at);
`);
// stt_seconds and kind arrived after the table did (a table made before they existed gets them added; its old
// rows are all turns).
const usageCols = db.prepare("PRAGMA table_info(assistant_usage)").all();
if (!usageCols.some((c) => c.name === "stt_seconds")) {
  db.exec("ALTER TABLE assistant_usage ADD COLUMN stt_seconds REAL NOT NULL DEFAULT 0");
}
if (!usageCols.some((c) => c.name === "kind")) {
  db.exec("ALTER TABLE assistant_usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn'");
}

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

// A user's own Google account, connected for Charli's calendar (lib/google/oauth.js). Both tokens are stored encrypted
// (lib/google/crypto.js); access_expires_at is epoch ms; status flips to 'reconnect' when Google refuses the refresh
// token. Disconnecting deletes the row.
db.exec(`
  CREATE TABLE IF NOT EXISTS google_connections (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    google_email      TEXT    NOT NULL,
    time_zone         TEXT    NOT NULL,
    scopes            TEXT    NOT NULL,
    access_token_enc  TEXT    NOT NULL,
    access_expires_at INTEGER NOT NULL,
    refresh_token_enc TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','reconnect')),
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// One row per sign-in to Google that has been started and not finished: the single-use `state` that comes back on the
// callback, the user it belongs to (the callback carries no cookie) and the PKCE verifier. expires_at is epoch ms.
db.exec(`
  CREATE TABLE IF NOT EXISTS google_oauth_states (
    state         TEXT    PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    code_verifier TEXT    NOT NULL,
    expires_at    INTEGER NOT NULL
  );
`);

module.exports = db;
