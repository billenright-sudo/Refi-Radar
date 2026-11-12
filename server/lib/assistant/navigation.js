"use strict";
// Charlie opens screens: which sentences are "open a page" requests, the fixed code-written lines about a screen,
// and the cleaning of the browser's `onScreen`. Every line the broker reads about a screen is written here, never by
// the model. Pure: no I/O, no state, no figures.

// Page ids are the client's nav.mjs ids. Broker-only pages are the ones a broker's own account sees.
const SCREEN_PAGES = Object.freeze(["home", "sweeps", "clients", "rates", "add", "team", "import", "profile", "billing"]);
const BROKER_PAGES = Object.freeze(new Set(["team", "import", "billing"]));

const FORM_OPEN = "You've got a form open. Save or cancel it first, then ask me again.";
const BROKER_ONLY = "That page is for your broker's account.";
const BILLING_OFF = "Billing isn't turned on for your account yet.";
const COULDNT_OPEN = "I couldn't open that page.";

const PAGE_LINES = Object.freeze({
  home: "Here's Home.",
  sweeps: "Here's Sweeps.",
  clients: "Here's your client list.",
  rates: "Here's Rate Watch.",
  add: "Here's the Add Client form.",
  team: "Here's your team.",
  import: "Here's Import Clients.",
  profile: "Here's your profile.",
  billing: "Here's Billing.",
});

const ON_SCREEN_PAGES = new Set(["home", "sweeps", "clients", "rates", "team", "import", "profile", "billing", "client", "form"]);

// What the browser says is on screen: { page } or { page: "client", clientId }. Anything else is unknown (null).
function cleanOnScreen(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { page, clientId } = raw;
  if (typeof page !== "string" || !ON_SCREEN_PAGES.has(page)) return null;
  if (page === "client") {
    return Number.isInteger(clientId) && clientId > 0 ? { page, clientId } : null;
  }
  return { page };
}

const tidyName = (name) => (typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "");

function screenLine(screen, name) {
  if (screen && screen.page === "client") {
    const n = tidyName(name);
    return n ? `Here's ${n}.` : COULDNT_OPEN;
  }
  return (screen && Object.prototype.hasOwnProperty.call(PAGE_LINES, screen.page) && PAGE_LINES[screen.page]) || COULDNT_OPEN;
}

function alreadyLine(screen, name) {
  if (screen && screen.page === "client") {
    const n = tidyName(name);
    return n ? `You're already on ${n}'s page.` : COULDNT_OPEN;
  }
  const line = screenLine(screen);
  return line === COULDNT_OPEN ? line : line.replace("Here's ", "You're already on ");
}

function isAlreadyOn(screen, onScreen) {
  if (!screen || !onScreen || screen.page !== onScreen.page) return false;
  return screen.page !== "client" || screen.clientId === onScreen.clientId;
}

// ---- Recognizing a page request -------------------------------------------------------------------------------

const FILLER_RE = /^(?:hey\b[\s,]*|charl(?:ie|i)\b[\s,:]*|please\b[\s,]*|(?:can|could|would|will)\s+you\b[\s,]*|let's\s+|i\s+want\s+to\s+)/;
const STRONG_RE = /^(pull\s+up|bring\s+up|open|go\s+back\s+to|go\s+to|go\s+home|take\s+me\s+to|take\s+me\s+home|jump\s+to|switch\s+to|navigate\s+to|head\s+to)\b\s*(.*)$/;
const SOFT_RE = /^(?:show(?:\s+me)?|look\s+up)\b\s*(.*)$/;
const OPEN_NOT_A_PAGE_RE = /\b(?:e-?mails?|drafts?|gmail|outlook|mail|links?)\b/;
const PAGE_NAME_RE = /^(?:the\s+)?(?:home(?:\s+page)?|dashboard|sweeps(?:\s+page)?|(?:all|my)\s+clients|client\s+list|rate\s+watch|rates\s+page|add\s+(?:a\s+)?client|my\s+team|import(?:\s+clients)?|(?:my\s+)?profile|billing(?:\s+page)?)$/;
const QUESTION_WORD_RE = /\b(?:what|who|whom|whose|when|where|why|how|which|is|are|does|do|did|can)\b/;
const POSSESSIVE_RE = /['’]s\b|s['’](?:\s|$)/;

const TRAILING_RE = /(?:'s\s+page|\s+(?:page|file|please|for\s+me))$|[\s.?!,;:]+$/;
function stripTrailing(s, patterns = TRAILING_RE) {
  let prev;
  do { prev = s; s = s.replace(patterns, ""); } while (s !== prev);
  return s.trim();
}

function normalize(text) {
  let s = String(text).toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
  let prev;
  do { prev = s; s = s.replace(FILLER_RE, "").trim(); } while (s !== prev);
  return s;
}

function isNavigationRequest(text, namesClient) {
  if (typeof text !== "string" || !text.trim()) return false;
  const s = normalize(text);

  const strong = STRONG_RE.exec(s);
  if (strong) {
    const verb = strong[1].replace(/\s+/g, " ");
    const rest = stripTrailing(strong[2]);
    if (verb === "go home" || verb === "take me home") return true;
    if (!rest) return false;
    if (verb === "open" && OPEN_NOT_A_PAGE_RE.test(rest)) return false;
    return true;
  }

  const soft = SOFT_RE.exec(s);
  if (soft) {
    const rest = soft[1];
    // A page name, allowing a trailing "please" / "for me".
    const pageish = stripTrailing(rest, /(?:\s+(?:please|for\s+me))$|[\s.?!,;:]+$/);
    if (PAGE_NAME_RE.test(pageish)) return true;
    // A client counts only when the remainder is ONLY about the client: no possessive, no question word.
    if (typeof namesClient !== "function") return false;
    const who = stripTrailing(rest);
    if (!who || POSSESSIVE_RE.test(who) || QUESTION_WORD_RE.test(who)) return false;
    return Boolean(namesClient(who));
  }
  return false;
}

// True when model text says a page or screen was opened: she pulled up or brought up something, took them to it, it is on their
// screen, "there / here you go"; or she opened or is opening something named as an object (CLAIM_OPENED_RE): it / that / this /
// them / him, a page of the app, a page, file, record, profile, list or form ("her page", "the client list", "Helen Brandt's page"),
// or a name ("Opening Helen Brandt now"; a capital that is no weekday or month). Never the noun "opening" ("Your only opening is
// Friday at 2.", "There's an opening Friday") or the market's "opened" ("Rates opened lower today.", "Opening balance is 5").
// Also true when the whole reply is the app's own line imitated (imitatesCodeLine).
const CLAIM_RE = /\b(?:pull(?:ing|ed)|bring(?:ing)?|brought)\s+(?:up|(?:it|that|her|him|them)\s+up)\b|\b(?:taking|took|take)\s+you\s+(?:to|there)\b|\bon\s+(?:your|the)\s+screen\b|\b(?:there|here)\s+you\s+go\b/i;
const CLAIM_PAGE_WORD = "(?:page|screen|file|record|profile|list|form)";
const CLAIM_PAGE_NAME = "(?:rate\\s+watch|sweeps|billing|import\\s+clients|add\\s+client|home\\s+page)";
const CLAIM_NAME_WORD = "[\\w&'.-]+";
const CLAIM_OPENED_RE = new RegExp(
  "\\bopen(?:ed|ing)\\s+(?:(?:it|that|this|them|him)\\b|" + CLAIM_PAGE_NAME + "\\b" +
    "|(?:her|his|their|your|my|the)\\s+(?:" + CLAIM_NAME_WORD + "\\s+){0,3}?" + CLAIM_PAGE_WORD + "\\b" +
    "|" + CLAIM_NAME_WORD + "(?:\\s+" + CLAIM_NAME_WORD + "){0,3}?'s\\s+" + CLAIM_PAGE_WORD + "\\b)",
  "i"
);
const NOT_A_NAME = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August" +
  "|September|October|November|December)";
const CLAIM_OPENED_NAME_RE = new RegExp("\\b[Oo]pen(?:ed|ing)\\s+(?!" + NOT_A_NAME + "\\b)\\p{Lu}", "u");
// The model imitating the app's own line (A4): the whole reply is ONE short sentence (at most CODE_LINE_MAX_WORDS words) that
// starts with "Here's " or "You're already on ", with no digit and no colon ("Here's Helen Brandt.", "You're already on Rate
// Watch."; not "Here are your top opportunities." nor "Here's Helen's rate: 6.5 percent.").
const CODE_LINE_LEAD_RE = /^(?:here's|you're\s+already\s+on)\s/i;
const CODE_LINE_MAX_WORDS = 10;
function imitatesCodeLine(t) {
  if (!CODE_LINE_LEAD_RE.test(t) || /[\d:]/.test(t)) return false;
  const sentence = t.replace(/[.!?]+$/, "");
  return !/[.!?]\s/.test(sentence) && sentence.split(/\s+/).length <= CODE_LINE_MAX_WORDS;
}
function claimsScreenOpened(text) {
  if (typeof text !== "string") return false;
  const t = text.replace(/’/g, "'").trim();
  return CLAIM_RE.test(t) || CLAIM_OPENED_RE.test(t) || CLAIM_OPENED_NAME_RE.test(t) || imitatesCodeLine(t);
}

module.exports = {
  SCREEN_PAGES, BROKER_PAGES, FORM_OPEN, BROKER_ONLY, BILLING_OFF, COULDNT_OPEN,
  cleanOnScreen, screenLine, alreadyLine, isAlreadyOn, isNavigationRequest, claimsScreenOpened,
};
