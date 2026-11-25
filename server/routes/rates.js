"use strict";
const express   = require("express");
const Anthropic  = require("@anthropic-ai/sdk");
const rateLimit  = require("express-rate-limit");

const router = express.Router();
const MODEL  = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const rateLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// ── Primary source: Optimal Blue daily mortgage indices via FRED ────────────
// Computed from actual rate locks; published every business day (~1-day lag). The fetch itself is lib/fred.js (the rate check uses
// it too), and the 6-hour cache is lib/ratesCache.js.
const { FRED_BASE, fetchFredObservations, fredRateSet } = require("../lib/fred");
const ratesCache = require("../lib/ratesCache");

// The keys the Claude web-search fallback may return; anything else in the model's JSON is dropped.
const FALLBACK_KEYS = ["rate_30yr_fixed", "rate_15yr_fixed", "rate_5_1_arm", "date", "source"];

// OBMMI has no ARM index (Freddie's weekly ARM series was discontinued), so
// the 5/1 ARM comes from Claude web search, or an estimate as last resort.
const ARM_SPREAD_ESTIMATE = -0.10; // typical recent 5/1 ARM spread vs 30yr fixed

// Rates are daily — cached (lib/ratesCache.js) so refresh clicks don't refetch (or re-hit Claude).

// Persist a genuinely resolved (FRED / Claude web-search) rate set for market-movement
// tracking, with the provider of the code path that produced it ("fred" | "claude"): the
// label is no proof, since a web-search result can call itself anything. Never throws —
// snapshotting must not break the rates response — and is required lazily so merely
// loading this router doesn't open the database. The hard-coded estimate is never recorded.
function captureSnapshot(rates, provider) {
  try {
    require("../lib/rateHistory").recordSnapshot(rates, undefined, provider);
  } catch (err) {
    console.error("Rate snapshot error:", err.message);
  }
}

async function claudeJson(prompt, timeoutMs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }, { signal: ac.signal });
    const textBlock = message.content?.find(b => b.type === "text");
    if (!textBlock?.text) throw new Error("No text response from Claude");
    const match = textBlock.text.match(/\{[^{}]*\}/);
    if (!match) throw new Error("Could not parse rate JSON");
    return JSON.parse(match[0]);
  } finally {
    clearTimeout(timeout);
  }
}

// POST /api/rates — Optimal Blue (FRED) primary, Claude web search fallback
router.post("/rates", rateLimiter, async (req, res) => {
  const cached = ratesCache.get();
  if (cached) return res.json({ ...cached, cached: true });

  const fredKey = process.env.FRED_API_KEY;

  try {
    if (!fredKey) throw new Error("FRED_API_KEY not configured");

    const fred = await fetchFredObservations({ fredKey });
    const { obmmi } = fred;

    // 5/1 ARM: Claude web search, estimate from 30yr spread if that fails
    let arm, armSource;
    try {
      const data = await claudeJson(
        [
          "Search for today's average US 5/1 ARM mortgage rate from Mortgage News Daily or Bankrate.",
          "Return ONLY a raw JSON object — no markdown, no explanation, no code fences.",
          'Format exactly: {"rate_5_1_arm": 6.45, "source": "Mortgage News Daily"}',
        ].join(" "),
        12_000
      );
      if (typeof data.rate_5_1_arm !== "number") throw new Error("Unexpected ARM format");
      arm = data.rate_5_1_arm;
      armSource = `ARM via ${data.source || "web search"}`;
    } catch (err) {
      console.error("ARM fetch error:", err.message);
      arm = Math.round((obmmi.rate_30yr_fixed.value + ARM_SPREAD_ESTIMATE) * 100) / 100;
      armSource = "ARM estimated";
    }

    const payload = { success: true, rates: fredRateSet(fred, { arm, armSource }) };
    ratesCache.set(payload);
    captureSnapshot(payload.rates, "fred");
    return res.json(payload);
  } catch (err) {
    console.error("OBMMI rates error:", err.name === "AbortError" ? "FRED timeout" : err.message);
  }

  // Fallback: Claude web search for the full rate set (previous primary path). Only the keys asked for pass, so a model-made FHA or
  // VA rate can never reach the upgrade checks.
  try {
    const found = await claudeJson(
      [
        "Search for today's current average US mortgage rates from Mortgage News Daily or Freddie Mac.",
        "Return ONLY a raw JSON object — no markdown, no explanation, no code fences.",
        'Format exactly: {"rate_30yr_fixed": 6.85, "rate_15yr_fixed": 6.12, "rate_5_1_arm": 6.45, "date": "2026-05-19", "source": "Mortgage News Daily"}',
      ].join(" "),
      15_000
    );
    const rates = {};
    for (const key of FALLBACK_KEYS) if (found[key] !== undefined) rates[key] = found[key];
    if (typeof rates.rate_30yr_fixed !== "number") throw new Error("Unexpected rate format");
    const payload = { success: true, rates };
    ratesCache.set(payload);
    captureSnapshot(rates, "claude");
    res.json(payload);
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    console.error("Rates fallback error:", isTimeout ? "timeout" : err.message);
    res.json({
      success: false,
      error: isTimeout ? "Rate fetch timed out" : err.message,
      rates: { rate_30yr_fixed: 6.87, rate_15yr_fixed: 6.18, rate_5_1_arm: 6.52, date: new Date().toISOString().split("T")[0], source: "Estimated — live fetch unavailable" }
    });
  }
});

// GET /api/treasury — FRED 10-year Treasury yield
router.get("/treasury", async (req, res) => {
  const fredKey = process.env.FRED_API_KEY;
  if (!fredKey) return res.status(500).json({ error: "FRED_API_KEY not configured" });

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 8_000);

  try {
    const url = `${FRED_BASE}?series_id=DGS10&api_key=${fredKey}&file_type=json&sort_order=desc&limit=30`;
    const response = await fetch(url, { signal: ac.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`FRED HTTP ${response.status}`);
    const data = await response.json();
    const valid = (data.observations||[]).filter(o => o.value !== ".").map(o => ({ date: o.date, value: parseFloat(o.value) }));
    if (!valid.length) throw new Error("No treasury data");
    res.json({ success: true, current: valid[0], previous: valid[1], history: valid.slice(0, 30).reverse() });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === "AbortError" ? "FRED API timed out" : err.message;
    console.error("Treasury error:", msg);
    res.status(502).json({ success: false, error: msg });
  }
});

module.exports = router;
