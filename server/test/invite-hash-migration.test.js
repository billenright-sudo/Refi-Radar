"use strict";
// db.js start-up: a pending invite's plaintext token is replaced by its SHA-256, so a copy of the database holds nothing that opens
// an account. Two subprocesses load db.js against an old-schema file (no invite_token_hash column).
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const test = require("node:test");
const assert = require("node:assert");

test("start-up moves a pending invite's token to its SHA-256, and running again changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-invite-hash-"));
  const dbJs = JSON.stringify(path.join(__dirname, "..", "db.js"));
  const token = "ab".repeat(32);
  const oldSchema = `
    const D = require("better-sqlite3");
    const d = new D(require("path").join(process.env.DATA_DIR, "refi-radar.db"));
    d.exec("CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'trial', trial_ends TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('broker','lo')), first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, invite_token TEXT, invite_expires TEXT, invite_accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.prepare("INSERT INTO organizations (name) VALUES ('Old Org')").run();
    d.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (1, 'broker', 'Old', 'Timer', 'old@x.co')").run();
    d.prepare("INSERT INTO users (org_id, role, first_name, last_name, email, invite_token, invite_expires, invite_accepted) VALUES (1, 'lo', 'Pen', 'Ding', 'pending@x.co', ?, '2999-01-01T00:00:00.000Z', 0)").run(${JSON.stringify(token)});
    d.close();
  `;
  const report = `
    const db = require(${dbJs});
    console.log(JSON.stringify({
      cols: db.prepare("PRAGMA table_info(users)").all().map((c) => c.name),
      rows: db.prepare("SELECT email, invite_token, invite_token_hash, invite_expires FROM users ORDER BY id").all(),
    }));
  `;
  const run = (script) => execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
  }).trim().split("\n").pop();
  try {
    run(oldSchema);
    const first = JSON.parse(run(report));    // first load of db.js: the column is added and the token moved
    const second = JSON.parse(run(report));   // second load: nothing to move, and nothing fails
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    for (const result of [first, second]) {
      assert.strictEqual(result.cols.filter((c) => c === "invite_token_hash").length, 1);
      assert.deepStrictEqual(result.rows, [
        { email: "old@x.co", invite_token: null, invite_token_hash: null, invite_expires: null },
        { email: "pending@x.co", invite_token: null, invite_token_hash: hash, invite_expires: "2999-01-01T00:00:00.000Z" },
      ]);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
