"use strict";
// The built client's static files (lib/clientStatic.js, mounted by index.js): the service worker and the manifest are never cached, so a
// new version reaches phones at once. A throwaway folder stands in for the build. No network beyond the local test server.
const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { clientStatic } = require("../lib/clientStatic");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-client-static-"));
let server, base;
before(async () => {
  fs.writeFileSync(path.join(dir, "sw.js"), "// sample worker");
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}");
  fs.writeFileSync(path.join(dir, "icon.svg"), "<svg/>");
  const app = express();
  app.use(clientStatic(dir));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

test("/sw.js and /manifest.webmanifest are served with Cache-Control: no-cache", async () => {
  for (const p of ["/sw.js", "/manifest.webmanifest"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get("cache-control"), "no-cache", p);
  }
});

test("other files keep the static defaults", async () => {
  const res = await fetch(base + "/icon.svg");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0");
});
