#!/usr/bin/env node
"use strict";
// Usage: node scripts/update-hpi.js <fhfa-zip3.xlsx> [out.json]
// Reads FHFA's "Three-Digit ZIP Codes (Developmental Index; Not Seasonally Adjusted)" workbook (a local file; no network)
// and writes lib/hpiData.json (or out.json): quarters from 2000Q1, index values rounded to 2 decimals.
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const file = process.argv[2];
const out = process.argv[3] || path.join(__dirname, "..", "lib", "hpiData.json");
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!file || !fs.existsSync(file)) fail("Usage: node scripts/update-hpi.js <path-to-fhfa-zip3.xlsx> [out.json]");

const wb = XLSX.readFile(file);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
const lc = (v) => String(v == null ? "" : v).toLowerCase();
let hi = -1, cz = -1, cy = -1, cq = -1, ci = -1;
for (let i = 0; i < Math.min(rows.length, 50); i++) {
  const r = rows[i].map(lc);
  const z = r.findIndex((s) => /(3|three)[- ]?digit|zip/.test(s));
  const y = r.findIndex((s) => s === "year");
  const q = r.findIndex((s) => s === "quarter");
  const x = r.findIndex((s) => /index/.test(s));
  if (z >= 0 && y >= 0 && q >= 0 && x >= 0) { hi = i; cz = z; cy = y; cq = q; ci = x; break; }
}
if (hi < 0) fail("Could not find the 3-digit ZIP, year, quarter and index columns in the first sheet.");

const num = (v) => (typeof v === "number" ? v : Number(v));
const cells = new Map(); // zip3 -> Map(quarter number -> value)
let maxQ = -Infinity;
for (const r of rows.slice(hi + 1)) {
  const zip = String(r[cz] == null ? "" : r[cz]).trim().padStart(3, "0");
  const y = num(r[cy]), q = num(r[cq]), v = num(r[ci]);
  if (!/^\d{3}$/.test(zip) || !Number.isInteger(y) || !(q >= 1 && q <= 4) || !Number.isFinite(v) || y < 2000) continue;
  const n = y * 4 + q - 1;
  if (!cells.has(zip)) cells.set(zip, new Map());
  cells.get(zip).set(n, Math.round(v * 100) / 100);
  maxQ = Math.max(maxQ, n);
}
if (!cells.size) fail("No index rows found from 2000 on.");

const label = (n) => `${Math.floor(n / 4)}Q${(n % 4) + 1}`;
const startN = 2000 * 4;
const zip3 = {};
for (const zip of [...cells.keys()].sort()) {
  const m = cells.get(zip);
  const a = [];
  for (let n = startN; n <= maxQ; n++) a.push(m.has(n) ? m.get(n) : null);
  zip3[zip] = a;
}
const data = { source: "FHFA HPI 3-digit ZIP (Developmental Index; Not Seasonally Adjusted)", start: label(startN), end: label(maxQ), zip3 };
fs.writeFileSync(out, JSON.stringify(data));
console.log(`Wrote ${out}: ${Object.keys(zip3).length} ZIP3 areas, ${data.start} to ${data.end}.`);
