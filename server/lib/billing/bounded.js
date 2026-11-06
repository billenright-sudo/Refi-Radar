"use strict";
// A Stripe push that has to land before the answer (Cloud Run throttles the CPU once a response has gone), without letting a slow
// Stripe hold the person up for long: the user count after a loan officer joins or is removed (H2), and the billing email after a
// broker's login email changes (H14). PUSH_WAIT_MS is the wait; app.set("billingPushWaitMs", n) overrides it (tests).
const PUSH_WAIT_MS = 8_000;

// Runs `work` and waits for it for at most `waitMs`. -> true when it finished (a failure included: `onError` gets the error), false when
// the wait gave up (the work carries on, and a later failure still reaches onError). Never rejects; the timer is always cleared.
async function withinBound(work, waitMs, onError) {
  let timer;
  const done = Promise.resolve().then(work).then(() => true, (err) => { onError(err); return true; });
  const gaveUp = new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); });
  try {
    return await Promise.race([done, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

// The push named `type` for organization `orgId` (our own id, the only thing logged with the error's message), within the app's wait.
// Never rejects.
async function pushBeforeAnswer(app, type, orgId, work) {
  const waitMs = app.get("billingPushWaitMs") ?? PUSH_WAIT_MS;
  try {
    const finished = await withinBound(work, waitMs, (err) => console.error(`[billing] ${type} failed for org ${orgId}:`, err?.message));
    if (!finished) console.error(`[billing] ${type} for org ${orgId} not finished after ${waitMs} ms: answered without it`);
  } catch (err) {
    console.error(`[billing] ${type} failed for org ${orgId}:`, err?.message);
  }
}

module.exports = { withinBound, pushBeforeAnswer, PUSH_WAIT_MS };
