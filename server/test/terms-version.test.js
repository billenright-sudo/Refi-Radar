"use strict";
// The Terms and Privacy Policy the client shows must carry the same version dates the server records acceptance of
// (spec §6.6). Reads the client files as text, so the server suite needs nothing from the client build.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { TERMS_VERSION, PRIVACY_VERSION } = require("../lib/terms");

const LEGAL_DIR = path.join(__dirname, "..", "..", "client", "src", "legal");

function clientVersion(file) {
  const text = fs.readFileSync(path.join(LEGAL_DIR, file), "utf8");
  const m = text.match(/export\s+const\s+VERSION\s*=\s*["']([^"']+)["']/);
  assert.ok(m, `${file} has no exported VERSION`);
  return m[1];
}

test("the client's Terms of Service version equals TERMS_VERSION", () => {
  assert.strictEqual(clientVersion("terms.mjs"), TERMS_VERSION);
});

test("the client's Privacy Policy version equals PRIVACY_VERSION", () => {
  assert.strictEqual(clientVersion("privacy.mjs"), PRIVACY_VERSION);
});
