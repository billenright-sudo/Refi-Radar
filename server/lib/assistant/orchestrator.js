"use strict";
// Charli orchestrator: a bounded tool-use loop in which the model can only produce facts by
// calling the deterministic tools in ./tools. The model never sees the CRM or the engine
// directly, and code (not the model) decides what is allowed to reach the user:
//
//   * text the model writes is screened before it is spoken: loan-guideline questions hand off,
//     first-person "done / I logged it" claims are replaced (nothing is ever performed here),
//     every figure must appear in this turn's tool results, and text with no cited tool result
//     behind it can't carry any fact (screenUngroundedText);
//   * a side-effect tool call is NOT acted on: it is returned as `sideEffect`, with a
//     code-authored read-back, for the confirmation step;
//   * an unknown tool name, or a loop that never settles, resolves to the can't-verify line.
//
// `client` is anything with messages.create(params) -> a Messages API response (the real
// @anthropic-ai/sdk client in production, a scripted fake in tests); this file never imports it.
const refi = require("../refi");
const { tools, TOOL_SCHEMA } = require("./tools");
const {
  CHARLI_SYSTEM, CANT_VERIFY, GUIDELINE_HANDOFF, NOTHING_CHANGED, ONE_AT_A_TIME, DIDNT_CATCH,
} = require("./prompt");

const MAX_MODEL_CALLS = 4;   // model calls per turn, including the one that narrates
const MAX_TOKENS = 600;      // replies are 1-3 spoken sentences
const SWEEP_TOP_OPPORTUNITIES = 10;
const SWEEP_TOP_CHECKINS = 10;
const FIND_CLIENT_MAX_MATCHES = 5;

// The tools that only PACKAGE a change (they never write; see tools.js). On the last allowed
// model call these are the only tools run, because nothing else's result could be used.
const SIDE_EFFECT_TOOLS = new Set(["addClientTool", "logContactTool"]);

// Same fallback as routes/rates.js and index.js. Read per call so the env can change.
const modelName = () => process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

// ── Text screening ───────────────────────────────────────────────────────────

const wordRe = (alts) => new RegExp("\\b(?:" + alts.join("|") + ")\\b", "i");

// Loan-guideline domain (deferred): the model has no verified source, so it must hand off.
const GUIDELINE_RE = wordRe([
  "guidelines?", "overlays?", "underwrit\\w*", "AUS", "DU\\s+findings?", "LPA",
  "reserve\\s+requirements?", "DTI\\s+limits?", "max(?:imum)?\\s+DTI", "HUD\\s+handbook", "selling\\s+guide",
]);
// Eligibility is a guideline question only next to a program or requirement word, in either
// order ("eligible for an FHA streamline", "FHA eligibility"); "is Chen eligible for a refi"
// is a sweep question and must still reach the tools.
const PROGRAM = "FHA|VA|USDA|conventional|jumbo|streamlines?|non[\\s-]?QM|programs?|requirements?";
const ELIGIBLE_NEAR_PROGRAM_RE = new RegExp(
  "\\beligib\\w*(?:\\W+\\w+){0,4}?\\W+(?:" + PROGRAM + ")\\b" +
  "|\\b(?:" + PROGRAM + ")(?:\\W+\\w+){0,4}?\\W+eligib\\w*\\b",
  "i"
);
const isGuidelineQuestion = (text) => GUIDELINE_RE.test(text) || ELIGIBLE_NEAR_PROGRAM_RE.test(text);

// Questions about the book or the market: an answer needs a tool, so text alone can't stand.
const BOOK_FACT_RE = wordRe([
  "rates?", "markets?", "sweeps?", "opportunit\\w*", "clients?", "balances?", "payments?",
  "savings?", "LTV", "equity", "refi\\w*", "cash[\\s-]?out",
  "call\\w*", "log\\w*", "contacts?", "loans?", "pipeline", "books?", "check[\\s-]?ins?", "follow[\\s-]?ups?",
]);

// A first-person completion claim. runTurn never performs an action, so by construction any
// "Done" or "I logged / added / saved ..." the model says is false.
const ACTION_CLAIM_RE =
  /^\s*done\b|\bI(?:['’]ve| have| just)?\s+(?:just\s+)?(?:logged|added|saved|booked|sent|scheduled|updated|created)\b/i;

// What may be said when the model answered in text and no tool result this turn carried a
// citation (it called no tool, or every tool it called failed).
//   1. guideline-domain question  -> the fixed hand-off line;
//   2. a clarifying question (no digit, ends with "?", no completion claim) -> unchanged: a
//      question asserts no figure, and "what's their name?" must reach the user;
//   3. the model's text has a digit, or the user asked about book/market facts, or the model
//      said nothing                -> the fixed can't-verify line;
//   4. anything else (greetings, small talk, "how can I help") -> the model's text, unchanged.
// Pure: no I/O, no state.
function screenUngroundedText(userText, modelText) {
  const user = String(userText == null ? "" : userText);
  const text = String(modelText == null ? "" : modelText);
  if (isGuidelineQuestion(user)) return GUIDELINE_HANDOFF;
  if (text.trim().endsWith("?") && !/\d/.test(text) && !ACTION_CLAIM_RE.test(text)) return text;
  if (!text.trim() || /\d/.test(text) || BOOK_FACT_RE.test(user)) return CANT_VERIFY;
  return text;
}

// ── Number grounding ─────────────────────────────────────────────────────────

// An integer (with optional thousands commas) and optional decimals.
const NUMBER_SRC = "(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?";
const MULTIPLIER = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6 };
// A figure in a reply: $ prefix, number, then an optional K / thousand / M / million multiplier
// and an optional % / percent / dollars suffix.
const FIGURE_RE = new RegExp(
  "(\\$)?" + NUMBER_SRC + "(?:\\s*(thousand|million|k|m)\\b)?(\\s*%|\\s+(?:percent|dollars?)\\b)?", "gi"
);

// Every number appearing anywhere in the payload text (values, dates inside strings, even the
// digits in a key like rate_30yr_fixed), unsigned so a reply of "down 0.10" matches a delta
// of -0.1.
function payloadNumbers(payloads) {
  const out = [];
  for (const p of payloads) {
    const s = typeof p === "string" ? p : JSON.stringify(p);
    for (const m of String(s).matchAll(new RegExp(NUMBER_SRC, "g"))) {
      out.push(Number(m[1].replace(/,/g, "") + (m[2] || "")));
    }
  }
  return out;
}

// The figures in `replyText` that are NOT backed by a number in `payloads` (the tool_result
// contents sent to the model this turn; strings or objects). [] means every figure is grounded.
//   * "$" "," "%" are ignored; K/thousand and M/million scale the figure;
//   * a figure is grounded when some payload number, divided by the same scale, rounds to it at
//     the reply's own decimal places (6.46 and 6.5 both match 6.461; 412 matches 412.37;
//     485,000 and $485K match 485000; ties round either way);
//   * a standalone integer 0-10 (counts, ordinals) is exempt, unless it sits next to a $, a %,
//     "percent", "dollars" or a multiplier.
// Pure: no I/O, no state.
function ungroundedNumbers(replyText, payloads) {
  const known = payloadNumbers(Array.isArray(payloads) ? payloads : []);
  const bad = [];
  for (const m of String(replyText == null ? "" : replyText).matchAll(FIGURE_RE)) {
    const [whole, dollar, int, frac, mult, suffix] = m;
    const value = Number(int.replace(/,/g, "") + (frac || ""));
    if (!dollar && !frac && !mult && !suffix && value <= 10) continue;
    const decimals = frac ? frac.length - 1 : 0;
    const scale = mult ? MULTIPLIER[mult.toLowerCase()] : 1;
    const tolerance = 0.5 * 10 ** -decimals + 1e-9;
    if (!known.some((p) => Math.abs(p / scale - value) <= tolerance)) bad.push(whole.trim());
  }
  return bad;
}

// ── Messages ─────────────────────────────────────────────────────────────────

function messageText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

// The newest user message that carries text (a tool_result-only user turn has none).
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      const t = messageText(messages[i]);
      if (t.trim()) return t;
    }
  }
  return "";
}

// ── Tool execution ───────────────────────────────────────────────────────────

// Error results carry a parenthesised label like "(not found)": those are never cited.
const isCitation = (source) => typeof source === "string" && source.trim() !== "" && !/^\(.*\)$/.test(source.trim());

// The sweep result can run to hundreds of rows; the model gets the real totals plus the top
// opportunities (each with its best lens) and the first check-ins. "Top" is the engine's own
// order for picking a client's best lens (lib/refi.js: priority, then impact()), applied across
// clients; Array.sort is stable, so ties keep the sweep's name order.
function trimSweep(data) {
  if (!data || data.error || !Array.isArray(data.opportunities)) return data;
  const rank = (r) => refi.PRIORITY_RANK[r.best.priority] || 0;
  const top = data.opportunities
    .filter((r) => r && r.best)
    .sort((a, b) => rank(b) - rank(a) || refi.impact(b.best) - refi.impact(a.best))
    .slice(0, SWEEP_TOP_OPPORTUNITIES)
    .map((r) => ({ name: r.name, best: r.best }));
  const checkIns = (Array.isArray(data.checkIns) ? data.checkIns : [])
    .slice(0, SWEEP_TOP_CHECKINS)
    .map((r) => ({ name: r.name, monthsSince: r.checkIn && r.checkIn.monthsSince }));
  const out = { counts: data.counts, byLens: data.byLens, opportunities: top, checkIns };
  if (data.estimated) out.estimated = true;
  return out;
}

// PII minimization: the model sees at most five matches, without contact details or notes
// (those stay in the UI record), plus how many matched in total.
function trimFindClient(data) {
  if (!data || !Array.isArray(data.matches)) return data;
  const matches = data.matches
    .slice(0, FIND_CLIENT_MAX_MATCHES)
    .map(({ email, phone, notes, ...rest }) => rest);
  const out = { matches, totalMatches: data.matches.length };
  if (data.error) out.error = data.error;
  return out;
}

const forModel = (name, data) =>
  name === "runSweepTool" ? trimSweep(data) : name === "findClient" ? trimFindClient(data) : data;

const toolResultBlock = (id, source, data, isError) => {
  const block = { type: "tool_result", tool_use_id: id, content: JSON.stringify({ source, data }) };
  if (isError) block.is_error = true;
  return block;
};

const cleanName = (n) => (typeof n === "string" ? n.replace(/\s+/g, " ").trim() : "");

// Runs one tool and shapes what goes back to the model. A throwing tool never leaks its error
// text to the model: it becomes an is_error result the model can apologise for. Returns
// { source, sideEffect?, data, toolResult }.
function runTool(block, ctx) {
  try {
    const result = tools[block.name](block.input && typeof block.input === "object" ? block.input : {}, ctx);
    if (!result || typeof result !== "object") throw new Error("tool returned no result");
    let { sideEffect } = result;
    if (sideEffect && sideEffect.type === "addClient") {
      // The saved name must be the one the read-back speaks; no usable name means nothing to confirm.
      const fields = sideEffect.fields || {};
      const name = cleanName(fields.name);
      if (!name) {
        const error = { error: "a client name is required" };
        return { source: "(invalid input)", data: error, toolResult: toolResultBlock(block.id, "(invalid input)", error) };
      }
      sideEffect = { ...sideEffect, fields: { ...fields, name } };
    }
    return {
      source: result.source, sideEffect, data: result.data,
      toolResult: toolResultBlock(block.id, result.source, forModel(block.name, result.data)),
    };
  } catch (_err) {
    const error = { error: "that lookup failed" };
    return { source: "(error)", data: error, toolResult: toolResultBlock(block.id, "(error)", error, true) };
  }
}

// Code-authored confirmation question, built from the tool's own data (never from anything the
// model wrote), so what is read back is what would be saved.
function readBack(out) {
  const se = out.sideEffect;
  switch (se.type) {
    case "logContact":
      return `Just to confirm — log a contact for ${cleanName(out.data && out.data.client && out.data.client.name) || "that client"}?`;
    case "addClient":
      return `Just to confirm — add ${se.fields.name} as a new client?`;
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
  const usage = { inputTokens: 0, outputTokens: 0 };
  const finish = (reply, cited, sideEffect) => {
    const out = { reply, sources: cited || [], usage };
    if (sideEffect) out.sideEffect = sideEffect;
    return out;
  };

  // Nothing to answer: no API call.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !messageText(last).trim()) return finish(DIDNT_CATCH);

  const convo = messages.slice();
  const userText = latestUserText(convo);
  const sources = [];   // citing sources of the read tools run this turn
  const payloads = [];  // the tool_result contents actually sent to the model this turn

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const lastCall = call === MAX_MODEL_CALLS - 1;
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
      if (isGuidelineQuestion(userText)) return finish(GUIDELINE_HANDOFF);
      if (ACTION_CLAIM_RE.test(text)) return finish(NOTHING_CHANGED);
      // No cited tool result behind the text: it may only be conversation (screenUngroundedText
      // is stricter than the figure check: it refuses any digit).
      if (sources.length === 0) return finish(screenUngroundedText(userText, text));
      // Grounded: every figure the model speaks must be one the tools returned this turn.
      if (!text || ungroundedNumbers(text, payloads).length > 0) return finish(CANT_VERIFY);
      return finish(text, sources);
    }

    // Unknown tool name: execute nothing, not even the valid calls alongside it.
    if (toolUses.some((b) => typeof b.name !== "string" || typeof tools[b.name] !== "function")) {
      return finish(CANT_VERIFY);
    }

    convo.push({ role: "assistant", content });
    // On the last allowed call no narration can follow, so only a change to confirm matters.
    const outs = (lastCall ? toolUses.filter((b) => SIDE_EFFECT_TOOLS.has(b.name)) : toolUses)
      .map((block) => runTool(block, ctx));

    // The tools only package a change; here it is handed up for confirmation, not acted on.
    const changes = outs.filter((o) => o.sideEffect);
    if (changes.length > 1) return finish(ONE_AT_A_TIME);
    if (changes.length === 1) {
      const change = changes[0];
      return finish(readBack(change), isCitation(change.source) ? [change.source] : [], change.sideEffect);
    }
    if (lastCall) break;

    for (const o of outs) {
      if (isCitation(o.source) && !sources.includes(o.source)) sources.push(o.source);
      payloads.push(o.toolResult.content);
    }
    convo.push({ role: "user", content: outs.map((o) => o.toolResult) });
  }

  // The model kept calling tools and never produced an answer within the cap.
  return finish(CANT_VERIFY);
}

module.exports = { runTurn, screenUngroundedText, ungroundedNumbers };
