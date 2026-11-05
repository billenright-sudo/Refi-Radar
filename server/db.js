"use strict";
const path = require("path");
const fs   = require("fs");
const Database = require("better-sqlite3");
const { hashToken } = require("./lib/passwordReset");

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

// What the client import and the ARIVE feed need (lib/intake/). loan_number is the lender's loan number, uppercased, '' when
// a client has none; it is the first thing an incoming loan is matched on. source says how the client got here ('manual' for
// one typed in, anything else for an import or the feed). Clients already stored get '' and 'manual'.
if (!clientCols.some((c) => c.name === "loan_number")) {
  db.exec("ALTER TABLE clients ADD COLUMN loan_number TEXT NOT NULL DEFAULT ''");
}
if (!clientCols.some((c) => c.name === "source")) {
  db.exec("ALTER TABLE clients ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
}
// edited_by_hand: which of the rate, property value and credit score a person changed on the client form
// (lib/intake/handEdits.js), so an import of the same loan keeps them. Clients already stored get '' (none).
if (!clientCols.some((c) => c.name === "edited_by_hand")) {
  db.exec("ALTER TABLE clients ADD COLUMN edited_by_hand TEXT NOT NULL DEFAULT ''");
}
// Matching looks across the whole company, not one loan officer's book, so the index leads with org_id.
db.exec("CREATE INDEX IF NOT EXISTS idx_clients_org_loan ON clients (org_id, loan_number)");

// integration_keys: one key per user for the ARIVE (Zapier) feed. Only a hash of the key is stored, so a key can be checked
// but never read back; last_used_at shows whether the feed is still running. The key goes when its user does.
db.exec(`
  CREATE TABLE IF NOT EXISTS integration_keys (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_hash     TEXT    NOT NULL UNIQUE,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
`);

// How Charli coaches a user: new / developing / established / veteran (lib/assistant/coaching.js). NULL until the
// user answers the greeting's question or their broker sets it; nothing assumes a stage.
const userCols = db.prepare("PRAGMA table_info(users)").all();
if (!userCols.some((c) => c.name === "career_stage")) {
  db.exec("ALTER TABLE users ADD COLUMN career_stage TEXT");
}

// NMLS IDs (digits only, set through routes/profile.js): a loan originator's own and their company's. Every client email
// Charli sets up is signed with them (lib/assistant/outreach.js). NULL until set; nothing assumes one.
if (!userCols.some((c) => c.name === "nmls_id")) {
  db.exec("ALTER TABLE users ADD COLUMN nmls_id TEXT");
}
// Which "generation" of login an account is on. Every session token carries the number it was signed with; raising it (a
// password reset does) makes every older token fail, so a stolen or forgotten session ends when the password changes.
if (!userCols.some((c) => c.name === "session_version")) {
  db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
}
// An invitation's secret is kept only as its SHA-256 (the link carries the secret, lookups hash it), so a copy of the database holds
// nothing that opens an account. invite_token is the old plaintext column: every start moves any value still in it to the hash, in one
// transaction. Links already mailed keep working, because their lookups use the hash. Nothing writes invite_token any more.
if (!userCols.some((c) => c.name === "invite_token_hash")) {
  db.exec("ALTER TABLE users ADD COLUMN invite_token_hash TEXT");
}
db.transaction(() => {
  const move = db.prepare("UPDATE users SET invite_token_hash = ?, invite_token = NULL WHERE id = ?");
  for (const r of db.prepare("SELECT id, invite_token FROM users WHERE invite_token IS NOT NULL").all()) move.run(hashToken(r.invite_token), r.id);
})();
const orgCols = db.prepare("PRAGMA table_info(organizations)").all();
if (!orgCols.some((c) => c.name === "nmls_id")) {
  db.exec("ALTER TABLE organizations ADD COLUMN nmls_id TEXT");
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
// state: 'done' for every row written once its action has run (all the synchronous actions, and so every row made before this
// column existed); 'pending' marks a Google booking that /confirm has claimed and is still carrying out (routes/assistant.js).
if (!confirmationCols.some((c) => c.name === "state")) {
  db.exec("ALTER TABLE assistant_confirmations ADD COLUMN state TEXT NOT NULL DEFAULT 'done'");
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

// Charlie's follow-ups (lib/assistant/followups.js). Every instant here is SQLite UTC text (YYYY-MM-DD HH:MM:SS) and every
// day is YYYY-MM-DD, so comparisons are plain string compares.
// contact_log: one row per call the broker logs for a client; `at` is when the call happened.
db.exec(`
  CREATE TABLE IF NOT EXISTS contact_log (
    id        INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id),
    at        TEXT    NOT NULL DEFAULT (datetime('now')),
    outcome   TEXT    NOT NULL CHECK(outcome IN ('reached','not_reached')),
    notes     TEXT    NOT NULL DEFAULT ''
  );
`);

// charlie_recommendations: a client Charlie put in front of the broker (a briefing or sweep call list, a calendar event that
// has ended, or a name carried to tomorrow's list), and what became of it. One row per (user, client, day, source);
// ask_count is how many times Charlie has asked "did you get to ...?" about it.
db.exec(`
  CREATE TABLE IF NOT EXISTS charlie_recommendations (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    day         TEXT    NOT NULL,
    source      TEXT    NOT NULL CHECK(source IN ('briefing','sweep','calendar','carry')),
    reason_code TEXT    NOT NULL DEFAULT '',
    due_at      TEXT,
    status      TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','reached','not_reached','expired')),
    ask_count   INTEGER NOT NULL DEFAULT 0,
    asked_at    TEXT,
    resolved_at TEXT,
    UNIQUE(user_id, client_id, day, source)
  );
`);

// user_briefing_state: per-user briefing memory. last_drop_obs is the FRED observation date of the latest rate drop the
// briefing has already led with.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_briefing_state (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id),
    last_drop_obs TEXT
  );
`);

// email_changes: a login-email change waiting for its confirmation link (routes/profile.js). One pending change per user; the
// token is mailed to new_email only, and expires_at is epoch milliseconds. users.email changes only when the link is used.
db.exec(`
  CREATE TABLE IF NOT EXISTS email_changes (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    new_email  TEXT    NOT NULL,
    token      TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  );
`);

// password_resets: a forgotten-password link waiting to be used (lib/passwordReset.js). One per user, so a new request replaces
// the old link. Unlike email_changes this keeps only the SHA-256 of the token, never the token itself: the link opens the account,
// so a copy of the database must not hold anything that can be used. expires_at is epoch milliseconds.
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  );
`);

// signup_requests: a sign-up waiting for its emailed link (lib/signup.js). One per address, so a new request replaces the old link.
// Like password_resets it keeps only the SHA-256 of the token. Nothing else exists for the person yet: the organization and the
// broker are created when the link is used. expires_at is epoch milliseconds.
db.exec(`
  CREATE TABLE IF NOT EXISTS signup_requests (
    email         TEXT    PRIMARY KEY,
    token_hash    TEXT    NOT NULL UNIQUE,
    first_name    TEXT    NOT NULL,
    last_name     TEXT    NOT NULL,
    org_name      TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    expires_at    INTEGER NOT NULL
  );
`);

// ── Billing (lib/billing/*). Times are epoch milliseconds. Every column is added only if missing, so a start is idempotent.
// organizations: the Stripe ids and a local copy of the subscription's state. billing_status is NULL for an organization
// that existed before billing (nothing has told us otherwise); the webhook and the sync keep the rest current.
const billingOrgCols = [
  ["stripe_customer_id", "TEXT"], ["stripe_subscription_id", "TEXT"], ["stripe_item_id", "TEXT"], ["billing_status", "TEXT"],
  ["billing_quantity", "INTEGER"], ["billing_trial_end", "INTEGER"], ["billing_period_end", "INTEGER"],
  ["billing_cancel_at_period_end", "INTEGER NOT NULL DEFAULT 0"], ["billing_exempt", "INTEGER NOT NULL DEFAULT 0"],
  ["billing_tester_until", "INTEGER"], ["billing_via_tester_code", "INTEGER NOT NULL DEFAULT 0"],
  ["billing_ever_subscribed", "INTEGER NOT NULL DEFAULT 0"], ["billing_has_card", "INTEGER NOT NULL DEFAULT 0"],
  ["billing_event_at", "INTEGER"], ["billing_synced_at", "INTEGER"], ["billing_pending_checkout", "TEXT"],
  ["billing_confirmation_sent", "INTEGER NOT NULL DEFAULT 0"],
];
const billingHave = new Set(db.prepare("PRAGMA table_info(organizations)").all().map((c) => c.name));
for (const [name, def] of billingOrgCols) {
  if (!billingHave.has(name)) db.exec(`ALTER TABLE organizations ADD COLUMN ${name} ${def}`);
}

// users: removing a seat keeps the row (its history stays) but frees the seat; removed_email remembers the address that was
// released so the person can be invited again.
const billingUserCols = db.prepare("PRAGMA table_info(users)").all();
if (!billingUserCols.some((c) => c.name === "removed_at")) db.exec("ALTER TABLE users ADD COLUMN removed_at INTEGER");
if (!billingUserCols.some((c) => c.name === "removed_email")) db.exec("ALTER TABLE users ADD COLUMN removed_email TEXT");

// signup_requests: what the person agreed to and whether they used the tester code, carried to the organization when the link is used.
const billingSignupCols = db.prepare("PRAGMA table_info(signup_requests)").all();
if (!billingSignupCols.some((c) => c.name === "tester")) db.exec("ALTER TABLE signup_requests ADD COLUMN tester INTEGER NOT NULL DEFAULT 0");
if (!billingSignupCols.some((c) => c.name === "terms_version")) db.exec("ALTER TABLE signup_requests ADD COLUMN terms_version TEXT");
if (!billingSignupCols.some((c) => c.name === "privacy_version")) db.exec("ALTER TABLE signup_requests ADD COLUMN privacy_version TEXT");

// stripe_events: the ids of webhook events already handled, so Stripe's retries and replays do nothing twice.
// terms_acceptances: which version of the Terms / Privacy Policy each user agreed to, when, and from which address.
// feedback: notes sent from inside the app.
db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_events (
    id          TEXT    PRIMARY KEY,
    type        TEXT    NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS terms_acceptances (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document    TEXT    NOT NULL CHECK(document IN ('terms','privacy')),
    version     TEXT    NOT NULL,
    accepted_at INTEGER NOT NULL,
    ip          TEXT
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    org_id     INTEGER NOT NULL,
    page       TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

module.exports = db;
