"use strict";
// The navigation module (server/lib/assistant/navigation.js): which sentences are "open a page" requests, the
// code-written lines about a screen, and the cleaning of the browser's `onScreen`. Pure, so no fakes beyond a
// namesClient predicate.
const test = require("node:test");
const assert = require("node:assert");

const {
  SCREEN_PAGES, BROKER_PAGES, FORM_OPEN, BROKER_ONLY, BILLING_OFF, COULDNT_OPEN,
  cleanOnScreen, screenLine, alreadyLine, isAlreadyOn, isNavigationRequest, claimsScreenOpened,
} = require("../lib/assistant/navigation");

const namesClient = (s) => /helen|brandt/i.test(s);

const YES = ["pull up Helen Brandt", "Charlie, bring up the Brandts", "open Helen Brandt", "go to Helen's page",
  "take me to Rate Watch", "open Sweeps", "go home", "show me my clients", "go to my team", "can you pull up Helen",
  "please open rate watch", "look up Helen Brandt", "show me Helen Brandt", "take me home", "switch to sweeps",
  "Hey Charlie, could you jump to billing?", "show me the home page please", "look up Helen's page"];
const NO = ["show me who's at their target", "show me today's rates", "what's Helen's target?", "log a call with Helen",
  "open the email", "open it in Gmail", "look up the Cowboys score", "look up Helen's balance", "who should I call?",
  "what are rates today", "show me Helen's target", "show me what Helen owes", "pull up", "open the draft"];

test("constants", () => {
  assert.deepStrictEqual([...SCREEN_PAGES], ["home", "sweeps", "clients", "rates", "add", "team", "import", "profile", "billing"]);
  assert.ok(Object.isFrozen(SCREEN_PAGES));
  assert.deepStrictEqual([...BROKER_PAGES].sort(), ["billing", "import", "team"]);
  assert.strictEqual(FORM_OPEN, "You've got a form open. Save or cancel it first, then ask me again.");
  assert.strictEqual(BROKER_ONLY, "That page is for your broker's account.");
  assert.strictEqual(BILLING_OFF, "Billing isn't turned on for your account yet.");
  assert.strictEqual(COULDNT_OPEN, "I couldn't open that page.");
});

test("isNavigationRequest: page requests", () => {
  for (const t of YES) assert.ok(isNavigationRequest(t, namesClient), t);
});

test("isNavigationRequest: not page requests", () => {
  for (const t of NO) assert.ok(!isNavigationRequest(t, namesClient), t);
});

test("isNavigationRequest: without a namesClient only strong verbs and page names count", () => {
  assert.ok(isNavigationRequest("pull up Helen Brandt"));
  assert.ok(isNavigationRequest("show me my clients"));
  assert.ok(!isNavigationRequest("show me Helen Brandt"));
  assert.ok(!isNavigationRequest("look up Helen Brandt"));
  assert.ok(!isNavigationRequest(undefined));
});

test("cleanOnScreen", () => {
  assert.deepStrictEqual(cleanOnScreen({ page: "client", clientId: 7 }), { page: "client", clientId: 7 });
  assert.deepStrictEqual(cleanOnScreen({ page: "rates", clientId: 7 }), { page: "rates" });
  assert.deepStrictEqual(cleanOnScreen({ page: "form" }), { page: "form" });
  for (const bad of [null, "rates", { page: "admin" }, { page: "client" }, { page: "client", clientId: 0 },
    { page: "client", clientId: "7" }, { page: "add" }, undefined, [], { page: "client", clientId: 1.5 }])
    assert.strictEqual(cleanOnScreen(bad), null);
});

test("screenLine, alreadyLine, isAlreadyOn", () => {
  assert.strictEqual(screenLine({ page: "client", clientId: 7 }, "Helen  Brandt"), "Here's Helen Brandt.");
  assert.strictEqual(screenLine({ page: "clients" }), "Here's your client list.");
  assert.strictEqual(alreadyLine({ page: "rates" }), "You're already on Rate Watch.");
  assert.strictEqual(alreadyLine({ page: "client", clientId: 7 }, "Helen Brandt"), "You're already on Helen Brandt's page.");
  assert.strictEqual(isAlreadyOn({ page: "client", clientId: 7 }, { page: "client", clientId: 7 }), true);
  assert.strictEqual(isAlreadyOn({ page: "client", clientId: 7 }, { page: "client", clientId: 8 }), false);
  assert.strictEqual(isAlreadyOn({ page: "rates" }, { page: "rates" }), true);
  assert.strictEqual(isAlreadyOn({ page: "rates" }, null), false);
});

test("screenLine: the fixed line for every page id", () => {
  const lines = {
    home: "Here's Home.", sweeps: "Here's Sweeps.", clients: "Here's your client list.", rates: "Here's Rate Watch.",
    add: "Here's the Add Client form.", team: "Here's your team.", import: "Here's Import Clients.",
    profile: "Here's your profile.", billing: "Here's Billing.",
  };
  for (const page of SCREEN_PAGES) {
    assert.strictEqual(screenLine({ page }), lines[page], page);
    assert.strictEqual(alreadyLine({ page }), lines[page].replace("Here's ", "You're already on "), page);
  }
});

test("claimsScreenOpened", () => {
  for (const t of ["Pulling up Helen now.", "I've opened her page.", "Taking you to Rate Watch.", "It's on your screen.", "There you go."])
    assert.ok(claimsScreenOpened(t), t);
  for (const t of ["Which Chen — Robert and Linda, or Chen Wei?", "I don't see a Zed in your book.", "Here are your top opportunities."])
    assert.ok(!claimsScreenOpened(t), t);
  assert.ok(!claimsScreenOpened(undefined));
});
