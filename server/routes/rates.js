"use strict";
const express   = require("express");
const Anthropic  = require("@anthropic-ai/sdk");
const rateLimit  = require("express-rate-limit");

const router = express.Router();
const MODEL  = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const rateLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// ── Primary source: Optimal Blue daily mortgage indices via FRED ────────────
// Computed from actual rate locks; published every business day (~1-day lag).
const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const OBMMI_SERIES = {
  rate_30yr_fixed:    "OBMMIC30YF",             // 30yr conforming
  rate_15yr_fixed:    "OBMMIC15YF",             // 15yr conforming
  rate_30yr_jumbo:    "OBMMIJUMBO30YF",         // 30yr jumbo
  rate_30yr_fha:      "OBMMIFHA30YF",           // 30yr FHA
  rate_30yr_top_tier: "OBMMIC30YFLVLE80FGE740", // 30yr, LTV≤80 FICO≥740
};

// OBMMI has no ARM index (Freddie's weekly ARM series was discontinued), so
// the 5/1 ARM comes from Claude web search, or an estimate as last resort.
const ARM_SPREAD_ESTIMATE = -0.10; // typical recent 5/1 ARM spread vs 30yr fixed

// Rates are daily — cache so refresh clicks don't refetch (or re-hit Claude).
const RATES_TTL_MS = 6 * 60 * 60 * 1000;
let ratesCache = null; // { payload, expires }

async function fredLatest(seriesId, fredKey, signal) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${fredKey}&file_type=json&sort_order=desc&limit=5`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`FRED ${seriesId} HTTP ${response.status}`);
  const data = await response.json();
  const obs = (data.observations || []).find(o => o.value !== ".");
  if (!obs) throw new Error(`FRED ${seriesId}: no observations`);
  return { date: obs.date, value: parseFloat(obs.value) };
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
  if (ratesCache && Date.now() < ratesCache.expires) {
    return res.json({ ...ratesCache.payload, cached: true });
  }

  const fredKey = process.env.FRED_API_KEY;

  try {
    if (!fredKey) throw new Error("FRED_API_KEY not configured");

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 10_000);
    let obmmi;
    try {
      const entries = await Promise.all(
        Object.entries(OBMMI_SERIES).map(async ([key, id]) => [key, await fredLatest(id, fredKey, ac.signal)])
      );
      obmmi = Object.fromEntries(entries);
    } finally {
      clearTimeout(timeout);
    }

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

    const payload = {
      success: true,
      rates: {
        rate_30yr_fixed: obmmi.rate_30yr_fixed.value,
        rate_15yr_fixed: obmmi.rate_15yr_fixed.value,
        rate_5_1_arm: arm,
        rate_30yr_jumbo: obmmi.rate_30yr_jumbo.value,
        rate_30yr_fha: obmmi.rate_30yr_fha.value,
        rate_30yr_top_tier: obmmi.rate_30yr_top_tier.value,
        date: obmmi.rate_30yr_fixed.date,
        source: `Optimal Blue lock data (${obmmi.rate_30yr_fixed.date}) · ${armSource}`,
      },
    };
    ratesCache = { payload, expires: Date.now() + RATES_TTL_MS };
    return res.json(payload);
  } catch (err) {
    console.error("OBMMI rates error:", err.name === "AbortError" ? "FRED timeout" : err.message);
  }

  // Fallback: Claude web search for the full rate set (previous primary path)
  try {
    const rates = await claudeJson(
      [
        "Search for today's current average US mortgage rates from Mortgage News Daily or Freddie Mac.",
        "Return ONLY a raw JSON object — no markdown, no explanation, no code fences.",
        'Format exactly: {"rate_30yr_fixed": 6.85, "rate_15yr_fixed": 6.12, "rate_5_1_arm": 6.45, "date": "2026-05-19", "source": "Mortgage News Daily"}',
      ].join(" "),
      15_000
    );
    if (typeof rates.rate_30yr_fixed !== "number") throw new Error("Unexpected rate format");
    const payload = { success: true, rates };
    ratesCache = { payload, expires: Date.now() + RATES_TTL_MS };
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
