"use strict";
// Spoken date labels shared by lib/rateHistory.js ("since October 18th") and lib/google/time.js ("Friday, October 30th").
// Kept apart from rateHistory.js because that module requires ../db, which opens SQLite on require; this one is pure.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 / 12 / 13 -> "11th" / "12th" / "13th", 21 -> "21st", 22 -> "22nd", 31 -> "31st"
const ordinal = (n) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
  return `${n}${suffix}`;
};

module.exports = { MONTHS, WEEKDAYS, ordinal };
