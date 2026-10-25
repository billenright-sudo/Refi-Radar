"use strict";
// toSpeech(text): the text the voice is given. Bill's standing rule for anything spoken is that every number
// is spelled out, so "7.40%" is sent as "seven point four zero percent". The on-screen transcript keeps its
// digits; only the text sent to speech synthesis goes through here. Pure and deterministic.
//
//   percents   7.40% -> seven point four zero percent
//   money      $1,250.50 -> one thousand two hundred fifty dollars and fifty cents ($1.2 million -> one point
//              two million dollars, $485K -> four hundred eighty-five thousand dollars)
//   integers   12 -> twelve, 1,250 -> one thousand two hundred fifty (up to hundreds of billions; an
//              identifier-shaped run, such as 007 or a 13-digit number, is read digit by digit)
//   decimals   6.52 -> six point five two (digit by digit after the point)
//   compounds  30-year -> thirty-year (the hyphen stays)
//   ARM names  5/1 ARM -> five one ARM (any other slash stays between the spoken numbers: 5/1 -> five/one)
//   ordinals   1st -> first
//   dates      2026-01-01 -> January first, twenty twenty-six; a time right after the date (2026-01-01 14:03:11,
//              2026-01-01T14:03:11Z, as a stored last contact reads) is dropped: the date alone is read
//   negatives  -3 -> minus three
//   also       "&" -> "and", markdown symbols (* _ # `) dropped, whitespace collapsed
//
// Words are left alone. Not handled (read as the plain numbers they contain): times like 9:30, other
// slash forms such as 10/21, phone numbers, ZIP codes, and non-ISO dates.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];
const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
];
const IRREGULAR_ORDINALS = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

// The longest run of digits read as one number. Longer is an identifier (an account number), read digit by digit.
const MAX_NUMBER_DIGITS = 12;

// 1..999 -> "four hundred twelve", "forty-five"
function belowThousand(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)], "hundred"); n %= 100; }
  if (n >= 20) out.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : ""));
  else if (n > 0) out.push(ONES[n]);
  return out.join(" ");
}

// "507" -> "five zero seven"
const digitWords = (digits) => [...digits].map((d) => ONES[Number(d)]).join(" ");

// A run of digits (no commas) -> "one thousand two hundred fifty"
function integerWords(digits) {
  if (digits.length > MAX_NUMBER_DIGITS || (digits.length > 1 && digits[0] === "0")) return digitWords(digits);
  let n = Number(digits);
  if (n === 0) return "zero";
  const out = [];
  for (const [size, name] of SCALES) {
    if (n >= size) { out.push(belowThousand(Math.floor(n / size)), name); n %= size; }
  }
  if (n > 0) out.push(belowThousand(n));
  return out.join(" ");
}

// "6", "52" -> "six point five two"; "6", undefined -> "six"
const decimalWords = (whole, fraction) =>
  integerWords(whole) + (fraction === undefined ? "" : " point " + digitWords(fraction));

// "twenty-one" -> "twenty-first", "four" -> "fourth", "twenty" -> "twentieth"
const ordinalWords = (cardinal) => cardinal.replace(/[a-z]+$/, (word) =>
  IRREGULAR_ORDINALS[word] || (word.endsWith("y") ? word.slice(0, -1) + "ieth" : word + "th"));

// 2026 -> "twenty twenty-six", 1999 -> "nineteen ninety-nine", 2005 -> "two thousand five", 1905 -> "nineteen oh five"
function yearWords(year) {
  if (year >= 2000 && year <= 2009) return year === 2000 ? "two thousand" : "two thousand " + ONES[year - 2000];
  const high = integerWords(String(Math.floor(year / 100)));
  const low = year % 100;
  if (low === 0) return high + " hundred";
  return high + " " + (low < 10 ? "oh " + ONES[low] : integerWords(String(low)));
}

// String#replace for a rule whose output replaces digits: if the match was stuck to a letter (Q4, 401k, 5x),
// a space goes in so the words do not run together ("Q four", "four hundred one k"). `render` gets the
// capture groups (undefined when they did not take part).
function replaceNumbers(text, pattern, render) {
  const isLetter = (ch) => ch !== undefined && /[A-Za-z]/.test(ch);
  return text.replace(pattern, (...args) => {
    const input = args[args.length - 1];
    const offset = args[args.length - 2];
    const match = args[0];
    const spoken = render(...args.slice(1, -2));
    return (isLetter(input[offset - 1]) ? " " : "") + spoken + (isLetter(input[offset + match.length]) ? " " : "");
  });
}

// (the optional " HH:MM:SS" / "THH:MM:SS" tail, with fractional seconds and a zone, is matched so that it is dropped)
const ISO_DATE =
  /(?<!\d)((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)/g;
const ORDINAL = /(?<![\d.,])(\d+)(?:st|nd|rd|th)\b/gi;
const MINUS = /(^|[\s(])-(?=\$?\d)/g;
// The loan type "5/1 ARM" (also 7/6, 10/6): brokers say "five one ARM", not "five slash one".
const ARM = /(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?=\s+ARMs?\b)/g;
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+))?(?:\s+(thousand|million|billion|trillion)\b|([kmb])\b)?/gi;
const MAGNITUDE = { k: "thousand", m: "million", b: "billion" };   // $485K, $1.2M
const NUMBER = /(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+))?(\s?%)?/g;

function moneyWords(whole, fraction, magnitude) {
  const digits = whole.replace(/,/g, "");
  // $1.2 million: the figure is read as written, then the magnitude word
  if (magnitude) return `${decimalWords(digits, fraction)} ${magnitude} dollars`;
  // $1,250.50 -> dollars and cents; any other number of decimals ($1.5, $1.255) is read as a plain decimal
  if (fraction !== undefined && fraction.length !== 2) return `${decimalWords(digits, fraction)} dollars`;
  const cents = fraction === undefined ? 0 : Number(fraction);
  const dollars = `${integerWords(digits)} ${digits === "1" ? "dollar" : "dollars"}`;
  if (cents === 0) return dollars;
  const centsWords = `${integerWords(String(cents))} ${cents === 1 ? "cent" : "cents"}`;
  return Number(digits) === 0 ? centsWords : `${dollars} and ${centsWords}`;
}

function toSpeech(text) {
  if (typeof text !== "string") return "";
  let s = text;
  s = s.replace(/[*_#`]/g, "");                      // markdown
  s = s.replace(/&/g, " and ");
  s = replaceNumbers(s, ISO_DATE, (year, month, day) =>
    `${MONTHS[Number(month) - 1]} ${ordinalWords(integerWords(String(Number(day))))}, ${yearWords(Number(year))}`);
  s = replaceNumbers(s, ORDINAL, (digits) => ordinalWords(integerWords(digits)));
  s = s.replace(MINUS, "$1minus ");
  s = replaceNumbers(s, ARM, (fixed, adjustable) => `${integerWords(fixed)} ${integerWords(adjustable)}`);
  s = replaceNumbers(s, MONEY, (whole, fraction, word, letter) =>
    moneyWords(whole, fraction, word || (letter && MAGNITUDE[letter.toLowerCase()])));
  s = replaceNumbers(s, NUMBER, (whole, fraction, percent) =>
    decimalWords(whole.replace(/,/g, ""), fraction) + (percent ? " percent" : ""));
  s = s.replace(/%/g, " percent");                   // a percent sign with no number in front of it
  return s.replace(/\s+/g, " ").trim();
}

module.exports = { toSpeech };
