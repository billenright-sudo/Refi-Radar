"use strict";
// Charli orchestrator: a bounded tool-use loop in which the model can only produce facts by
// calling the deterministic tools in ./tools. The model never sees the CRM or the engine
// directly, and code (not the model) decides what is allowed to reach the user:
//
//   * a text-only answer is screened (screenUngroundedText) so it can't carry a made-up fact;
//   * a side-effect tool call is NOT acted on: it is returned as `sideEffect`, with a
//     code-authored read-back, for the confirmation step;
//   * an unknown tool name, or a loop that never settles, resolves to the can't-verify line.
//
// `client` is anything with messages.create(params) -> a Messages API response (the real
// @anthropic-ai/sdk client in production, a scripted fake in tests); this file never imports it.
const { tools, TOOL_SCHEMA } = require("./tools");
const { CHARLI_SYSTEM, CANT_VERIFY, GUIDELINE_HANDOFF } = require("./prompt");

const MAX_MODEL_CALLS = 4;   // model calls per turn, including the one that narrates
const MAX_TOKENS = 600;      // replies are 1-3 spoken sentences
const SWEEP_TOP_OPPORTUNITIES = 10;
const SWEEP_TOP_CHECKINS = 10;

// Same fallback as routes/rates.js and index.js. Read per call so the env can change.
const modelName = () => process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

// ── Text-only screening ──────────────────────────────────────────────────────

// Loan-guideline domain (deferred): the model has no verified source, so it must hand off.
const GUIDELINE_RE = new RegExp(
  "\\b(?:" + [
    "guidelines?", "overlays?", "underwrit\\w*", "AUS", "DU\\s+findings?", "LPA",
    "reserve\\s+requirements?", "eligib\\w*", "DTI\\s+limits?", "max(?:imum)?\\s+DTI",
    "HUD\\s+handbook", "selling\\s+guide",
  ].join("|") + ")\\b",
  "i"
);

// Questions about the book or the market: an answer needs a tool, so text alone can't stand.
const BOOK_FACT_RE = new RegExp(
  "\\b(?:" + [
    "rates?", "markets?", "sweeps?", "opportunit\\w*", "clients?", "balances?", "payments?",
    "savings?", "LTV", "equity", "refi\\w*", "cash[\\s-]?out",
  ].join("|") + ")\\b",
  "i"
);

// What may be said when the model answered in text and called no data tool this turn.
//   1. guideline-domain question  -> the fixed hand-off line;
//   2. the model's text has a digit, or the user asked about book/market facts, or the model
//      said nothing                -> the fixed can't-verify line;
//   3. anything else (greetings, small talk, "how can I help") -> the model's text, unchanged.
// Pure: no I/O, no state.
function screenUngroundedText(userText, modelText) {
  const user = String(userText == null ? "" : userText);
  const text = String(modelText == null ? "" : modelText);
  if (GUIDELINE_RE.test(user)) return GUIDELINE_HANDOFF;
  if (!text.trim() || /\d/.test(text) || BOOK_FACT_RE.test(user)) return CANT_VERIFY;
  return text;
}

// The newest user message that carries text (a tool_result-only user turn has none).
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ");
      if (t.trim()) return t;
    }
  }
  return "";
}

// ── Tool execution ───────────────────────────────────────────────────────────

// Error results carry a parenthesised label like "(not found)": those are never cited.
const isCitation = (source) => typeof source === "string" && source.trim() !== "" && !/^\(.*\)$/.test(source.trim());

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };

// The sweep result can run to hundreds of rows; the model gets the real totals plus the top
// opportunities (each with its best lens) and the first check-ins. Ordering mirrors lib/refi.js:
// priority first, then monthly savings (cash-out has none, and is not comparable with $/mo, so
// it just sorts after savers of the same priority); Array.sort is stable, so ties keep name order.
function trimSweep(data) {
  if (!data || data.error || !Array.isArray(data.opportunities)) return data;
  const savings = (r) => (r.best && Number.isFinite(r.best.monthlySavings) ? r.best.monthlySavings : 0);
  const rank = (r) => PRIORITY_RANK[r.best && r.best.priority] || 0;
  const top = data.opportunities
    .filter((r) => r && r.best)
    .sort((a, b) => rank(b) - rank(a) || savings(b) - savings(a))
    .slice(0, SWEEP_TOP_OPPORTUNITIES)
    .map((r) => ({ name: r.name, best: r.best }));
  const checkIns = (Array.isArray(data.checkIns) ? data.checkIns : [])
    .slice(0, SWEEP_TOP_CHECKINS)
    .map((r) => ({ name: r.name, monthsSince: r.checkIn && r.checkIn.monthsSince }));
  const out = { counts: data.counts, byLens: data.byLens, opportunities: top, checkIns };
  if (data.estimated) out.estimated = true;
  return out;
}

// Runs one tool and shapes what goes back to the model. A throwing tool never leaks its error
// text to the model: it becomes an is_error result the model can apologise for.
function runTool(block, ctx) {
  try {
    const result = tools[block.name](block.input && typeof block.input === "object" ? block.input : {}, ctx);
    if (!result || typeof result !== "object") throw new Error("tool returned no result");
    const data = block.name === "runSweepTool" ? trimSweep(result.data) : result.data;
    return {
      source: result.source,
      sideEffect: result.sideEffect,
      data: result.data,
      toolResult: { type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ source: result.source, data }) },
    };
  } catch (_err) {
    return {
      source: "(error)",
      toolResult: {
        type: "tool_result", tool_use_id: block.id, is_error: true,
        content: JSON.stringify({ source: "(error)", data: { error: "that lookup failed" } }),
      },
    };
  }
}

// Code-authored confirmation question, built from the tool's own preview data (never from
// anything the model wrote), so what is read back is what would be saved.
const cleanName = (n) => (typeof n === "string" ? n.replace(/\s+/g, " ").trim() : "");
function readBack(result) {
  const data = result.data || {};
  switch (result.sideEffect && result.sideEffect.type) {
    case "logContact":
      return `Just to confirm — log a contact for ${cleanName(data.client && data.client.name) || "that client"}?`;
    case "addClient": {
      const name = cleanName(data.preview && data.preview.name);
      return name ? `Just to confirm — add ${name} as a new client?` : "Just to confirm — add a new client?";
    }
    default:
      return "Just to confirm — go ahead with that?";
  }
}

// ── The turn ─────────────────────────────────────────────────────────────────

// runTurn({ messages, ctx, client }) -> { reply, sources, sideEffect?, usage }
//   messages: Messages API history ending with the user's latest message (not mutated)
//   ctx:      { user, rates, db }, handed to the tools
//   sources:  citing `source` strings of the tool results used (error labels are not cited)
async function runTurn({ messages, ctx, client } = {}) {
  if (!Array.isArray(messages)) throw new TypeError("runTurn: messages must be an array");
  if (!client || !client.messages || typeof client.messages.create !== "function") {
    throw new TypeError("runTurn: client must provide messages.create()");
  }
  const convo = messages.slice();
  const userText = latestUserText(convo);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const sources = [];
  const cite = (source) => { if (isCitation(source) && !sources.includes(source)) sources.push(source); };
  const finish = (reply, cited, sideEffect) => {
    const out = { reply, sources: cited || [], usage };
    if (sideEffect) out.sideEffect = sideEffect;
    return out;
  };

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    // No temperature / tool_choice / thinking: CLAUDE_MODEL is configurable and newer models
    // reject forced tool use and non-default sampling.
    const response = await client.messages.create({
      model: modelName(), max_tokens: MAX_TOKENS, system: CHARLI_SYSTEM, tools: TOOL_SCHEMA,
      messages: convo.slice(),
    });
    const u = (response && response.usage) || {};
    usage.inputTokens += Number.isFinite(u.input_tokens) ? u.input_tokens : 0;
    usage.outputTokens += Number.isFinite(u.output_tokens) ? u.output_tokens : 0;

    const content = response && Array.isArray(response.content) ? response.content : [];
    const toolUses = response && response.stop_reason === "tool_use"
      ? content.filter((b) => b && b.type === "tool_use")
      : [];

    // Final answer in text.
    if (toolUses.length === 0) {
      const text = content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ")
        .trim();
      // Grounded: at least one tool result this turn carried a citation. The tool's figures
      // are what the model narrates; there is nothing for the text screen to add.
      if (sources.length > 0) return text ? finish(text, sources) : finish(CANT_VERIFY);
      return finish(screenUngroundedText(userText, text));
    }

    // Unknown tool name: execute nothing, not even the valid calls alongside it.
    if (toolUses.some((b) => typeof b.name !== "string" || typeof tools[b.name] !== "function")) {
      return finish(CANT_VERIFY);
    }

    convo.push({ role: "assistant", content });
    const toolResults = [];
    for (const block of toolUses) {
      const out = runTool(block, ctx);
      cite(out.source);
      // The tools only package a side effect; here it is handed up for confirmation, not acted on.
      if (out.sideEffect) return finish(readBack(out), sources, out.sideEffect);
      toolResults.push(out.toolResult);
    }
    convo.push({ role: "user", content: toolResults });
  }

  // The model kept calling tools and never produced an answer within the cap.
  return finish(CANT_VERIFY);
}

module.exports = { runTurn, screenUngroundedText };
