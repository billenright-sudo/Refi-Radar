"use strict";
require("dotenv").config();
const express      = require("express");
const path         = require("path");
const cookieParser = require("cookie-parser");

// Load DB first (creates schema)
const db           = require("./db");

// Routes
const authRoutes   = require("./routes/auth");
const clientRoutes = require("./routes/clients");
const orgRoutes    = require("./routes/org");
const notifRoutes  = require("./routes/notifications");
const ratesRoutes  = require("./routes/rates");
const importRoutes = require("./routes/import");
const sweepsRoutes = require("./routes/sweeps");
const assistantRoutes = require("./routes/assistant");
const voiceRoutes = require("./routes/voice");
const googleRoutes = require("./routes/google");
const profileRoutes = require("./routes/profile");
const integrationRoutes = require("./routes/integrations");
const billingWebhookRoutes = require("./routes/billingWebhook");
const billingRoutes = require("./routes/billing");
const { charliModel } = require("./lib/assistant/orchestrator");
const { startBilling } = require("./lib/billing/startup");
const { createStripeGateway } = require("./lib/billing/stripeGateway");

const PORT         = process.env.PORT || 8080;
const CLIENT_BUILD = path.join(__dirname, "client/build");

const app = express();

// Trust Cloud Run's load balancer so express-rate-limit reads the real client IP
app.set("trust proxy", 1);

// The ARIVE (Zapier) feed reads its own 32 KB body and no cookie on /loans, so it is mounted BEFORE the app-wide 20 MB JSON
// parser below (R9): that parser would otherwise take the body first and the 32 KB limit would never apply.
app.use("/api/integrations", integrationRoutes);
// The Stripe webhook checks a signature over the exact bytes Stripe sent, so it reads its own raw body and must come before the JSON
// parser too. It answers 404 until billing is switched on (the billing config and gateway on the app).
app.use("/api/billing/webhook", billingWebhookRoutes);

app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());
app.use(express.static(CLIENT_BUILD));

// API routes
app.use("/api/auth",          authRoutes);
app.use("/api/clients",       clientRoutes);
app.use("/api/org",           orgRoutes);
app.use("/api/notifications", notifRoutes);
app.use("/api",               ratesRoutes);   // mounts /api/rates and /api/treasury
app.use("/api/import",        importRoutes);
app.use("/api/sweeps",        sweepsRoutes);
app.use("/api/assistant",     assistantRoutes);
app.use("/api/voice",         voiceRoutes);
app.use("/api/google",        googleRoutes);
app.use("/api/profile",       profileRoutes);
app.use("/api/billing",       billingRoutes);   // not gated: a locked brokerage still adds a card and takes its clients out

// Health check
app.get("/health", (req, res) => {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM clients").get();
  res.json({ status: "ok", clients: n, db: process.env.DATA_DIR || "./data" });
});

// SPA fallback — must be last
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_BUILD, "index.html"));
});

// Billing is switched on before the server listens (lib/billing/startup.js): only with all three Stripe settings and a Stripe price
// that matches the one the app shows (H5), checked with a wait of about 10 seconds at most, so a slow Stripe can't hold up the start.
// Otherwise billing stays off ("[billing] off: <reason>" in the log) and the app behaves exactly as it did before billing.
(async () => {
  try {
    const { config, gateway } = await startBilling(db, process.env, (c) => createStripeGateway({ secretKey: c.secretKey }));
    app.set("billingConfig", config);
    if (gateway) app.set("billingGateway", gateway);
  } catch (err) {
    console.warn(`[billing] off: start-up failed (${err?.message})`);
    app.set("billingConfig", { enabled: false });
  }
  app.listen(PORT, () => {
    console.log(`RefiRadar v2 running on port ${PORT}`);
    // the two model settings, each by its name: the rates fetch's (routes/rates.js) and Charlie's (orchestrator.js)
    console.log(`Rates model (CLAUDE_MODEL): ${process.env.CLAUDE_MODEL || "claude-sonnet-4-5"}`);
    console.log(`Charlie model (CHARLI_MODEL): ${charliModel()}`);
  });
})();
