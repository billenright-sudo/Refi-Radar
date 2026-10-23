"use strict";
// Cost metering for Charli: one assistant_usage row per turn, and the org-wide totals the broker
// reads back. Token counts come from the orchestrator's `usage`; tts_chars is the text sent to speech
// synthesis (0 for a turn that only returned text).
const db = require("../../db");

// A whole, non-negative count: anything else (undefined, NaN, negative, a string) is 0.
const count = (n) => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

// recordUsage({ userId, turnId?, inputTokens?, outputTokens?, ttsChars? }) -> void. Throws on a database
// error (an unknown userId violates the foreign key); callers that must not fail on metering catch it.
function recordUsage({ userId, turnId = null, inputTokens = 0, outputTokens = 0, ttsChars = 0 } = {}) {
  db.prepare(
    "INSERT INTO assistant_usage (user_id, turn_id, input_tokens, output_tokens, tts_chars) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, turnId == null ? null : String(turnId), count(inputTokens), count(outputTokens), count(ttsChars));
}

// Totals over the last `days` days (a whole number, already clamped by the caller) for every user in
// the org. -> { turns, inputTokens, outputTokens, ttsChars }
function getOrgUsage(orgId, days) {
  const row = db.prepare(`
    SELECT COUNT(*) AS turns,
           COALESCE(SUM(a.input_tokens), 0)  AS inputTokens,
           COALESCE(SUM(a.output_tokens), 0) AS outputTokens,
           COALESCE(SUM(a.tts_chars), 0)     AS ttsChars
    FROM assistant_usage a
    JOIN users u ON u.id = a.user_id
    WHERE u.org_id = ? AND a.created_at >= datetime('now', ?)
  `).get(orgId, `-${days} days`);
  return { turns: row.turns, inputTokens: row.inputTokens, outputTokens: row.outputTokens, ttsChars: row.ttsChars };
}

module.exports = { recordUsage, getOrgUsage };
