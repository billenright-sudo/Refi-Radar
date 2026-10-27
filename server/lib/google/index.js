"use strict";
// The per-user Google adapter the assistant tools receive as ctx.google (the /turn route builds one per request):
// everything Charli may do with a broker's Google account, bound to ONE user id, so a tool cannot reach another user's
// calendar. It holds no token: a token is fetched (and refreshed) inside each call, used for that call and dropped.
//
//   connection()        { timeZone, googleEmail } | { code: "not_connected" | "reconnect" }
//                       Reads the stored row only. No network, no token. Cheap enough to ask before every tool call.
//   listDay({ date })   { events } | { error } | { code }       one calendar day, titles and spoken times (./calendar.js)
//   insertEvent(event)  { eventId } | { duplicate: true } | { error } | { code }
//                       event = { id, title, date, time, durationMinutes, timeZone? }; the event's own time zone wins, else
//                       the calendar's. No attendees, no invitations.
//
// A `{ code }` is oauth.accessToken's failure passed straight back ("not_connected", "reconnect", "unavailable") with no
// call made to Calendar. Nothing touches the network until listDay or insertEvent is called.
//
// A Calendar call that Google itself refuses as unauthorised (401, or a 403 for an auth reason: ./calendar.js) is
// { code: "reconnect" } too, and the connection is flagged 'reconnect' on the spot, so nothing keeps trying a token Google has
// stopped honouring. The flag is guarded by the refresh token the call was made under (oauth.markReconnect): a connection the
// user has redone while the call was in flight is left alone.
//
// `now` (epoch ms) is for tests; left out, the clock is read at each call. `fetchFn` defaults to the global fetch.
const { accessToken, getConnection, markReconnect, refreshTokenOf } = require("./oauth");
const calendar = require("./calendar");

function googleFor({ db, userId, fetchFn = globalThis.fetch, now } = {}) {
  const clock = () => (Number.isFinite(now) ? now : Date.now());

  // The token for this call, or the { code } to hand back. `refreshEnc` is read right after the token (nothing else can run in
  // between), so it names the connection the token came from, even when the token step just rotated the refresh token.
  async function authorize() {
    const auth = await accessToken(db, userId, fetchFn, clock());
    if (!auth || !auth.token) return { failure: { code: (auth && auth.code) || "unavailable" } };
    return { auth, refreshEnc: refreshTokenOf(db, userId) };
  }

  // A Calendar answer of { code: "reconnect" } means Google refused this connection's token: flag it, whatever else happens.
  function settle(result, refreshEnc) {
    if (result && result.code === "reconnect" && refreshEnc) {
      try { markReconnect(db, userId, refreshEnc); } catch (_err) { /* the code is still handed back */ }
    }
    return result;
  }

  return {
    connection() {
      const row = getConnection(db, userId);
      if (!row) return { code: "not_connected" };
      if (row.status !== "connected") return { code: "reconnect" };
      return { timeZone: row.timeZone, googleEmail: row.googleEmail };
    },

    async listDay({ date } = {}) {
      const { auth, refreshEnc, failure } = await authorize();
      if (failure) return failure;
      return settle(await calendar.listDay(auth.token, { date, timeZone: auth.timeZone }, fetchFn), refreshEnc);
    },

    async insertEvent(event) {
      const booking = event && typeof event === "object" ? event : {};
      const { auth, refreshEnc, failure } = await authorize();
      if (failure) return failure;
      return settle(await calendar.insertEvent(auth.token, { ...booking, timeZone: booking.timeZone || auth.timeZone }, fetchFn), refreshEnc);
    },
  };
}

module.exports = { googleFor };
