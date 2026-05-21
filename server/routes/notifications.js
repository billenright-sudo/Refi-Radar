"use strict";
const express = require("express");
const db      = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function toNotif(n) {
  return {
    id: n.id, fromUser: n.from_user_name, clientId: n.client_id,
    clientName: n.client_name, message: n.message,
    read: !!n.read, createdAt: n.created_at,
  };
}

// GET /api/notifications — list all for current user, newest first
router.get("/", (req, res) => {
  const rows = db.prepare(`
    SELECT n.*,
           (u.first_name || ' ' || u.last_name) AS from_user_name,
           c.name AS client_name
    FROM notifications n
    JOIN users u ON u.id = n.from_user
    LEFT JOIN clients c ON c.id = n.client_id
    WHERE n.to_user = ?
    ORDER BY n.created_at DESC
    LIMIT 50
  `).all(req.user.id);
  res.json({ success: true, notifications: rows.map(toNotif) });
});

// GET /api/notifications/unread-count
router.get("/unread-count", (req, res) => {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE to_user = ? AND read = 0").get(req.user.id);
  res.json({ success: true, count: n });
});

// POST /api/notifications/:id/read — mark one as read
router.post("/:id/read", (req, res) => {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND to_user = ?").run(parseInt(req.params.id), req.user.id);
  res.json({ success: true });
});

// POST /api/notifications/read-all
router.post("/read-all", (req, res) => {
  db.prepare("UPDATE notifications SET read = 1 WHERE to_user = ?").run(req.user.id);
  res.json({ success: true });
});

module.exports = router;
