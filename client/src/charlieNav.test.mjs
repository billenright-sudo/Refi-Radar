import { test } from "node:test";
import assert from "node:assert/strict";
import { onScreenOf, pageAllowed, panelAfter, viewForScreen } from "./charlieNav.mjs";

test("onScreenOf maps the open view", () => {
  assert.deepEqual(onScreenOf({ view: "client-detail", selectedId: 7 }), { page: "client", clientId: 7 });
  assert.equal(onScreenOf({ view: "client-detail", selectedId: null }), null);
  assert.deepEqual(onScreenOf({ view: "add" }), { page: "form" });
  assert.deepEqual(onScreenOf({ view: "edit", selectedId: 3 }), { page: "form" });
  assert.deepEqual(onScreenOf({ view: "import", importHasFile: true }), { page: "form" });
  assert.deepEqual(onScreenOf({ view: "import", importHasFile: false }), { page: "import" });
  assert.deepEqual(onScreenOf({ view: "lo-portal" }), { page: "team" });
  for (const p of ["home", "sweeps", "clients", "rates", "team", "profile", "billing"]) {
    assert.deepEqual(onScreenOf({ view: p }), { page: p });
  }
  assert.equal(onScreenOf({ view: "nope" }), null);
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
