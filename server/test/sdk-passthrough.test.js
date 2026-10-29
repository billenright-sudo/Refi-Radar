"use strict";
// The pinned @anthropic-ai/sdk sends the newer request fields exactly as given: output_config (runTurn's effort on Sonnet 5.5)
// and thinking (the judge's disabled thinking on Haiku 5.5). No network: the client's fetch is a capture that answers like the API.
const test = require("node:test");
const assert = require("node:assert");
const Anthropic = require("@anthropic-ai/sdk");

test("the SDK passes output_config and thinking through to the request body unchanged", async () => {
  const sent = [];
  const capture = async (url, init) => {
    sent.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "m",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "test", fetch: capture, maxRetries: 0 });
  const params = {
    model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "low" }, thinking: { type: "disabled" },
  };
  const out = await client.messages.create(params);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/v1\/messages$/);
  assert.equal(sent[0].method, "POST");
  assert.deepStrictEqual(sent[0].body.output_config, { effort: "low" });
  assert.deepStrictEqual(sent[0].body.thinking, { type: "disabled" });
  assert.deepStrictEqual(sent[0].body, params, "nothing added, dropped or renamed");
  assert.equal(out.stop_reason, "end_turn");
});
