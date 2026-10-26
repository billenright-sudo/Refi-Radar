"use strict";
// The seam between the browser session (client/src/charli/session.mjs) and the real /api/assistant + /api/auth routers, which was only
// ever checked by hand: the session's requests go over HTTP to the real express app, a scripted fake stands in for the model, and every
// step is asserted against BOTH the session state (getState) and the database.
const os = require("os");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-charli-seam-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";

const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { CAREER_QUESTION } = require("../lib/assistant/coaching");
const assistantRoutes = require("../routes/assistant");

const LIVE = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STALE = "2024-01-01 00:00:00";
const SENTINEL = "2000-01-01 00:00:00";   // a last_contact no real write can produce: a second write would replace it

// ── seed: one broker with no career stage, one client ────────────────────────

const orgId = Number(db.prepare("INSERT INTO organizations (name) VALUES ('Seam Org')").run().lastInsertRowid);
const ann = Number(db.prepare("INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, 'broker', 'Ann', 'User', 'ann@seam.co')").run(orgId).lastInsertRowid);
const chen = Number(db.prepare(`
  INSERT INTO clients (org_id, user_id, name, loan_type, current_rate, loan_balance, property_value, credit_score, last_contact)
  VALUES (?, ?, 'Robert & Linda Chen', '30yr_fixed', 7.85, 485000, 650000, 760, ?)
`).run(orgId, ann, STALE).lastInsertRowid);
const stageInDb = () => db.prepare("SELECT career_stage FROM users WHERE id = ?").get(ann).career_stage;
const lastContactInDb = () => db.prepare("SELECT last_contact FROM clients WHERE id = ?").get(chen).last_contact;
const clientCount = () => db.prepare("SELECT COUNT(*) AS n FROM clients WHERE org_id = ?").get(orgId).n;
const usageRows = () => db.prepare("SELECT * FROM assistant_usage WHERE user_id = ?").all(ann);

// ── a scripted model: responses are queued per step; the Messages API's history rules are enforced on every call ──

const resp = (content, stop_reason) => ({ id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason, usage: { input_tokens: 100, output_tokens: 20 } });
const say = (text) => resp([{ type: "text", text }], "end_turn");
const useTool = (name, input, id = "toolu_1") => resp([{ type: "tool_use", id, name, input }], "tool_use");
const toolResult = (params) => JSON.parse(params.messages.at(-1).content[0].content);
function scriptedModel() {
  const calls = [];
  const queue = [];
  return {
    calls, queue,
    messages: {
      create: async (params) => {
        const roles = params.messages.map((m) => m.role);
        if (roles[0] !== "user" || roles.some((r, i) => i > 0 && r === roles[i - 1])) throw new Error("the Messages API would answer 400: " + roles.join(","));
        calls.push(JSON.parse(JSON.stringify(params)));
        if (!queue.length) throw new Error("unscripted model call " + calls.length);
        const next = queue.shift();
        return typeof next === "function" ? next(params) : next;
      },
    },
  };
}

// ── the real app on a real port ──────────────────────────────────────────────

let server, base, cookie, model, createSession, net;
before(async () => {
  ({ createSession } = await import(pathToFileURL(path.join(__dirname, "../../client/src/charli/session.mjs")).href));
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(cookieParser());
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/assistant", assistantRoutes.createAssistantRouter({ limiter: { max: 100000 } }));
  model = scriptedModel();
  app.set("anthropicClient", model);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
  cookie = "rr_token=" + signToken({ userId: ann });
});
after(() => {
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// The session's fetch: the real server, signed in as Ann. It logs every /confirm exchange, and can lose the response to the next
// one AFTER the server has handled it (the retry case: the write happened, the browser never heard).
function newNet() {
  const n = { confirms: [], dropNextConfirmResponse: false };
  n.fetch = async (url, init = {}) => {
    const res = await fetch(base + url, { ...init, headers: { ...(init.headers || {}), cookie } });
    if (url === "/api/assistant/confirm") {
      n.confirms.push({ sent: JSON.parse(init.body), status: res.status, got: await res.clone().json() });
      if (n.dropNextConfirmResponse) { n.dropNextConfirmResponse = false; throw new TypeError("Failed to fetch"); }
    }
    return res;
  };
  return n;
}
function newSession(user) {
  net = newNet();
  const spoken = [];
  const session = createSession({ fetch: net.fetch, rates: LIVE, localHour: 9, user, onSpeak: (s) => spoken.push(s.text) });
  return { session, spoken, state: () => session.getState() };
}
const me = async () => (await (await fetch(base + "/api/auth/me", { headers: { cookie } })).json()).user;

// ── the session, step by step ────────────────────────────────────────────────

test("seam: greeting, career-stage answer (Tier 1), a logged contact and its retry, a thank-you, a cancelled new client", async () => {
  const { session, spoken, state } = newSession({ careerStage: null });

  // 1. open(): the code-authored greeting, with sources, and no model call
  await session.open();
  assert.equal(state().turns.length, 1);
  const greeting = state().turns[0];
  assert.equal(greeting.role, "assistant");
  assert.equal(greeting.kind, "message");
  assert.match(greeting.content, /^Good morning, Ann\./);
  assert.ok(greeting.content.endsWith(CAREER_QUESTION), "a user with no stage is asked the career question");
  assert.ok(greeting.sources.length > 0 && greeting.sources.every((s) => typeof s === "string" && s), "the greeting cites its tools");
  assert.deepEqual(spoken, [greeting.content]);
  assert.equal(model.calls.length, 0, "the greeting costs no model call");
  assert.deepEqual([state().busy, state().opening, state().hasRates, state().careerStage], [false, false, true, null]);
  assert.equal(stageInDb(), null);
  assert.deepEqual(usageRows().map((r) => [r.kind, r.input_tokens, r.output_tokens]), [["turn", 0, 0]], "metered, at zero tokens");

  // 2. "about 20 years": Tier 1 packages the stage with no model call; nothing is saved until the yes
  assert.deepEqual(await session.submit("about 20 years"), { ok: true, action: "turn" });
  const stageChange = state().pending;
  assert.deepEqual({ ...stageChange.sideEffect, confirmId: undefined }, { type: "setCareerStage", stage: "veteran", confirmId: undefined });
  assert.match(stageChange.sideEffect.confirmId, UUID);
  assert.equal(stageChange.readBack, "Just to confirm — set your career stage to Veteran, ten or more years?");
  assert.deepEqual(stageChange.details, [{ label: "Career stage", value: "Veteran (10+ years)" }]);
  assert.equal(model.calls.length, 0, "Tier 1: zero model calls");
  assert.equal(stageInDb(), null, "nothing written before the yes");
  assert.equal(spoken.at(-1), stageChange.readBack);

  assert.deepEqual(await session.submit("yes"), { ok: true, action: "confirm" });
  assert.equal(state().turns.at(-1).content, "Done — your career stage is set to Veteran, ten or more years.");
  assert.equal(state().pending, null);
  assert.equal(state().careerStage, "veteran");
  assert.equal((await me()).careerStage, "veteran");
  assert.equal(stageInDb(), "veteran");
  assert.deepEqual(net.confirms.map((c) => c.sent.sideEffect), [stageChange.sideEffect], "the sideEffect went back verbatim, confirmId included");
  assert.equal(model.calls.length, 0, "the yes never reached /turn");

  // 3. "log a contact for the Chens": findClient, then logContactTool -> a pending change; the yes writes it once
  model.queue.push(useTool("findClient", { query: "chen" }), (p) => useTool("logContactTool", { clientId: toolResult(p).data.matches[0].id }, "toolu_2"));
  assert.deepEqual(await session.submit("log a contact for the Chens"), { ok: true, action: "turn" });
  const contact = state().pending;
  assert.equal(model.calls.length, 2);
  assert.deepEqual({ ...contact.sideEffect, confirmId: undefined }, { type: "logContact", clientId: chen, confirmId: undefined });
  assert.match(contact.sideEffect.confirmId, UUID);
  assert.equal(contact.readBack, "Just to confirm — log a contact for Robert & Linda Chen?");
  assert.deepEqual(contact.details, [{ label: "Client", value: "Robert & Linda Chen" }, { label: "Contact date", value: "Today" }]);
  assert.equal(lastContactInDb(), STALE, "nothing written before the yes");

  assert.deepEqual(await session.submit("yes"), { ok: true, action: "confirm" });
  assert.equal(state().turns.at(-1).content, "Done — I logged a contact for Robert & Linda Chen.");
  assert.equal(state().pending, null);
  assert.notEqual(lastContactInDb(), STALE, "the contact was logged");
  assert.equal(model.calls.length, 2);

  // ... and the same sideEffect sent again (a retry) is a dedupe: nothing is written a second time
  db.prepare("UPDATE clients SET last_contact = ? WHERE id = ?").run(SENTINEL, chen);
  const again = await fetch(base + "/api/assistant/confirm", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ sideEffect: contact.sideEffect }),
  });
  assert.equal(again.status, 200);
  const dup = await again.json();
  assert.equal(dup.duplicate, true);
  assert.equal(dup.reply, "Done — I logged a contact for Robert & Linda Chen.");
  assert.equal(lastContactInDb(), SENTINEL, "no second write");
  assert.equal(clientCount(), 1);

  // 4. "thanks": the model's answer passes, and the history it was sent holds the Done line (merged) and never the details
  model.queue.push(say("You're welcome — anything else?"));
  assert.deepEqual(await session.submit("thanks"), { ok: true, action: "turn" });
  assert.equal(state().turns.at(-1).content, "You're welcome — anything else?");
  assert.equal(state().turns.at(-1).kind, "message");
  const sent = model.calls.at(-1).messages;
  const doneLine = sent.find((m) => m.role === "assistant" && String(m.content).includes("Done — I logged a contact for Robert & Linda Chen."));
  assert.ok(doneLine, "the Done line is in the history as assistant content");
  assert.ok(doneLine.content.startsWith(contact.readBack), "merged with the read-back it answers");
  assert.equal(sent.at(-1).content, "thanks");
  const wire = JSON.stringify(sent);
  for (const never of ["Contact date", "Career stage", "details", "confirmId", "Today"]) assert.ok(!wire.includes(never), `"${never}" is not sent to the model`);

  // 5. a new client with every field: every details row is shown, and cancelling writes nothing
  const fields = {
    name: "Jane Doe", loanType: "30yr_fixed", currentRate: 6.875, loanBalance: 350000, propertyValue: 500000, closeDate: "2021-03-15",
    creditScore: 740, email: "jane@example.test", phone: "555-0100", notes: "Referred by the Chens",
  };
  model.queue.push(useTool("addClientTool", fields));
  assert.deepEqual(await session.submit("add a client Jane Doe, 6.875 percent, 350 thousand on a 500 thousand house"), { ok: true, action: "turn" });
  const added = state().pending;
  assert.equal(added.sideEffect.type, "addClient");
  assert.deepEqual(added.sideEffect.fields, fields);
  assert.deepEqual(added.details.map((d) => d.label), ["Name", "Loan type", "Rate", "Balance", "Property value", "Close date", "Credit score", "Email", "Phone", "Notes"]);
  assert.deepEqual(added.details.filter((d) => ["Name", "Rate", "Balance", "Credit score", "Notes"].includes(d.label)).map((d) => d.value),
    ["Jane Doe", "6.875%", "$350,000", "740", "Referred by the Chens"]);
  assert.equal(clientCount(), 1, "nothing written before the yes");

  assert.deepEqual(await session.cancelPending(), { ok: true, action: "cancel" });
  assert.equal(state().turns.at(-1).content, "Okay — I'll leave that.");
  assert.equal(state().pending, null);
  assert.equal(clientCount(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM clients WHERE name = 'Jane Doe'").get().n, 0);
  assert.equal(net.confirms.length, 2, "only the stage and the contact were ever confirmed");
  assert.equal(model.calls.length, 4);
  assert.equal(model.queue.length, 0, "every scripted answer was used");
});

test("seam: a /confirm whose answer is lost on the way back is retried with the same confirmId and written once", async () => {
  const { session, state } = newSession({ careerStage: "veteran" });
  model.queue.push(useTool("findClient", { query: "chen" }), (p) => useTool("logContactTool", { clientId: toolResult(p).data.matches[0].id }, "toolu_2"));
  await session.submit("log a contact for the Chens");
  const pending = state().pending;
  assert.equal(pending.sideEffect.type, "logContact");
  db.prepare("UPDATE clients SET last_contact = ? WHERE id = ?").run(STALE, chen);

  net.dropNextConfirmResponse = true;   // the server writes, the browser never hears
  assert.deepEqual(await session.submit("yes"), { ok: true, action: "confirm" });
  assert.notEqual(lastContactInDb(), STALE, "the first request did write");
  assert.equal(state().turns.at(-1).kind, "notice");
  assert.equal(state().turns.at(-1).content, "I couldn't finish that just now. Say yes to try again, or cancel.");
  assert.equal(state().pending, pending, "the read-back is kept");
  assert.equal(state().busy, false);

  db.prepare("UPDATE clients SET last_contact = ? WHERE id = ?").run(SENTINEL, chen);
  assert.deepEqual(await session.submit("yes"), { ok: true, action: "confirm" });
  assert.equal(state().turns.at(-1).content, "Done — I logged a contact for Robert & Linda Chen.");
  assert.equal(state().pending, null);
  assert.equal(lastContactInDb(), SENTINEL, "the retry wrote nothing");
  assert.equal(net.confirms.length, 2);
  assert.equal(net.confirms[1].sent.sideEffect.confirmId, net.confirms[0].sent.sideEffect.confirmId, "the same confirmId");
  assert.equal(net.confirms[1].got.duplicate, true);
});
