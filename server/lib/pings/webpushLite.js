"use strict";
// Web Push without a dependency: the payload encryption of RFC 8291 (aes128gcm, RFC 8188), the VAPID header of RFC 8292 and the
// POST to the push service, using only node:crypto and fetch. It offers the shape of the `web-push` package's sendNotification, so
// lib/pings/push.js can use either; it is the default.
//
//   sendNotification(subscription, payload, { vapidDetails: { subject, publicKey, privateKey }, TTL, urgency, topic, timeout })
//     -> resolves { statusCode } for a 2xx answer; REJECTS for anything else with an Error whose `statusCode` is the HTTP status
//        (a push service that is gone, 3xx included), or with no `statusCode` for a timeout or a network failure.
//
// The encryption is pinned by the RFC 8291 Appendix A test vector (test/ping-push.test.js): with that vector's salt and keys the body is
// the RFC's bytes. Nothing here logs, and an error never carries the endpoint, a key or the push service's answer.
const crypto = require("node:crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");

const RECORD_SIZE = 4096;
const HEADER_LENGTH = 16 + 4 + 1 + 65;     // salt, record size, key id length, the sender's public key
const JWT_LIFETIME_S = 12 * 60 * 60;       // RFC 8292: no more than 24 hours
const DEFAULT_TIMEOUT_MS = 10_000;

const utf8 = (text) => Buffer.from(text, "utf8");
const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));

// An ECDH object on P-256 holding the private key given as 32 raw octets, or a fresh one.
function ecdhWith(privateKey) {
  const ecdh = crypto.createECDH("prime256v1");
  if (privateKey) ecdh.setPrivateKey(privateKey); else ecdh.generateKeys();
  return ecdh;
}

// -> the request body for one push message (RFC 8291 section 3, one aes128gcm record, RFC 8188): header (salt, record size, the
// sender's public key as the key id) then the encrypted payload and its 16-octet tag.
//   plaintext   Buffer or string
//   p256dh      the subscription's public key, base64url (65 octets, 0x04...)
//   auth        the subscription's authentication secret, base64url (16 octets)
//   salt, ephemeralPrivateKey   only for the RFC's test vector; random per message otherwise
function encryptPayload(plaintext, { p256dh, auth, salt, ephemeralPrivateKey }) {
  const data = Buffer.isBuffer(plaintext) ? plaintext : utf8(String(plaintext));
  // push services take 4096 octets of body at most: the 86-octet header, the data, the delimiter octet and the 16-octet tag
  if (HEADER_LENGTH + data.length + 1 + 16 > RECORD_SIZE) throw new Error("push payload too long");
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("bad subscription key");
  if (authSecret.length !== 16) throw new Error("bad subscription auth secret");
  const saltBytes = salt ? Buffer.from(salt) : crypto.randomBytes(16);
  const sender = ecdhWith(ephemeralPrivateKey);
  const asPublic = sender.getPublicKey();                       // uncompressed, 65 octets
  const ecdhSecret = sender.computeSecret(uaPublic);            // throws for a point that is not on the curve
  // RFC 8291 section 3.4: mix in the authentication secret, then derive the content-encryption key and nonce (RFC 8188 section 2.2/2.3)
  const keyInfo = Buffer.concat([utf8("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, saltBytes, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, saltBytes, utf8("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  saltBytes.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

// The P-256 key pair behind the VAPID keys (raw base64url: public 65 octets, private 32), as node KeyObjects; null for malformed ones.
function vapidKeyObjects(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  const priv = unb64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) return null;
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
  try {
    return {
      publicKey: crypto.createPublicKey({ key: jwk, format: "jwk" }),
      privateKey: crypto.createPrivateKey({ key: { ...jwk, d: b64u(priv) }, format: "jwk" }),
    };
  } catch (_err) {
    return null;
  }
}

// -> the `Authorization` header value of RFC 8292: "vapid t=<ES256 JWT>, k=<the public key>". The JWT's `aud` is the endpoint's origin,
// `exp` is 12 hours out (the limit is 24) and `sub` is the configured subject.
function vapidAuthorization(endpoint, { subject, publicKey, privateKey }, nowMs = Date.now()) {
  const keys = vapidKeyObjects(publicKey, privateKey);
  if (!keys) throw new Error("bad VAPID keys");
  const aud = new URL(endpoint).origin;
  const signingInput = `${b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64u(JSON.stringify({
    aud, exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S, sub: subject,
  }))}`;
  // a JWT's ES256 signature is the raw r || s (IEEE P1363), not DER
  const signature = crypto.sign("sha256", utf8(signingInput), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${b64u(signature)}, k=${publicKey}`;
}

// Whether a `topic` header value is valid (RFC 8030: at most 32 characters of the URL-safe base64 alphabet).
const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;
const URGENCIES = new Set(["very-low", "low", "normal", "high"]);

// A sendNotification with its own fetch, clock and (for the test vector) salt and ephemeral key.
function createWebPush({ fetchImpl, now = Date.now, salt, ephemeralPrivateKey } = {}) {
  async function sendNotification(subscription, payload, options = {}) {
    const { vapidDetails, TTL = 0, urgency, topic, timeout = DEFAULT_TIMEOUT_MS } = options;
    if (!subscription || typeof subscription.endpoint !== "string" || !subscription.keys) throw new Error("bad subscription");
    if (!vapidDetails) throw new Error("no VAPID details");
    const body = encryptPayload(typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload), {
      p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, salt, ephemeralPrivateKey,
    });
    const headers = {
      Authorization: vapidAuthorization(subscription.endpoint, vapidDetails, now()),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(Math.max(0, Math.floor(Number(TTL)) || 0)),
    };
    if (urgency && URGENCIES.has(urgency)) headers.Urgency = urgency;
    if (topic && TOPIC_RE.test(topic)) headers.Topic = topic;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let response;
    try {
      // redirect: "manual", so a push service cannot bounce the server to another address (a 3xx is a failure like any non-2xx)
      response = await (fetchImpl || fetch)(subscription.endpoint, { method: "POST", headers, body, signal: ac.signal, redirect: "manual" });
    } catch (err) {
      // a timeout or a network failure: no status, and nothing of the endpoint in the error
      throw Object.assign(new Error(err && err.name === "AbortError" ? "push service timed out" : "push service unreachable"), { name: err && err.name === "AbortError" ? "AbortError" : "FetchError" });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 200 && response.status < 300) return { statusCode: response.status };
    throw Object.assign(new Error(`push service answered ${response.status}`), { statusCode: response.status });
  }
  return { sendNotification };
}

module.exports = { encryptPayload, vapidAuthorization, vapidKeyObjects, createWebPush, sendNotification: (...args) => createWebPush().sendNotification(...args) };
