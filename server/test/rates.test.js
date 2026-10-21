"use strict";
// Resilience test for the live-rate endpoint: when FRED and the Claude fallback are
// both unavailable, /api/rates must still return a complete, sane rate set (never a
// 500) so the dashboard never breaks. Runs fully offline — with no keys configured,
// the route short-circuits before any network call and returns its hardcoded estimate.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");

test("rates endpoint degrades gracefully when all feeds are down", async () => {
  delete process.env.FRED_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const ratesRouter = require("../routes/rates");
  const app = express();
  app.use(express.json());
  app.use("/api", ratesRouter);

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://localhost:${port}/api/rates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200, "must never 500 the UI");
    const data = await res.json();
    assert.ok(data.rates, "always returns a rates object");
    for (const k of ["rate_30yr_fixed", "rate_15yr_fixed", "rate_5_1_arm"]) {
      assert.equal(typeof data.rates[k], "number", `${k} is numeric`);
      assert.ok(data.rates[k] > 0 && data.rates[k] < 20, `${k} in a sane range`);
    }
    assert.equal(data.success, false, "reports that it fell back to estimates");
    assert.ok(/estimat/i.test(data.rates.source || ""), "source labels the estimate");
  } finally {
    server.close();
  }
});
