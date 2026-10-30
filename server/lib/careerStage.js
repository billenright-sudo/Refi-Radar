"use strict";
// The one write of a user's career stage (tenure), shared by Charli's /api/assistant/confirm setCareerStage and the Profile
// page's PUT /api/profile/career-stage. The stage object comes from lib/assistant/coaching.js (stageById).
const db = require("../db");

// ONLY the signed-in user's own row (never an id from the body), and the receipt kept per confirmId is the stage and its
// label. It is idempotent, so a confirmId is optional here.
function setCareerStageForUser(user, stage) {
  const info = db.prepare("UPDATE users SET career_stage = ? WHERE id = ?").run(stage.id, user.id);
  if (info.changes !== 1) return { status: 404, error: "User not found" };
  const receipt = { stage: stage.id, label: stage.label };
  return { result: receipt, receipt };
}

module.exports = { setCareerStageForUser };
