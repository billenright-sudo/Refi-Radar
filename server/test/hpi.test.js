"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const XLSX = require("xlsx");
const { createIndex, defaultIndex, quarterOf } = require("../lib/hpi");

// 22 quarters 2021Q1..2026Q2; 2021Q2 = 100, 2026Q2 = 129.
function series() {
  const a = [];
  for (let i = 0; i < 22; i++) a.push(100 + (i - 1) * (29 / 20));
  a[1] = 100;
  a[21] = 129;
  return a;
}
const idx = () => createIndex({ source: "t", start: "2021Q1", end: "2026Q2", zip3: { "850": series() } });

test("growth from the from-quarter to the latest quarter", () => {
  const g = idx().growth("85016", "2021-06-30", "2026-11-13");
  assert.ok(Math.abs(g.factor - 1.29) < 1e-9);
  assert.strictEqual(g.area, "850");
  assert.strictEqual(g.fromQuarter, "2021Q2");
  assert.strictEqual(g.toQuarter, "2026Q2");
  assert.strictEqual(idx().latestQuarter, "2026Q2");
});

test("unknown zip3, early date, bad zip give null", () => {
  assert.strictEqual(idx().growth("90210", "2021-06-30", "2026-11-13"), null);
  assert.strictEqual(idx().growth("85016", "2020-06-30", "2026-11-13"), null);
  assert.strictEqual(idx().growth("8501", "2021-06-30", "2026-11-13"), null);
  assert.strictEqual(idx().growth("", "2021-06-30", "2026-11-13"), null);
});

test("from date in or after the end quarter gives factor 1", () => {
  assert.strictEqual(idx().growth("85016", "2026-05-01", "2026-11-13").factor, 1);
  assert.strictEqual(idx().growth("85016", "2026-09-01", "2026-11-13").factor, 1);
});

test("quarterOf", () => {
  assert.strictEqual(quarterOf("2021-01-01"), "2021Q1");
  assert.strictEqual(quarterOf("2021-03-31"), "2021Q1");
  assert.strictEqual(quarterOf("2021-04-01"), "2021Q2");
  assert.strictEqual(quarterOf("2021-06-30"), "2021Q2");
  assert.strictEqual(quarterOf("2021-12-15"), "2021Q4");
});

test("shipped data loads", () => {
  const l = defaultIndex.latestQuarter;
  assert.ok(l === null || typeof l === "string");
  assert.strictEqual(defaultIndex.growth("85016", "2021-06-30", "2026-11-13"), null);
});

test("update-hpi.js builds the snapshot from a local xlsx", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpi-"));
  const rows = [
    ["Three-Digit ZIP Codes (Developmental Index; Not Seasonally Adjusted)"],
    [],
    ["Three-Digit ZIP Code", "Year", "Quarter", "Index (Not Seasonally Adjusted)"],
    ["850", 1999, 4, 90],
    ["850", 2000, 1, 100],
    ["850", 2000, 2, 101.234],
    ["850", 2000, 3, 102],
    ["941", 2000, 1, 50],
    ["941", 2000, 2, 55.5],
    ["941", 2000, 3, "-"],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  const file = path.join(dir, "in.xlsx");
  XLSX.writeFile(wb, file);
  const out = path.join(dir, "out.json");
  const script = path.join(__dirname, "..", "scripts", "update-hpi.js");
  const r = spawnSync(process.execPath, [script, file, out], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  const d = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.strictEqual(d.start, "2000Q1");
  assert.strictEqual(d.end, "2000Q3");
  assert.deepStrictEqual(d.zip3["850"], [100, 101.23, 102]);
  assert.strictEqual(d.zip3["941"][1], 55.5);
  assert.match(r.stdout, /2 ZIP3/);
  assert.match(r.stdout, /2000Q3/);
});

test("update-hpi.js exits 1 when columns are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpi-"));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
  const file = path.join(dir, "bad.xlsx");
  XLSX.writeFile(wb, file);
  const script = path.join(__dirname, "..", "scripts", "update-hpi.js");
  const r = spawnSync(process.execPath, [script, file, path.join(dir, "o.json")], { encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /column/i);
});
