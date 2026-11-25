"use strict";
// The rate check: what Cloud Scheduler asks for through POST /internal/rate-check (routes/internal.js). It fetches FRED only (never the
// Claude web search, never the hard-coded estimate), records the observation, applies the SAME drop rule and the SAME rounded numbers
// the briefing uses (lib/rateDrop.js), and for each user who turned pings on decides send / hold / skip in their own time zone.
//
// Safety, in the order a reviewer should read it:
//   * One ping per user per FRED observation date: a row in rate_alerts_sent is CLAIMED (INSERT OR IGNORE) before anything is sent, so a
//     retry, a double call or two overlapping runs cannot send twice. The claim is released only when NO channel delivered; once any
//     channel delivered the row is finished ('sent') and is never released, whatever happens after.
//   * A drop must be CONFIRMED before anyone is pinged: FRED's own previous 30-year observation (from this run's own fetch) must be the
//     one we stored, same date and within 0.005. Otherwise the drop is "unconfirmed" and nobody is pinged.
//   * Only the latest observation can ping, and only while it still clears the user's size, is at most STALE_DAYS old, and this run's own
//     FRED fetch succeeded.
//   * No client data, user email, user id or endpoint in any log line: a log line is a fixed label, an error NAME, counts and market figures.
const { fetchFredObservations, fredRateSet, sameObservation } = require("../fred");
const ratesCache = require("../ratesCache");
const rateHistory = require("../rateHistory");
const targets = require("../targets");
const { marketMove, isDrop, DEFAULT_THRESHOLD } = require("../rateDrop");
const { wallClock } = require("../google/time");
const { DEFAULT_TIME_ZONE } = require("../timeZone");
const { orgBilling, accessFor } = require("../billing/access");
const { termsCurrent } = require("../terms");
const { getSettings } = require("./settings");
const { pingDecision, ttlSeconds } = require("./schedule");
const { pingText } = require("./text");

const CONFIRM_TOLERANCE = 0.005;
const ARM_SPREAD_ESTIMATE = -0.10;   // as routes/rates.js: the 5/1 ARM is estimated here, never searched for
const DEFAULT_DEADLINE_MS = 45_000;

const errName = (err) => (err && typeof err.name === "string" && err.name) || "Error";
const round2 = (n) => Math.round(n * 100) / 100;
const utcText = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// ── the claim ─────────────────────────────────────────────────────────────────

// -> true when this call made the claim (and so may send), false when the user already has one for this observation date.
function claimPing(db, userId, obsDate, nowUtc) {
  return db.prepare(
    "INSERT OR IGNORE INTO rate_alerts_sent (user_id, observation_date, channel, status, sent_at) VALUES (?, ?, '', 'sending', ?)"
  ).run(userId, obsDate, nowUtc).changes === 1;
}
// A channel delivered: the claim becomes the record of the send.
function finishPing(db, userId, obsDate, channel) {
  db.prepare("UPDATE rate_alerts_sent SET status = 'sent', channel = ? WHERE user_id = ? AND observation_date = ?").run(channel, userId, obsDate);
}
// No channel delivered: free the claim so the next run tries again. A row that is already 'sent' is never touched.
function releasePing(db, userId, obsDate) {
  db.prepare("DELETE FROM rate_alerts_sent WHERE user_id = ? AND observation_date = ? AND status = 'sending'").run(userId, obsDate);
}

// ── one user ──────────────────────────────────────────────────────────────────

const accessOkFor = (db, user, billingConfig, nowMs) => {
  const config = billingConfig || { enabled: false };
  if (!config.enabled) return true;
  const org = orgBilling(db, user.org_id);
  return org ? accessFor({ config, org, termsOk: termsCurrent(db, user.id), nowMs }).ok : false;
};

// Sends one user's ping over their chosen channels. -> "sent" | "failed" | "skipped".
async function pingUser({ db, user, settings, zone, drop, nowMs, push, mail }) {
  const nowUtc = utcText(nowMs);
  if (!claimPing(db, user.id, drop.obsDate, nowUtc)) return "skipped";   // already sent (or being sent) for this observation
  let pushOk = false;                                                    // kept outside the try: an error AFTER a device took the ping
  let emailOk = false;                                                   // must never release the claim
  let attempted = false;
  try {
    const localDate = wallClock(zone, nowMs).date;
    const text = pingText(drop, localDate);
    if (settings.channels !== "email" && push && push.enabled) {
      const subs = db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY id").all(user.id);
      const ttl = ttlSeconds(settings, zone, nowMs);
      for (const sub of subs) {
        attempted = true;
        let result;
        try { result = await push.send(sub, text, { ttlSeconds: ttl }); } catch (_err) { result = { ok: false, gone: false, status: null }; }
        if (result && result.ok) pushOk = true;
        else if (result && result.gone) {
          // removing a gone device is housekeeping: it may never throw into the send
          try { db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id); } catch (err) { console.error(`[pings] removing a gone device failed: ${errName(err)}`); }
        }
      }
    }
    if (settings.channels !== "push" && mail && mail.enabled) {
      attempted = true;
      try { emailOk = Boolean(await mail.sendRateDrop({ to: user.email, drop, localDate })); } catch (_err) { emailOk = false; }
    }
  } catch (err) {
    console.error(`[pings] a user's ping step failed: ${errName(err)}`);
  }
  const delivered = pushOk || emailOk ? (pushOk && emailOk ? "both" : pushOk ? "push" : "email") : null;
  if (delivered) {
    // from here the ping is sent: nothing below may release the claim
    try { finishPing(db, user.id, drop.obsDate, delivered); } catch (err) { console.error(`[pings] recording a sent ping failed: ${errName(err)}`); }
    return "sent";
  }
  releasePing(db, user.id, drop.obsDate);
  return attempted ? "failed" : "skipped";
}

// ── the run ───────────────────────────────────────────────────────────────────

// -> Summary { fetched, observation, recorded, drop: "none" | "yes" | "unconfirmed", sent, held, skipped, failed }: counts and nothing else.
async function runRateCheck({ db, env = {}, nowMs, fetchImpl, push, mail, billingConfig, deadlineMs = DEFAULT_DEADLINE_MS }) {
  const summary = { fetched: false, observation: null, recorded: false, drop: "none", sent: 0, held: 0, skipped: 0, failed: 0 };
  const started = Date.now();

  // 1. FRED only. A failed fetch, or a partial publish, sends nothing.
  let obs;
  try {
    if (!env.FRED_API_KEY) throw Object.assign(new Error("no key"), { name: "ConfigError" });
    obs = await fetchFredObservations({ fredKey: env.FRED_API_KEY, fetchImpl });
  } catch (err) {
    console.error(`[pings] FRED fetch failed: ${errName(err)}`);
    return summary;
  }
  summary.fetched = true;
  if (!sameObservation(obs)) {
    console.log("[pings] FRED series are on different dates (a partial publish): nothing recorded or sent");
    return summary;
  }
  summary.observation = obs.obmmi.rate_30yr_fixed.date;

  // 2. Record it (a new or revised observation), and empty the rates cache so /api/rates, and so the briefing a ping opens, carries it.
  const rates = fredRateSet(obs, { arm: round2(obs.obmmi.rate_30yr_fixed.value + ARM_SPREAD_ESTIMATE), armSource: "ARM estimated" });
  const status = rateHistory.recordFredObservation(rates, nowMs);
  summary.recorded = status === "new" || status === "revised";
  if (summary.recorded) ratesCache.clear();

  // 3. The drop, from the latest stored FRED observation, with the briefing's own rule and rounding.
  const latest = targets.latestRealSnapshot(db);
  const movement = latest ? rateHistory.getMovement(latest.rates, "fred") : null;
  const drop = movement ? marketMove(movement) : null;
  if (!drop || !isDrop(drop.move30, DEFAULT_THRESHOLD)) {
    console.log(`[pings] obs ${summary.observation} 30yr ${obs.obmmi.rate_30yr_fixed.value}: no drop to ping`);
    return summary;
  }

  // 4. Confirm it against FRED's own previous observation, from this run's fetch. FRED older than what we stored is never a drop either.
  const prev = obs.previous30;
  if (status === "older" || !prev || prev.date !== drop.sinceDate || !(Math.abs(prev.value - movement.previous.rate_30yr_fixed) <= CONFIRM_TOLERANCE)) {
    summary.drop = "unconfirmed";
    console.log(`[pings] obs ${drop.obsDate} 30yr ${drop.rate30} move ${drop.move30}: unconfirmed against FRED's previous observation, nobody pinged`);
    return summary;
  }
  summary.drop = "yes";

  // 5. Each user who turned pings on, in id order, until the deadline (the rest wait for the next run; their claims make that safe).
  const users = db.prepare(
    `SELECT u.id, u.org_id, u.email FROM users u JOIN user_alert_settings s ON s.user_id = u.id
     WHERE s.enabled = 1 AND u.removed_at IS NULL AND u.invite_accepted = 1 ORDER BY u.id`
  ).all();
  const hasClaim = db.prepare("SELECT 1 FROM rate_alerts_sent WHERE user_id = ? AND observation_date = ?");
  for (const user of users) {
    if (Date.now() - started >= deadlineMs) { summary.held += 1; continue; }
    try {
      if (hasClaim.get(user.id, drop.obsDate)) { summary.skipped += 1; continue; }
      const settings = getSettings(db, user.id);
      const zone = settings.timeZone || DEFAULT_TIME_ZONE;
      const decision = pingDecision({ settings, zone, drop, accessOk: accessOkFor(db, user, billingConfig, nowMs), nowMs });
      if (decision === "hold") summary.held += 1;
      else if (decision !== "send") summary.skipped += 1;
      else {
        const result = await pingUser({ db, user, settings, zone, drop, nowMs, push, mail });
        summary[result] += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`[pings] a user's step failed: ${errName(err)}`);
    }
  }
  console.log(`[pings] obs ${drop.obsDate} 30yr ${drop.rate30} move ${drop.move30}: sent ${summary.sent}, held ${summary.held}, skipped ${summary.skipped}, failed ${summary.failed}`);
  return summary;
}

module.exports = { runRateCheck, claimPing, finishPing, releasePing };
