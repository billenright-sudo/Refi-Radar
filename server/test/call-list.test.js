"use strict";
// Morning call list selection (lib/assistant/callList.js): a pure function over a runSweep result. Fixtures are
// hand-written sweep-shaped rows ({ clientId, name, best, opportunities, checkIn }), as runSweep returns them (name order,
// not ranked), plus one test against the real runSweep to pin the shape.
const test = require("node:test");
const assert = require("node:assert");

const { pickCallList } = require("../lib/assistant/callList");
const refi = require("../lib/refi");

// ── fixtures ─────────────────────────────────────────────────────────────────

const NO_CHECK_IN = { due: false, monthsSince: 2, basis: "last_contact" };
const DUE = (monthsSince = 15) => ({ due: true, monthsSince, basis: "last_contact" });

const rateTerm = (priority, monthlySavings) => ({
  lens: "rate_term", priority, monthlySavings, headline: monthlySavings, unit: "$/mo", rateDelta: 0.75, breakEven: 20, effRate: 6.25,
});
const cashOut = (priority, cashAvailable) => ({
  lens: "cash_out", priority, cashAvailable, headline: cashAvailable, unit: "$", currentLtv: 55.2,
});
const armToFixed = (priority, monthlySavings, effRate = 6.38) => ({
  lens: "arm_to_fixed", priority, monthlySavings, effRate, headline: monthlySavings, unit: "$/mo",
});
const termSwap = (priority, extra) => ({ lens: "term_swap", priority, headline: 5.25, unit: "%", ...extra });

const row = (clientId, name, best = null, checkIn = NO_CHECK_IN) => ({
  clientId, name, best, opportunities: best ? [best] : [], checkIn,
});

// Same shape runSweep returns: both lists in name order, never ranked.
function sweepOf(rows) {
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const opportunities = sorted.filter((r) => r.best);
  const checkIns = sorted.filter((r) => r.checkIn.due);
  return { opportunities, checkIns, byLens: {}, counts: { total: rows.length, withOpportunity: opportunities.length, checkInsDue: checkIns.length }, ranAt: "2026-10-30T12:00:00.000Z" };
}

const idsOf = (list) => list.map((c) => c.clientId);
const FIGURE_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|hundred|thousand|million)\b/i;

// ── order ────────────────────────────────────────────────────────────────────

test("order: carried first, then alternating cash-out and rate-term by cross-client rank, then check-ins only", () => {
  const sweep = sweepOf([
    row(1, "Carla Carried", rateTerm("low", 90)),
    row(2, "Alan Cash", cashOut("high", 210000)),
    row(3, "Bea Cash", cashOut("medium", 95000)),
    row(4, "Cy Rate", rateTerm("high", 620)),
    row(5, "Di Rate", rateTerm("medium", 310)),
    row(6, "Ed Checkin", null, DUE(9)),
    row(7, "Flo Checkin", null, DUE(20)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4, 5, 6, 7], carriedIds: [1], excludeIds: [], limit: 10 });
  // Cross-client rank: high before medium, then the bigger impact. Cash-out (210,000) outranks rate-term (620) in the
  // shared ranking, so it leads the alternation; the longest-overdue check-in goes first.
  assert.deepStrictEqual(idsOf(list), [1, 2, 4, 3, 5, 7, 6]);
  assert.deepStrictEqual(list.map((c) => c.reasonCode), ["carry", "cash_out", "rate_term", "cash_out", "rate_term", "check_in", "check_in"]);
});

test("order: a rate-term client that outranks every cash-out client leads the alternation", () => {
  const sweep = sweepOf([
    row(1, "Alan Cash", cashOut("medium", 120000)),
    row(2, "Bea Rate", rateTerm("high", 400)),
    row(3, "Cy Rate", rateTerm("medium", 300)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [2, 1, 3]);
});

test("order: within a kind, priority comes first and then impact, as trimSweep ranks them", () => {
  const sweep = sweepOf([
    row(1, "Ann Rate", rateTerm("medium", 900)),
    row(2, "Bob Rate", rateTerm("high", 150)),
    row(3, "Cat Rate", rateTerm("high", 450)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [3, 2, 1]);
});

test("order: equal rank keeps the sweep's name order", () => {
  const sweep = sweepOf([
    row(1, "Zed Rate", rateTerm("high", 400)),
    row(2, "Abe Rate", rateTerm("high", 400)),
    row(3, "Moe Rate", rateTerm("high", 400)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [2, 3, 1]);
});

test("alternation: three cash-out clients ranked above two rate-term clients give cash-out, rate-term, cash-out", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Cash", cashOut("high", 250000)),
    row(3, "Cat Cash", cashOut("high", 200000)),
    row(4, "Dee Rate", rateTerm("medium", 500)),
    row(5, "Eve Rate", rateTerm("medium", 400)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4, 5], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(list.map((c) => c.reasonCode), ["cash_out", "rate_term", "cash_out"]);
  assert.deepStrictEqual(idsOf(list), [1, 4, 2]);
});

test("alternation: when one kind runs out the other fills the list", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Rate", rateTerm("high", 400)),
    row(3, "Cat Rate", rateTerm("medium", 300)),
    row(4, "Dee Rate", rateTerm("medium", 200)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4], carriedIds: [], excludeIds: [], limit: 4 });
  assert.deepStrictEqual(idsOf(list), [1, 2, 3, 4]);
});

test("a carried client takes a slot, and the alternation then fills the rest", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Cash", cashOut("high", 250000)),
    row(3, "Cat Rate", rateTerm("high", 500)),
    row(4, "Dee Carried", rateTerm("low", 60)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4], carriedIds: [4], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [4, 1, 3]);
  assert.strictEqual(list[0].reasonCode, "carry");
});

test("a carried client is listed once, in the order it was carried", () => {
  const sweep = sweepOf([
    row(1, "Ann Rate", rateTerm("high", 500)),
    row(2, "Bob Rate", rateTerm("high", 400)),
    row(3, "Cat Rate", rateTerm("high", 300)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [3, 1, 3], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [3, 1, 2]);
  assert.deepStrictEqual(list.map((c) => c.reasonCode), ["carry", "carry", "rate_term"]);
});

test("arm-to-fixed clients count with the refi-savings kind and term swaps follow the alternation", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Arm", armToFixed("high", 480)),
    row(3, "Cat Swap", termSwap("medium", { newRate: 5.25, paymentChange: 120 })),
    row(4, "Dee Check", null, DUE(11)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4], carriedIds: [], excludeIds: [], limit: 4 });
  assert.deepStrictEqual(list.map((c) => c.reasonCode), ["cash_out", "arm_to_fixed", "term_swap", "check_in"]);
});

// ── who can appear ───────────────────────────────────────────────────────────

test("excludeIds and clients outside ownClientIds never appear", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Rate", rateTerm("high", 400)),
    row(3, "Cat Rate", rateTerm("high", 350)),
    row(4, "Dee Cash", cashOut("medium", 100000)),
    row(5, "Eve Check", null, DUE(14)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 4, 5], carriedIds: [], excludeIds: [2], limit: 10 });
  assert.deepStrictEqual(idsOf(list).sort(), [1, 4, 5]);
  assert.ok(!idsOf(list).includes(2), "excluded");
  assert.ok(!idsOf(list).includes(3), "not the broker's own client");
});

test("a client in both carriedIds and excludeIds is excluded (the caller removes carried ids from excludeIds)", () => {
  const sweep = sweepOf([
    row(1, "Ann Carried", rateTerm("high", 400)),
    row(2, "Bob Rate", rateTerm("medium", 300)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [1], excludeIds: [1] });
  assert.deepStrictEqual(idsOf(list), [2]);
  assert.strictEqual(list[0].reasonCode, "rate_term");
});

test("a carried client outside ownClientIds never appears", () => {
  const sweep = sweepOf([
    row(1, "Ann Other", rateTerm("high", 400)),
    row(2, "Bob Own", rateTerm("medium", 300)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [2], carriedIds: [1], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [2]);
});

test("a carried client that has neither an opportunity nor a due check-in has nothing to say, so it is left off", () => {
  const sweep = sweepOf([row(2, "Bob Rate", rateTerm("high", 400))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [1], excludeIds: [] });
  assert.deepStrictEqual(idsOf(list), [2]);
});

test("ids compare by value whether they arrive as numbers or strings, and ownClientIds may be a Set", () => {
  const sweep = sweepOf([
    row(1, "Ann Rate", rateTerm("high", 400)),
    row(2, "Bob Rate", rateTerm("high", 300)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: new Set(["1", "2"]), carriedIds: ["2"], excludeIds: ["1"] });
  assert.deepStrictEqual(idsOf(list), [2]);
});

test("with no ownClientIds nobody is in scope", () => {
  const sweep = sweepOf([row(1, "Ann Rate", rateTerm("high", 400))]);
  assert.deepStrictEqual(pickCallList({ sweep, carriedIds: [1] }), []);
  assert.deepStrictEqual(pickCallList({ sweep, ownClientIds: [] }), []);
});

// ── fewer than the limit ─────────────────────────────────────────────────────

test("fewer candidates than the limit returns fewer without throwing", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Check", null, DUE(8)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [], limit: 1 }).length, 1);
});

test("an empty, missing or malformed sweep returns an empty list", () => {
  const args = { ownClientIds: [1], carriedIds: [1], excludeIds: [] };
  assert.deepStrictEqual(pickCallList({ ...args, sweep: sweepOf([]) }), []);
  assert.deepStrictEqual(pickCallList({ ...args, sweep: {} }), []);
  assert.deepStrictEqual(pickCallList({ ...args, sweep: null }), []);
  assert.deepStrictEqual(pickCallList({ ...args }), []);
  assert.deepStrictEqual(pickCallList({}), []);
});

test("the limit defaults to three and a zero limit returns nothing", () => {
  const sweep = sweepOf([1, 2, 3, 4, 5].map((n) => row(n, `Client ${"ABCDE"[n - 1]}`, rateTerm("high", 100 + n))));
  const own = [1, 2, 3, 4, 5];
  assert.strictEqual(pickCallList({ sweep, ownClientIds: own }).length, 3);
  assert.strictEqual(pickCallList({ sweep, ownClientIds: own, limit: 5 }).length, 5);
  assert.deepStrictEqual(pickCallList({ sweep, ownClientIds: own, limit: 0 }), []);
});

// ── reasons ──────────────────────────────────────────────────────────────────

test("a cash-out reason rounds to the nearest 1,000, says about, and names the client", () => {
  const sweep = sweepOf([row(1, "Owen Prescott", cashOut("high", 174312))]);
  const [item] = pickCallList({ sweep, ownClientIds: [1], carriedIds: [], excludeIds: [] });
  assert.strictEqual(item.clientId, 1);
  assert.strictEqual(item.name, "Owen Prescott");
  assert.strictEqual(item.reasonCode, "cash_out");
  assert.ok(item.reason.includes("$174,000"), item.reason);
  assert.ok(item.reason.includes("about $174,000"), item.reason);
  assert.ok(item.reason.includes("Owen Prescott"), item.reason);
  assert.ok(!item.reason.includes("174,312"), "the unrounded figure is not said");
});

test("cash-out rounding goes up at the halfway point and groups thousands with commas", () => {
  const sweep = sweepOf([row(1, "Big Equity", cashOut("high", 1234567)), row(2, "Edge Case", cashOut("medium", 49500))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  assert.ok(list.find((c) => c.clientId === 1).reason.includes("$1,235,000"));
  assert.ok(list.find((c) => c.clientId === 2).reason.includes("$50,000"));
});

test("a rate-term reason carries the monthly saving in whole dollars and says a month", () => {
  const sweep = sweepOf([row(1, "Lucy Tran", rateTerm("high", 573.6))]);
  const [item] = pickCallList({ sweep, ownClientIds: [1], carriedIds: [], excludeIds: [] });
  assert.strictEqual(item.reasonCode, "rate_term");
  assert.ok(item.reason.includes("Lucy Tran"), item.reason);
  assert.ok(item.reason.includes("$574"), item.reason);
  assert.ok(item.reason.includes("a month"), item.reason);
  assert.ok(item.reason.includes("about $574"), item.reason);
});

test("a due check-in is appended to an opportunity reason as digits", () => {
  const sweep = sweepOf([row(1, "Lucy Tran", rateTerm("high", 574), DUE(15))]);
  const [item] = pickCallList({ sweep, ownClientIds: [1], carriedIds: [], excludeIds: [] });
  assert.strictEqual(item.reasonCode, "rate_term");
  assert.ok(item.reason.includes("$574"), item.reason);
  assert.ok(item.reason.includes("15 months since your last check-in"), item.reason);
});

test("a check-in that is not due adds no clause", () => {
  const sweep = sweepOf([row(1, "Lucy Tran", rateTerm("high", 574), { due: false, monthsSince: 4, basis: "last_contact" })]);
  const [item] = pickCallList({ sweep, ownClientIds: [1], carriedIds: [], excludeIds: [] });
  assert.ok(!/check-in/.test(item.reason), item.reason);
  assert.ok(!/months/.test(item.reason), item.reason);
});

test("a check-in-only reason names the client and the months since", () => {
  const sweep = sweepOf([row(1, "Sam Hill", null, DUE(9)), row(2, "Tia Moss", null, DUE(1))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  const sam = list.find((c) => c.clientId === 1);
  const tia = list.find((c) => c.clientId === 2);
  assert.strictEqual(sam.reasonCode, "check_in");
  assert.ok(sam.reason.includes("Sam Hill") && sam.reason.includes("9 months since your last check-in"), sam.reason);
  assert.ok(tia.reason.includes("1 month since your last check-in"), tia.reason);
});

test("a carry reason names the client and keeps its figure", () => {
  const sweep = sweepOf([
    row(1, "Owen Prescott", cashOut("high", 174312)),
    row(2, "Sam Hill", null, DUE(9)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [1, 2], excludeIds: [] });
  assert.deepStrictEqual(list.map((c) => c.reasonCode), ["carry", "carry"]);
  assert.ok(list[0].reason.includes("Owen Prescott") && list[0].reason.includes("$174,000"), list[0].reason);
  assert.ok(list[1].reason.includes("Sam Hill") && list[1].reason.includes("9 months"), list[1].reason);
});

test("arm-to-fixed and term-swap reasons carry their sweep figures", () => {
  const sweep = sweepOf([
    row(1, "Ann Arm", armToFixed("high", 480.4, 6.38)),
    row(2, "Bob Arm", armToFixed("medium", 0, 6.5)),
    row(3, "Cat Swap", termSwap("medium", { newRate: 5.25, paymentChange: 1234 })),
    row(4, "Dee Swap", termSwap("low", { paymentChange: -310 })),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4], carriedIds: [], excludeIds: [], limit: 4 });
  const byId = Object.fromEntries(list.map((c) => [c.clientId, c]));
  assert.ok(byId[1].reason.includes("Ann Arm") && byId[1].reason.includes("$480") && byId[1].reason.includes("6.38"), byId[1].reason);
  assert.ok(byId[2].reason.includes("Bob Arm") && byId[2].reason.includes("6.5"), byId[2].reason);
  assert.ok(!byId[2].reason.includes("$0"), "no zero saving is claimed");
  assert.ok(byId[3].reason.includes("Cat Swap") && byId[3].reason.includes("5.25") && byId[3].reason.includes("$1,234"), byId[3].reason);
  assert.ok(byId[4].reason.includes("Dee Swap") && byId[4].reason.includes("$310"), byId[4].reason);
  assert.deepStrictEqual(list.map((c) => c.reasonCode).sort(), ["arm_to_fixed", "arm_to_fixed", "term_swap", "term_swap"]);
});

test("an opportunity with no usable figure falls back to its check-in, or is left off", () => {
  const sweep = sweepOf([
    row(1, "Ann NoFigure", rateTerm("high", undefined), DUE(12)),
    row(2, "Bob NoFigure", cashOut("high", 0)),
    row(3, "Cat Good", rateTerm("medium", 300)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(list.map((c) => [c.clientId, c.reasonCode]), [[3, "rate_term"], [1, "check_in"]]);
  for (const c of list) assert.ok(!/undefined|NaN|null/.test(c.reason), c.reason);
});

test("every reason is figures as digits: no figure words and no question mark", () => {
  const sweep = sweepOf([
    row(1, "Owen Prescott", cashOut("high", 174312), DUE(15)),
    row(2, "Lucy Tran", rateTerm("high", 574), DUE(13)),
    row(3, "Ann Arm", armToFixed("high", 480, 6.38)),
    row(4, "Bob Arm", armToFixed("medium", 0, 6.5)),
    row(5, "Cat Swap", termSwap("medium", { newRate: 5.25, paymentChange: 120 })),
    row(6, "Dee Swap", termSwap("low", { paymentChange: -310 })),
    row(7, "Eve Swap", termSwap("medium", { newRate: 5.5, paymentChange: 0 })),
    row(8, "Sam Hill", null, DUE(9)),
    row(9, "Tia Moss", null, DUE(1)),
  ]);
  const own = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const list = [
    ...pickCallList({ sweep, ownClientIds: own, carriedIds: [], excludeIds: [], limit: 20 }),
    ...pickCallList({ sweep, ownClientIds: own, carriedIds: own, excludeIds: [], limit: 20 }),
  ];
  assert.strictEqual(list.length, 18);
  for (const c of list) {
    assert.ok(!FIGURE_WORDS.test(c.reason), `figure word in: ${c.reason}`);
    assert.ok(!c.reason.includes("?"), `question mark in: ${c.reason}`);
    assert.ok(c.reason.includes(c.name), `name missing in: ${c.reason}`);
    assert.ok(/\d/.test(c.reason), `no figure in: ${c.reason}`);
    assert.ok(!/@/.test(c.reason), "no email");
  }
});

test("each item has exactly clientId, name, reasonCode and reason", () => {
  const sweep = sweepOf([row(1, "Lucy Tran", rateTerm("high", 574))]);
  const [item] = pickCallList({ sweep, ownClientIds: [1], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(Object.keys(item).sort(), ["clientId", "name", "reason", "reasonCode"]);
});

test("the input sweep is not mutated", () => {
  const sweep = sweepOf([
    row(1, "Ann Cash", cashOut("high", 300000)),
    row(2, "Bob Rate", rateTerm("high", 400)),
    row(3, "Cat Check", null, DUE(7)),
  ]);
  const before = JSON.stringify(sweep);
  pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [3], excludeIds: [] });
  assert.strictEqual(JSON.stringify(sweep), before);
});

// ── carried clients the broker asked for (R7) ────────────────────────────────

const NAMES = new Map([[1, "Lucy Tran"], [2, "Bob Rate"], [9, "Zoe Elsewhere"]]);

test("a carried client with no sweep row is listed first when its name is in clientNames", () => {
  const sweep = sweepOf([row(2, "Bob Rate", rateTerm("high", 400)), row(3, "Cat Rate", rateTerm("medium", 300))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3], carriedIds: [1], excludeIds: [], clientNames: NAMES });
  assert.deepStrictEqual(idsOf(list), [1, 2, 3]);
  assert.strictEqual(list[0].reasonCode, "carry");
  assert.strictEqual(list[0].name, "Lucy Tran");
  assert.strictEqual(list[0].reason, "Lucy Tran, who you asked me to put on today's list");
  assert.ok(!/\d/.test(list[0].reason), "no figure is made up");
  assert.ok(!FIGURE_WORDS.test(list[0].reason) && !list[0].reason.includes("?"), list[0].reason);
});

test("the same carried client is dropped without clientNames, or when its id is not in clientNames", () => {
  const sweep = sweepOf([row(2, "Bob Rate", rateTerm("high", 400))]);
  const args = { sweep, ownClientIds: [1, 2], carriedIds: [1], excludeIds: [] };
  assert.deepStrictEqual(idsOf(pickCallList(args)), [2]);
  assert.deepStrictEqual(idsOf(pickCallList({ ...args, clientNames: new Map() })), [2]);
  assert.deepStrictEqual(idsOf(pickCallList({ ...args, clientNames: new Map([[7, "Someone Else"]]) })), [2]);
  assert.deepStrictEqual(idsOf(pickCallList({ ...args, clientNames: new Map([[1, "   "]]) })), [2], "a blank name says nothing");
});

test("a carried client whose sweep row has nothing usable is also listed from clientNames", () => {
  const sweep = sweepOf([row(1, "Lucy Tran", rateTerm("high", undefined))]);
  const list = pickCallList({ sweep, ownClientIds: [1], carriedIds: [1], excludeIds: [], clientNames: NAMES });
  assert.deepStrictEqual(list.map((c) => [c.clientId, c.reasonCode, c.reason]), [[1, "carry", "Lucy Tran, who you asked me to put on today's list"]]);
});

test("clientNames never widens scope: not-own and excluded carried clients still do not appear", () => {
  const sweep = sweepOf([row(2, "Bob Rate", rateTerm("high", 400))]);
  const names = new Map([[1, "Lucy Tran"], [3, "Cat Rate"]]);
  const list = pickCallList({ sweep, ownClientIds: [2, 3], carriedIds: [1, 3], excludeIds: [3], clientNames: names });
  assert.deepStrictEqual(idsOf(list), [2], "1 is not the broker's own, 3 is excluded");
});

test("a carried client with a usable sweep row keeps its figure; clientNames is only a fallback", () => {
  const sweep = sweepOf([row(2, "Bob Rate", rateTerm("high", 400))]);
  const [item] = pickCallList({ sweep, ownClientIds: [2], carriedIds: [2], excludeIds: [], clientNames: NAMES });
  assert.ok(item.reason.includes("$400"), item.reason);
});

test("clientNames ids compare by value, and the id returned is the map's own key", () => {
  const list = pickCallList({ sweep: sweepOf([]), ownClientIds: ["1"], carriedIds: ["1"], excludeIds: [], clientNames: NAMES });
  assert.deepStrictEqual(idsOf(list), [1]);
  assert.strictEqual(list[0].name, "Lucy Tran");
});

test("four carried clients with a limit of three give exactly the first three, in the order given", () => {
  const sweep = sweepOf([
    row(1, "Ann Rate", rateTerm("high", 500)),
    row(2, "Bob Rate", rateTerm("high", 400)),
    row(3, "Cat Rate", rateTerm("high", 300)),
    row(4, "Dee Rate", rateTerm("high", 200)),
    row(5, "Eve Cash", cashOut("high", 900000)),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4, 5], carriedIds: [4, 2, 3, 1], excludeIds: [], limit: 3 });
  assert.deepStrictEqual(idsOf(list), [4, 2, 3]);
  assert.deepStrictEqual(list.map((c) => c.reasonCode), ["carry", "carry", "carry"]);
});

test("name-only carried clients take their place in the carried order and count against the limit", () => {
  const sweep = sweepOf([row(2, "Bob Rate", rateTerm("high", 400)), row(3, "Cat Rate", rateTerm("high", 300))]);
  const names = new Map([[1, "Lucy Tran"], [4, "Dee Nameonly"]]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2, 3, 4], carriedIds: [4, 2, 1, 3], excludeIds: [], limit: 3, clientNames: names });
  assert.deepStrictEqual(idsOf(list), [4, 2, 1]);
});

// ── what the check-in is counted from (R8) ───────────────────────────────────

const DUE_BY = (basis, monthsSince) => ({ due: true, monthsSince, basis });

test("check-in basis last_contact: months since your last check-in", () => {
  const sweep = sweepOf([row(1, "Sam Hill", null, DUE_BY("last_contact", 9)), row(2, "Lucy Tran", rateTerm("high", 574), DUE_BY("last_contact", 1))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  assert.strictEqual(list.find((c) => c.clientId === 1).reason, "Sam Hill, 9 months since your last check-in");
  assert.strictEqual(list.find((c) => c.clientId === 2).reason, "Lucy Tran could save about $574 a month, 1 month since your last check-in");
});

test("check-in basis close_date: months since closing", () => {
  const sweep = sweepOf([row(1, "Sam Hill", null, DUE_BY("close_date", 14)), row(2, "Lucy Tran", rateTerm("high", 574), DUE_BY("close_date", 1))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  const sam = list.find((c) => c.clientId === 1).reason;
  const lucy = list.find((c) => c.clientId === 2).reason;
  assert.strictEqual(sam, "Sam Hill, 14 months since closing");
  assert.strictEqual(lucy, "Lucy Tran could save about $574 a month, 1 month since closing");
  assert.ok(!/check-in/.test(sam + lucy), "no claim of a check-in that was never logged");
});

test("check-in basis created_at: months since you added them", () => {
  const sweep = sweepOf([row(1, "Sam Hill", null, DUE_BY("created_at", 8)), row(2, "Lucy Tran", rateTerm("high", 574), DUE_BY("created_at", 1))]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  const sam = list.find((c) => c.clientId === 1).reason;
  const lucy = list.find((c) => c.clientId === 2).reason;
  assert.strictEqual(sam, "Sam Hill, 8 months since you added them");
  assert.strictEqual(lucy, "Lucy Tran could save about $574 a month, 1 month since you added them");
  assert.ok(!/check-in/.test(sam + lucy), "no claim of a check-in that was never logged");
});

test("a due check-in with no known basis says nothing about it, rather than guess what it counts from", () => {
  const sweep = sweepOf([
    row(1, "Sam Hill", null, { due: true, monthsSince: 9, basis: null }),
    row(2, "Lucy Tran", rateTerm("high", 574), { due: true, monthsSince: 9 }),
  ]);
  const list = pickCallList({ sweep, ownClientIds: [1, 2], carriedIds: [], excludeIds: [] });
  assert.deepStrictEqual(list.map((c) => [c.clientId, c.reason]), [[2, "Lucy Tran could save about $574 a month"]]);
});

test("the carry reason uses the basis too", () => {
  const sweep = sweepOf([row(1, "Sam Hill", null, DUE_BY("close_date", 14))]);
  const [item] = pickCallList({ sweep, ownClientIds: [1], carriedIds: [1], excludeIds: [] });
  assert.strictEqual(item.reason, "Sam Hill, who you put on today's list, 14 months since closing");
});

// ── the real sweep ───────────────────────────────────────────────────────────

test("a real runSweep check-in carries the basis the engine reported", () => {
  const rates = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461 };
  const now = new Date("2026-10-30T12:00:00Z");
  const base = { loan_type: "30yr_fixed", current_rate: 6.4, loan_balance: 380000, property_value: 520000, credit_score: 760 };
  const sweep = refi.runSweep([
    { ...base, id: 21, name: "Last Contact", last_contact: "2025-06-01" },
    { ...base, id: 22, name: "Close Date", close_date: "2025-06-01" },
    { ...base, id: 23, name: "Created At", created_at: "2025-06-01" },
  ], rates, now);
  const list = pickCallList({ sweep, ownClientIds: [21, 22, 23], carriedIds: [], excludeIds: [], limit: 10 });
  const said = (id) => list.find((c) => c.clientId === id).reason;
  assert.ok(said(21).includes("since your last check-in"), said(21));
  assert.ok(said(22).includes("since closing"), said(22));
  assert.ok(said(23).includes("since you added them"), said(23));
});

test("works on a real runSweep result", () => {
  const rates = { rate_30yr_fixed: 6.52, rate_15yr_fixed: 5.91, rate_5_1_arm: 5.81, rate_30yr_top_tier: 6.461, date: "2026-10-21", source: "Optimal Blue lock data (2026-10-21)" };
  const now = new Date("2026-10-30T12:00:00Z");
  const clients = [
    { id: 11, name: "Rita Rate", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760, last_contact: "2026-09-01" },
    { id: 12, name: "Cal Cash", loan_type: "30yr_fixed", current_rate: 6.4, loan_balance: 200000, property_value: 600000, credit_score: 760, last_contact: "2026-09-01" },
    { id: 13, name: "Old Friend", loan_type: "30yr_fixed", current_rate: 6.4, loan_balance: 380000, property_value: 520000, credit_score: 760, last_contact: "2025-06-01" },
    { id: 14, name: "Not Mine", loan_type: "30yr_fixed", current_rate: 7.85, loan_balance: 485000, property_value: 650000, credit_score: 760, last_contact: "2026-09-01" },
  ];
  const sweep = refi.runSweep(clients, rates, now);
  const list = pickCallList({ sweep, ownClientIds: [11, 12, 13], carriedIds: [], excludeIds: [] });
  assert.ok(list.length >= 2, JSON.stringify(list));
  assert.ok(!idsOf(list).includes(14));
  for (const c of list) {
    assert.ok(["carry", "rate_term", "cash_out", "arm_to_fixed", "term_swap", "check_in"].includes(c.reasonCode));
    assert.ok(c.reason.includes(c.name) && /\d/.test(c.reason), c.reason);
    assert.ok(!FIGURE_WORDS.test(c.reason) && !c.reason.includes("?"), c.reason);
  }
  const rita = list.find((c) => c.clientId === 11);
  assert.ok(rita, "the rate-term client is on the list");
  const sweepRita = sweep.opportunities.find((r) => r.clientId === 11);
  assert.ok(rita.reason.includes(`$${sweepRita.best.monthlySavings.toLocaleString("en-US")}`), rita.reason);
});
