"use strict";
// /api/voice (routes/voice.js) end to end against a throwaway DB, with the outbound ElevenLabs call stubbed
// through app.set("voiceFetch", stub): NO test here touches the network. TTS streams audio/mpeg from the
// streaming endpoint with the speech-normalized text; STT forwards one audio upload to Scribe and answers
// { text }. Both meter their use, map every upstream failure to 502/504 (never 500), and never carry the key.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "br-voice-api-"));
process.env.JWT_SECRET = "test-secret-" + Math.random().toString(16).slice(2);
process.env.NODE_ENV = "test";
const KEY = "test-eleven-key-" + Math.random().toString(16).slice(2);
process.env.ELEVENLABS_API_KEY = KEY;
process.env.ELEVENLABS_VOICE_ID_CHARLI = "voice-charli-test";
delete process.env.ELEVENLABS_TTS_MODEL;
delete process.env.ELEVENLABS_STT_MODEL;

const { execFileSync } = require("child_process");
const test = require("node:test");
const { before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("../db");
const { signToken } = require("../middleware/auth");
const { recordUsage, getOrgUsage } = require("../lib/assistant/metering");
const { toSpeech } = require("../lib/assistant/speech");
const assistantRoutes = require("../routes/assistant");
const voiceRoutes = require("../routes/voice");

// ── seed data ────────────────────────────────────────────────────────────────

const addOrg = (name) => Number(db.prepare("INSERT INTO organizations (name) VALUES (?)").run(name).lastInsertRowid);
const addUser = (orgId, role, email, first = "T") => Number(db.prepare(
  "INSERT INTO users (org_id, role, first_name, last_name, email) VALUES (?, ?, ?, 'User', ?)"
).run(orgId, role, first, email).lastInsertRowid);
const usageRows = (userId) => db.prepare("SELECT * FROM assistant_usage WHERE user_id = ? ORDER BY id").all(userId);

const orgA = addOrg("Alpha");
const ann = addUser(orgA, "broker", "ann@a.co", "Ann");
const orgB = addOrg("Bravo");
const bea = addUser(orgB, "broker", "bea@b.co", "Bea");

// ── harness ──────────────────────────────────────────────────────────────────

function buildApp(router) {
  const a = express();
  a.use(express.json({ limit: "20mb" }));   // as index.js mounts it
  a.use(cookieParser());
  a.use("/api/voice", router);
  a.use("/api/assistant", assistantRoutes.createAssistantRouter({ limiter: { max: 100000 } }));
  return a;
}
const listen = async (a) => {
  const s = a.listen(0);
  await new Promise((r) => s.once("listening", r));
  return { server: s, base: `http://localhost:${s.address().port}` };
};
// as(userId)(method, path, { json | form }) -> { status, headers, bytes, data }; as(null) is anonymous.
const asUser = (base) => (userId) => async (method, p, { json, form } = {}) => {
  const headers = {};
  if (userId != null) headers.cookie = "rr_token=" + signToken({ userId });
  let body;
  if (json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  else if (form) body = form;
  const res = await fetch(base + p, { method, headers, body });
  const bytes = Buffer.from(await res.arrayBuffer());
  let data = null;
  if ((res.headers.get("content-type") || "").includes("json")) { try { data = JSON.parse(bytes.toString("utf8")); } catch { /* */ } }
  return { status: res.status, headers: res.headers, bytes, data };
};

let app, server, base, as;
before(async () => {
  app = buildApp(voiceRoutes.createVoiceRouter({ limiter: { max: 100000 } }));
  ({ server, base } = await listen(app));
  as = asUser(base);
});
after(() => {
  server.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// The stub: every outbound call is recorded; a call nobody scripted fails loudly instead of reaching the network.
let calls;
beforeEach(() => {
  calls = [];
  setFetch(() => { throw new Error("unexpected outbound call"); });
});
function setFetch(handler, target = app) {
  target.set("voiceFetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  });
}
const bytesOf = (...n) => Uint8Array.from(n);
// A 200 audio response whose body is a real web stream of the given chunks.
const audio = (...chunks) => new Response(
  new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }),
  { status: 200, headers: { "content-type": "audio/mpeg" } }
);
const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Runs fn with env vars set (a value) or unset (undefined), then restores them.
async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
// Captures console.error / warn / log for the duration of fn.
async function capturingConsole(fn) {
  const logged = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(saved)) console[k] = (...args) => logged.push(args.map(String).join(" "));
  try { await fn(logged); } finally { Object.assign(console, saved); }
}
const within = (ms, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for " + what)), ms))]);

const GREETING = "Good morning, Bill. You have 4 opportunities and 12 check-ins due; the 30-year is at 7.40%.";
const SPOKEN = "Good morning, Bill. You have four opportunities and twelve check-ins due; the thirty-year is at seven point four zero percent.";

const tts = (userId, body) => as(userId)("POST", "/api/voice/tts", { json: body });
const audioForm = (bytes, { type = "audio/webm;codecs=opus", name = "clip.webm", field = "audio", extra } = {}) => {
  const form = new FormData();
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
  if (bytes) form.append(field, new Blob([bytes], { type }), name);
  return form;
};
const stt = (userId, form) => as(userId)("POST", "/api/voice/stt", { form });

// ── TTS ──────────────────────────────────────────────────────────────────────

test("tts: the greeting is spoken through the streaming endpoint with the NORMALIZED text, and metered", async () => {
  assert.strictEqual(toSpeech(GREETING), SPOKEN);
  setFetch(() => audio(bytesOf(1, 2, 3), bytesOf(4, 5), bytesOf(6)));
  const turnId = "turn-tts-" + Math.random().toString(16).slice(2);
  const before = usageRows(ann).length;

  const r = await tts(ann, { text: `  ${GREETING}  `, turnId });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.deepStrictEqual([...r.bytes], [1, 2, 3, 4, 5, 6], "the upstream bytes, in order");

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  const u = new URL(url);
  assert.equal(u.origin, "https://api.elevenlabs.io");
  assert.equal(u.pathname, "/v1/text-to-speech/voice-charli-test/stream", "the streaming variant, for the configured voice");
  assert.equal(u.searchParams.get("output_format"), "mp3_44100_128");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("xi-api-key"), KEY);
  assert.equal(headers.get("accept"), "audio/mpeg");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepStrictEqual(JSON.parse(init.body), { text: SPOKEN, model_id: "eleven_v4_turbo" }, "normalized text + the default model, nothing else");
  assert.ok(init.signal instanceof AbortSignal, "the call carries an AbortSignal for the timeout");

  const rows = usageRows(ann).slice(before);
  assert.equal(rows.length, 1);
  assert.deepStrictEqual(
    { turn_id: rows[0].turn_id, tts_chars: rows[0].tts_chars, stt_seconds: rows[0].stt_seconds, input_tokens: rows[0].input_tokens, output_tokens: rows[0].output_tokens },
    { turn_id: turnId, tts_chars: SPOKEN.length, stt_seconds: 0, input_tokens: 0, output_tokens: 0 },
    "ttsChars is the normalized length, not the on-screen text's"
  );
  assert.notEqual(SPOKEN.length, GREETING.length);
});

test("tts: the API key and voice id never appear in what the browser gets", async () => {
  setFetch(() => audio(bytesOf(9)));
  const r = await tts(ann, { text: "Hello." });
  assert.equal(r.status, 200);
  const everything = JSON.stringify([...r.headers.entries()]) + r.bytes.toString("latin1");
  assert.ok(!everything.includes(KEY));
  assert.ok(!everything.includes("voice-charli-test"));
});

test("tts: without a turnId the usage row has none; the model and voice come from the environment", async () => {
  setFetch(() => audio(bytesOf(1)));
  const before = usageRows(ann).length;
  await withEnv({ ELEVENLABS_TTS_MODEL: "eleven_flash_v2_5", ELEVENLABS_VOICE_ID_CHARLI: "voice-other" }, async () => {
    const r = await tts(ann, { text: "Hi" });
    assert.equal(r.status, 200);
  });
  assert.equal(new URL(calls[0].url).pathname, "/v1/text-to-speech/voice-other/stream");
  assert.equal(JSON.parse(calls[0].init.body).model_id, "eleven_flash_v2_5");
  const rows = usageRows(ann).slice(before);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn_id, null);
  assert.equal(rows[0].tts_chars, 2);
});

test("tts: audio is streamed through as it arrives, not buffered", { timeout: 15000 }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let step = 0;
  setFetch(() => new Response(new ReadableStream({
    async pull(c) {
      if (step === 0) { step = 1; c.enqueue(bytesOf(1, 2, 3)); return; }
      if (step === 1) { step = 2; await gate; c.enqueue(bytesOf(4, 5)); c.close(); }
    },
  }), { status: 200, headers: { "content-type": "audio/mpeg" } }));

  const res = await within(3000, fetch(base + "/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "rr_token=" + signToken({ userId: ann }) },
    body: JSON.stringify({ text: "Stream me." }),
  }), "the response headers (the server is buffering the clip)");
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = await within(3000, reader.read(), "the first audio chunk while the upstream is still open");
  assert.deepStrictEqual([...first.value], [1, 2, 3]);
  release();
  const parts = [...first.value];
  for (;;) {
    const { done, value } = await within(3000, reader.read(), "the rest of the clip");
    if (done) break;
    parts.push(...value);
  }
  assert.deepStrictEqual(parts, [1, 2, 3, 4, 5]);
});

test("tts: a missing, empty, blank or non-string text is 400 and calls nobody", async () => {
  for (const body of [{}, { text: "" }, { text: "   \n " }, { text: 42 }, { text: null }, { text: ["a"] }, { text: "***" }, { text: " # ` " }]) {
    const r = await tts(ann, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.data.error, "string");
  }
  assert.equal((await as(ann)("POST", "/api/voice/tts", { json: undefined })).status, 400, "no body at all");
  assert.equal((await tts(ann, { text: "Hi", turnId: 7 })).status, 400, "a turnId that is not a short string");
  assert.equal((await tts(ann, { text: "Hi", turnId: "x".repeat(65) })).status, 400);
  assert.equal(calls.length, 0);
});

test("tts: more than 2,000 characters is 400; exactly 2,000 is fine", async () => {
  setFetch(() => audio(bytesOf(1)));
  let r = await tts(ann, { text: "a".repeat(2001) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /2,000/);
  assert.equal(calls.length, 0);
  r = await tts(ann, { text: "a".repeat(2000) });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  // the cap is on the text as sent (trimmed), not on the spelled-out version
  r = await tts(ann, { text: "   " + "1".repeat(1999) + "   " });
  assert.equal(r.status, 200);
});

test("tts: not configured (no API key, or no voice id) is 503 and calls nobody", async () => {
  setFetch(() => audio(bytesOf(1)));
  for (const env of [
    { ELEVENLABS_API_KEY: undefined }, { ELEVENLABS_API_KEY: "" }, { ELEVENLABS_API_KEY: "   " },
    { ELEVENLABS_VOICE_ID_CHARLI: undefined }, { ELEVENLABS_VOICE_ID_CHARLI: "" },
  ]) {
    await withEnv(env, async () => {
      const r = await tts(ann, { text: "Hello." });
      assert.equal(r.status, 503, JSON.stringify(env));
      assert.deepStrictEqual(r.data, { error: "voice not configured" });
    });
  }
  assert.equal(calls.length, 0);
  assert.equal((await tts(ann, { text: "Hello." })).status, 200, "the environment is restored");
});

test("tts: an upstream failure is 502 with a short message that never echoes the upstream body or the key", async () => {
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    setFetch(() => new Response(JSON.stringify({ detail: { message: `invalid api key ${KEY}` } }), { status, headers: { "content-type": "application/json" } }));
    await capturingConsole(async (logged) => {
      const r = await tts(ann, { text: "Hello." });
      assert.equal(r.status, 502, "upstream " + status);
      assert.deepStrictEqual(Object.keys(r.data), ["error"]);
      assert.equal(typeof r.data.error, "string");
      assert.ok(!JSON.stringify(r.data).includes(KEY), "the response does not echo the upstream body");
      assert.ok(!logged.join("\n").includes(KEY), "the log does not carry the key");
    });
  }
  const rowsBefore = usageRows(ann).length;
  setFetch(() => new Response("nope", { status: 401 }));
  await tts(ann, { text: "Hello." });
  assert.equal(usageRows(ann).length, rowsBefore, "a failed synthesis is not metered");
});

test("tts: a network error is 504; so is a stub that gives up before any audio", async () => {
  await capturingConsole(async (logged) => {
    setFetch(() => { throw new Error(`getaddrinfo ENOTFOUND api.elevenlabs.io (xi-api-key: ${KEY})`); });
    let r = await tts(ann, { text: "Hello." });
    assert.equal(r.status, 504);
    assert.deepStrictEqual(Object.keys(r.data), ["error"]);
    assert.ok(!JSON.stringify(r.data).includes(KEY));
    assert.ok(!logged.join("\n").includes(KEY), "an upstream error message is not logged verbatim");

    setFetch(() => Promise.reject(new TypeError("fetch failed")));
    r = await tts(ann, { text: "Hello." });
    assert.equal(r.status, 504);

    // a 200 whose stream dies before the first byte: still a clean 504, not a half-open 200
    setFetch(() => new Response(new ReadableStream({ start(c) { c.error(new Error("socket hang up")); } }), { status: 200 }));
    r = await tts(ann, { text: "Hello." });
    assert.equal(r.status, 504);
  });
});

test("tts: a 200 with no audio in it is 502", async () => {
  setFetch(() => new Response(null, { status: 200, headers: { "content-type": "audio/mpeg" } }));
  let r = await tts(ann, { text: "Hello." });
  assert.equal(r.status, 502);
  setFetch(() => audio());
  r = await tts(ann, { text: "Hello." });
  assert.equal(r.status, 502);
});

test("tts: a stream that dies after audio has started ends the response early and the server carries on", async () => {
  let step = 0;
  setFetch(() => new Response(new ReadableStream({
    pull(c) {
      if (step++ === 0) { c.enqueue(bytesOf(1, 2, 3)); return; }
      c.error(new Error("upstream reset"));
    },
  }), { status: 200 }));
  await capturingConsole(async () => {
    await assert.rejects(() => tts(ann, { text: "Hello." }), "the client sees an aborted body, not a clean 200");
  });
  setFetch(() => audio(bytesOf(7)));
  const again = await tts(ann, { text: "Hello." });
  assert.equal(again.status, 200);
  assert.deepStrictEqual([...again.bytes], [7]);
});

test("tts: anonymous is 401 and calls nobody", async () => {
  setFetch(() => audio(bytesOf(1)));
  assert.equal((await as(null)("POST", "/api/voice/tts", { json: { text: "Hello." } })).status, 401);
  assert.equal((await as(null)("POST", "/api/voice/tts", { json: {} })).status, 401);
  assert.equal(calls.length, 0);
});

test("tts: a failing usage write never fails the audio", async () => {
  setFetch(() => audio(bytesOf(1, 2)));
  const original = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/INSERT INTO assistant_usage/.test(sql)) throw new Error("disk full");
    return original(sql);
  };
  try {
    await capturingConsole(async (logged) => {
      const r = await tts(ann, { text: "Hello." });
      assert.equal(r.status, 200);
      assert.deepStrictEqual([...r.bytes], [1, 2]);
      assert.deepStrictEqual(logged, ["voice usage: disk full"]);
    });
  } finally {
    delete db.prepare;   // back to the prototype method
  }
});

// ── the timeout ──────────────────────────────────────────────────────────────

test("timeout: no response within the deadline is 504; a stall mid-stream ends the response; a slow healthy stream finishes", { timeout: 30000 }, async () => {
  const timed = buildApp(voiceRoutes.createVoiceRouter({ limiter: { max: 100000 }, timeoutMs: 300 }));
  const { server: s, base: b } = await listen(timed);
  const call = asUser(b);
  const abortable = (init, fn) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    if (init.signal.aborted) return abort();
    init.signal.addEventListener("abort", abort, { once: true });
    fn(resolve);
  });
  try {
    // 1. the request never gets a response
    setFetch((url, init) => abortable(init, () => {}), timed);
    let t = Date.now();
    let r = await call(ann)("POST", "/api/voice/tts", { json: { text: "Hello." } });
    assert.equal(r.status, 504);
    assert.match(r.data.error, /timed out/i);
    assert.ok(Date.now() - t < 3000);

    // 2. headers arrive, then no audio at all
    setFetch((url, init) => {
      let ctl;
      const body = new ReadableStream({ start(c) { ctl = c; } });
      init.signal.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
      return new Response(body, { status: 200 });
    }, timed);
    r = await call(ann)("POST", "/api/voice/tts", { json: { text: "Hello." } });
    assert.equal(r.status, 504);

    // 3. one chunk, then silence: the response is cut off rather than held open forever
    setFetch((url, init) => {
      let ctl; let sent = false;
      const body = new ReadableStream({
        start(c) { ctl = c; },
        pull(c) { if (!sent) { sent = true; c.enqueue(bytesOf(1, 2)); } return new Promise(() => {}); },
      });
      init.signal.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
      return new Response(body, { status: 200 });
    }, timed);
    t = Date.now();
    await capturingConsole(async () => {
      await assert.rejects(() => call(ann)("POST", "/api/voice/tts", { json: { text: "Hello." } }));
    });
    assert.ok(Date.now() - t < 3000, "ended by the inactivity timeout");

    // 4. total time well past the deadline, but a chunk always arrives in time: not a timeout
    setFetch(() => {
      let n = 0;
      return new Response(new ReadableStream({
        async pull(c) {
          await new Promise((res) => setTimeout(res, 100));
          c.enqueue(bytesOf(++n));
          if (n === 6) c.close();
        },
      }), { status: 200 });
    }, timed);
    r = await call(ann)("POST", "/api/voice/tts", { json: { text: "Hello." } });
    assert.equal(r.status, 200);
    assert.deepStrictEqual([...r.bytes], [1, 2, 3, 4, 5, 6]);

    // 5. STT: the same deadline
    setFetch((url, init) => abortable(init, () => {}), timed);
    r = await call(ann)("POST", "/api/voice/stt", { form: audioForm(Buffer.from("abc")) });
    assert.equal(r.status, 504);
    assert.match(r.data.error, /timed out/i);
  } finally {
    s.close();
  }
});

test("timeout: the default deadline is 20 seconds", () => {
  assert.equal(voiceRoutes.TIMEOUT_MS, 20_000);
});

// ── STT ──────────────────────────────────────────────────────────────────────

const CLIP = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);   // the first bytes of a WebM

test("stt: one audio upload is forwarded to Scribe as multipart; { text } comes back trimmed; seconds are metered", async () => {
  let seen;
  setFetch(async (url, init) => {
    const file = init.body.get("file");
    seen = {
      model: init.body.get("model_id"),
      fields: [...init.body.keys()].sort(),
      bytes: Buffer.from(await file.arrayBuffer()),
      type: file.type,
      isFile: file instanceof Blob,
    };
    return jsonResponse({
      language_code: "eng", language_probability: 0.99, text: "  What's the rate today?  ",
      words: [], transcription_id: "tr_1", audio_duration_secs: 10.5,
    });
  });
  const before = usageRows(ann).length;
  const r = await stt(ann, audioForm(CLIP));
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, { text: "What's the rate today?" });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(init.method, "POST");
  assert.ok(init.body instanceof FormData, "multipart");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("xi-api-key"), KEY);
  assert.equal(headers.get("content-type"), null, "fetch sets the multipart boundary itself");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepStrictEqual(seen.fields, ["file", "model_id"], "no forced language, nothing else");
  assert.equal(seen.model, "scribe_v2");
  assert.ok(seen.isFile);
  assert.deepStrictEqual([...seen.bytes], [...CLIP], "the audio, byte for byte");
  assert.match(seen.type, /^audio\/webm/);

  const rows = usageRows(ann).slice(before);
  assert.equal(rows.length, 1);
  assert.deepStrictEqual(
    { stt_seconds: rows[0].stt_seconds, tts_chars: rows[0].tts_chars, input_tokens: rows[0].input_tokens, turn_id: rows[0].turn_id },
    { stt_seconds: 10.5, tts_chars: 0, input_tokens: 0, turn_id: null }
  );
});

test("stt: the model comes from the environment; no voice id is needed", async () => {
  setFetch(() => jsonResponse({ text: "hello", audio_duration_secs: 1 }));
  await withEnv({ ELEVENLABS_STT_MODEL: "scribe_v1", ELEVENLABS_VOICE_ID_CHARLI: undefined }, async () => {
    const r = await stt(ann, audioForm(CLIP));
    assert.equal(r.status, 200);
    assert.equal(calls[0].init.body.get("model_id"), "scribe_v1");
  });
});

test("stt: an empty transcript is { text: '' }, and a missing duration is 0 seconds", async () => {
  const before = usageRows(ann).length;
  for (const reply of [{ text: "", audio_duration_secs: 2 }, { text: "   \n" }, {}, { text: null }, { text: 5 }]) {
    setFetch(() => jsonResponse(reply));
    const r = await stt(ann, audioForm(CLIP));
    assert.equal(r.status, 200, JSON.stringify(reply));
    assert.deepStrictEqual(r.data, { text: "" }, JSON.stringify(reply));
  }
  const rows = usageRows(ann).slice(before);
  assert.deepStrictEqual(rows.map((x) => x.stt_seconds), [2, 0, 0, 0, 0], "a bad or absent duration is 0");
});

test("stt: other audio types are accepted (Safari records mp4)", async () => {
  setFetch(() => jsonResponse({ text: "ok", audio_duration_secs: 1 }));
  for (const [type, name] of [["audio/mp4", "clip.m4a"], ["audio/wav", "clip.wav"], ["audio/mpeg", "clip.mp3"], ["audio/ogg;codecs=opus", "clip.ogg"]]) {
    assert.equal((await stt(ann, audioForm(CLIP, { type, name }))).status, 200, type);
  }
});

test("stt: a non-audio upload, no upload, or the wrong field is 400 and calls nobody", async () => {
  setFetch(() => jsonResponse({ text: "x" }));
  for (const type of ["text/plain", "application/pdf", "image/png", "video/webm", "application/octet-stream"]) {
    const r = await stt(ann, audioForm(CLIP, { type, name: "x.bin" }));
    assert.equal(r.status, 400, type);
    assert.equal(typeof r.data.error, "string");
  }
  assert.equal((await stt(ann, audioForm(null, { extra: { note: "no file here" } }))).status, 400, "multipart without a file");
  assert.equal((await stt(ann, audioForm(CLIP, { field: "file" }))).status, 400, "the field must be named audio");
  assert.equal((await stt(ann, audioForm(Buffer.alloc(0)))).status, 400, "an empty recording");
  assert.equal((await as(ann)("POST", "/api/voice/stt", { json: { audio: "abc" } })).status, 400, "JSON instead of an upload");
  assert.equal((await as(ann)("POST", "/api/voice/stt")).status, 400, "no body at all");
  const garbled = await fetch(base + "/api/voice/stt", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=xyz", cookie: "rr_token=" + signToken({ userId: ann }) },
    body: "this is not a multipart body",
  });
  assert.equal(garbled.status, 400, "a malformed multipart body");
  assert.equal(calls.length, 0);
});

test("stt: more than 10 MB is 413 and calls nobody; a file just under it is accepted", async () => {
  const TEN_MB = 10 * 1024 * 1024;
  setFetch(() => jsonResponse({ text: "long one", audio_duration_secs: 600 }));
  let r = await stt(ann, audioForm(Buffer.alloc(TEN_MB + 1, 1)));
  assert.equal(r.status, 413);
  assert.equal(typeof r.data.error, "string");
  assert.equal(calls.length, 0);
  r = await stt(ann, audioForm(Buffer.alloc(TEN_MB - 1, 1)));   // (busboy counts a file that reaches the limit exactly as over it)
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.data, { text: "long one" });
});

test("stt: not configured (no API key) is 503 and calls nobody", async () => {
  setFetch(() => jsonResponse({ text: "x" }));
  for (const env of [{ ELEVENLABS_API_KEY: undefined }, { ELEVENLABS_API_KEY: "" }]) {
    await withEnv(env, async () => {
      const r = await stt(ann, audioForm(CLIP));
      assert.equal(r.status, 503);
      assert.deepStrictEqual(r.data, { error: "voice not configured" });
    });
  }
  assert.equal(calls.length, 0);
});

test("stt: an upstream failure is 502 and never echoes the body or the key; a network error is 504", async () => {
  for (const status of [400, 401, 422, 429, 500, 503]) {
    setFetch(() => new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status, headers: { "content-type": "application/json" } }));
    await capturingConsole(async (logged) => {
      const r = await stt(ann, audioForm(CLIP));
      assert.equal(r.status, 502, "upstream " + status);
      assert.deepStrictEqual(Object.keys(r.data), ["error"]);
      assert.ok(!JSON.stringify(r.data).includes(KEY));
      assert.ok(!logged.join("\n").includes(KEY));
    });
  }
  setFetch(() => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }));
  assert.equal((await stt(ann, audioForm(CLIP))).status, 502, "a 200 that is not JSON");
  setFetch(() => jsonResponse(["not", "an", "object"]));
  assert.equal((await stt(ann, audioForm(CLIP))).status, 200, "an unexpected JSON shape is just an empty transcript");

  await capturingConsole(async (logged) => {
    setFetch(() => { throw new Error(`connect ECONNREFUSED (xi-api-key: ${KEY})`); });
    const r = await stt(ann, audioForm(CLIP));
    assert.equal(r.status, 504);
    assert.ok(!JSON.stringify(r.data).includes(KEY));
    assert.ok(!logged.join("\n").includes(KEY));
  });
  const before = usageRows(ann).length;
  setFetch(() => new Response("nope", { status: 500 }));
  await stt(ann, audioForm(CLIP));
  assert.equal(usageRows(ann).length, before, "a failed transcription is not metered");
});

test("stt: anonymous is 401 and calls nobody", async () => {
  setFetch(() => jsonResponse({ text: "x" }));
  assert.equal((await stt(null, audioForm(CLIP))).status, 401);
  assert.equal(calls.length, 0);
});

test("stt: a failing usage write never fails the transcript", async () => {
  setFetch(() => jsonResponse({ text: "still here", audio_duration_secs: 3 }));
  const original = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/INSERT INTO assistant_usage/.test(sql)) throw new Error("disk full");
    return original(sql);
  };
  try {
    await capturingConsole(async (logged) => {
      const r = await stt(ann, audioForm(CLIP));
      assert.equal(r.status, 200);
      assert.deepStrictEqual(r.data, { text: "still here" });
      assert.deepStrictEqual(logged, ["voice usage: disk full"]);
    });
  } finally {
    delete db.prepare;
  }
});

// ── metering ─────────────────────────────────────────────────────────────────

test("recordUsage keeps stt_seconds (fractions allowed); anything not a non-negative finite number is 0", () => {
  const id = "stt-" + Math.random().toString(16).slice(2);
  recordUsage({ userId: ann, turnId: id, sttSeconds: 11.25 });
  const rows = () => db.prepare("SELECT stt_seconds FROM assistant_usage WHERE turn_id = ? ORDER BY id").all(id).map((r) => r.stt_seconds);
  assert.deepStrictEqual(rows(), [11.25]);
  for (const bad of [-1, NaN, Infinity, -Infinity, "lots", undefined, null, {}]) recordUsage({ userId: ann, turnId: id, sttSeconds: bad });
  recordUsage({ userId: ann, turnId: id });
  recordUsage({ userId: ann, turnId: id, sttSeconds: 0 });
  assert.deepStrictEqual(rows(), [11.25, ...new Array(10).fill(0)]);
});

test("the usage endpoint and getOrgUsage return sttSeconds alongside the existing totals", async () => {
  const org = addOrg("Meter");
  const mia = addUser(org, "broker", "mia@m.co", "Mia");
  const lee = addUser(org, "lo", "lee@m.co", "Lee");
  const other = addUser(addOrg("MeterOther"), "broker", "oth@m.co", "Oth");
  const usage = (userId, q = "") => as(userId)("GET", "/api/assistant/usage" + q);
  assert.deepStrictEqual((await usage(mia)).data, { success: true, turns: 0, inputTokens: 0, outputTokens: 0, ttsChars: 0, sttSeconds: 0 });

  setFetch(() => audio(bytesOf(1)));
  assert.equal((await tts(mia, { text: "Hi" })).status, 200);       // 2 characters
  assert.equal((await tts(lee, { text: "12" })).status, 200);       // "twelve": 6 characters, another user in the org
  setFetch(() => jsonResponse({ text: "a", audio_duration_secs: 10.5 }));
  assert.equal((await stt(mia, audioForm(CLIP))).status, 200);
  setFetch(() => jsonResponse({ text: "b", audio_duration_secs: 2.25 }));
  assert.equal((await stt(lee, audioForm(CLIP))).status, 200);
  assert.equal((await stt(other, audioForm(CLIP))).status, 200);     // another org never counts

  const r = await usage(mia);
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.ttsChars, 8);
  assert.equal(r.data.sttSeconds, 12.75);
  assert.equal(r.data.inputTokens, 0);
  assert.equal(r.data.outputTokens, 0);
  const o = getOrgUsage(org, 30);
  assert.equal(o.sttSeconds, 12.75);
  assert.equal(o.ttsChars, 8);
  assert.deepStrictEqual(Object.keys(o).sort(), ["inputTokens", "outputTokens", "sttSeconds", "ttsChars", "turns"]);
  assert.equal((await usage(mia, "?days=1")).data.sttSeconds, 12.75);

  // an old row falls outside a short window; sums are rounded so float dust never reaches the broker
  db.prepare("INSERT INTO assistant_usage (user_id, turn_id, stt_seconds, created_at) VALUES (?, 'old', 100, datetime('now', '-40 days'))").run(mia);
  assert.equal((await usage(mia)).data.sttSeconds, 12.75);
  assert.equal((await usage(mia, "?days=60")).data.sttSeconds, 112.75);
  db.prepare("INSERT INTO assistant_usage (user_id, turn_id, stt_seconds) VALUES (?, 'dust', 0.1)").run(mia);
  db.prepare("INSERT INTO assistant_usage (user_id, turn_id, stt_seconds) VALUES (?, 'dust', 0.2)").run(mia);
  assert.equal((await usage(mia)).data.sttSeconds, 13.05);
});

test("the stt_seconds migration is idempotent and keeps the rows a database already had", () => {
  const Database = require("better-sqlite3");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-voice-migrate-"));
  try {
    const legacy = new Database(path.join(dir, "refi-radar.db"));
    legacy.exec(`
      CREATE TABLE assistant_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, turn_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        tts_chars INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO assistant_usage (user_id, turn_id, input_tokens, tts_chars) VALUES (1, 'old', 5, 9);
    `);
    legacy.close();
    const serverDir = path.join(__dirname, "..");
    const boot = () => execFileSync(process.execPath, ["-e", "require('./db'); require('./db');"], {
      cwd: serverDir, env: { ...process.env, DATA_DIR: dir }, stdio: "pipe",
    });
    boot();
    boot();   // a second start finds the column and leaves it alone
    const check = new Database(path.join(dir, "refi-radar.db"));
    const col = check.prepare("PRAGMA table_info(assistant_usage)").all().filter((c) => c.name === "stt_seconds");
    assert.equal(col.length, 1);
    assert.equal(col[0].type, "REAL");
    assert.equal(col[0].notnull, 1);
    assert.equal(col[0].dflt_value, "0");
    assert.deepStrictEqual(
      { ...check.prepare("SELECT turn_id, input_tokens, tts_chars, stt_seconds FROM assistant_usage").get() },
      { turn_id: "old", input_tokens: 5, tts_chars: 9, stt_seconds: 0 }
    );
    check.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── rate limit ───────────────────────────────────────────────────────────────

test("rate limit: counted per signed-in user across tts and stt, 429 with a JSON error past the cap", async () => {
  const limited = buildApp(voiceRoutes.createVoiceRouter({ limiter: { max: 3 } }));
  const { server: s, base: b } = await listen(limited);
  setFetch(() => audio(bytesOf(1)), limited);
  try {
    const call = asUser(b);
    assert.equal((await call(ann)("POST", "/api/voice/tts", { json: { text: "one" } })).status, 200);
    assert.equal((await call(ann)("POST", "/api/voice/tts", { json: {} })).status, 400, "a rejected request still counts");
    assert.equal((await call(ann)("POST", "/api/voice/stt", { form: audioForm(null) })).status, 400);
    const over = await call(ann)("POST", "/api/voice/tts", { json: { text: "four" } });
    assert.equal(over.status, 429);
    assert.match(over.data.error, /too many/i);
    assert.equal((await call(ann)("POST", "/api/voice/stt", { form: audioForm(CLIP) })).status, 429, "the cap covers stt too");
    // another user is counted separately; anonymous is 401 whatever the count
    assert.equal((await call(bea)("POST", "/api/voice/tts", { json: { text: "hello" } })).status, 200);
    assert.equal((await call(null)("POST", "/api/voice/tts", { json: { text: "hello" } })).status, 401);
    assert.equal(calls.length, 2);
  } finally {
    s.close();
  }
});

test("rate limit: the router index.js mounts allows 120 requests per 15 minutes", async () => {
  const real = buildApp(voiceRoutes);
  const { server: s, base: b } = await listen(real);
  try {
    const call = asUser(b)(bea);
    for (let i = 0; i < 120; i++) {
      const r = await call("POST", "/api/voice/tts", { json: {} });   // a cheap 400
      assert.equal(r.status, 400, "request " + (i + 1));
    }
    const over = await call("POST", "/api/voice/tts", { json: {} });
    assert.equal(over.status, 429);
    assert.ok(over.headers.get("ratelimit-limit") || over.headers.get("ratelimit"), "standard rate-limit headers are sent");
    assert.equal(over.headers.get("ratelimit-limit"), "120");
  } finally {
    s.close();
  }
});
