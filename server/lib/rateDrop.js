"use strict";
// The one rule for "rates dropped", shared by the briefing's lead and the rate-drop ping (lib/pings/), so the two never contradict
// each other. Pure: no database, no clock.

// The drop sizes a user may choose, in points; the smallest is the default and the one the briefing has always used.
const DEFAULT_THRESHOLD = 0.125;
const THRESHOLDS = [0.125, 0.25, 0.375, 0.5];

module.exports = { DEFAULT_THRESHOLD, THRESHOLDS };
