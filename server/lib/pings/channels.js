"use strict";
// Start-up wiring for the rate-drop pings: whether the rate check is on, and the two channels (phone push, email) as the objects the
// rate check and the Profile routes use. Everything is read from environment settings by NAME; a reason names the setting that is
// missing, never a value, and the private VAPID key stays inside the sender's closure.
const { pushConfig, createPushSender } = require("./push");

const SECRET_MIN = 32;

// RATE_CHECK_SECRET with surrounding whitespace trimmed (a secret piped in from a shell can end in a newline), or "".
const rateCheckSecret = (env) => (typeof env.RATE_CHECK_SECRET === "string" ? env.RATE_CHECK_SECRET.trim() : "");

// -> { enabled, reason }: the door is open only with a secret of at least 32 characters, and there is nothing to check without FRED.
function rateCheckStatus(env) {
  const secret = rateCheckSecret(env);
  if (!secret) return { enabled: false, reason: "RATE_CHECK_SECRET not set" };
  if (secret.length < SECRET_MIN) return { enabled: false, reason: "RATE_CHECK_SECRET shorter than 32 characters" };
  if (!(typeof env.FRED_API_KEY === "string" && env.FRED_API_KEY.trim())) return { enabled: false, reason: "FRED_API_KEY not set" };
  return { enabled: true, reason: "" };
}

// -> { push, mail, line }.
//   push  { enabled: true, publicKey, send(sub, payload, { ttlSeconds }) } or null
//   mail  { enabled: true, sendRateDrop({ to, drop, localDate }), sendTestPing({ to }) } or null
//   line  the one start-up log line: "[pings] rate check on|off (<reason>), push on|off (<reason>), email on|off"
// `emailModule` is ../../email (mailReady, sendRateDrop, sendTestPing); a test passes its own.
function buildChannels(env, emailModule = require("../../email")) {
  const rate = rateCheckStatus(env);
  const config = pushConfig(env);
  const push = config.enabled ? { enabled: true, publicKey: config.publicKey, send: createPushSender(config).send } : null;
  const mail = emailModule.mailReady(env)
    ? { enabled: true, sendRateDrop: emailModule.sendRateDrop, sendTestPing: emailModule.sendTestPing }
    : null;
  const line = `[pings] rate check ${rate.enabled ? "on" : `off (${rate.reason})`}, push ${push ? "on" : `off (${config.reason})`}, email ${mail ? "on" : "off"}`;
  return { push, mail, line };
}

module.exports = { SECRET_MIN, rateCheckSecret, rateCheckStatus, buildChannels };
