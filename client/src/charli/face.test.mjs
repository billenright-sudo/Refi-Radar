import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FACE, PORTRAIT, faceState } from "./face.mjs";

test("Charlie's face talks while she speaks, thinks while she works, and listens otherwise", () => {
  assert.equal(faceState({ speaking: true, working: false, paused: false }), "talking");
  assert.equal(faceState({ speaking: true, working: true, paused: false }), "talking", "her voice wins over the thinking look");
  assert.equal(faceState({ speaking: false, working: true, paused: false }), "thinking");
  assert.equal(faceState({ speaking: false, working: false, paused: false }), "listening");
  assert.equal(faceState({ speaking: true, working: true, paused: true }), "listening", "paused: she is still and quiet");
  assert.equal(faceState({}), "listening");
});

test("every face file the app points at ships in client/public", () => {
  for (const url of [...Object.values(FACE), ...Object.values(PORTRAIT)]) {
    assert.match(url, /^\/charlie\/charlie-[a-z-]+\.(jpg|mp4|webm)$/);
    const file = fileURLToPath(new URL(`../../public${url}`, import.meta.url));
    assert.ok(fs.statSync(file).size > 1000, `${url} is missing or empty`);
  }
});
