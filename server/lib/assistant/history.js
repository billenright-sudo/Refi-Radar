"use strict";
// The conversation the browser sends to /api/assistant/turn, reshaped into what the Messages API accepts:
// it requires the FIRST message to be a user message and the roles to ALTERNATE (otherwise it answers 400,
// which the route would mask as the generic error turn). A real session breaks both rules: it opens with
// Charli's code-authored greeting (an assistant message), and two utterances can arrive before a reply
// (or a user message whose turn failed). Pure: no I/O, no state.

const MAX_HISTORY = 20;   // messages kept, newest last (one synthetic opener may be added on top)

// One message from the browser may not be longer than this (checked by the route before normalization): a
// spoken turn or one of Charli's replies is a few hundred characters, so this only stops runaway input.
const MAX_MESSAGE_CHARS = 4000;

// Stands in for the user turn before an assistant-first history, so the greeting (and anything the user
// was asked) stays in the model's context. The orchestrator treats it as inert: it is no action request
// and no question, and a real user message always follows it, so it is never the latest user message.
const SESSION_STARTED = "(Session started.)";

// normalizeHistory(raw) -> [{ role, content }] | null
//   1. keep only { role: "user" | "assistant", content: non-empty string } items, content trimmed (tool_use /
//      tool_result blocks, other roles, blanks and extra fields are dropped);
//   2. merge consecutive messages of the same role into one, joined with "\n";
//   3. null unless the newest message is the user's (and null for a non-array or nothing usable);
//   4. keep the last MAX_HISTORY;
//   5. if the first remaining message is the assistant's, put the SESSION_STARTED user message in front.
// The result strictly alternates, starts with a user message and ends with a user message.
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const merged = [];
  for (const m of raw) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.trim();
    if (!content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + content;
    else merged.push({ role: m.role, content });
  }
  if (!merged.length || merged[merged.length - 1].role !== "user") return null;
  const recent = merged.slice(-MAX_HISTORY);
  if (recent[0].role === "assistant") recent.unshift({ role: "user", content: SESSION_STARTED });
  return recent;
}

// True if any item of the browser's history has a string `content` longer than MAX_MESSAGE_CHARS (as sent,
// before trimming; other shapes are dropped by normalizeHistory anyway). Pure.
function hasOversizedMessage(raw) {
  return Array.isArray(raw) &&
    raw.some((m) => m && typeof m === "object" && typeof m.content === "string" && m.content.length > MAX_MESSAGE_CHARS);
}

module.exports = { normalizeHistory, hasOversizedMessage, SESSION_STARTED, MAX_HISTORY, MAX_MESSAGE_CHARS };
