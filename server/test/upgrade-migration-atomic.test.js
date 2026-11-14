"use strict";
// M10: the loan-upgrade migration (db.js: the new client columns and their backfills) is one transaction. A database whose backfill
// fails part-way keeps none of the new columns, so the next start runs the whole block again with its backfills. The failure is
// forced by a trigger that aborts any UPDATE of clients, made before db.js runs.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-upgrade-migration-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const Database = require("better-sqlite3");

const FILE = path.join(process.env.DATA_DIR, "refi-radar.db");
{
  const old = new Database(FILE);
  old.exec(`CREATE TABLE clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL,
    email TEXT DEFAULT '', phone TEXT DEFAULT '', loan_type TEXT NOT NULL DEFAULT '30yr_fixed',
    current_rate REAL NOT NULL, loan_balance REAL NOT NULL, property_value REAL NOT NULL, close_date TEXT DEFAULT '',
    credit_score INTEGER DEFAULT 700, notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_by_hand TEXT NOT NULL DEFAULT '')`);
  old.prepare("INSERT INTO clients (org_id, user_id, name, current_rate, loan_balance, property_value) VALUES (1, 1, 'Pat Sample', 6.5, 300000, 400000)").run();
  old.exec("CREATE TRIGGER block_updates BEFORE UPDATE ON clients BEGIN SELECT RAISE(ABORT, 'blocked'); END");
  old.close();
}

test.after(() => {
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* the failed start may hold the file open */ }
});

test("a backfill that fails rolls back every new column of the block", () => {
  assert.throws(() => require("../db"), /blocked/);
  const check = new Database(FILE, { readonly: true });
  try {
    const cols = check.prepare("PRAGMA table_info(clients)").all().map((c) => c.name);
    for (const col of ["loan_program", "monthly_mi", "original_amount", "original_value", "property_zip", "occupancy",
      "balance_as_of", "value_as_of", "credit_score_known"]) {
      assert.ok(!cols.includes(col), `${col} was rolled back`);
    }
    assert.ok(cols.includes("target_rate"), "the migrations before the block still ran");
  } finally { check.close(); }
});
