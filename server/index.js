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

const PORT         = process.env.PORT || 8080;
const CLIENT_BUILD = path.join(__dirname, "client/build");

const app = express();

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

// Health check
app.get("/health", (req, res) => {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM clients").get();
  res.json({ status: "ok", clients: n, db: process.env.DATA_DIR || "./data" });
});

// SPA fallback — must be last
app.get("*", (req, res) => {
  res.sendFile(path.join(CLIENT_BUILD, "index.html"));
});

app.listen(PORT, () => {
  console.log(`RefiRadar v2 running on port ${PORT}`);
  console.log(`Model: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-5"}`);
});
