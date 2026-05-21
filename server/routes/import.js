"use strict";
const express = require("express");
const multer  = require("multer");
const XLSX    = require("xlsx");
const db      = require("../db");
const { requireAuth } = require("../middleware/auth");

const router  = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const VALID_LOAN_TYPES = ["30yr_fixed", "15yr_fixed", "5_1_arm"];

// Smart column mapping: tries many common CRM export column names
function detectColumn(headers, candidates) {
  const h = headers.map(s => s?.toString().toLowerCase().trim().replace(/[\s_\-]/g, ""));
  for (const c of candidates) {
    const idx = h.indexOf(c.toLowerCase().replace(/[\s_\-]/g, ""));
    if (idx !== -1) return idx;
  }
  return -1;
}

function mapLoanType(val) {
  if (!val) return "30yr_fixed";
  const v = val.toString().toLowerCase().replace(/\s/g, "");
  if (v.includes("15")) return "15yr_fixed";
  if (v.includes("arm") || v.includes("5/1") || v.includes("51")) return "5_1_arm";
  return "30yr_fixed";
}

function parseRows(buffer, mimetype) {
  let wb;
  if (mimetype === "text/csv" || mimetype === "application/vnd.ms-excel" && buffer.toString("utf8", 0, 5).includes(",")) {
    wb = XLSX.read(buffer, { type: "buffer", raw: false });
  } else {
    wb = XLSX.read(buffer, { type: "buffer" });
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

// POST /api/import/preview — parse file, return mapped rows for user to review
router.post("/preview", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

  try {
    const rows = parseRows(req.file.buffer, req.file.mimetype);
    if (rows.length < 2) return res.status(400).json({ success: false, error: "File appears to be empty" });

    const headers = rows[0].map(h => h?.toString() || "");
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell !== ""));

    // Detect columns
    const colIdx = {
      name:          detectColumn(headers, ["name","fullname","clientname","borrowername","client"]),
      email:         detectColumn(headers, ["email","emailaddress","e-mail"]),
      phone:         detectColumn(headers, ["phone","phonenumber","mobile","cell","telephone"]),
      currentRate:   detectColumn(headers, ["rate","currentrate","interestrate","mortgagerate","loanrate","currentinterestrate"]),
      loanBalance:   detectColumn(headers, ["balance","loanbalance","remainingbalance","outstandingbalance","loanamount","amount","principal"]),
      propertyValue: detectColumn(headers, ["propertyvalue","value","homevalue","appraisedvalue","estimatedvalue","property"]),
      loanType:      detectColumn(headers, ["loantype","type","mortgagetype","loan"]),
      closeDate:     detectColumn(headers, ["closedate","closingdate","originationdate","date","loandate"]),
      creditScore:   detectColumn(headers, ["creditscore","fico","score","creditrating"]),
      notes:         detectColumn(headers, ["notes","note","comments","memo"]),
    };

    const preview = dataRows.slice(0, 5).map((row, i) => ({
      _row: i + 2,
      name:          colIdx.name >= 0          ? row[colIdx.name] : "",
      email:         colIdx.email >= 0         ? row[colIdx.email] : "",
      phone:         colIdx.phone >= 0         ? row[colIdx.phone] : "",
      currentRate:   colIdx.currentRate >= 0   ? row[colIdx.currentRate] : "",
      loanBalance:   colIdx.loanBalance >= 0   ? row[colIdx.loanBalance] : "",
      propertyValue: colIdx.propertyValue >= 0 ? row[colIdx.propertyValue] : "",
      loanType:      colIdx.loanType >= 0      ? row[colIdx.loanType] : "30yr_fixed",
      closeDate:     colIdx.closeDate >= 0     ? row[colIdx.closeDate] : "",
      creditScore:   colIdx.creditScore >= 0   ? row[colIdx.creditScore] : "",
      notes:         colIdx.notes >= 0         ? row[colIdx.notes] : "",
    }));

    // Store parsed data in session via a temp structure (base64 encode the buffer)
    // We'll re-parse on confirm — simpler than sessions
    res.json({
      success: true,
      totalRows: dataRows.length,
      headers,
      columnMap: colIdx,
      preview,
      fileData: req.file.buffer.toString("base64"),
      mimetype: req.file.mimetype,
    });
  } catch (err) {
    console.error("Import preview error:", err.message);
    res.status(400).json({ success: false, error: "Could not parse file: " + err.message });
  }
});

// POST /api/import/confirm — actually insert all rows
router.post("/confirm", express.json({ limit: "20mb" }), (req, res) => {
  const { fileData, mimetype, columnMap } = req.body;
  if (!fileData || !columnMap) return res.status(400).json({ success: false, error: "Missing import data" });

  try {
    const buffer = Buffer.from(fileData, "base64");
    const rows   = parseRows(buffer, mimetype);
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell !== ""));

    const ins = db.prepare(`
      INSERT INTO clients (org_id, user_id, name, email, phone, loan_type, current_rate, loan_balance, property_value, close_date, credit_score, notes)
      VALUES (@org_id, @user_id, @name, @email, @phone, @loan_type, @current_rate, @loan_balance, @property_value, @close_date, @credit_score, @notes)
    `);

    let imported = 0, skipped = 0;
    const errors = [];

    const runImport = db.transaction(() => {
      for (const [i, row] of dataRows.entries()) {
        const get = (key) => columnMap[key] >= 0 ? (row[columnMap[key]]?.toString() || "") : "";
        const name = get("name").trim();
        if (!name) { skipped++; continue; }

        const rate = parseFloat(get("currentRate").replace(/[%,]/g, ""));
        const bal  = parseFloat(get("loanBalance").replace(/[,$]/g, ""));
        const val  = parseFloat(get("propertyValue").replace(/[,$]/g, ""));

        if (isNaN(rate) || isNaN(bal) || isNaN(val) || bal <= 0 || val <= 0) {
          errors.push(`Row ${i + 2}: Missing or invalid rate/balance/value — skipped`);
          skipped++;
          continue;
        }

        ins.run({
          org_id: req.user.org_id, user_id: req.user.id,
          name, email: get("email").trim(), phone: get("phone").trim(),
          loan_type: mapLoanType(get("loanType")),
          current_rate: rate, loan_balance: bal, property_value: val,
          close_date: get("closeDate").trim(), credit_score: parseInt(get("creditScore")) || 700,
          notes: get("notes").trim(),
        });
        imported++;
      }
    });

    runImport();
    res.json({ success: true, imported, skipped, errors: errors.slice(0, 10) });
  } catch (err) {
    console.error("Import confirm error:", err.message);
    res.status(500).json({ success: false, error: "Import failed: " + err.message });
  }
});

module.exports = router;
