"use strict";
// The words of a rate-drop ping, all written by code from FRED data: market news only, never a client, never a model's sentence.
// The numbers and dates are the briefing's (rateDrop.marketMove, rateHistory.sinceLabel), so the ping and Charlie never disagree.
const { sinceLabel } = require("../rateHistory");

// `drop` is rateDrop.marketMove's; `localDate` is the user's own day (YYYY-MM-DD), which decides whether a date names its year.
function pingText(drop, localDate) {
  const down = Number(Math.abs(drop.move30).toFixed(2));
  return {
    title: "Rates dropped",
    body: `The national average 30-year is ${drop.rate30}%, down ${down} since ${sinceLabel(drop.sinceDate, localDate)} `
      + `(as of ${sinceLabel(drop.obsDate, localDate)}). Open Charlie for a sweep.`,
    url: "/",
    tag: "rate-drop",
  };
}

// What "Send a test" shows on the device (routes/alerts.js).
const TEST_TEXT = Object.freeze({
  title: "Broker Radar", body: "Test notification: rate-drop pings will arrive on this device.", url: "/", tag: "rate-drop-test",
});

module.exports = { pingText, TEST_TEXT };
