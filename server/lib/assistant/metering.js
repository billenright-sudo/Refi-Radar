"use strict";
// Cost metering for Charli: assistant_usage rows, and the org-wide totals the broker reads back. A row is
// one of three kinds: a 'turn' (one per conversational turn), a 'tts' (one spoken reply) or an 'stt' (one
// recording transcribed), so the turn count is not inflated by the voice requests around it. Token counts come from the orchestrator's `usage`; tts_chars is the text sent to speech
// synthesis (0 for a turn that only returned text) and stt_seconds the audio sent to transcription (0
// unless it is a recording). The voice proxy writes a row of its own for each of those.
const db = require("../../db");

// A whole, non-negative count: anything else (undefined, NaN, negative, a string) is 0.
const count = (n) => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

// Seconds of audio: a finite, non-negative number (fractions kept); anything else is 0.
const seconds = (n) => {
  const v = typeof n === "number" || typeof n === "string" ? Number(n) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 0;
};

const KINDS = new Set(["turn", "tts", "stt"]);

// recordUsage({ userId, kind?, turnId?, inputTokens?, outputTokens?, ttsChars?, sttSeconds? }) -> void. `kind` is
// 'turn' (the default), 'tts' or 'stt'; anything else is a 'turn'. Throws on a database error (an unknown userId
// violates the foreign key); callers that must not fail on metering catch it.
function recordUsage({ userId, kind = "turn", turnId = null, inputTokens = 0, outputTokens = 0, ttsChars = 0, sttSeconds = 0 } = {}) {
  db.prepare(
    "INSERT INTO assistant_usage (user_id, kind, turn_id, input_tokens, output_tokens, tts_chars, stt_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    userId, KINDS.has(kind) ? kind : "turn", turnId == null ? null : String(turnId),
    count(inputTokens), count(outputTokens), count(ttsChars), seconds(sttSeconds)
  );
}

// Totals over the last `days` days (a whole number, already clamped by the caller) for every user in
// the org. -> { turns, ttsRequests, sttRequests, inputTokens, outputTokens, ttsChars, sttSeconds }: turns counts
// the 'turn' rows only, ttsRequests the 'tts' rows and sttRequests the 'stt' rows (sttSeconds is rounded to the
// millisecond, so summing fractions never shows float dust)
function getOrgUsage(orgId, days) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(a.kind = 'turn'), 0) AS turns,
           COALESCE(SUM(a.kind = 'tts'), 0)  AS ttsRequests,
           COALESCE(SUM(a.kind = 'stt'), 0)  AS sttRequests,
           COALESCE(SUM(a.input_tokens), 0)  AS inputTokens,
           COALESCE(SUM(a.output_tokens), 0) AS outputTokens,
           COALESCE(SUM(a.tts_chars), 0)     AS ttsChars,
           COALESCE(SUM(a.stt_seconds), 0)   AS sttSeconds
    FROM assistant_usage a
    JOIN users u ON u.id = a.user_id
    WHERE u.org_id = ? AND a.created_at >= datetime('now', ?)
  `).get(orgId, `-${days} days`);
  return {
    turns: row.turns, ttsRequests: row.ttsRequests, sttRequests: row.sttRequests,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, ttsChars: row.ttsChars,
    sttSeconds: Math.round(row.sttSeconds * 1000) / 1000,
  };
}

module.exports = { recordUsage, getOrgUsage };
