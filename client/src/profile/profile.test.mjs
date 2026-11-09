// node --test src/profile/
// The Profile page's logic talks to the server only through an injected fetch, so every flow here runs with no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validName, cleanName, validEmail, loadProfile, saveName, requestEmailChange, saveStage, saveNmls, emailChangedNotice,
  loadConnection, connectLos, disconnectLos, utcTextToDate,
  BAD_NAME, TOO_MANY, profileMissing, stillNeededLine, profilePrompt, nextProfilePrompt, PROFILE_WELCOME,
  profileCheckDue, profileLanding,
} from "./profile.mjs";

const reply = (status, body) => ({ status, body });
const PROFILE = {
  firstName: "Ann", lastName: "Lee", email: "ann@a.co", pendingEmail: null, careerStage: "developing",
  nmlsId: "123456", orgNmlsId: null, canEditOrg: false,
};

// A fake server like the one in ../charli/session.test.mjs. `routes` maps "METHOD /url" to a function (body) -> reply(...)
// (or a throw = network failure). Anything unrouted answers 404 and shows up in server.unexpected. A reply body of the string
// "not json" makes res.json() throw, like an HTML error page would.
function fakeServer(routes) {
  const calls = [];
  const unexpected = [];
  const fetch = async (url, init = {}) => {
    const call = { method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
    calls.push(call);
    const handler = routes[`${call.method} ${url}`];
    if (!handler) { unexpected.push(call); return { ok: false, status: 404, json: async () => ({ error: "no route" }) }; }
    const { status, body } = await handler(call.body, call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => { if (body === "not json") throw new SyntaxError("Unexpected token"); return body; },
    };
  };
  return { fetch, calls, unexpected };
}

// ── names: the same accept / reject table as server/test/profile-api.test.js ──

test("validName accepts letters, spaces, apostrophes and hyphens (trimmed), and a last name may be empty", () => {
  for (const [first, last] of [
    ["Mary-Jane", "O'Brien-Smith"], ["  Mary-Jane ", " O'Brien-Smith  "], ["José", ""], ["Ann Marie", "van der Berg"],
    ["A".repeat(50), "B".repeat(50)], ["Ann", "  "],
    // a curly apostrophe (iOS smart punctuation) is read as a plain one
    ["D’Angelo", "O’Brien"], ["Mary‘Jane", "  ’Neil-O’Hara "], ["O’".repeat(25), ""],
  ]) {
    assert.equal(validName(first, last), null, JSON.stringify([first, last]));
  }
});

test("validName rejects everything else with the server's message", () => {
  assert.equal(BAD_NAME, "Use letters only in your name");
  for (const [first, last] of [
    ["", "Reed"], ["   ", "Reed"], ["A".repeat(51), "Reed"], ["Owen", "R".repeat(51)], ["Owen2", "Reed"], ["Owen", "Re3d"],
    ["<b>Owen</b>", "Reed"], ["Owen", "Reed; DROP TABLE users"], ["Owen.", "Reed"], ["Owen", "Reed\nJr"], ["-", "Reed"], ["'", "Reed"],
    [5, "Reed"], [null, "Reed"], [["Owen"], "Reed"], ["Owen", 7], ["Owen", null], ["Owen"], [undefined, "Reed"], [],
    // a curly mark alone is still not a name, and the 50-character limit counts the plain form
    ["’", ""], ["‘’", "Reed"], ["A", "’"], ["O’".repeat(26), ""],
  ]) {
    assert.equal(validName(first, last), BAD_NAME, JSON.stringify([first, last]));
  }
});

test("cleanName gives the form the server stores: trimmed, with a plain apostrophe", () => {
  assert.equal(cleanName("  D’Angelo "), "D'Angelo");
  assert.equal(cleanName("‘Neil’"), "'Neil'");
  assert.equal(cleanName("Mary-Jane"), "Mary-Jane");
  assert.equal(cleanName(null), "");
  assert.equal(cleanName(5), "");
});

// ── email: mirrors the server's EMAIL_RE and 254 limit ──

test("validEmail accepts a basic x@y.z (trimmed, any case)", () => {
  for (const mail of ["ann@a.co", " FAYE@p.co ", "first.last+tag@sub.example.com", "o'brien@example.org", "a@b.c"]) {
    assert.equal(validEmail(mail), true, mail);
  }
  assert.equal(validEmail(`${"a".repeat(64)}@${"b".repeat(60)}.com`), true);
});

test("validEmail rejects malformed addresses and anything nodemailer would read as another or an extra recipient", () => {
  for (const mail of [
    "", "   ", "nope", "a@b", "a b@c.co", "@c.co", "a@.co", "a@@c.co", "a@b.c o", "a@b..co", 5, null, ["a@b.co"], undefined, {},
    "<x@y.co>", "Name<x@y.co>", "Name <x@y.co>", '"a"@y.co', "a;b@y.co", "a,b@c.co", "x@y.co,z@y.co", "x@y.co;z@y.co",
    "a(b)@c.co", "a:b@c.co", "a\\b@c.co", "x@[1.2.3.4]", "x@y.co>", "x@y.c,o", "a\tb@c.co", "a\nb@c.co", "a[b]@c.co",
    `${"a".repeat(250)}@b.co`,
  ]) {
    assert.equal(validEmail(mail), false, JSON.stringify(mail));
  }
});

// ── the API wrappers ──

test("loadProfile: GET /api/profile -> { ok, data }", async () => {
  const server = fakeServer({ "GET /api/profile": () => reply(200, PROFILE) });
  assert.deepEqual(await loadProfile(server.fetch), { ok: true, data: PROFILE });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["GET", "/api/profile", undefined]]);
});

test("loadProfile: a failure is { ok: false, error } and never throws", async () => {
  const cases = [
    [() => reply(401, { success: false, error: "Not authenticated" }), "Your session has ended. Sign in again."],
    [() => reply(500, { success: false, error: "Database error" }), "Couldn't load your profile. Try again."],
    [() => reply(200, { success: true }), "Couldn't load your profile. Try again."],        // not a profile
    [() => reply(200, "not json"), "Couldn't load your profile. Try again."],
    [() => reply(200, null), "Couldn't load your profile. Try again."],
    [() => { throw new Error("offline"); }, "Couldn't reach the server. Check your connection and try again."],
  ];
  for (const [handler, error] of cases) {
    const server = fakeServer({ "GET /api/profile": handler });
    assert.deepEqual(await loadProfile(server.fetch), { ok: false, error });
  }
});

test("saveName: PUT /api/profile/name with both names; the answer is the profile", async () => {
  const saved = { ...PROFILE, firstName: "Mary-Jane", lastName: "" };
  const server = fakeServer({ "PUT /api/profile/name": () => reply(200, saved) });
  assert.deepEqual(await saveName(server.fetch, "Mary-Jane", ""), { ok: true, data: saved });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["PUT", "/api/profile/name", { firstName: "Mary-Jane", lastName: "" }]]);
  assert.equal(server.calls[0].headers["Content-Type"], "application/json");
});

test("saveName: the server's 400 message comes back as the error", async () => {
  const server = fakeServer({ "PUT /api/profile/name": () => reply(400, { success: false, error: "Use letters only in your name" }) });
  assert.deepEqual(await saveName(server.fetch, "Owen2", "Reed"), { ok: false, error: "Use letters only in your name" });
});

test("saveStage: PUT /api/profile/career-stage { stage }", async () => {
  const saved = { ...PROFILE, careerStage: "veteran" };
  const server = fakeServer({ "PUT /api/profile/career-stage": () => reply(200, saved) });
  assert.deepEqual(await saveStage(server.fetch, "veteran"), { ok: true, data: saved });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["PUT", "/api/profile/career-stage", { stage: "veteran" }]]);
});

test("saveStage: a 400 comes back with the server's message", async () => {
  const server = fakeServer({ "PUT /api/profile/career-stage": () => reply(400, { success: false, error: "A valid career stage is required" }) });
  assert.deepEqual(await saveStage(server.fetch, "expert"), { ok: false, error: "A valid career stage is required" });
});

test("requestEmailChange: POST /api/profile/email { email } -> { pendingEmail }", async () => {
  const server = fakeServer({ "POST /api/profile/email": () => reply(200, { pendingEmail: "new@example.com" }) });
  assert.deepEqual(await requestEmailChange(server.fetch, "new@example.com"), { ok: true, data: { pendingEmail: "new@example.com" } });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["POST", "/api/profile/email", { email: "new@example.com" }]]);
});

test("requestEmailChange: 400, 409 and 503 come back with the server's message", async () => {
  for (const [status, error] of [
    [400, "Enter a valid email address"], [400, "That is already your email address"],
    [409, "That email is already in use"], [503, "Email isn't set up yet"],
  ]) {
    const server = fakeServer({ "POST /api/profile/email": () => reply(status, { success: false, error }) });
    assert.deepEqual(await requestEmailChange(server.fetch, "x@y.co"), { ok: false, error }, `${status} ${error}`);
  }
});

test("requestEmailChange: a 429 uses the server's message, or a plain one when it sends none", async () => {
  assert.equal(TOO_MANY, "Too many tries. Please wait a bit and try again.");
  const serverMessage = "Too many email-change requests — please try again in an hour";
  let server = fakeServer({ "POST /api/profile/email": () => reply(429, { success: false, error: serverMessage }) });
  assert.deepEqual(await requestEmailChange(server.fetch, "x@y.co"), { ok: false, error: serverMessage });
  for (const body of [{}, { error: "" }, { error: "   " }, { error: 5 }, null, "not json"]) {
    server = fakeServer({ "POST /api/profile/email": () => reply(429, body) });
    assert.deepEqual(await requestEmailChange(server.fetch, "x@y.co"), { ok: false, error: TOO_MANY }, JSON.stringify(body));
  }
});

test("requestEmailChange: a server error is not shown raw, and a 200 without a pendingEmail is a failure", async () => {
  let server = fakeServer({ "POST /api/profile/email": () => reply(500, { success: false, error: "Database error" }) });
  assert.deepEqual(await requestEmailChange(server.fetch, "x@y.co"), { ok: false, error: "That didn't go through. Try again." });
  server = fakeServer({ "POST /api/profile/email": () => reply(200, { success: true }) });
  assert.deepEqual(await requestEmailChange(server.fetch, "x@y.co"), { ok: false, error: "That didn't go through. Try again." });
  server = fakeServer({ "POST /api/profile/email": () => { throw new Error("offline"); } });
  assert.deepEqual(await requestEmailChange(server.fetch, "x@y.co"), { ok: false, error: "Couldn't reach the server. Check your connection and try again." });
});

test("saveNmls: the caller's own ID goes to /nmls and the company's to /org-nmls, trimmed; the answer is the NMLS triple", async () => {
  const triple = { nmlsId: "123456", orgNmlsId: "654321", canEditOrg: true };
  const server = fakeServer({ "PUT /api/profile/nmls": () => reply(200, triple), "PUT /api/profile/org-nmls": () => reply(200, triple) });
  assert.deepEqual(await saveNmls(server.fetch, "own", " 123456 "), { ok: true, data: triple });
  assert.deepEqual(await saveNmls(server.fetch, "org", "654321"), { ok: true, data: triple });
  assert.deepEqual(await saveNmls(server.fetch, "own", ""), { ok: true, data: triple });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [
    ["PUT", "/api/profile/nmls", { nmlsId: "123456" }],
    ["PUT", "/api/profile/org-nmls", { nmlsId: "654321" }],
    ["PUT", "/api/profile/nmls", { nmlsId: "" }],
  ]);
});

test("saveNmls: a 400 comes back with the server's message, and an unknown field name is refused without a call", async () => {
  const server = fakeServer({ "PUT /api/profile/nmls": () => reply(400, { success: false, error: "An NMLS ID is digits only" }) });
  assert.deepEqual(await saveNmls(server.fetch, "own", "12 34"), { ok: false, error: "An NMLS ID is digits only" });
  assert.deepEqual(await saveNmls(server.fetch, "team", "1"), { ok: false, error: "That didn't save. Try again." });
  assert.equal(server.calls.length, 1);
  const wrongShape = fakeServer({ "PUT /api/profile/nmls": () => reply(200, { success: true }) });
  assert.deepEqual(await saveNmls(wrongShape.fetch, "own", "1"), { ok: false, error: "That didn't save. Try again." });
});

// ── the ARIVE connection (server/routes/integrations.js) ──

const KEY_URL = "/api/integrations/key";
const WEBHOOK = "https://app.example.com/api/integrations/loans";
const NEW_KEY = `br_${"ab12".repeat(16)}`;

test("loadConnection reads the key status", async () => {
  const status = { success: true, connected: true, createdAt: "2026-11-01 14:05:09", lastUsedAt: null, webhookUrl: WEBHOOK, los: "lendingpad" };
  const server = fakeServer({ [`GET ${KEY_URL}`]: () => reply(200, status) });
  assert.deepEqual(await loadConnection(server.fetch), { ok: true, data: status });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["GET", KEY_URL, undefined]]);
  // not connected is an answer too
  const none = { success: true, connected: false, createdAt: null, lastUsedAt: null, webhookUrl: WEBHOOK, los: null };
  const quiet = fakeServer({ [`GET ${KEY_URL}`]: () => reply(200, none) });
  assert.deepEqual(await loadConnection(quiet.fetch), { ok: true, data: none });
});

test("connectLos asks for a key for the LOS and returns the new key once", async () => {
  const made = { success: true, key: NEW_KEY, webhookUrl: WEBHOOK, createdAt: "2026-11-01 14:06:00", los: "lendingpad" };
  const server = fakeServer({ [`POST ${KEY_URL}`]: () => reply(200, made) });
  const res = await connectLos(server.fetch, "lendingpad");
  assert.deepEqual(res, { ok: true, data: made });
  assert.equal(res.data.key, NEW_KEY);
  assert.equal(res.data.webhookUrl, WEBHOOK);
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["POST", KEY_URL, { los: "lendingpad" }]]);
});

test("disconnectLos deletes the key", async () => {
  const server = fakeServer({ [`DELETE ${KEY_URL}`]: () => reply(200, { success: true, connected: false }) });
  assert.deepEqual(await disconnectLos(server.fetch), { ok: true, data: { success: true, connected: false } });
  assert.deepEqual(server.calls.map((c) => [c.method, c.url, c.body]), [["DELETE", KEY_URL, undefined]]);
});

test("connection calls map a 401 to the session-ended message and a network throw to the no-server message", async () => {
  const calls = [
    ["GET", loadConnection], ["POST", connectLos], ["DELETE", disconnectLos],
  ];
  for (const [method, call] of calls) {
    const signedOut = fakeServer({ [`${method} ${KEY_URL}`]: () => reply(401, { success: false, error: "Not authenticated" }) });
    assert.deepEqual(await call(signedOut.fetch, "arive"), { ok: false, error: "Your session has ended. Sign in again." }, method);
    const offline = fakeServer({ [`${method} ${KEY_URL}`]: () => { throw new Error("offline"); } });
    assert.deepEqual(await call(offline.fetch, "arive"), { ok: false, error: "Couldn't reach the server. Check your connection and try again." }, method);
  }
});

test("connection calls show a plain line for a server error or an answer of the wrong shape, never the raw one", async () => {
  const calls = [
    ["GET", loadConnection, "Couldn't check your connection. Try again."],
    ["POST", connectLos, "Couldn't make a key. Try again."],
    ["DELETE", disconnectLos, "Couldn't disconnect. Try again."],
  ];
  for (const [method, call, error] of calls) {
    for (const handler of [
      () => reply(500, { success: false, error: "Database error" }),
      () => reply(200, { success: true }),            // no key / no connected flag
      () => reply(200, "not json"),
      () => reply(200, null),
    ]) {
      const server = fakeServer({ [`${method} ${KEY_URL}`]: handler });
      assert.deepEqual(await call(server.fetch, "arive"), { ok: false, error }, method);
    }
  }
  // a key is only worth showing with the address to send it to
  const noUrl = fakeServer({ [`POST ${KEY_URL}`]: () => reply(200, { success: true, key: NEW_KEY }) });
  assert.equal((await connectLos(noUrl.fetch, "arive")).ok, false);
});

test("utcTextToDate reads the SQLite UTC text as UTC; anything else is null", () => {
  assert.equal(utcTextToDate("2026-11-01 14:05:09").toISOString(), "2026-11-01T14:05:09.000Z");
  assert.equal(utcTextToDate("2026-11-01T14:05:09.250Z").toISOString(), "2026-11-01T14:05:09.250Z");   // an ISO stamp is the same instant
  for (const bad of [null, undefined, "", "   ", "yesterday", "2026-13-45 99:99:99", 5, {}]) {
    assert.equal(utcTextToDate(bad), null, JSON.stringify(bad));
  }
});

// ── the notice for the emailed confirm link ──

test("emailChangedNotice: ?emailChanged=1 is the success line and =0 the failure line; anything else is nothing", () => {
  assert.deepEqual(emailChangedNotice("?emailChanged=1"), { text: "Your email address is updated.", bad: false });
  assert.deepEqual(emailChangedNotice("?emailChanged=0"), {
    text: "That link didn't work. If you already confirmed it, sign in with your new address.", bad: true,
  });
  assert.deepEqual(emailChangedNotice("?a=1&emailChanged=1&b=2"), { text: "Your email address is updated.", bad: false });
  for (const search of ["", "?", "?emailChanged=", "?emailChanged=2", "?emailChanged=true", "?emailchanged=1", "?google=connected", null, undefined, 1]) {
    assert.equal(emailChangedNotice(search), null, JSON.stringify(search));
  }
});

// ── Round 2, items 1 and 2: profile first ──
// What counts as a complete profile: the career stage and the user's own NMLS ID for everyone, and the company's NMLS ID for a
// broker too. Google Calendar and ARIVE are optional. The missing items come back in this order, worded as the banner says them.
const STAGE = "how long you've been originating";
const OWN = "your NMLS ID";
const COMPANY = "your company's NMLS ID";
const COMPLETE = { ...PROFILE, careerStage: "veteran", nmlsId: "123456", orgNmlsId: "654321" };

test("profileMissing: nothing for a complete profile; each missing item, in order; the company's ID only for a broker", () => {
  assert.deepEqual(profileMissing(COMPLETE, "broker"), []);
  assert.deepEqual(profileMissing(COMPLETE, "lo"), []);
  assert.deepEqual(profileMissing({ ...COMPLETE, orgNmlsId: null }, "lo"), [], "a loan officer never needs the company's ID");
  assert.deepEqual(profileMissing({ ...COMPLETE, orgNmlsId: null }, "broker"), [COMPANY]);
  assert.deepEqual(profileMissing({ ...COMPLETE, careerStage: null }, "lo"), [STAGE]);
  assert.deepEqual(profileMissing({ ...COMPLETE, nmlsId: null }, "lo"), [OWN]);
  assert.deepEqual(profileMissing({ ...COMPLETE, careerStage: null, nmlsId: null, orgNmlsId: null }, "broker"), [STAGE, OWN, COMPANY]);
  assert.deepEqual(profileMissing({ ...COMPLETE, careerStage: null, nmlsId: null, orgNmlsId: null }, "lo"), [STAGE, OWN]);
  // blank text is not set; an unknown role is held to the loan officer's list
  assert.deepEqual(profileMissing({ ...COMPLETE, careerStage: "", nmlsId: "  ", orgNmlsId: "" }, "broker"), [STAGE, OWN, COMPANY]);
  assert.deepEqual(profileMissing({ ...COMPLETE, orgNmlsId: null }, undefined), []);
  // the shape GET /api/profile answers with, with nothing set yet (careerStage, nmlsId and orgNmlsId are null)
  assert.deepEqual(profileMissing({ ...PROFILE, careerStage: null, nmlsId: null, orgNmlsId: null, canEditOrg: true }, "broker"), [STAGE, OWN, COMPANY]);
  // anything that is not a profile is treated as nothing set
  assert.deepEqual(profileMissing(null, "broker"), [STAGE, OWN, COMPANY]);
});

test("stillNeededLine and the welcome line: the banner's words", () => {
  assert.equal(PROFILE_WELCOME, "Welcome to Broker Radar — finish your profile so Charlie can coach you and sign your emails.");
  assert.equal(stillNeededLine([STAGE, OWN, COMPANY]), "Still needed: how long you've been originating · your NMLS ID · your company's NMLS ID.");
  assert.equal(stillNeededLine([OWN]), "Still needed: your NMLS ID.");
});

test("profilePrompt: the landing's read -> the missing items to prompt for, or null (a failed read lands on Home, as today)", () => {
  assert.deepEqual(profilePrompt({ ok: true, data: { ...COMPLETE, nmlsId: null } }, "lo"), [OWN]);
  assert.equal(profilePrompt({ ok: true, data: COMPLETE }, "broker"), null);
  assert.equal(profilePrompt({ ok: false, error: "Couldn't load your profile. Try again." }, "broker"), null);
  assert.equal(profilePrompt(null, "broker"), null);
});

test("nextProfilePrompt: follows what the Profile page reports; gone for good once the profile is complete; never starts one", () => {
  const prompt = [STAGE, OWN, COMPANY];
  assert.deepEqual(nextProfilePrompt(prompt, { ...COMPLETE, nmlsId: null, orgNmlsId: null }, "broker"), [OWN, COMPANY]);
  assert.deepEqual(nextProfilePrompt([OWN, COMPANY], { ...COMPLETE, orgNmlsId: null }, "broker"), [COMPANY]);
  assert.equal(nextProfilePrompt([COMPANY], COMPLETE, "broker"), null, "complete: the banner goes");
  assert.equal(nextProfilePrompt(null, { ...COMPLETE, nmlsId: null }, "broker"), null, "no banner showing (or skipped): none appears");
});

// Fix pass (Ruling 36, item 7): the landing decision as one pure helper. After a sign-in, on boot, and when the terms gate opens
// (item 3), App reads the profile only when the check is due, and lands on Profile only when that read finds something missing.
test("profileCheckDue: only with the gate open, and never for the user who chose Skip for now this page visit", () => {
  assert.equal(profileCheckDue({ gateOpen: true, userId: 7, skippedBy: null }), true);
  assert.equal(profileCheckDue({ gateOpen: true, userId: 7, skippedBy: 8 }), true, "another user's skip is not this user's");
  assert.equal(profileCheckDue({ gateOpen: true, userId: 7, skippedBy: 7 }), false, "this user skipped");
  assert.equal(profileCheckDue({ gateOpen: false, userId: 7, skippedBy: null }), false, "a gate page is showing");
  assert.equal(profileCheckDue({ gateOpen: true, userId: null, skippedBy: null }), true, "an unknown user is still asked");
  assert.equal(profileCheckDue({ gateOpen: "yes", userId: 7, skippedBy: null }), false, "only a true opens it");
  assert.equal(profileCheckDue({}), false);
});

test("profileLanding: Profile with the missing items when the check is due and the read finds any; else the landing stays", () => {
  const read = (data) => ({ ok: true, data });
  const incomplete = read({ ...COMPLETE, nmlsId: null, orgNmlsId: null });
  const open = { gateOpen: true, userId: 7, skippedBy: null };
  assert.deepEqual(profileLanding({ ...open, res: incomplete, role: "broker" }), { view: "profile", ask: [OWN, COMPANY] });
  assert.deepEqual(profileLanding({ ...open, res: incomplete, role: "lo" }), { view: "profile", ask: [OWN] });
  const stays = { view: null, ask: null };
  assert.deepEqual(profileLanding({ ...open, res: read(COMPLETE), role: "broker" }), stays, "complete");
  assert.deepEqual(profileLanding({ ...open, res: { ok: false, error: "Couldn't load your profile. Try again." }, role: "broker" }), stays, "a failed read lands on Home, as today");
  assert.deepEqual(profileLanding({ ...open, res: null, role: "broker" }), stays, "not read");
  assert.deepEqual(profileLanding({ ...open, skippedBy: 7, res: incomplete, role: "broker" }), stays, "skipped by this user");
  assert.deepEqual(profileLanding({ ...open, gateOpen: false, res: incomplete, role: "broker" }), stays, "the gate is in the way");
});
