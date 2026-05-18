require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "client/build")));
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.post("/api/rates", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "Search for today's current average US mortgage rates. Return ONLY a raw JSON object, no markdown, no explanation. Format: {\"rate_30yr_fixed\": 6.85, \"rate_15yr_fixed\": 6.12, \"rate_5_1_arm\": 6.45, \"date\": \"2026-05-14\", \"source\": \"Mortgage News Daily\"}" }]
    });
    const textBlock = message.content?.find(b => b.type === "text");
    if (!textBlock?.text) throw new Error("No response from Claude");
    const match = textBlock.text.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("Could not parse rate data");
    res.json({ success: true, rates: JSON.parse(match[0]) });
  } catch (err) {
    console.error("Rates error:", err.message);
    res.json({ success: false, error: err.message, rates: { rate_30yr_fixed: 6.87, rate_15yr_fixed: 6.18, rate_5_1_arm: 6.52, date: new Date().toISOString().split("T")[0], source: "Estimated" } });
  }
});
app.get("/api/treasury", async (req, res) => {
  const fredKey = process.env.FRED_API_KEY;
  if (!fredKey) return res.status(500).json({ error: "FRED_API_KEY not configured" });
  try {
    const url = "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=" + fredKey + "&file_type=json&sort_order=desc&limit=30";
    const response = await fetch(url);
    const data = await response.json();
    const valid = (data.observations || []).filter(o => o.value !== ".").map(o => ({ date: o.date, value: parseFloat(o.value) }));
    if (!valid.length) throw new Error("No treasury data from FRED");
    res.json({ success: true, current: valid[0], previous: valid[1], history: valid.slice(0, 30).reverse() });
  } catch (err) {
    console.error("Treasury error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "client/build", "index.html"));
});
app.listen(PORT, () => console.log("RefiRadar running on port " + PORT));
