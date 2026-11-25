"use strict";
// The phone channel of a rate-drop ping: the VAPID settings (from environment settings read by NAME only), the allowlist of push-service
// hosts a subscription may name, and the sender that turns a send into { ok, gone, status }. The sender logs nothing itself: its caller
// (lib/pings/rateCheck.js) counts. An error is never described beyond its HTTP status: not by the push service's words, an endpoint,
// a key or a user.
const crypto = require("node:crypto");
const { vapidKeyObjects } = require("./webpushLite");

const unb64u = (text) => Buffer.from(String(text), "base64url");

// -> { enabled, reason, publicKey, privateKey, subject }. `env` is process.env. Push is on only with both VAPID keys (base64url: the
// public one 65 octets starting 0x04, the private one 32, and a pair that belong together) and a subject the push service can reach
// the sender by (RFC 8292): APP_URL when it is https://, else mailto:<EMAIL_USER>. `reason` says why not, never carrying a value; the
// keys are in the answer only when push is on.
function pushConfig(env) {
  const off = (reason) => ({ enabled: false, reason, publicKey: null, privateKey: null, subject: null });
  const publicKey = typeof env.VAPID_PUBLIC_KEY === "string" ? env.VAPID_PUBLIC_KEY.trim() : "";
  const privateKey = typeof env.VAPID_PRIVATE_KEY === "string" ? env.VAPID_PRIVATE_KEY.trim() : "";
  if (!publicKey || !privateKey) return off("VAPID keys not set");
  if (!isVapidPair(publicKey, privateKey)) return off("VAPID keys malformed");
  const appUrl = typeof env.APP_URL === "string" ? env.APP_URL.trim() : "";
  const mailUser = typeof env.EMAIL_USER === "string" ? env.EMAIL_USER.trim() : "";
  const subject = /^https:\/\/[^\s]+$/i.test(appUrl) ? appUrl : mailUser ? `mailto:${mailUser}` : null;
  if (!subject) return off("no https APP_URL or EMAIL_USER for the VAPID subject");
  return { enabled: true, reason: "", publicKey, privateKey, subject };
}

// Whether the two strings are a real P-256 key pair: the right lengths, and the public key is the one the private key makes.
function isVapidPair(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  const priv = unb64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32 || !vapidKeyObjects(publicKey, privateKey)) return false;
  try {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch (_err) {
    return false;
  }
}

// The push services a browser's subscription can name. The server POSTs to a stored endpoint, so anything else (an internal address, a
// look-alike host) is refused when it is stored (SSRF). https only, no credentials, the default port.
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
const ENDPOINT_MAX = 2048;

function isPushEndpoint(url) {
  if (typeof url !== "string" || !url || url.length > ENDPOINT_MAX) return false;
  let parsed;
  try { parsed = new URL(url); } catch (_err) { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

const GONE = new Set([404, 410]);
const SEND_TIMEOUT_MS = 10_000;

// -> { send(sub, payload, { ttlSeconds, topic = "rate-drop" }) -> Promise<{ ok: true } | { ok: false, gone: boolean, status: number | null }> }.
//   sub      { endpoint, p256dh, auth } (a push_subscriptions row) or { endpoint, keys: { p256dh, auth } }
//   payload  the object a service worker reads (pingText's)
// `webpush` is anything with the `web-push` package's sendNotification; the default is lib/pings/webpushLite.js, loaded on first use.
// 404 and 410 mean the device is gone for good (the caller deletes the subscription); 429, 5xx, a timeout or a network failure are
// a failed send that may work next time.
function createPushSender(config, { webpush } = {}) {
  const sender = () => webpush || require("./webpushLite");
  return {
    async send(sub, payload, { ttlSeconds, topic = "rate-drop" }) {
      const subscription = { endpoint: sub.endpoint, keys: sub.keys || { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        const result = await sender().sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: ttlSeconds,
          urgency: "normal",
          topic,
          timeout: SEND_TIMEOUT_MS,
        });
        const status = result && Number.isInteger(result.statusCode) ? result.statusCode : 201;
        if (status >= 200 && status < 300) return { ok: true };
        return { ok: false, gone: GONE.has(status), status };
      } catch (err) {
        const status = err && Number.isInteger(err.statusCode) ? err.statusCode : null;
        return { ok: false, gone: status !== null && GONE.has(status), status };
      }
    },
  };
}

// A new VAPID key pair, as the two base64url strings the settings take (public 65 octets = 87 characters, private 32 = 43). Made from
// the system's random source and held in memory: nothing is written anywhere (scripts/vapid-keys.js decides where each goes).
function makeVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicBytes = Buffer.concat([Buffer.from([0x04]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: publicBytes.toString("base64url"), privateKey: jwk.d };
}

module.exports = { pushConfig, isPushEndpoint, createPushSender, makeVapidKeys, PUSH_HOSTS };
