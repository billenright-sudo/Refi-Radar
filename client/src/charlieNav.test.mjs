import { test } from "node:test";
import assert from "node:assert/strict";
import { onScreenOf, pageAllowed, panelAfter, viewForScreen, prepareScreenFor } from "./charlieNav.mjs";

test("onScreenOf maps the open view", () => {
  assert.deepEqual(onScreenOf({ view: "client-detail", selectedId: 7 }), { page: "client", clientId: 7 });
  assert.equal(onScreenOf({ view: "client-detail", selectedId: null }), null);
  assert.deepEqual(onScreenOf({ view: "add" }), { page: "form" });
  assert.deepEqual(onScreenOf({ view: "edit", selectedId: 3 }), { page: "form" });
  assert.deepEqual(onScreenOf({ view: "import", importHasFile: true }), { page: "form" });
  assert.deepEqual(onScreenOf({ view: "import", importHasFile: false }), { page: "import" });
  // (final review M4, R15) one loan officer's portal is no page Charlie knows: "take me to My Team" from it opens the team list
  assert.equal(onScreenOf({ view: "lo-portal" }), null);
  for (const p of ["home", "sweeps", "clients", "rates", "team", "profile", "billing"]) {
    assert.deepEqual(onScreenOf({ view: p }), { page: p });
  }
  assert.equal(onScreenOf({ view: "nope" }), null);
});

test("onScreenOf (final review): a client page reports its id only when it is a positive integer", () => {
  for (const selectedId of ["7", 7.5, 0, -3, Number.NaN, Infinity, undefined, {}, 7n]) {
    assert.equal(onScreenOf({ view: "client-detail", selectedId }), null, String(selectedId));
  }
});

// ── prepareScreenFor: what the App does when Charlie's turn hands it a screen ───────────────────────────────────────────────────

const HELEN = { id: 7, name: "Helen Brandt" };
// The App as prepareScreenFor sees it, recording each call in `events`.
function appOf({ view = "home", clients = [HELEN], fresh = [HELEN], role = "broker", billingOn = false, isPhone = false, reload } = {}) {
  const events = [];
  const app = {
    view,
    screenNow: () => { events.push("screenNow"); return onScreenOf({ view: app.view, selectedId: null }); },
    clients,
    reloadClients: reload || (async () => { events.push("reload"); return fresh; }),
    role, billingOn,
    isPhone: () => isPhone,
    setSelected: (c) => events.push(["setSelected", c]),
    setView: (v) => events.push(["setView", v]),
    setPanelOpen: (open) => events.push(["setPanelOpen", open]),
    scrollTo: (x, y) => events.push(["scrollTo", x, y]),
  };
  return { app, events };
}

test("prepareScreenFor: a client in the list opens; go() shows her page, then scrolls to the top (final review I3, R12)", async () => {
  const { app, events } = appOf();
  const ready = await prepareScreenFor({ page: "client", clientId: 7 }, app);
  assert.equal(ready.ok, true);
  assert.equal(typeof ready.go, "function");
  assert.equal(events.includes("reload"), false, "no reload: she is in the list");
  events.length = 0;
  ready.go();
  assert.deepEqual(events, [["setSelected", HELEN], ["setView", "client-detail"], ["setPanelOpen", true], ["scrollTo", 0, 0]]);
});

test("prepareScreenFor: a page opens and scrolls to the top; Home and a phone close her panel", async () => {
  for (const [screen, isPhone, open] of [[{ page: "rates" }, false, true], [{ page: "home" }, false, false], [{ page: "rates" }, true, false]]) {
    const { app, events } = appOf({ view: "sweeps", isPhone });
    const ready = await prepareScreenFor(screen, app);
    events.length = 0;
    ready.go();
    assert.deepEqual(events, [["setView", screen.page], ["setPanelOpen", open], ["scrollTo", 0, 0]], JSON.stringify([screen, isPhone]));
  }
});

test("prepareScreenFor: a client not in the list is looked for once more; not found, or the reload fails, is missing", async () => {
  let { app, events } = appOf({ clients: [], fresh: [HELEN] });
  const ready = await prepareScreenFor({ page: "client", clientId: 7 }, app);
  assert.equal(ready.ok, true);
  assert.equal(events.filter((e) => e === "reload").length, 1);
  ({ app } = appOf({ clients: [], fresh: [] }));
  assert.deepEqual(await prepareScreenFor({ page: "client", clientId: 7 }, app), { ok: false, reason: "missing" });
  ({ app } = appOf({ clients: [], fresh: null }));
  assert.deepEqual(await prepareScreenFor({ page: "client", clientId: 7 }, app), { ok: false, reason: "missing" });
  ({ app } = appOf({ clients: [], reload: async () => { throw new Error("offline"); } }));
  assert.deepEqual(await prepareScreenFor({ page: "client", clientId: 7 }, app), { ok: false, reason: "missing" });
  assert.deepEqual(await prepareScreenFor(null, appOf().app), { ok: false, reason: "missing" });
});

test("prepareScreenFor: a form open keeps the page; a page not in the sidebar is not allowed", async () => {
  for (const view of ["add", "edit"]) {
    const { app } = appOf({ view });
    assert.deepEqual(await prepareScreenFor({ page: "client", clientId: 7 }, app), { ok: false, reason: "form" }, view);
    assert.deepEqual(await prepareScreenFor({ page: "rates" }, app), { ok: false, reason: "form" }, view);
  }
  assert.deepEqual(await prepareScreenFor({ page: "team" }, appOf({ role: "lo" }).app), { ok: false, reason: "not-allowed" });
  assert.deepEqual(await prepareScreenFor({ page: "billing" }, appOf({ billingOn: false }).app), { ok: false, reason: "not-allowed" });
  assert.equal((await prepareScreenFor({ page: "billing" }, appOf({ billingOn: true }).app)).ok, true);
});

test("prepareScreenFor (final review I4, A2): a form opened while the client list is re-read keeps the page", async () => {
  const { app, events } = appOf({ clients: [] });
  app.reloadClients = async () => {
    events.push("reload");
    app.view = "add";   // the broker clicks Add Client by hand while the list comes back
    return [HELEN];
  };
  const ready = await prepareScreenFor({ page: "client", clientId: 7 }, app);
  assert.deepEqual(ready, { ok: false, reason: "form" });
  assert.deepEqual(events, ["screenNow", "reload", "screenNow"], "the form is checked again after the reload, last");
});

test("pageAllowed follows the sidebar", () => {
  assert.equal(pageAllowed("team", "lo", false), false);
  assert.equal(pageAllowed("billing", "broker", false), false);
  assert.equal(pageAllowed("billing", "broker", true), true);
  assert.equal(pageAllowed("rates", "lo", false), true);
  assert.equal(pageAllowed("client", "broker", true), false);
});

test("panelAfter", () => {
  assert.equal(panelAfter({ target: "client-detail", isPhone: true }), "close");
  assert.equal(panelAfter({ target: "rates", isPhone: false }), "open");
  assert.equal(panelAfter({ target: "home", isPhone: false }), "close");
});

test("viewForScreen", () => {
  assert.equal(viewForScreen({ page: "client", clientId: 4 }), "client-detail");
  assert.equal(viewForScreen({ page: "rates" }), "rates");
});
