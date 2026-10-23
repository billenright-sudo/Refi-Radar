"use strict";
// Charli over HTTP.
//   POST /api/assistant/turn     one conversational turn (or the code-authored morning greeting)
//   POST /api/assistant/confirm  the ONLY path that writes from a voice action
//   GET  /api/assistant/usage    org-wide cost totals (broker only)
//
// /turn never writes and never 500s: a model or tool failure is a 200 error turn. A change Charli
// proposes comes back as `sideEffect` with a code-authored read-back; the browser echoes it to
// /confirm only after the user says yes. That body is UNTRUSTED browser input, so /confirm accepts
// two action types, takes org/user from the session alone, and runs the same validation and checks
// as the REST routes (createClientForUser / logContactForUser in routes/clients.js).
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("../db");
const { requireAuth, requireBroker } = require("../middleware/auth");
const { runTurn } = require("../lib/assistant/orchestrator");
const assistantTools = require("../lib/assistant/tools");   // called as assistantTools.x(): tests can swap a tool
const { ERROR_TURN } = require("../lib/assistant/prompt");
const { recordUsage, getOrgUsage } = require("../lib/assistant/metering");
const { createClientForUser, logContactForUser } = require("./clients");

const MAX_HISTORY = 20;          // messages sent to the model, newest last
const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 365;

// ── The Anthropic client ─────────────────────────────────────────────────────

// `app.set("anthropicClient", fake)` is the test seam. Otherwise one real client is built on first use
// (like routes/rates.js) and cached. A missing key throws here, inside the turn's try block, so it
// becomes the error turn rather than a crash.
let realClient = null;
function getClient(req) {
  const injected = req.app.get("anthropicClient");
  if (injected) return injected;
  if (!realClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
    // A voice turn can't wait out the SDK's 10-minute default.
    realClient = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  }
  return realClient;
}

// What gets logged for a failure: the message only (never the stack or the request, which hold client data).
const errText = (err) => (err && err.message) || String(err);

// ── Request shaping ──────────────────────────────────────────────────────────

// The browser's rates are the ones it already fetched for the dashboard (as for /api/sweeps). Only the
// numeric rate_* fields, a YYYY-MM-DD date and a short source label go on to the tools and the model.
// null when there is no usable 30-year rate.
function cleanRates(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Number.isFinite(raw.rate_30yr_fixed)) return null;
  const rates = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/^rate_[a-z0-9_]{1,40}$/.test(key) && Number.isFinite(value)) rates[key] = value;
  }
  if (typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) rates.date = raw.date;
  if (typeof raw.source === "string") rates.source = raw.source.slice(0, 200);
  return rates;
}

// The history from the browser, rebuilt as plain { role, content } text messages: anything that is not a
// non-empty user/assistant string (tool_use / tool_result blocks, other roles, blanks) is dropped. Keeps
// the last MAX_HISTORY, and starts at a user message (the Messages API rejects a history that opens
// with an assistant turn). null unless the newest kept message is the user's.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const kept = [];
  for (const m of raw) {
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    const content = m.content.trim();
    if (content) kept.push({ role: m.role, content });
  }
  if (!kept.length || kept[kept.length - 1].role !== "user") return null;
  const recent = kept.slice(-MAX_HISTORY);
  while (recent[0].role !== "user") recent.shift();
  return recent;
}

// ── The greeting (no model call) ─────────────────────────────────────────────

// A tool result counts only if it carries a citation: error labels like "(unavailable)" are not one.
const isCitation = (source) => typeof source === "string" && source.trim() !== "" && !/^\(.*\)$/.test(source.trim());
const runSafely = (tool, ctx) => {
  try { return tool({}, ctx); } catch (_err) { return null; }
};

const hourOf = (localHour) =>
  Number.isInteger(localHour) && localHour >= 0 && localHour <= 23 ? localHour : new Date().getHours();
const partOfDay = (hour) => (hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening");

// "Good morning, Ann. You have 2 opportunities and 1 check-in due; the 30-year is at 6.52%. Want a
// market update, a sweep of your book, or something else?" Every figure comes straight from the sweep
// and market tools; a tool that failed leaves its clause out.
function buildGreeting(user, ctx, localHour) {
  const sweep = runSafely(assistantTools.runSweepTool, ctx);
  const market = runSafely(assistantTools.getMarketUpdate, ctx);

  const counts = sweep && isCitation(sweep.source) && sweep.data && sweep.data.counts;
  const opportunities = counts && counts.withOpportunity;
  const checkIns = counts && counts.checkInsDue;
  const rate = market && isCitation(market.source) && market.data && market.data.rates && market.data.rates.rate_30yr_fixed;

  const countsClause = Number.isFinite(opportunities) && Number.isFinite(checkIns)
    ? `You have ${opportunities} ${opportunities === 1 ? "opportunity" : "opportunities"} and ${checkIns} ` +
      `${checkIns === 1 ? "check-in" : "check-ins"} due`
    : "";
  const rateClause = Number.isFinite(rate)
    ? `the 30-year is at ${rate}%${market.data.estimated ? " (estimated)" : ""}`
    : "";
  let facts = "";
  if (countsClause && rateClause) facts = ` ${countsClause}; ${rateClause}.`;
  else if (countsClause) facts = ` ${countsClause}.`;
  else if (rateClause) facts = ` ${rateClause[0].toUpperCase()}${rateClause.slice(1)}.`;

  const name = typeof user.first_name === "string" ? user.first_name.trim() : "";
  const reply =
    `Good ${partOfDay(hourOf(localHour))}${name ? `, ${name}` : ""}.${facts}` +
    " Want a market update, a sweep of your book, or something else?";
  const sources = [sweep, market].filter((r) => r && isCitation(r.source)).map((r) => r.source);
  return { reply, sources };
}

// ── The /confirm action bodies ───────────────────────────────────────────────

const CLIENT_TEXT_FIELDS = ["name", "email", "phone", "loanType", "closeDate", "notes"];
const CLIENT_NUMBER_FIELDS = ["currentRate", "loanBalance", "propertyValue", "creditScore"];

// A client the browser asks to add, reduced to the fields POST /api/clients reads. Text fields must be
// strings (a number there would throw inside the shared helper, not validate). -> { body } | { errors }
function clientFromFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return { errors: { name: "Name is required" } };
  const body = {};
  const errors = {};
  for (const key of CLIENT_TEXT_FIELDS) {
    if (fields[key] == null) continue;
    if (typeof fields[key] === "string") body[key] = fields[key];
    else errors[key] = "Must be text";
  }
  for (const key of CLIENT_NUMBER_FIELDS) {
    if (fields[key] != null) body[key] = fields[key];
  }
  return Object.keys(errors).length ? { errors } : { body };
}

// ── The router ───────────────────────────────────────────────────────────────

// createAssistantRouter({ limiter }) builds a router with its own rate-limit counter; `limiter` overrides
// the express-rate-limit options (tests use a bigger or smaller `max`). The default export is the one
// index.js mounts.
function createAssistantRouter({ limiter = {} } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  // 60 requests per 15 minutes, counted per signed-in user (an office shares one IP address).
  router.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { success: false, error: "Too many requests to the assistant — please try again in a few minutes" },
    ...limiter,
  }));

  // Metering must never break a turn.
  const meter = (userId, turnId, usage) => {
    try {
      recordUsage({ userId, turnId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ttsChars: 0 });
    } catch (err) {
      console.error("assistant usage:", errText(err));
    }
  };

  // POST /api/assistant/turn
  // Body: { rates, messages } or { rates, greeting: true, localHour? }.
  // -> { reply, sources, sideEffect?, turnId }; a failed turn -> 200 { reply, error: true, sources: [], turnId }
  router.post("/turn", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rates = cleanRates(body.rates);
    if (!rates) return res.status(400).json({ success: false, error: "current rates required" });
    const turnId = crypto.randomUUID();
    const ctx = { user: req.user, rates, db };

    if (body.greeting === true) {
      try {
        const { reply, sources } = buildGreeting(req.user, ctx, body.localHour);
        meter(req.user.id, turnId, {});
        return res.json({ reply, sources, turnId });
      } catch (err) {
        console.error("POST /api/assistant/turn (greeting):", errText(err));
        meter(req.user.id, turnId, {});
        return res.json({ reply: ERROR_TURN, error: true, sources: [], turnId });
      }
    }

    const messages = sanitizeMessages(body.messages);
    if (!messages) return res.status(400).json({ success: false, error: "messages must be a history ending with the user's message" });

    let out;
    try {
      out = await runTurn({ messages, ctx, client: getClient(req) });
    } catch (err) {
      console.error("POST /api/assistant/turn:", errText(err));
      meter(req.user.id, turnId, {});
      return res.json({ reply: ERROR_TURN, error: true, sources: [], turnId });
    }
    meter(req.user.id, turnId, out.usage || {});
    const payload = { reply: out.reply, sources: out.sources, turnId };
    if (out.sideEffect) payload.sideEffect = out.sideEffect;
    res.json(payload);
  });

  // POST /api/assistant/confirm — Body: { sideEffect } as /turn returned it, after the user said yes.
  // -> { success: true, result: <client> }
  router.post("/confirm", (req, res) => {
    const sideEffect = req.body && req.body.sideEffect;
    if (!sideEffect || typeof sideEffect !== "object" || Array.isArray(sideEffect)) {
      return res.status(400).json({ success: false, error: "sideEffect required" });
    }
    try {
      if (sideEffect.type === "addClient") {
        const parsed = clientFromFields(sideEffect.fields);
        if (parsed.errors) return res.status(400).json({ success: false, errors: parsed.errors });
        const result = createClientForUser(db, req.user, parsed.body);
        if (result.errors) return res.status(400).json({ success: false, errors: result.errors });
        return res.json({ success: true, result: result.client });
      }
      if (sideEffect.type === "logContact") {
        const id = sideEffect.clientId;
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "a valid clientId is required" });
        const result = logContactForUser(db, req.user, id);
        if (result.error) return res.status(result.status).json({ success: false, error: result.error });
        return res.json({ success: true, result: result.client });
      }
      return res.status(400).json({ success: false, error: "unknown action" });
    } catch (err) {
      console.error("POST /api/assistant/confirm:", errText(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  // GET /api/assistant/usage?days=30 — broker only; totals over every user in the caller's org.
  router.get("/usage", requireBroker, (req, res) => {
    const asked = parseInt(req.query.days, 10);
    const days = Number.isFinite(asked) ? Math.min(MAX_USAGE_DAYS, Math.max(1, asked)) : DEFAULT_USAGE_DAYS;
    try {
      res.json({ success: true, ...getOrgUsage(req.user.org_id, days) });
    } catch (err) {
      console.error("GET /api/assistant/usage:", errText(err));
      res.status(500).json({ success: false, error: "Database error" });
    }
  });

  return router;
}

module.exports = Object.assign(createAssistantRouter(), { createAssistantRouter });
