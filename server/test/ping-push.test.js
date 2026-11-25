"use strict";
// The phone channel of a rate-drop ping: VAPID settings, the push-host allowlist, the sender, and the dependency-free Web Push
// implementation (lib/pings/webpushLite.js) pinned by the RFC 8291 Appendix A test vector. Offline: a fake fetch stands in for the push
// service, and every key here is made in memory (the RFC's own public test values excepted).
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert");

const { pushConfig, isPushEndpoint, createPushSender, makeVapidKeys } = require("../lib/pings/push");
const lite = require("../lib/pings/webpushLite");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (text) => Buffer.from(text, "base64url");
const keys = makeVapidKeys();
const good = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
const pick = (c) => ({ enabled: c.enabled, reason: c.reason });

// ── settings ──────────────────────────────────────────────────────────────────

test("pushConfig is off without keys, on with good ones", () => {
  assert.deepEqual(pick(pushConfig({})), { enabled: false, reason: "VAPID keys not set" });
  assert.deepEqual(pick(pushConfig({ VAPID_PUBLIC_KEY: keys.publicKey })), { enabled: false, reason: "VAPID keys not set" });
  assert.equal(pushConfig({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: keys.privateKey, APP_URL: "https://x.test" }).reason, "VAPID keys malformed");
  assert.equal(pushConfig({ ...good, VAPID_PRIVATE_KEY: "short", APP_URL: "https://x.test" }).reason, "VAPID keys malformed");
  const other = makeVapidKeys();
  assert.equal(pushConfig({ VAPID_PUBLIC_KEY: other.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, APP_URL: "https://x.test" }).reason, "VAPID keys malformed", "not a pair");
  assert.equal(pushConfig({ ...good, APP_URL: "http://localhost:8080" }).reason, "no https APP_URL or EMAIL_USER for the VAPID subject");
  assert.equal(pushConfig({ ...good }).reason, "no https APP_URL or EMAIL_USER for the VAPID subject");
  const on = pushConfig({ ...good, APP_URL: "https://x.test" });
  assert.equal(on.enabled, true);
  assert.equal(on.subject, "https://x.test");
  assert.equal(on.publicKey, keys.publicKey);
});

test("the VAPID subject is APP_URL when https, else mailto:EMAIL_USER; settings are trimmed", () => {
  assert.equal(pushConfig({ ...good, APP_URL: "http://localhost:8080", EMAIL_USER: "sender@x.test" }).subject, "mailto:sender@x.test");
  assert.equal(pushConfig({ VAPID_PUBLIC_KEY: `${keys.publicKey}\n`, VAPID_PRIVATE_KEY: ` ${keys.privateKey}\r\n`, APP_URL: "https://x.test" }).enabled, true);
});

test("no reason ever carries a key, and a disabled config carries none either", () => {
  const cases = [{}, { VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: keys.privateKey }, { ...good }, { ...good, APP_URL: "http://localhost" }];
  for (const env of cases) {
    const c = pushConfig(env);
    assert.equal(c.enabled, false);
    assert.ok(!c.reason.includes(keys.privateKey) && !c.reason.includes(keys.publicKey));
    assert.equal(c.privateKey, null);
    assert.equal(c.publicKey, null);
  }
});

test("only push-service hosts are endpoints", () => {
  assert.equal(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), true);
  assert.equal(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"), true);
  assert.equal(isPushEndpoint("https://web.push.apple.com/QK1"), true);
  assert.equal(isPushEndpoint("https://api.push.apple.com/3/device/abc"), true);
  assert.equal(isPushEndpoint("https://db5p.notify.windows.com/?token=abc"), true);
  assert.equal(isPushEndpoint("http://fcm.googleapis.com/x"), false);
  assert.equal(isPushEndpoint("https://169.254.169.254/latest"), false);
  assert.equal(isPushEndpoint("https://localhost/x"), false);
  assert.equal(isPushEndpoint("https://push.apple.com.evil.test/x"), false);
  assert.equal(isPushEndpoint("https://evilpush.apple.com.test/x"), false);
  assert.equal(isPushEndpoint("https://notify.windows.com/x"), false, "the bare suffix is not a host");
  assert.equal(isPushEndpoint("https://fcm.googleapis.com@evil.test/x"), false);
  assert.equal(isPushEndpoint("https://user:pw@fcm.googleapis.com/x"), false);
  assert.equal(isPushEndpoint("https://fcm.googleapis.com:8443/x"), false);
  assert.equal(isPushEndpoint(`https://fcm.googleapis.com/${"a".repeat(2100)}`), false);
  for (const bad of [null, undefined, 5, "", "not a url", {}]) assert.equal(isPushEndpoint(bad), false);
});

// ── the sender ────────────────────────────────────────────────────────────────

const cfg = pushConfig({ ...good, APP_URL: "https://x.test" });
const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/sample-device", p256dh: "pk", auth: "au" };
const TEXT = { title: "Rates dropped", body: "The national average 30-year is 6.4%", url: "/", tag: "rate-drop" };

// A stand-in for the `web-push` package's sendNotification: answers by status, rejecting a non-2xx with the statusCode on the error.
function fakeWebpush(statuses) {
  const calls = [];
  return {
    calls,
    async sendNotification(subscription, payload, options) {
      calls.push({ subscription, payload, options });
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      if (status === "timeout") throw Object.assign(new Error("push service timed out"), { name: "AbortError" });
      if (status >= 200 && status < 300) return { statusCode: status };
      throw Object.assign(new Error("push service answered"), { statusCode: status });
    },
  };
}

test("send passes the TTL and topic; 410 is gone, 500 is not", async () => {
  const fake = fakeWebpush([201, 410, 500]);
  const s = createPushSender(cfg, { webpush: fake });
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 5400 }), { ok: true });
  assert.equal(fake.calls[0].options.TTL, 5400);
  assert.equal(fake.calls[0].options.topic, "rate-drop");
  assert.equal(fake.calls[0].options.urgency, "normal");
  assert.equal(fake.calls[0].options.timeout, 10000);
  assert.deepEqual(fake.calls[0].options.vapidDetails, { subject: "https://x.test", publicKey: keys.publicKey, privateKey: keys.privateKey });
  assert.deepEqual(fake.calls[0].subscription, { endpoint: SUB.endpoint, keys: { p256dh: "pk", auth: "au" } });
  assert.deepEqual(JSON.parse(fake.calls[0].payload), TEXT);
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: true, status: 410 });
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: false, status: 500 });
});

test("404 is gone; 429, 503 and a timeout are failed sends that keep the device", async () => {
  const fake = fakeWebpush([404, 429, 503, "timeout"]);
  const s = createPushSender(cfg, { webpush: fake });
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: true, status: 404 });
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: false, status: 429 });
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: false, status: 503 });
  assert.deepEqual(await s.send(SUB, TEXT, { ttlSeconds: 60 }), { ok: false, gone: false, status: null });
});

test("a subscription given as { endpoint, keys } is passed through as it is", async () => {
  const fake = fakeWebpush([201]);
  await createPushSender(cfg, { webpush: fake }).send({ endpoint: SUB.endpoint, keys: { p256dh: "a", auth: "b" } }, TEXT, { ttlSeconds: 60 });
  assert.deepEqual(fake.calls[0].subscription.keys, { p256dh: "a", auth: "b" });
});

test("makeVapidKeys makes a P-256 pair that signs and verifies", () => {
  const k = makeVapidKeys();
  assert.equal(k.publicKey.length, 87);
  assert.equal(k.privateKey.length, 43);
  const pub = unb64u(k.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
  const priv = crypto.createPrivateKey({ key: { ...jwk, d: k.privateKey }, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from("hello"), priv);
  assert.equal(crypto.verify("sha256", Buffer.from("hello"), crypto.createPublicKey({ key: jwk, format: "jwk" }), sig), true);
  assert.notEqual(makeVapidKeys().privateKey, k.privateKey);
});

test("scripts/vapid-keys.js: the private key on stdout only, the public key on stderr only, nothing on disk", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "br-vapid-script-"));
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "vapid-keys.js")], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^[A-Za-z0-9_-]{43}$/, "stdout is the private key and nothing else");
    assert.match(r.stderr, /^[A-Za-z0-9_-]{87}\n$/, "stderr is the public key and nothing else");
    assert.ok(!r.stderr.includes(r.stdout) && !r.stdout.includes(r.stderr.trim()));
    assert.equal(pushConfig({ VAPID_PUBLIC_KEY: r.stderr.trim(), VAPID_PRIVATE_KEY: r.stdout, APP_URL: "https://x.test" }).enabled, true, "they are a pair");
    assert.deepEqual(fs.readdirSync(cwd), [], "nothing written to the working directory");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── webpushLite: RFC 8291 ─────────────────────────────────────────────────────

// The RFC 8291 Appendix A values (the RFC's own published test data, not keys of ours).
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("RFC 8291 Appendix A: the body is the RFC's bytes, exactly", () => {
  const body = lite.encryptPayload(RFC.plaintext, {
    p256dh: RFC.uaPublic, auth: RFC.auth, salt: unb64u(RFC.salt), ephemeralPrivateKey: unb64u(RFC.asPrivate),
  });
  assert.equal(b64u(body), RFC.body);
  // 86 header + 41 data + 1 delimiter + 16 tag (the RFC's example request prints Content-Length: 145, which its own body does not have)
  assert.equal(body.length, 144);
  // the 86-octet header: salt, record size 4096, key id length 65, the sender's public key
  assert.equal(b64u(body.subarray(0, 86)), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  assert.equal(b64u(body.subarray(86)), "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ");
});

// The receiver's side, written out from RFC 8291 section 3.4 independently of the sender's code: the user agent decrypts with its private key.
function decryptAsReceiver(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const hk = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, len));
  const ikm = hk(secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hk(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hk(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const record = body.subarray(21 + idlen);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 0x02, "the last-record delimiter");
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

function newDevice() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return { ecdh, uaPublic: ecdh.getPublicKey(), authSecret, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(authSecret) };
}

test("a fresh salt and key each time, and the device can read it", () => {
  const dev = newDevice();
  const a = lite.encryptPayload("Rates dropped — 6.4%", { p256dh: dev.p256dh, auth: dev.auth });
  const b = lite.encryptPayload("Rates dropped — 6.4%", { p256dh: dev.p256dh, auth: dev.auth });
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salt");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "ephemeral key");
  assert.equal(decryptAsReceiver(a, dev.ecdh.getPrivateKey(), dev.uaPublic, dev.authSecret), "Rates dropped — 6.4%");
});

test("a bad subscription key or a payload over the record is refused, never sent", () => {
  const dev = newDevice();
  assert.throws(() => lite.encryptPayload("x", { p256dh: "short", auth: dev.auth }), /bad subscription key/);
  assert.throws(() => lite.encryptPayload("x", { p256dh: dev.p256dh, auth: "short" }), /bad subscription auth/);
  assert.throws(() => lite.encryptPayload("x", { p256dh: b64u(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)])), auth: dev.auth }), Error, "a point off the curve");
  assert.throws(() => lite.encryptPayload("x".repeat(4000), { p256dh: dev.p256dh, auth: dev.auth }), /too long/);
  assert.doesNotThrow(() => lite.encryptPayload("x".repeat(3993), { p256dh: dev.p256dh, auth: dev.auth }));
});

// ── webpushLite: VAPID, headers, the request ──────────────────────────────────

function jwtParts(authorization) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization);
  assert.ok(m, `the Authorization header has the RFC 8292 form: ${authorization.replace(/[\w-]{20,}/g, "…")}`);
  return { signingInput: `${m[1]}.${m[2]}`, header: JSON.parse(unb64u(m[1])), claims: JSON.parse(unb64u(m[2])), signature: unb64u(m[3]), k: m[4] };
}

test("VAPID (RFC 8292): an ES256 JWT that verifies with the public key, audience = the endpoint's origin, at most 24 h", () => {
  const nowMs = Date.parse("2026-11-24T15:00:00Z");
  const auth = lite.vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc?x=1", { subject: "https://x.test", publicKey: keys.publicKey, privateKey: keys.privateKey }, nowMs);
  const { signingInput, header, claims, signature, k } = jwtParts(auth);
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "https://x.test");
  assert.ok(claims.exp > nowMs / 1000 && claims.exp <= nowMs / 1000 + 24 * 3600, `exp ${claims.exp}`);
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "sub"]);
  assert.equal(k, keys.publicKey);
  assert.equal(signature.length, 64, "raw r || s, not DER");
  const pub = unb64u(keys.publicKey);
  const pubKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
  assert.equal(crypto.verify("sha256", Buffer.from(signingInput), { key: pubKey, dsaEncoding: "ieee-p1363" }, signature), true);
  assert.equal(crypto.verify("sha256", Buffer.from(`${signingInput}x`), { key: pubKey, dsaEncoding: "ieee-p1363" }, signature), false);
});

test("VAPID: another subject or push service changes the claims; bad keys are refused", () => {
  const a = jwtParts(lite.vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/x", { subject: "mailto:sender@x.test", publicKey: keys.publicKey, privateKey: keys.privateKey })).claims;
  assert.equal(a.aud, "https://updates.push.services.mozilla.com");
  assert.equal(a.sub, "mailto:sender@x.test");
  assert.throws(() => lite.vapidAuthorization("https://fcm.googleapis.com/x", { subject: "https://x.test", publicKey: "short", privateKey: keys.privateKey }), /bad VAPID keys/);
});

// A fetch that records the request and answers `status`, or hangs until aborted.
function fakePushService(status) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (status === "hang") {
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    if (status === "network") throw new TypeError("fetch failed");
    return { status, ok: status >= 200 && status < 300 };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

const vapidDetails = { subject: "https://x.test", publicKey: keys.publicKey, privateKey: keys.privateKey };

test("sendNotification: the headers, the encrypted body, no redirects", async () => {
  const dev = newDevice();
  const fetchImpl = fakePushService(201);
  const wp = lite.createWebPush({ fetchImpl, now: () => Date.parse("2026-11-24T15:00:00Z") });
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: dev.p256dh, auth: dev.auth } };
  const out = await wp.sendNotification(sub, JSON.stringify(TEXT), { vapidDetails, TTL: 5400, urgency: "normal", topic: "rate-drop", timeout: 10000 });
  assert.deepEqual(out, { statusCode: 201 });
  const { url, init } = fetchImpl.requests[0];
  assert.equal(url, sub.endpoint);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal, "a request with a timeout");
  assert.equal(init.headers.TTL, "5400");
  assert.equal(init.headers.Urgency, "normal");
  assert.equal(init.headers.Topic, "rate-drop");
  assert.equal(init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(init.headers["Content-Type"], "application/octet-stream");
  assert.equal(jwtParts(init.headers.Authorization).claims.aud, "https://fcm.googleapis.com");
  assert.deepEqual(JSON.parse(decryptAsReceiver(init.body, dev.ecdh.getPrivateKey(), dev.uaPublic, dev.authSecret)), TEXT);
});

test("sendNotification: an object payload is sent as JSON; an invalid urgency or topic is left off", async () => {
  const dev = newDevice();
  const fetchImpl = fakePushService(201);
  const wp = lite.createWebPush({ fetchImpl });
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: dev.p256dh, auth: dev.auth } };
  await wp.sendNotification(sub, TEXT, { vapidDetails, TTL: 60, urgency: "urgent!", topic: "not a valid topic!" });
  const { init } = fetchImpl.requests[0];
  assert.equal("Urgency" in init.headers, false);
  assert.equal("Topic" in init.headers, false);
  assert.deepEqual(JSON.parse(decryptAsReceiver(init.body, dev.ecdh.getPrivateKey(), dev.uaPublic, dev.authSecret)), TEXT);
});

test("sendNotification: a non-2xx answer rejects with its status, and the error names no endpoint", async () => {
  const dev = newDevice();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/secret-device-token", keys: { p256dh: dev.p256dh, auth: dev.auth } };
  for (const status of [301, 400, 404, 410, 429, 500, 503]) {
    const wp = lite.createWebPush({ fetchImpl: fakePushService(status) });
    await assert.rejects(wp.sendNotification(sub, "x", { vapidDetails, TTL: 60 }), (err) => {
      assert.equal(err.statusCode, status);
      assert.ok(!err.message.includes("secret-device-token") && !err.message.includes("fcm.googleapis.com"));
      return true;
    });
  }
});

test("through the sender: 410 and 404 are gone, 429 and 500 are not, a 201 is ok", async () => {
  const dev = newDevice();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: dev.p256dh, auth: dev.auth };
  const outcomes = {};
  for (const status of [201, 410, 404, 429, 500]) {
    const sender = createPushSender(cfg, { webpush: lite.createWebPush({ fetchImpl: fakePushService(status) }) });
    outcomes[status] = await sender.send(sub, TEXT, { ttlSeconds: 60 });
  }
  assert.deepEqual(outcomes, {
    201: { ok: true },
    410: { ok: false, gone: true, status: 410 },
    404: { ok: false, gone: true, status: 404 },
    429: { ok: false, gone: false, status: 429 },
    500: { ok: false, gone: false, status: 500 },
  });
});

test("the request has a timeout: a hung push service gives a failed send with no status, not a hang", async () => {
  const dev = newDevice();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: dev.p256dh, auth: dev.auth } };
  const wp = lite.createWebPush({ fetchImpl: fakePushService("hang") });
  const started = Date.now();
  await assert.rejects(wp.sendNotification(sub, "x", { vapidDetails, TTL: 60, timeout: 40 }), (err) => err.name === "AbortError" && err.statusCode === undefined);
  assert.ok(Date.now() - started < 2000);
  const lax = lite.createWebPush({ fetchImpl: fakePushService("network") });
  await assert.rejects(lax.sendNotification(sub, "x", { vapidDetails, TTL: 60 }), (err) => err.statusCode === undefined && !err.message.includes("fcm.googleapis.com"));
});
