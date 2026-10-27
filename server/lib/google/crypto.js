"use strict";
// Encryption for the Google tokens at rest: AES-256-GCM under GOOGLE_TOKEN_KEY (base64 of 32 random bytes).
// A blob is "v1:" + base64(iv12 | tag16 | ciphertext). GCM authenticates, so a flipped byte or another key makes
// decrypt throw instead of returning garbage. The key is read on each call (never cached, never logged), and no
// error here carries the text being encrypted or the key.
const crypto = require("crypto");

const VERSION = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// The key as a Buffer, or null when GOOGLE_TOKEN_KEY is unset or is not exactly 32 bytes of base64.
function readKey() {
  const raw = (process.env.GOOGLE_TOKEN_KEY || "").trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === KEY_BYTES ? key : null;
}

const hasTokenKey = () => readKey() !== null;

function requireKey() {
  const key = readKey();
  if (!key) throw new Error("GOOGLE_TOKEN_KEY is not set to base64 of 32 bytes");
  return key;
}

function encrypt(text) {
  if (typeof text !== "string") throw new TypeError("encrypt needs a string");
  const key = requireKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function decrypt(blob) {
  if (typeof blob !== "string" || !blob.startsWith(VERSION)) throw new Error("not an encrypted token");
  const key = requireKey();
  const raw = Buffer.from(blob.slice(VERSION.length), "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("encrypted token is too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

module.exports = { hasTokenKey, encrypt, decrypt };
