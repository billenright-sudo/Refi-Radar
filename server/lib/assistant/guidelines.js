"use strict";
// The loan-guideline test, shared by the orchestrator (a guideline question hands off) and the tools (lookUpLive never searches
// one). It lives here, not in orchestrator.js, because the orchestrator requires the tools: the tools requiring it back would be
// a require cycle. Pure: no I/O, no state.

// Loan-guideline domain (deferred): the model has no verified source, so it must hand off.
const GUIDELINE_RE = new RegExp("\\b(?:" + [
  "guidelines?", "overlays?", "underwrit\\w*", "AUS", "DU\\s+findings?", "LPA",
  "reserve\\s+requirements?", "DTI\\s+limits?", "max(?:imum)?\\s+DTI", "HUD\\s+handbook", "selling\\s+guide",
].join("|") + ")\\b", "i");
// Eligibility is a guideline question only next to a program or requirement word, in either
// order ("eligible for an FHA streamline", "FHA eligibility"); "is Chen eligible for a refi"
// is a sweep question and must still reach the tools.
const PROGRAM = "FHA|VA|USDA|conventional|jumbo|streamlines?|non[\\s-]?QM|programs?|requirements?";
const ELIGIBLE_NEAR_PROGRAM_RE = new RegExp(
  "\\beligib\\w*(?:\\W+\\w+){0,4}?\\W+(?:" + PROGRAM + ")\\b" +
  "|\\b(?:" + PROGRAM + ")(?:\\W+\\w+){0,4}?\\W+eligib\\w*\\b",
  "i"
);
const isGuidelineQuestion = (text) => GUIDELINE_RE.test(text) || ELIGIBLE_NEAR_PROGRAM_RE.test(text);

module.exports = { isGuidelineQuestion };
