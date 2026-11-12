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

// (final review I1) Speech-to-text audio-event tags, "(background noise)", "[laughter]", anywhere: not the user's words. The same
// tags as orchestrator.js's AUDIO_TAG_RE (kept in step by hand: orchestrator.js requires this module, so this one can't require it).
const AUDIO_TAG_RE = /\([^()]*\)|\[[^[\]]*\]/g;
// Words ahead of the request that ask for nothing: the orchestrator's filler (FILLER_RE: hey / hi / hello / ok / okay / so / and /
// but / well / alright / oh / um / uh / good morning / morning / Charlie), and now / just / yes / yeah / thanks / thank you, with the
// commas, dashes, colons and ellipses after them; and please, can / could / would / will you, let's, I want to.
const FILLER_RE = new RegExp(
  "^(?:(?:hey|hi|hello|ok|okay|so|and|but|well|alright|all\\s+right|oh|um|uh|good\\s+(?:morning|afternoon|evening)|morning|charl(?:ie|i)" +
    "|now|just|yes|yeah|thanks|thank\\s+you)\\b[\\s,.:;!\\u2014\\u2013\\u2026-]*" +
    "|please\\b[\\s,]*|(?:can|could|would|will)\\s+you\\b[\\s,]*|let's\\s+|i\\s+want\\s+to\\s+)"
);
const STRONG_RE = new RegExp(
  "^(pull\\s+up|bring\\s+up|open|go\\s+back\\s+to|go\\s+back\\s+home|go\\s+to|go\\s+home|take\\s+me\\s+back\\s+to|take\\s+me\\s+back\\s+home" +
    "|take\\s+me\\s+to|take\\s+me\\s+home|jump\\s+to|switch\\s+to|navigate\\s+to|head\\s+to)\\b\\s*(.*)$"
);
const NO_OBJECT_VERBS = new Set(["go home", "go back home", "take me home", "take me back home"]);
// (final review I1) The split form, "pull her up", "bring the Chens up": a pronoun or one to three name words between the verb and
// "up", nothing after it (the trailing please / for me aside). "Bring it up with her" is no page request.
const NAME_WORD = "[\\p{L}][\\p{L}\\p{N}'.-]*";
const SPLIT_RE = new RegExp(
  "^(?:pull|bring)\\s+(it|her|him|them|that|(?:the\\s+)?" + NAME_WORD + "(?:(?:\\s+(?:&|and))?\\s+" + NAME_WORD + "){0,2})\\s+up$", "u"
);
const PERSON_PRONOUNS = new Set(["her", "him", "them"]);
const SOFT_RE = /^(?:show(?:\s+me)?|look\s+up)\b\s*(.*)$/;
// (final review I2) an email, a draft, Gmail, Outlook, mail or a link is never a page, whatever the strong verb ("pull up Helen's
// email" after a compose card is about the card)
const NOT_A_PAGE_RE = /\b(?:e-?mails?|drafts?|gmail|outlook|mail|links?)\b/;
const PAGE_NAME_RE = /^(?:the\s+)?(?:home(?:\s+page)?|dashboard|sweeps(?:\s+page)?|(?:all|my)\s+clients|client\s+list|rate\s+watch|rates\s+page|add\s+(?:a\s+)?client|my\s+team|import(?:\s+clients)?|(?:my\s+)?profile|billing(?:\s+page)?)$/;
const QUESTION_WORD_RE = /\b(?:what|who|whom|whose|when|where|why|how|which|is|are|does|do|did|can)\b/;
const POSSESSIVE_RE = /['’]s\b|s['’](?:\s|$)/;

// (final review I1) "'s page" / "'s file" and the plural "s' page" / "s' file" go with the rest ("show me the Chens' file" -> "the chens")
const TRAILING_RE = /(?:'s\s+(?:page|file)|(?<=s)'\s+(?:page|file)|\s+(?:page|file|please|for\s+me))$|[\s.?!,;:]+$/;
function stripTrailing(s, patterns = TRAILING_RE) {
  let prev;
  do { prev = s; s = s.replace(patterns, ""); } while (s !== prev);
  return s.trim();
}

// Lower case, one space, no speech-to-text tags and no filler ahead of the request.
function normalize(text) {
  let s = String(text).toLowerCase().replace(/’/g, "'").replace(AUDIO_TAG_RE, " ").replace(/\s+/g, " ").trim();
  let prev;
  do { prev = s; s = s.replace(FILLER_RE, "").trim(); } while (s !== prev);
  return s;
}

// The split form's middle word or words ("her", "the chens"), or null when the request is not one.
function splitFormOf(s) {
  const m = SPLIT_RE.exec(stripTrailing(s));
  return m ? m[1] : null;
}

function isNavigationRequest(text, namesClient) {
  if (typeof text !== "string" || !text.trim()) return false;
  const s = normalize(text);

  const strong = STRONG_RE.exec(s);
  if (strong) {
    const verb = strong[1].replace(/\s+/g, " ");
    const rest = stripTrailing(strong[2]);
    if (NO_OBJECT_VERBS.has(verb)) return true;
    if (!rest) return false;
    return !NOT_A_PAGE_RE.test(rest);
  }
  const split = splitFormOf(s);
  if (split !== null) return !NOT_A_PAGE_RE.test(split);

  const soft = SOFT_RE.exec(s);
  if (soft) {
    const rest = soft[1];
    // A page name, allowing a trailing "please" / "for me", and "page" after a page's name ("show me Rate Watch page"; "the rates
    // page" is a page name with it, "the rates" is no page without it).
    const pageish = stripTrailing(rest, /(?:\s+(?:please|for\s+me))$|[\s.?!,;:]+$/);
    if (PAGE_NAME_RE.test(pageish) || PAGE_NAME_RE.test(pageish.replace(/\s+page$/, ""))) return true;
    // A client counts only when the remainder is ONLY about the client: no possessive, no question word.
    if (typeof namesClient !== "function") return false;
    const who = stripTrailing(rest);
    if (!who || POSSESSIVE_RE.test(who) || QUESTION_WORD_RE.test(who)) return false;
    return Boolean(namesClient(who));
  }
  return false;
}

// ---- Model text that says a page opened ------------------------------------------------------------------------

// The sentences of a reply: a break after . ! ? (or a newline), never after Dr. / Mr. / Mrs. / Ms. / St. ("Here's Dr. Smith.").
const ABBREVIATION_END_RE = /\b(?:dr|mr|mrs|ms|st)\.$/i;
function sentencesOf(t) {
  const out = [];
  for (const piece of t.split(/(?<=[.!?])\s+|\n+/)) {
    const p = piece.trim();
    if (!p) continue;
    if (out.length > 0 && ABBREVIATION_END_RE.test(out[out.length - 1])) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out;
}

// A statement (a sentence that does not end with "?": a question or an offer is never a claim, "Which Chen should I bring up?")
// says a page or screen was opened when she pulled up or brought up something, or lets them know she will ("let me pull up her
// page"), took them to it, it is on their screen, "there / here you go", a page is open or up ("Helen Brandt's page is open."); or
// she opened or is opening (up) an object (CLAIM_OPENED_RE): it / them / him, this / that as a pronoun (followed by up, now, for
// you, a punctuation mark or nothing: not "this week", "that day"), a page of the app, a page / screen / file / profile / list
// ("her page", "the client list", "Helen Brandt's page"); or a name (CLAIM_OPENED_NAME_RE: a capital and a lower-case letter, maybe
// after "the", that start no weekday or month, in full or short: "Opening Helen Brandt now", "Opening the Chens now", not "opening
// I see", "MBS" or "Nov 13"). Never the noun "opening" ("Your only opening this week is Friday at 2.") or the market's "opened"
// ("Rates opened this morning a touch lower.", "Rates opened the week near record lows.", "Opening balance is 5").
// (final review M1) She pulled or brought something up only when she is the subject: the sentence starts with it (after a word like
// "Sure," or "Okay —"), or I / I've / I'm / I have / I'll / I will / let me comes right before it; and not when a colon follows in
// the sentence, which brings in data ("I pulled up the numbers: Helen is at 7.1%."). "Helen brought up a refi on your last call."
// is the client's doing. "There / here you go" counts only with nothing after it but punctuation ("Here you go — Helen Brandt is at
// 7.9 percent." is an answer).
const CLAIM_LEAD = "(?:(?:sure|okay|ok|alright|all\\s+right|got\\s+it|yes|yep|absolutely|of\\s+course|on\\s+it|one\\s+sec(?:ond)?|right)" +
  "\\b[\\s,\\u2014\\u2013-]*)*";
const CLAIM_PULLED_RE = new RegExp(
  "(?:^" + CLAIM_LEAD + "(?:pull(?:ing|ed)|bringing|brought)" +
    "|\\b(?:i|i've|i'm|i\\s+have|i'll|i\\s+will|let\\s+me)\\s+(?:just\\s+|now\\s+)?(?:pull(?:ing|ed)?|bring(?:ing)?|brought))" +
    "\\s+(?:up|(?:it|that|her|him|them)\\s+up)\\b(?=[^:]*$)",
  "i"
);
const CLAIM_HERE_YOU_GO_RE = new RegExp("\\b(?:there|here)\\s+you\\s+go[\\s.!\\u2026]*$", "i");
const CLAIM_RE = new RegExp(
  "\\b(?:taking|took|take)\\s+you\\s+(?:to|there)\\b|\\bon\\s+(?:your|the)\\s+screen\\b" +
    "|(?:'s|\\b(?:her|his|their|your|the))\\s+page\\s+is\\s+(?:now\\s+)?(?:open|up)\\b",
  "i"
);
const CLAIM_PAGE_WORD = "(?:page|screen|file|profile|list)";
const CLAIM_PAGE_NAME = "(?:rate\\s+watch|sweeps|billing|import\\s+clients|add\\s+client|home\\s+page)";
const CLAIM_NAME_WORD = "[\\w&'.-]+";
const CLAIM_OPENED_RE = new RegExp(
  "\\bopen(?:ed|ing)(?:\\s+up)?\\s+(?:(?:it|them|him)\\b" +
    "|(?:this|that)(?=\\s+(?:up|now|for\\s+you)\\b|\\s*[.,!?;:\\u2014\\u2013-]|\\s*$)" +
    "|" + CLAIM_PAGE_NAME + "\\b" +
    "|(?:her|his|their|your|my|the)\\s+(?:" + CLAIM_NAME_WORD + "\\s+){0,3}?" + CLAIM_PAGE_WORD + "\\b" +
    "|" + CLAIM_NAME_WORD + "(?:\\s+" + CLAIM_NAME_WORD + "){0,3}?'s\\s+" + CLAIM_PAGE_WORD + "\\b)",
  "i"
);
const NOT_A_NAME = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun" +
  "|January|February|March|April|May|June|July|August|September|October|November|December" +
  "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)";
const CLAIM_OPENED_NAME_RE = new RegExp("\\b[Oo]pen(?:ed|ing)(?:\\s+up)?\\s+(?:the\\s+)?(?!" + NOT_A_NAME + "\\b)\\p{Lu}\\p{Ll}", "u");
const saysOpened = (sentence) =>
  !sentence.endsWith("?") && (CLAIM_PULLED_RE.test(sentence) || CLAIM_HERE_YOU_GO_RE.test(sentence) || CLAIM_RE.test(sentence) ||
    CLAIM_OPENED_RE.test(sentence) || CLAIM_OPENED_NAME_RE.test(sentence));

// The model imitating the app's own line (A4): the whole reply is ONE statement of at most CODE_LINE_MAX_WORDS words, "Here's " or
// "You're already on " and then only a page's label (the words screenLine uses: "Rate Watch", "your client list") or a client's
// name (`namesClient`, "'s page" allowed after it), with no digit, colon, comma or dash ("Here's Helen Brandt.", "You're already
// on Rate Watch."; not "Here are your top opportunities.", "Here's Helen's rate: 6.5 percent." nor "Here's Helen Brandt, your top
// opportunity."). With no `namesClient` no name counts.
const CODE_LINE_RE = /^(?:here's|you're\s+already\s+on)\s+([^\d:,;—–?!]+?)[.!]?$/i;
const CODE_LINE_MAX_WORDS = 10;
const PAGE_LABELS = new Set(Object.values(PAGE_LINES).map((line) => line.slice("Here's ".length, -1).toLowerCase()));
function imitatesCodeLine(t, namesClient) {
  if (sentencesOf(t).length !== 1 || t.split(/\s+/).length > CODE_LINE_MAX_WORDS) return false;
  const m = CODE_LINE_RE.exec(t);
  if (!m || /\s-\s/.test(m[1])) return false;
  const rest = m[1].replace(/\s+/g, " ").trim();
  if (PAGE_LABELS.has(rest.toLowerCase())) return true;
  return typeof namesClient === "function" && Boolean(namesClient(rest.replace(/'s\s+page$/i, "")));
}

// True when model text says a page or screen was opened (a statement of it, or the app's line imitated). `namesClient(text)`, when
// given, says whether a text names a client.
function claimsScreenOpened(text, namesClient) {
  if (typeof text !== "string") return false;
  const t = text.replace(/’/g, "'").trim();
  return sentencesOf(t).some(saysOpened) || imitatesCodeLine(t, namesClient);
}

// A request that targets a screen (Ruling R5): it names one of the app's pages, says page / file / screen, or names a client
// (`namesClient`, when given). "pull up Helen Brandt", "take me to Rate Watch", "bring up the Chen file"; not "pull up today's rates"
// or "pull up my top opportunities", which are answered in words.
const PAGE_MENTION_RE = /\b(?:home|dashboard|sweeps|(?:all|my)\s+clients|client\s+list|rate\s+watch|rates\s+page|add\s+(?:a\s+)?client|my\s+team|import(?:\s+clients)?|profile|billing)\b/;
const SCREEN_WORD_RE = /\b(?:pages?|files?|screens?)\b/;
// (final review I1, my call) the split form with a person's pronoun, "pull her up", "bring them up", is a client's page: a person is
// a client here. "Pull it up" / "pull that up" are not (it may be the email card or a figure).
function targetsScreen(text, namesClient) {
  if (typeof text !== "string" || !text.trim()) return false;
  const s = normalize(text);
  if (PAGE_MENTION_RE.test(s) || SCREEN_WORD_RE.test(s)) return true;
  if (PERSON_PRONOUNS.has(splitFormOf(s))) return true;
  return typeof namesClient === "function" && Boolean(namesClient(text));
}

module.exports = {
  SCREEN_PAGES, BROKER_PAGES, FORM_OPEN, BROKER_ONLY, BILLING_OFF, COULDNT_OPEN,
  cleanOnScreen, screenLine, alreadyLine, isAlreadyOn, isNavigationRequest, claimsScreenOpened, targetsScreen,
};
