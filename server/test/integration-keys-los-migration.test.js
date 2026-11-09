"use strict";
// db.js start-up: an integration key made before the LendingPad feed gets los 'arive' (it was the only LOS), and keeps its hash.
// Two subprocesses load db.js against an old-schema file (integration_keys without a los column).
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const test = require("node:test");
const assert = require("node:assert");

test("start-up gives an old key los 'arive' and keeps its hash, and running again changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-keys-los-"));
  const dbJs = JSON.stringify(path.join(__dirname, "..", "db.js"));
  const hash = "cd".repeat(32);
  const oldSchema = `
    const D = require("better-sqlite3");
    const d = new D(require("path").join(process.env.DATA_DIR, "refi-radar.db"));
    d.exec("CREATE TABLE organizations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'trial', trial_ends TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('broker','lo')), first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT, invite_token TEXT, invite_expires TEXT, invite_accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    d.exec("CREATE TABLE integration_keys (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT)");
    d.prepare("INSERT INTO organizations (name) VALUES ('Old Org')").run();
    d.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (1, 'broker', 'Old', 'Timer', 'old@x.co')").run();
    d.prepare("INSERT INTO integration_keys (user_id, key_hash) VALUES (1, ?)").run(${JSON.stringify(hash)});
    d.close();
  `;
  const report = `
    const db = require(${dbJs});
    console.log(JSON.stringify({
      col: db.prepare("PRAGMA table_info(integration_keys)").all().find((c) => c.name === "los") || null,
      rows: db.prepare("SELECT user_id, key_hash, los FROM integration_keys ORDER BY user_id").all(),
    }));
  `;
  const run = (script) => execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
  }).trim().split("\n").pop();
  try {
    run(oldSchema);
    const first = JSON.parse(run(report));    // first load of db.js: the column is added
    const second = JSON.parse(run(report));   // second load: nothing to add, and nothing fails
    for (const result of [first, second]) {
      assert.ok(result.col, "the los column exists");
      assert.strictEqual(result.col.notnull, 1);
      assert.strictEqual(result.col.dflt_value, "'arive'");
      assert.deepStrictEqual(result.rows, [{ user_id: 1, key_hash: hash, los: "arive" }]);
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});
