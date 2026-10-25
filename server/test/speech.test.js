"use strict";
// toSpeech (lib/assistant/speech.js): the text-to-speech normalizer. Bill's standing rule is that a
// spoken script spells out every number; the on-screen transcript keeps its digits and only the text
// sent to the voice goes through here. Pure and deterministic, so it is table-tested.
const test = require("node:test");
const assert = require("node:assert");
const { toSpeech } = require("../lib/assistant/speech");

// [input, expected] rows -> one assertion each, named by the input.
function table(rows) {
  for (const [input, expected] of rows) {
    assert.strictEqual(toSpeech(input), expected, JSON.stringify(input));
  }
}

test("percents: digits after the point are read one by one, trailing zeros included", () => {
  table([
    ["7.40%", "seven point four zero percent"],
    ["6.5%", "six point five percent"],
    ["12%", "twelve percent"],
    ["0.5%", "zero point five percent"],
    ["100%", "one hundred percent"],
    ["7 %", "seven percent"],
    ["-0.25%", "minus zero point two five percent"],
    ["the rate is 6.52 percent", "the rate is six point five two percent"],
    ["(down 0.125%)", "(down zero point one two five percent)"],
  ]);
});

test("money: dollars and cents, commas, singular forms, magnitude words", () => {
  table([
    ["$412", "four hundred twelve dollars"],
    ["$485,000", "four hundred eighty-five thousand dollars"],
    ["$1,250.50", "one thousand two hundred fifty dollars and fifty cents"],
    ["$1", "one dollar"],
    ["$1.01", "one dollar and one cent"],
    ["$1.50", "one dollar and fifty cents"],
    ["$0.99", "ninety-nine cents"],
    ["$0.05", "five cents"],
    ["$0.01", "one cent"],
    ["$0", "zero dollars"],
    ["$2,000.00", "two thousand dollars"],
    ["$1,000,000", "one million dollars"],
    ["$2 million", "two million dollars"],
    ["$1.2 million", "one point two million dollars"],
    ["$1.25 Million", "one point two five Million dollars"],
    ["$3 billion", "three billion dollars"],
    ["$1.5", "one point five dollars"],
    ["$485K", "four hundred eighty-five thousand dollars"],
    ["$250k.", "two hundred fifty thousand dollars."],
    ["$1.2M loan", "one point two million dollars loan"],
    ["$3b", "three billion dollars"],
    ["$5 m", "five dollars m"],
    ["a $12 fee and $3.50 back", "a twelve dollars fee and three dollars and fifty cents back"],
    ["$412.", "four hundred twelve dollars."],
    ["$485,000, then $1,250.50.", "four hundred eighty-five thousand dollars, then one thousand two hundred fifty dollars and fifty cents."],
  ]);
});

test("hyphenated N-year and N-month compounds keep their hyphen", () => {
  table([
    ["30-year", "thirty-year"],
    ["6-month", "six-month"],
    ["15-year fixed", "fifteen-year fixed"],
    ["the 30-year and 15-year rates", "the thirty-year and fifteen-year rates"],
    ["a 5-10 year hold", "a five-ten year hold"],
    ["COVID-19", "COVID-nineteen"],
  ]);
});

test("plain integers, with or without commas, up to hundreds of billions", () => {
  table([
    ["0", "zero"],
    ["1", "one"],
    ["12", "twelve"],
    ["19", "nineteen"],
    ["20", "twenty"],
    ["21", "twenty-one"],
    ["40", "forty"],
    ["99", "ninety-nine"],
    ["100", "one hundred"],
    ["101", "one hundred one"],
    ["412", "four hundred twelve"],
    ["760", "seven hundred sixty"],
    ["1,001", "one thousand one"],
    ["1000", "one thousand"],
    ["1,250", "one thousand two hundred fifty"],
    ["2026", "two thousand twenty-six"],
    ["485,000", "four hundred eighty-five thousand"],
    ["1,000,000", "one million"],
    ["1,250,000", "one million two hundred fifty thousand"],
    ["2,500,000,000", "two billion five hundred million"],
    [
      "999,999,999,999",
      "nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine",
    ],
    ["4 opportunities", "four opportunities"],
    ["12 check-ins", "twelve check-ins"],
  ]);
});

test("integers that are really identifiers are read digit by digit", () => {
  table([
    ["007", "zero zero seven"],
    ["05", "zero five"],
    ["1234567890123", "one two three four five six seven eight nine zero one two three"],
  ]);
});

test("a thousands group that is not a group is read as separate numbers", () => {
  table([
    ["1,2500", "one,two thousand five hundred"],
    ["1,2,3", "one,two,three"],
  ]);
});

test("decimals: every digit after the point is read one by one", () => {
  table([
    ["6.52", "six point five two"],
    ["0.05", "zero point zero five"],
    ["7.40", "seven point four zero"],
    ["3.14159", "three point one four one five nine"],
    ["1,250.5", "one thousand two hundred fifty point five"],
    ["12.0", "twelve point zero"],
  ]);
});

test("a full stop after a number is a full stop, not a decimal point", () => {
  table([
    ["The rate is 7.", "The rate is seven."],
    ["It closed at 12. Then 4.", "It closed at twelve. Then four."],
    ["Call me at 5, or 6.", "Call me at five, or six."],
  ]);
});

test("negative numbers are spoken with minus", () => {
  table([
    ["down -3", "down minus three"],
    ["(-3)", "(minus three)"],
    ["-5", "minus five"],
    ["-$5", "minus five dollars"],
    ["a-3", "a-three"],
  ]);
});

test("ISO dates are read as a month, an ordinal day and a spoken year", () => {
  table([
    ["2026-01-01", "January first, twenty twenty-six"],
    ["2026-10-21", "October twenty-first, twenty twenty-six"],
    ["1999-12-31", "December thirty-first, nineteen ninety-nine"],
    ["2005-03-02", "March second, two thousand five"],
    ["2000-07-04", "July fourth, two thousand"],
    ["2026-11-30", "November thirtieth, twenty twenty-six"],
    ["2026-02-12", "February twelfth, twenty twenty-six"],
    ["2026-05-03", "May third, twenty twenty-six"],
    ["1905-06-22", "June twenty-second, nineteen oh five"],
    ["1900-09-09", "September ninth, nineteen hundred"],
    ["Closes on 2026-01-01.", "Closes on January first, twenty twenty-six."],
    ["from 2026-01-01 to 2026-12-31", "from January first, twenty twenty-six to December thirty-first, twenty twenty-six"],
  ]);
});

test("B8: a time right after an ISO date is dropped; the date alone is read (a stored last contact is a datetime)", () => {
  table([
    ["2026-10-14 14:03:11", "October fourteenth, twenty twenty-six"],
    ["Last contact was logged on 2026-10-14 14:03:11.", "Last contact was logged on October fourteenth, twenty twenty-six."],
    ["2026-10-14T14:03:11", "October fourteenth, twenty twenty-six"],
    ["2026-10-14T14:03:11Z", "October fourteenth, twenty twenty-six"],
    ["2026-10-14T14:03:11.250Z, then", "October fourteenth, twenty twenty-six, then"],
    ["2026-10-14 09:30", "October fourteenth, twenty twenty-six"],
    // a time on its own, or one that is not a time, is unchanged (read as the plain numbers it contains)
    ["at 14:03:11", "at fourteen:zero three:eleven"],
    ["2026-10-14 25:00:00", "October fourteenth, twenty twenty-six twenty-five:zero zero:zero zero"],
  ]);
});

test("a hyphenated run of numbers that is not a real date is not read as one", () => {
  table([
    ["2026-13-01", "two thousand twenty-six-thirteen-zero one"],
    ["2026-01-32", "two thousand twenty-six-zero one-thirty-two"],
  ]);
});

test("ordinals", () => {
  table([
    ["1st", "first"],
    ["2nd", "second"],
    ["3rd", "third"],
    ["4th", "fourth"],
    ["5th", "fifth"],
    ["8th", "eighth"],
    ["9th", "ninth"],
    ["11th", "eleventh"],
    ["12th", "twelfth"],
    ["20th", "twentieth"],
    ["21st", "twenty-first"],
    ["100th", "one hundredth"],
    ["your 1st mortgage", "your first mortgage"],
  ]);
});

test("ARM product names are read the way brokers say them: 5/1 ARM is five one ARM", () => {
  table([
    ["5/1 ARM", "five one ARM"],
    ["7/6 ARM", "seven six ARM"],
    ["10/6 ARM", "ten six ARM"],
    ["5 / 1 ARM", "five one ARM"],
    ["5/1 ARMs", "five one ARMs"],
    ["a 5/1 ARM and a 7/1 ARM", "a five one ARM and a seven one ARM"],
    ["Lopez has a 5/1 ARM at 8.25%.", "Lopez has a five one ARM at eight point two five percent."],
    ["the 5/1 ARM is at 5.81%", "the five one ARM is at five point eight one percent"],
    ["Good news: 30-year fixed or 5/1 ARM?", "Good news: thirty-year fixed or five one ARM?"],
  ]);
});

test("other slash forms are unchanged: the slash stays between the spoken numbers", () => {
  table([
    ["5/1", "five/one"],
    ["5/1 fixed", "five/one fixed"],
    ["5/1 arm", "five/one arm"],
    ["10/21", "ten/twenty-one"],
    ["and/or 3/4 of it", "and/or three/four of it"],
    ["1/2/2026", "one/two/two thousand twenty-six"],
    ["5/1 ARMY", "five/one ARMY"],
    ["100/6 ARM", "one hundred/six ARM"],
    ["5/100 ARM", "five/one hundred ARM"],
  ]);
});

test("an ampersand is spoken as and", () => {
  table([
    ["Robert & Linda Chen", "Robert and Linda Chen"],
    ["R&D", "R and D"],
    ["AT&T", "AT and T"],
  ]);
});

test("markdown symbols are stripped", () => {
  table([
    ["**Good** _news_", "Good news"],
    ["# Heading", "Heading"],
    ["`code`", "code"],
    ["* item", "item"],
    ["a_b", "ab"],
    ["**7.40%**", "seven point four zero percent"],
    ["*4* opportunities", "four opportunities"],
  ]);
});

test("whitespace is collapsed and trimmed", () => {
  table([
    ["  a \n\n b\t c  ", "a b c"],
    ["one\r\ntwo", "one two"],
    ["   ", ""],
    ["", ""],
  ]);
});

test("digits stuck to letters are separated so the words do not run together", () => {
  table([
    ["Q4", "Q four"],
    ["401k", "four hundred one k"],
    ["5x", "five x"],
    ["H2O", "H two O"],
    ["4K", "four K"],
  ]);
});

test("words and punctuation are left alone", () => {
  table([
    ["No numbers here, just words.", "No numbers here, just words."],
    ["Want a market update, a sweep of your book, or something else?", "Want a market update, a sweep of your book, or something else?"],
    ["Hmm... okay; fine: (yes) \"sure\" — done!", "Hmm... okay; fine: (yes) \"sure\" — done!"],
    ["Sorry — I hit a snag on my end.", "Sorry — I hit a snag on my end."],
  ]);
});

test("anything that is not a string speaks as nothing", () => {
  for (const v of [undefined, null, 42, {}, [], true]) assert.strictEqual(toSpeech(v), "", String(v));
});

test("the greeting: digits spelled out, words untouched", () => {
  assert.strictEqual(
    toSpeech("Good morning, Bill. You have 4 opportunities and 12 check-ins due; the 30-year is at 7.40%."),
    "Good morning, Bill. You have four opportunities and twelve check-ins due; the thirty-year is at seven point four zero percent."
  );
  assert.strictEqual(
    toSpeech("Good afternoon, Ann. You have 1 opportunity and 1 check-in due; the 30-year is at 6.52% (estimated). " +
      "Want a market update, a sweep of your book, or something else?"),
    "Good afternoon, Ann. You have one opportunity and one check-in due; the thirty-year is at six point five two percent (estimated). " +
      "Want a market update, a sweep of your book, or something else?"
  );
});

test("a typical spoken reply with money, a rate and a date", () => {
  assert.strictEqual(
    toSpeech("Robert & Linda Chen are at 7.85% on a $485,000 balance; their last contact was 2024-01-01."),
    "Robert and Linda Chen are at seven point eight five percent on a four hundred eighty-five thousand dollars balance; " +
      "their last contact was January first, twenty twenty-four."
  );
});

test("deterministic and idempotent: the output has nothing left to normalize", () => {
  const samples = [
    "Good morning, Bill. You have 4 opportunities and 12 check-ins due; the 30-year is at 7.40%.",
    "$1,250.50 on 2026-10-21 at 6.5% for the 1st time & 30-year **fixed**",
    "Q4 401k -3 12. 007",
    "",
  ];
  for (const s of samples) {
    assert.strictEqual(toSpeech(s), toSpeech(s));
    assert.strictEqual(toSpeech(toSpeech(s)), toSpeech(s), s);
    assert.doesNotMatch(toSpeech(s), /[0-9&*_#`$%]/, "no digits or symbols left: " + s);
  }
});
