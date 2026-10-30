import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEW, navGroups, navItems } from "./nav.mjs";

const ids = (items) => items.map((i) => i.id);

test("the app lands on Home, which is Charlie", () => {
  assert.equal(DEFAULT_VIEW, "home");
});

test("a loan officer's nav starts with Home, has no Charlie tab, and ends with Profile", () => {
  const items = navItems("lo");
  assert.equal(items[0].id, "home");
  assert.equal(items[0].label, "Home");
  assert.ok(!ids(items).includes("charli"));
  assert.ok(!items.some((i) => /charli/i.test(i.id) || /charli/i.test(i.label)));
  assert.deepEqual(items[items.length - 1], { id: "profile", label: "Profile", icon: "user" });
});

test("the loan officer's items are in this order, with the old Dashboard now called Overview", () => {
  assert.deepEqual(
    navItems("lo").map(({ id, label }) => [id, label]),
    [
      ["home", "Home"],
      ["sweeps", "Sweeps"],
      ["clients", "All Clients"],
      ["rates", "Rate Watch"],
      ["overview", "Overview"],
      ["add", "Add Client"],
      ["profile", "Profile"],
    ]
  );
  assert.ok(!ids(navItems("lo")).includes("dashboard"));
});

test("a broker also gets My Team and Import Clients, before Profile", () => {
  const items = navItems("broker");
  const list = ids(items);
  assert.ok(list.includes("team"));
  assert.ok(list.includes("import"));
  assert.ok(list.indexOf("team") > list.indexOf("add"));
  assert.equal(list[list.length - 1], "profile");
  assert.equal(items.find((i) => i.id === "team").label, "My Team");
  assert.equal(items.find((i) => i.id === "import").label, "Import Clients");
});

test("a loan officer, or nobody yet, gets no team or import", () => {
  for (const role of ["lo", undefined, null, ""]) {
    const list = ids(navItems(role));
    assert.ok(!list.includes("team"), String(role));
    assert.ok(!list.includes("import"), String(role));
  }
});

test("every item has an id, a label and an icon, and no id is used twice", () => {
  for (const role of ["lo", "broker"]) {
    const items = navItems(role);
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ["icon", "id", "label"]);
      assert.ok(item.id && item.label && item.icon);
    }
    assert.equal(new Set(ids(items)).size, items.length);
  }
});

test("the sidebar's groups are the same items, in the same order", () => {
  for (const role of ["lo", "broker"]) {
    const { main, broker, bottom } = navGroups(role);
    assert.deepEqual([...main, ...broker, ...bottom], navItems(role));
    assert.deepEqual(ids(bottom), ["profile"]);
    assert.equal(broker.length > 0, role === "broker");
  }
});

test("the default view is one the nav can open", () => {
  assert.ok(ids(navItems("lo")).includes(DEFAULT_VIEW));
});

test("the lists are fresh copies: changing one does not change the next", () => {
  const first = navItems("broker");
  first.pop();
  first[0].label = "Changed";
  assert.equal(navItems("broker")[0].label, "Home");
  assert.equal(navItems("broker").at(-1).id, "profile");
});
