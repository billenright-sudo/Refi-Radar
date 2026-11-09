"use strict";
// The loan values a person changed by hand on the client form (routes/clients.js), which an import or an LOS feed keeps
// for the same loan (Bill, 2026-11-03; ingest.js). clients.edited_by_hand holds them as column names, comma-separated, in
// HAND_KEPT's order, and '' when there are none.

const HAND_KEPT = Object.freeze(["current_rate", "property_value", "credit_score"]);
// How the import's review names each one.
const LABELS = Object.freeze({ current_rate: "rate", property_value: "property value", credit_score: "credit score" });

// The stored text as a Set of column names; anything that is not one of HAND_KEPT is dropped.
const readMarks = (text) => new Set(String(text ?? "").split(",").map((s) => s.trim()).filter((c) => HAND_KEPT.includes(c)));
// A Set of column names as stored.
const writeMarks = (marks) => HAND_KEPT.filter((c) => marks.has(c)).join(",");

module.exports = { HAND_KEPT, LABELS, readMarks, writeMarks };
