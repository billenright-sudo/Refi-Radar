"use strict";
// The navigation module (server/lib/assistant/navigation.js): which sentences are "open a page" requests, the
// code-written lines about a screen, and the cleaning of the browser's `onScreen`. Pure, so no fakes beyond a
// namesClient predicate.
const test = require("node:test");
const assert = require("node:assert");

const {
  SCREEN_PAGES, BROKER_PAGES, FORM_OPEN, BROKER_ONLY, BILLING_OFF, COULDNT_OPEN,
  cleanOnScreen, screenLine, alreadyLine, isAlreadyOn, isNavigationRequest, claimsScreenOpened, targetsScreen,
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

test("claimsScreenOpened (Task 3 fix 1): a page opened, never the noun \"opening\" or the market's \"opened\"", () => {
  for (const t of [
    "Here you go.", "Opening her page now.", "Opening it now.", "I'm opening Helen Brandt's page.", "Opening Helen Brandt now.",
    "I opened Rate Watch for you.", "Brought up the Chens for you.", "Pulling her up now.", "It's on the screen now.",
    "Opening the client list.", "I’ve opened her page.",
  ]) assert.ok(claimsScreenOpened(t), t);
  for (const t of [
    "Your only opening is Friday at 2.", "Rates opened lower today.", "Opening balance is 5", "There's an opening Friday at 2.",
    "You have one opening: Friday at 2.", "Your next opening is Thursday at 10.", "Rates opened the week a touch higher.",
    "Calendar's open after 2 today.", "Want me to open her page?",
  ]) assert.ok(!claimsScreenOpened(t), t);
});

// (fix 2) a client-name test that knows the names these pins use
const knownNames = (s) => /helen|brandt|chen|smith/i.test(s);

test("claimsScreenOpened (Task 3 fix 2): the noun \"opening\" and the market's \"opened\" are never a claim", () => {
  for (const t of [
    "Your only opening this week is Friday at 2.", "There is an opening this afternoon at 3.", "The only opening I see is Friday at 2.",
    "Your first opening Nov 13 is at 9.", "Rates opened this morning a touch lower.", "Rates opened the week near record lows.",
    "Mortgage rates opened the day in better form.", "Rates opened MBS trading higher.",
    "Your next opening that day is at 4.", "The only opening I have on your calendar is Thursday at 10.", "You have an opening Thu at 10.",
    "Rates opened the year at a record low.", "Rates opened Wednesday lower.", "The market opened this week lower.",
    "Opening rates are 6.5 percent.", "Your calendar has one opening: this afternoon.",
    "Friday's open after 2, and that's your only opening that day.",
  ]) assert.ok(!claimsScreenOpened(t, knownNames), t);
});

test("claimsScreenOpened (Task 3 fix 2): a question is never a claim; a statement beside one still is", () => {
  for (const t of [
    "Which Chen should I bring up, Robert and Linda or Chen Wei?", "Want me to bring her up?", "Want me to take you to Rate Watch?",
    "Which page should I take you to?", "Should I pull up her page?",
  ]) assert.ok(!claimsScreenOpened(t, knownNames), t);
  assert.ok(claimsScreenOpened("Pulling up Helen now. Want her rate too?", knownNames));
});

test("claimsScreenOpened (Task 3 fix 2): opening up, a page that is open, and let me pull up are claims", () => {
  for (const t of [
    "Opening up her page now.", "I have opened up Rate Watch.", "Opening the Chens now.", "Helen Brandt's page is open.",
    "Let me pull up her page.", "Let me pull that up.", "Opening this up for you.", "I'm opening that now.", "Opening Sweeps for you.",
    "Opening your profile.",
  ]) assert.ok(claimsScreenOpened(t, knownNames), t);
});

test("claimsScreenOpened (Task 3 fix 1, 2): a reply that is only the app's own line, imitated, is a claim", () => {
  for (const t of [
    "Here's Helen Brandt.", "You're already on Rate Watch.", "  Here's Robert & Linda Chen. ", "Here’s Helen Brandt",
    "You're already on Helen Brandt's page.", "Here's Dr. Smith.", "Here's Helen Brandt's page.",
  ]) assert.ok(claimsScreenOpened(t, knownNames), t);
  // every line the app writes: each page's needs no names, a client's needs the client's name to be one
  for (const page of SCREEN_PAGES) {
    assert.ok(claimsScreenOpened(screenLine({ page })), page);
    assert.ok(claimsScreenOpened(alreadyLine({ page })), page);
  }
  assert.ok(claimsScreenOpened(screenLine({ page: "client", clientId: 7 }, "Robert & Linda Chen"), knownNames));
  assert.ok(claimsScreenOpened(alreadyLine({ page: "client", clientId: 7 }, "Robert & Linda Chen"), knownNames));
  // what follows is no page label and no client's name, or there is more than the line
  assert.ok(!claimsScreenOpened("Here's Helen Brandt."), "no name test: no client is known");
  for (const t of [
    "Here are your top opportunities.", "Here's Helen's rate: 6.5 percent.", "Here's who to call: Helen Brandt and the Chens.",
    "Here's 3 to call today.", "Here's Helen Brandt. Want her rate?",
    "Here's the thing about refinancing when rates move this fast for your whole book.", "Helen Brandt is here.",
    "Here's Helen Brandt, your top opportunity.", "Here's who is worth a call today.", "Here's the latest.", "Here's what I've got.",
    "You're already on it.", "Here's your best bet: Helen Brandt.", "Here's Helen Brandt?",
  ]) assert.ok(!claimsScreenOpened(t, knownNames), t);
});

test("targetsScreen (Task 3 fix 2): a request that names a page, a client, or a page / file / screen", () => {
  for (const t of [
    "pull up Helen Brandt", "take me to Rate Watch", "go home", "open Sweeps", "show me my clients", "go to my team", "open billing",
    "open Import Clients", "go to my profile", "open Add Client", "pull up her page", "bring up the Chen file", "put it on my screen",
    "go to the client list",
  ]) assert.ok(targetsScreen(t, knownNames), t);
  for (const t of ["pull up today's rates", "pull up my top opportunities", "pull up the latest numbers", "pull up the important ones", ""]) {
    assert.ok(!targetsScreen(t, knownNames), t);
  }
  assert.ok(!targetsScreen("pull up Helen Brandt"), "with no name test, a name alone is no screen");
  assert.ok(!targetsScreen(undefined));
});
