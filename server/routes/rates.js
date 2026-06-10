"use strict";
const express   = require("express");
const Anthropic  = require("@anthropic-ai/sdk");
const rateLimit  = require("express-rate-limit");

const router = express.Router();
const MODEL  = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const rateLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

// POST /api/rates — Claude web search for live mortgage rates
router.post("/rates", rateLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 15_000);

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: [
          "Search for today's current average US mortgage rates from Mortgage News Daily or Freddie Mac.",
          "Return ONLY a raw JSON object — no markdown, no explanation, no code fences.",
          'Format exactly: {"rate_30yr_fixed": 6.85, "rate_15yr_fixed": 6.12, "rate_5_1_arm": 6.45, "date": "2026-05-19", "source": "Mortgage News Daily"}'
        ].join(" ")
      }]
    }, { signal: ac.signal });
    clearTimeout(timeout);

    const textBlock = message.content?.find(b => b.type === "text");
    if (!textBlock?.text) throw new Error("No text response from Claude");
    const match = textBlock.text.match(/\{[^{}]*\}/);
    if (!match) throw new Error("Could not parse rate JSON");
    const rates = JSON.parse(match[0]);
    if (typeof rates.rate_30yr_fixed !== "number") throw new Error("Unexpected rate format");
    res.json({ success: true, rates });
  } catch (err) {
    clearTimeout(timeout);
    const isTimeout = err.name === "AbortError";
    console.error("Rates error:", isTimeout ? "15s timeout" : err.message);
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
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${fredKey}&file_type=json&sort_order=desc&limit=30`;
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
