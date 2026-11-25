"use strict";
// Per-user rate-drop ping settings (lib/pings/settings.js) and the three tables behind them, against a throwaway DB.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-ping-settings-"));
process.env.NODE_ENV = "test";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert");

const db = require("../db");
const S = require("../lib/pings/settings");

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, email, first) => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', ?, 'User', ?)"
).run(orgId, first, email).lastInsertRowid);
const insertGoogle = (userId, zone) => db.prepare(
  `INSERT INTO google_connections (user_id, google_email, time_zone, scopes, access_token_enc, access_expires_at, refresh_token_enc)
   VALUES (?, 'sample@example.test', ?, 'calendar', 'x', 0, 'y')`
).run(userId, zone);

const org = addOrg("Alpha");
const annId = addUser(org, "ann@pset.test", "Ann");
const bobId = addUser(org, "bob@pset.test", "Bob");

after(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

test("a user with no row gets the defaults: off", () => {
  assert.deepEqual(S.getSettings(db, annId), { ...S.DEFAULTS, timeZone: null });
  assert.equal(S.DEFAULTS.enabled, false);
  assert.equal(S.thresholdFor(db, annId), 0.125);
  assert.equal(S.zoneFor(db, annId), "America/New_York");
});

test("the zone falls back to the Google calendar's, then the sign-up one", () => {
  db.prepare("UPDATE users SET time_zone = 'America/Denver' WHERE id = ?").run(annId);
  assert.equal(S.zoneFor(db, annId), "America/Denver");
  assert.equal(S.getSettings(db, annId).timeZone, "America/Denver");
  insertGoogle(annId, "America/Chicago");
  assert.equal(S.zoneFor(db, annId), "America/Chicago");
  // a stored zone of the user's own wins over both
  S.saveSettings(db, annId, { ...S.DEFAULTS, timeZone: "America/Phoenix" });
  assert.equal(S.zoneFor(db, annId), "America/Phoenix");
  db.prepare("DELETE FROM user_alert_settings WHERE user_id = ?").run(annId);
  db.prepare("DELETE FROM google_connections WHERE user_id = ?").run(annId);
  db.prepare("UPDATE users SET time_zone = NULL WHERE id = ?").run(annId);
});

test("parseSettings accepts the four drop sizes only and checks every field", () => {
  const ok = { enabled: true, threshold: 0.25, quietStart: "21:30", quietEnd: "06:45", weekdaysOnly: false, channels: "both", timeZone: "america/los_angeles" };
  assert.deepEqual(S.parseSettings(ok).value, { ...ok, timeZone: "America/Los_Angeles" });
  for (const t of [0.125, 0.25, 0.375, 0.5]) assert.equal(S.parseSettings({ ...ok, threshold: t }).value.threshold, t);
  assert.equal(S.parseSettings({ ...ok, timeZone: null }).value.timeZone, null);
  assert.equal(S.parseSettings({ ...ok, threshold: 0.1 }).error, "Choose a drop size of 0.125, 0.25, 0.375 or 0.5.");
  assert.equal(S.parseSettings({ ...ok, threshold: "0.25" }).error, "Choose a drop size of 0.125, 0.25, 0.375 or 0.5.");
  assert.equal(S.parseSettings({ ...ok, quietStart: "9pm" }).error, "Quiet hours are times like 20:00.");
  assert.equal(S.parseSettings({ ...ok, quietEnd: "24:00" }).error, "Quiet hours are times like 20:00.");
  assert.equal(S.parseSettings({ ...ok, channels: "sms" }).error, "Choose phone, email or both.");
  assert.equal(S.parseSettings({ ...ok, timeZone: "+05:00" }).error, "Choose a time zone from the list.");
  assert.equal(S.parseSettings({ ...ok, enabled: "yes" }).error, "Something in these settings isn't valid.");
  assert.equal(S.parseSettings({ ...ok, weekdaysOnly: 1 }).error, "Something in these settings isn't valid.");
  assert.equal(S.parseSettings(null).error, "Something in these settings isn't valid.");
  assert.equal(S.parseSettings("x").error, "Something in these settings isn't valid.");
});

test("saveSettings round-trips and a second save replaces the first", () => {
  const ok = { enabled: true, threshold: 0.25, quietStart: "21:30", quietEnd: "06:45", weekdaysOnly: false, channels: "both", timeZone: "America/Los_Angeles" };
  assert.deepEqual(S.saveSettings(db, bobId, ok), ok);
  assert.deepEqual(S.getSettings(db, bobId), ok);
  S.saveSettings(db, bobId, { ...ok, threshold: 0.5 });
  assert.equal(S.getSettings(db, bobId).threshold, 0.5);
  assert.equal(S.thresholdFor(db, bobId), 0.5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_alert_settings WHERE user_id = ?").get(bobId).n, 1);
});

test("rate_alerts_sent allows one row per user and observation date", () => {
  const ins = db.prepare("INSERT INTO rate_alerts_sent (user_id, observation_date, status, sent_at) VALUES (?, ?, 'sent', '2026-11-24 15:00:00')");
  ins.run(annId, "2026-11-24");
  assert.throws(() => ins.run(annId, "2026-11-24"), /UNIQUE/);
  ins.run(annId, "2026-11-25"); ins.run(bobId, "2026-11-24");
  assert.throws(() => db.prepare("INSERT INTO rate_alerts_sent (user_id, observation_date, status, sent_at) VALUES (?, '2026-11-26', 'bogus', 'x')").run(annId), /CHECK/);
});

test("push_subscriptions: an endpoint is unique, and removing a user removes their rows", () => {
  const ins = db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'a')");
  ins.run(annId, "https://push.example.test/one");
  assert.throws(() => ins.run(bobId, "https://push.example.test/one"), /UNIQUE/);
  const org2 = addOrg("Gone");
  const goneId = addUser(org2, "gone@pset.test", "Gone");
  ins.run(goneId, "https://push.example.test/two");
  db.prepare("DELETE FROM users WHERE id = ?").run(goneId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(goneId).n, 0);
});
