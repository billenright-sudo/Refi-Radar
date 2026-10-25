"use strict";
// Charli orchestrator: a bounded tool-use loop in which the model can only produce facts by
// calling the deterministic tools in ./tools. The model never sees the CRM or the engine
// directly, and code (not the model) decides what is allowed to reach the user:
//
//   * text the model writes is screened before it is spoken: loan-guideline questions hand off,
//     on an action request ("log a call with Chen") with no change handed up only a question may
//     be spoken (isActionRequest / isQuestionShaped), "done / I logged it" claims are replaced
//     (nothing is ever performed here), every figure must appear in this turn's tool results, and
//     text with no cited tool result behind it can't carry any fact (screenUngroundedText);
//   * a side-effect tool call is NOT acted on: it is returned as `sideEffect`, with a
//     code-authored read-back, for the confirmation step;
//   * an unknown tool name, or a loop that never settles, resolves to the can't-verify line.
//
// `client` is anything with messages.create(params) -> a Messages API response (the real
// @anthropic-ai/sdk client in production, a scripted fake in tests); this file never imports it.
const refi = require("../refi");
const { tools, TOOL_SCHEMA } = require("./tools");
const {
  buildCharliSystem, CANT_VERIFY, GUIDELINE_HANDOFF, NOTHING_CHANGED, ONE_AT_A_TIME, DIDNT_CATCH,
} = require("./prompt");
const { CAREER_STAGES, stageById } = require("./coaching");
const { GLOSSARY_SOURCE, mentionsGlossaryTerm } = require("./glossary");

const MAX_MODEL_CALLS = 4;   // model calls per turn, including the one that narrates
const MAX_TOKENS = 600;      // replies are 1-3 spoken sentences
const SWEEP_TOP_OPPORTUNITIES = 10;
const SWEEP_TOP_CHECKINS = 10;
const FIND_CLIENT_MAX_MATCHES = 5;

// The tools that only PACKAGE a change (they never write; see tools.js). On the last allowed
// model call these are the only tools run, because nothing else's result could be used.
const SIDE_EFFECT_TOOLS = new Set(["addClientTool", "logContactTool", "setCareerStageTool"]);

// Same fallback as routes/rates.js and index.js. Read per call so the env can change.
const modelName = () => process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

// ── Text screening ───────────────────────────────────────────────────────────

const wordRe = (alts) => new RegExp("\\b(?:" + alts.join("|") + ")\\b", "i");

// Loan-guideline domain (deferred): the model has no verified source, so it must hand off.
const GUIDELINE_RE = wordRe([
  "guidelines?", "overlays?", "underwrit\\w*", "AUS", "DU\\s+findings?", "LPA",
  "reserve\\s+requirements?", "DTI\\s+limits?", "max(?:imum)?\\s+DTI", "HUD\\s+handbook", "selling\\s+guide",
]);
// Eligibility is a guideline question only next to a program or requirement word, in either
// order ("eligible for an FHA streamline", "FHA eligibility"); "is Chen eligible for a refi"
// is a sweep question and must still reach the tools.
const PROGRAM = "FHA|VA|USDA|conventional|jumbo|streamlines?|non[\\s-]?QM|programs?|requirements?";
const ELIGIBLE_NEAR_PROGRAM_RE = new RegExp(
  "\\beligib\\w*(?:\\W+\\w+){0,4}?\\W+(?:" + PROGRAM + ")\\b" +
  "|\\b(?:" + PROGRAM + ")(?:\\W+\\w+){0,4}?\\W+eligib\\w*\\b",
  "i"
);
const isGuidelineQuestion = (text) => GUIDELINE_RE.test(text) || ELIGIBLE_NEAR_PROGRAM_RE.test(text);

// Questions about the book or the market: an answer needs a tool, so text alone can't stand.
const BOOK_FACT_RE = wordRe([
  "rates?", "markets?", "sweeps?", "opportunit\\w*", "clients?", "balances?", "payments?",
  "savings?", "LTV", "equity", "refi\\w*", "cash[\\s-]?out",
  "call\\w*", "log\\w*", "contact\\w*", "loans?", "pipeline", "books?", "check[\\s-]?ins?", "follow[\\s-]?ups?",
]);

// ── Openers, questions, completion claims ────────────────────────────────────

// One content-free conversational opener ("Sure,", "Got it.", "Happy to -") ahead of the real
// sentence. The closed list is followed by , . ! an em or en dash or a spaced hyphen.
const OPENER_RE = new RegExp(
  "^\\s*(?:sure|okay|ok|got\\s+it|of\\s+course|happy\\s+to|absolutely|certainly|no\\s+problem|great|perfect|alright|right)" +
  "(?:\\s*[,.!\\u2014\\u2013]|\\s+-(?=\\s))\\s*",
  "i"
);
// Removes at most one such opener. "Sure, what's their name?" -> "what's their name?";
// "Surely, ..." and "Right now, ..." are left alone. Pure.
const stripOpener = (text) => String(text == null ? "" : text).replace(OPENER_RE, "");

// Words that open a question or an offer. A leading and/or/so (no comma) is allowed.
const QUESTION_WORDS =
  "what|which|who|whom|whose|when|where|why|how|do|does|did|is|are|was|were|can|could|would|should|will|shall|may|might|want|need";
const QUESTION_START_RE = new RegExp("^(?:(?:and|or|so)\\s+)?(?:" + QUESTION_WORDS + ")\\b", "i");
// The question word of an offer plus its subject pronoun ("Should I", "Would you", "Can we"). Only
// this is removed from an offer before the full claim test runs on the rest of the sentence.
const OFFER_LEAD_RE = new RegExp("^(?:(?:and|or|so)\\s+)?(?:" + QUESTION_WORDS + ")\\s+(?:I|you|we)\\b", "i");
// A sentence or clause break: . ! ; : ? an em or en dash, "--", an ellipsis, or a spaced hyphen.
const CLAUSE_BREAK_RE = /[.!;:?\u2014\u2013\u2026]|--| - /;
const lettersOf = (s) => String(s == null ? "" : s).match(/[A-Za-z\u00c0-\u024f]+/g) || [];

// ── What the user asked ──────────────────────────────────────────────────────

// Filler and address ahead of what the user actually says: "hey Charli,", "good morning Charli,",
// "ok so", "and", "well". Removed from the start of a sentence or clause before the tests below.
const FILLER_RE = new RegExp(
  "^\\s*(?:(?:hey|hi|hello|ok|okay|so|and|but|well|alright|oh|um|uh|good\\s+(?:morning|afternoon|evening)|morning|charli|charlie)" +
    "\\b[\\s,\\u2014\\u2013-]*)*",
  "i"
);
const afterFiller = (s) => String(s == null ? "" : s).replace(FILLER_RE, "").trim();
// A break between the user's own clauses: . ! ? ; : , a newline (consecutive utterances are joined with one),
// an em or en dash, an ellipsis, "--" or a spaced hyphen.
const USER_CLAUSE_BREAK_RE = /[.!?;:,—–…\n]|--|\s-\s/;

// R5-1. The user's message is a yes/no question only if ALL hold:
//   (a) the message ends with "?" (a clause in the middle of the message never counts on its own);
//   (b) the question (its last sentence, or the last clause of that), after filler, opens with is / are
//       / am / was / were / do / does / did / has / have / had (or the n't form), or the message ends
//       with a state tag: right? correct? isn't it? isn't he? isn't she? aren't they? true?;
//   (c) it is not a request or a mic check: the message (after filler) does not open with an
//       imperative action verb ("Add a client for me, yeah?"), neither the message nor the question
//       opens with one of the request leads in NOT_YES_NO_LEAD_RE ("do you mind", "is it possible",
//       "do me a favor", ...), and neither the message nor the question IS a mic check (MIC_CHECK_RE: the
//       whole question, "are you there?", "is this thing on?", "did you get that?").
// A reply's leading "Sure" / "Absolutely" / "Right" would BE the answer to such a question, so the
// lone-question predicate does not strip it, and on an ungrounded turn nothing else may answer it
// (R5-2, in screenUngroundedText). Pure.
const YES_NO_AUX_RE = /^(?:is|are|am|was|were|do|does|did|has|have|had)(?:n['\u2019]t)?\b/i;
const STATE_TAG_RE = /\b(?:right|correct|isn['\u2019]t\s+(?:it|he|she)|aren['\u2019]t\s+they|true)\s*\?\s*$/i;
// Requests phrased as questions: a message or question that OPENS with one of these is no yes/no question.
const NOT_YES_NO_LEAD_RE = new RegExp(
  "^(?:are\\s+you\\s+(?:able|free)" +
    "|do\\s+you\\s+(?:mind|want\\s+to|have\\s+time|think\\s+you\\s+could)" +
    "|have\\s+you\\s+got\\s+a\\s+(?:minute|sec|second)|is\\s+it\\s+possible|is\\s+there\\s+a\\s+way" +
    "|do\\s+me\\s+a\\s+favou?r)\\b",
  "i"
);
// Mic checks. Unlike the leads above, a mic check must be the WHOLE question: one of these openings (for
// "are you ..." an optional "still" and an optional "to me" / "to go": "Are you still there?", "Are you
// listening to me?", "Are you ready to go?"), an optional "now / today / right now / ok / okay", an optional
// trailing "Charli", and the "?". So "Is this working?" and "Did you get that?" are mic checks, while "Did
// you get Chen's file?", "Are you on the Chen file?" and "Is it on the schedule?" are yes/no questions.
// Tested on the message (after filler) and on the question (its last sentence, or the last clause of that)
// with its "?" put back.
const MIC_CHECK_RE = new RegExp(
  "^(?:(?:do|did)\\s+you\\s+(?:hear|get|catch)(?:\\s+(?:me|that|it|this|what\\s+i\\s+said))?" +
    "|is\\s+(?:this\\s+thing|this|it|everything)\\s+(?:on|working)" +
    "|are\\s+you\\s+(?:still\\s+)?(?:on|working|there|ready|awake|listening|around|up|with\\s+me)(?:\\s+to\\s+(?:me|go))?" +
    "|can\\s+you\\s+hear\\s+me)" +
    "(?:\\s+(?:now|today|right\\s+now|ok|okay))?(?:[\\s,]+(?:charli|charlie))?\\s*\\?$",
  "i"
);
const IMPERATIVE_LEAD_RE =
  /^(?:add|log|mark|record|note|update|set|book|schedule|save|create|enter|put|pull|run|show|find|give|send|draft)(?![\w'\u2019-])/i;
function isYesNoQuestion(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t.endsWith("?")) return false;
  const opening = afterFiller(t);
  if (IMPERATIVE_LEAD_RE.test(opening) || NOT_YES_NO_LEAD_RE.test(opening) || MIC_CHECK_RE.test(opening)) return false;
  const body = t.replace(/[?\s]+$/, "");
  const questions = [body.split(/[.!?;\n]/).pop(), body.split(USER_CLAUSE_BREAK_RE).pop()].map(afterFiller);
  // `q` has lost its "?" with the body, and a mic check is anchored on it, so put it back
  return STATE_TAG_RE.test(t) ||
    questions.some((q) => YES_NO_AUX_RE.test(q) && !NOT_YES_NO_LEAD_RE.test(q) && !MIC_CHECK_RE.test(q + "?"));
}

// R5-3. An action request: some clause of the user's message, after filler, that is not a past-state or
// wh-question (it does not open with when / what / which / who / how / did / has / have / had / was /
// were), either opens with an action verb ("log a call with Chen", "Chen called me, ..., log it"), or
// holds a request lead (can you, could you, would you, will you, please, do you mind, do you want to,
// are you able to, is it possible to, go ahead and, I need you to, I want you to, let's, let me, help me,
// can we, could we, I need / want / have to, I'd like to, do me a favor and, you could) followed by an
// action verb, or its -ing form, with only the closed list of filler words (REQUEST_FILLER) in between
// ("do you mind logging a call", "would you be able to add a client"). Any other word between the lead and
// the verb is a noun or another verb ("can you pull up Chen's record"), so there is no request. Two
// information requests share a verb with an action and are carved out of the verb list (and of its -ing
// form): "update me / us / on ..." ("update me on rates") and "put together" ("put together a call list").
// The polite leads "would you mind" and a clause-initial "mind" ("mind logging a call") take the -ing form.
// The filler list holds only words that cannot be a noun: "go log", "make sure to log", "try to log",
// "remember to log", and "make a note" (the "a" counts only when "note" follows). "remember" counts only
// before "to": "Can you remember logging a call with Chen?" asks about the past, it requests nothing. Pure.
const ACTION_VERBS =
  "log|add|mark|record|note|update(?!\\s+(?:me|us|on)\\b)|set|book|schedule|save|create|enter|put(?!\\s+together\\b)";
const ACTION_VERBS_ING =
  "logging|adding|marking|recording|noting|updating(?!\\s+(?:me|us|on)\\b)|setting|booking|scheduling|saving|creating|entering|putting(?!\\s+together\\b)";
const REQUEST_FILLER =
  "please|just|quickly|real|quick|also|maybe|kindly|be|able|to|help|me|go|make\\s+sure|make\\s+a(?=\\s+note\\b)|remember(?=\\s+to\\b)|try";
const ACTION_LEAD_RE = new RegExp("^(?:" + ACTION_VERBS + ")(?![\\w'\\u2019-])", "i");
const REQUEST_LEAD_RE = new RegExp(
  "\\b(?:^mind|can\\s+you|could\\s+you|would\\s+you\\s+mind|would\\s+you|will\\s+you|please|do\\s+you\\s+mind|do\\s+you\\s+want\\s+to" +
    "|are\\s+you\\s+able\\s+to|is\\s+it\\s+possible\\s+to|go\\s+ahead\\s+and|I\\s+need\\s+you\\s+to|I\\s+want\\s+you\\s+to" +
    "|let['\\u2019]?s|let\\s+me|help\\s+me|can\\s+we|could\\s+we|I\\s+(?:need|want|have)\\s+to|I['\\u2019]d\\s+like\\s+to" +
    "|do\\s+me\\s+a\\s+favou?r\\s+and|you\\s+could)" +
    "(?:\\s+(?:" + REQUEST_FILLER + ")\\b){0,4}?\\s+(?:" + ACTION_VERBS + "|" + ACTION_VERBS_ING + ")(?![\\w'\\u2019-])",
  "i"
);
const STATE_QUESTION_LEAD_RE = /^(?:when|what|which|who|how|did|has|have|had|was|were)\b/i;
const isActionRequest = (text) =>
  String(text == null ? "" : text).split(USER_CLAUSE_BREAK_RE).some((clause) => {
    const c = afterFiller(clause);
    return !STATE_QUESTION_LEAD_RE.test(c) && (ACTION_LEAD_RE.test(c) || REQUEST_LEAD_RE.test(c));
  });

// R5-3's pass condition: after at most one opener strip, the reply's first clause (the text before
// its first . ! ; em dash, en dash or spaced hyphen) opens with a question/auxiliary word, and the
// reply ends with "?". The first clause begins where the reply begins and QUESTION_START_RE is
// anchored there, so it is tested on the stripped reply directly. A claim after the question word
// is the claim guard's job. Names are allowed ("Which Chen — Robert and Linda, or Chen Wei?"). Pure.
function isQuestionShaped(reply) {
  const s = stripOpener(reply).trim();
  return s.endsWith("?") && QUESTION_START_RE.test(s);
}

// The first word of a reply (after leading whitespace, an opening quote and the fillers oh / ah /
// um / uh / er / erm / hmm / well / so) is an affirming or negating word. Tested on the raw reply,
// before any opener strip, because "Sure" / "Absolutely" / "Right" are openers too.
const YES_NO_WORD_RE = new RegExp(
  "^[\\s\"'\\u201c\\u2018]*(?:(?:oh|ah|um|uh|er|erm|hmm|well|so)\\b[\\s,.!\\u2014\\u2013\\u2026-]*)*" +
    "(?:yes|yeah|yep|yup|no|nope|nah|absolutely|right|correct|sure|of\\s+course|certainly|definitely|indeed|exactly|true|false)\\b",
  "i"
);
// The user asked a yes/no or tag question (isYesNoQuestion) and the reply opens with a yes or a
// no: that first word IS the answer ("Is Chen my best?" + "Absolutely — want me to pull their
// numbers?"). Kept as a helper: R5-2 in screenUngroundedText is stricter and subsumes it (on an
// ungrounded yes/no turn only a lone clarifying question passes), so the guards no longer call it. Pure.
const isBareYesNoAnswer = (reply, userText) =>
  isYesNoQuestion(userText) && YES_NO_WORD_RE.test(String(reply == null ? "" : reply));

// A completion claim. runTurn never performs an action, so by construction anything the model
// says that reads as "it's done" is false. Each sentence (split on . ! ? ; and em/en dashes) is
// tested on its own, after one content-free opener is stripped from it:
//   * a completion opener at its start ("Done", "All set", "You're all set", "Consider it done",
//     "Logged", "Already saved", ...); a sentence that is only "done" / "all done" / "all set" is
//     the simplest case of this;
//   * "I" / "we" (+ 've / have) then up to four words then a past-tense verb ("I just went ahead
//     and logged it"); the words may not be a negation or modal ("I have not logged", "I can add");
//     and "I'm / we're logging it" (an action in progress is just as false);
//   * a present, perfect or "got" passive ("is logged", "Chen's marked", "has been updated", "are
//     saved", "got that logged") and the just-happened adverb forms ("is now marked", "has already
//     been logged", "was just saved", "it's now been logged"), on every turn;
//   * "it's done", "is done", "has been done", "all set", "taken care of", anywhere in the sentence;
//   * a career stage reported as set, on every turn: first-person "I've set you as a veteran" (FIRST_PERSON_SET_RE: the
//     pronoun right next to "set"), "is / are / 's / 're / been (now) set to / as <a stage>", the bare "your (career) stage
//     is set / updated" (STAGE_SET_BARE_RE), and "you're (now) set / marked / listed as / to". The first three are a truth
//     check against `storedStage` (falseSetClaim): one that names only the stored stage is true and is no claim ("Your
//     career stage is set to Veteran." for a stored veteran); one that names no stage, or another, is a claim;
//   * the simple past passive ("was logged", "were added", "was set") only on an ungrounded turn: it is the one
//     form a grounded turn may use to narrate a tool fact ("your last contact with Chen was logged on
//     2026-01-01"; the date still goes through the figure check);
//   * a completion opener at the start of a later clause, after a comma, colon, ellipsis, "--", a
//     spaced hyphen, "and" or "then" ("Sure thing, done!", "Yep, logged it.", "Found Chen and logged
//     the call", and in an offer "Should I set a follow-up, logged it already?"). There "updated" and
//     "marked" count only when an object or nothing follows them ("updated the record", "marked as
//     contacted"), so narration like "6.52 percent, updated this morning" is left alone.
// An offer (a sentence that starts with a question/auxiliary word and ends with "?") loses only its
// question word and subject pronoun ("Should I", "Would you"), and the rest gets the same test,
// later clauses included (R5-4): "Should I get that marked as contacted?" is not a claim, "Would you
// like me to set a follow-up now that I've logged the call?" is. "changed" is not a claim verb: "I see
// rates changed overnight" is narration.
const CLAIM_VERBS = "logged|added|saved|booked|sent|scheduled|updated|created|recorded|marked|noted|handled|done";
const PASSIVE_VERBS = "logged|added|saved|recorded|updated|marked|noted|booked|sent|handled";
const NOT_A_CLAIM = "not|never|no|can|cannot|could|would|should|will|shall|may|might|must|to";
const FIRST_PERSON_CLAIM_RE = new RegExp(
  "\\b(?:I|we)(?:['\\u2019]ve|\\s+have)?(?:\\s+(?!(?:" + NOT_A_CLAIM + ")\\b)\\w+){0,4}\\s+(?:" + CLAIM_VERBS + ")\\b", "i"
);
const IN_PROGRESS_RE =
  /\b(?:I['\u2019]m|I\s+am|we['\u2019]re|we\s+are)\s+(?:(?:now|just|going\s+ahead\s+and)\s+)?(?:logging|saving|adding|booking|recording|marking|noting|updating|scheduling|sending|creating)\b/i;
const PASSIVE_RE = new RegExp("(?:\\b(?:is|are|been|got)|['\\u2019](?:s|re))\\s+(?:" + PASSIVE_VERBS + ")\\b", "i");
const PASSIVE_PAST_RE = new RegExp("\\b(?:was|were)\\s+(?:" + PASSIVE_VERBS + "|set)\\b", "i");   // "was set": a career stage reported as set
const PASSIVE_JUST_RE = new RegExp(
  "(?:\\b(?:is|are|was|were|been|got|has|have|had)|['\\u2019](?:s|re|ve))\\s+(?:now|already|just|all)\\s+(?:been\\s+)?(?:" +
    PASSIVE_VERBS + ")\\b",
  "i"
);
// Career stages (coaching.js). "new" is also an everyday word ("3 new opportunities", "a new fixed rate"), so it names a
// stage only in a stage context; the other ids are rare enough to count anywhere, in the plural ("veterans") and as
// "seasoned vet" too.
const STAGE_IDS = CAREER_STAGES.map((st) => st.id);
const OTHER_STAGE_WORDS = STAGE_IDS.filter((id) => id !== "new")
  .map((id) => (id === "veteran" ? "veterans?" : id)).concat("seasoned\\s+vets?").join("|");
// "new" is a stage only where the clause ends or a stage noun follows ("is set to New.", "New broker"): "set to a new fixed rate",
// "to a new low" and "in the new year" are not stages
const NEW_STAGE_END = "(?=\\s*(?:[.!?,;:\\u2014\\u2013(]|$)|\\s+(?:stage|category|level|tier|bracket|broker|brokers|originator|loan\\s+officer|LO|now|then|instead|from|for|today|going)\\b)";

// Setting a career stage is a change too, and it is reported with the stage next to the verb: "is set to Veteran",
// "has been set as an Established broker", "is set to: “Veteran (10+ years)”" and "You're now set / marked / listed as
// Veteran" are false on every turn. The object must be a stage ("Their ARM is set to adjust" is narration). The
// first-person forms are FIRST_PERSON_SET_RE.
const SET_PASSIVE_RE = new RegExp(
  "(?:\\b(?:is|are|been)|['\\u2019](?:s|re))\\s+(?:now\\s+)?set\\s+(?:to|as)[\\s:\"'\\u201c\\u2018]*(?:(?:an?|the)[\\s:\"'\\u201c\\u2018]+)?(?:" +
    OTHER_STAGE_WORDS + "|new" + NEW_STAGE_END + ")\\b", "i"
);
// "Your career stage is set." / "has been saved": the bare claim, with no stage named ("Your stage is set for growth" is not one)
const STAGE_SET_BARE_RE = /\b(?:your|career)\s+stage(?:\s+(?:is|has\s+been)|['\u2019]s)\s+(?:now\s+)?(?:all\s+)?(?:set|updated|saved|changed|locked\s+in)\b(?!\s+for\b)/i;
// "I set you / your / it / that / this" with nothing but "have", "just", "already", "now" or "went ahead and" in between:
// "I suggest you set up a call" and "I'd recommend we set a follow-up" are suggestions, and "if I set your stage" an offer.
const FIRST_PERSON_SET_RE = /(?<!\bif\s)\b(?:I|we)(?:['\u2019]ve|\s+have)?(?:\s+(?:just|already|now|went\s+ahead\s+and|gone\s+ahead\s+and))*\s+set\s+(?:you|your|it|that|this)\b/i;
const YOURE_SET_RE = /\byou(?:['\u2019]re|\s+are)\s+(?:now\s+)?(?:set|marked|listed)\s+(?:as|to)\b/i;
const GOT_IT_DONE_RE = new RegExp("\\bgot\\s+(?:\\S+\\s+){1,3}?(?:" + PASSIVE_VERBS + ")\\b", "i");
const DONE_RE =
  /\b(?:it|that)['\u2019]s\s+(?:all\s+)?done\b|\b(?:is|been)\s+(?:all\s+)?done\b|\ball\s+set\b|\b(?:taken|took)\s+care\s+of\b/i;
const COMPLETION_OPENER_RE =
  /^\s*(?:(?:just|already|also)\s+)?(?:done|all\s+done|all\s+set|you['\u2019]re\s+all\s+set|you\s+are\s+all\s+set|consider\s+it\s+(?:done|handled)|logged|saved|added|booked|recorded|noted|updated|marked|handled)\b/i;
const CLAUSE_SPLIT_RE = /,|:|\u2026|--|\s-\s|\b(?:and|then)\b/i;
const LEADING_CONJ_RE = /^(?:(?:so|but|plus)\s+)+/i;
const TRAILING_PUNCT_RE = /[\s.!?;:,\u2026"\u201d)]+$/;
const CLAUSE_CLAIM_RE =
  /^(?:(?:just|already|also)\s+)?(?:(?:all\s+)?done|all\s+set|logged|saved|added|booked|recorded|noted|handled|(?:updated|marked)(?=$|\s+(?:it|that|them|him|her|the|your|their|as\s+contacted)\b))\b/i;

const sentencesOf = (text) => String(text).match(/[^.!?;\u2014\u2013]+[.!?;\u2014\u2013]*/g) || [];
const isOffer = (sentence) => /\?\s*$/.test(sentence) && QUESTION_START_RE.test(sentence.trim());
// A completion opener at the start of any clause after the first (the first is the sentence start).
const laterClauseClaims = (sentence) =>
  sentence.split(CLAUSE_SPLIT_RE).slice(1).some((c) =>
    CLAUSE_CLAIM_RE.test(stripOpener(c.trim().replace(LEADING_CONJ_RE, "")).trim().replace(TRAILING_PUNCT_RE, ""))
  );

// `grounded` = a cited tool result backs this turn; `storedStage` = the user's stored stage id (null / omitted = not set).
// Pure: no I/O, no state.
function claimsCompletion(text, grounded, storedStage) {
  return sentencesOf(String(text == null ? "" : text)).some((part) => {
    let s = stripOpener(part.trim()).trim();
    if (isOffer(s)) s = s.replace(OFFER_LEAD_RE, "").trim();
    return COMPLETION_OPENER_RE.test(s) ||
      FIRST_PERSON_CLAIM_RE.test(s) || IN_PROGRESS_RE.test(s) ||
      PASSIVE_RE.test(s) || PASSIVE_JUST_RE.test(s) || GOT_IT_DONE_RE.test(s) || DONE_RE.test(s) ||
      falseSetClaim(s, storedStage) || YOURE_SET_RE.test(s) ||
      (!grounded && PASSIVE_PAST_RE.test(s)) ||
      laterClauseClaims(s);
  });
}

// Spoken figures that no payload can ground: hundred / thousand / million / billion / percent, or
// "point" followed by a digit word ("six point five", "six-point-two"). A numeral consumes its own
// multiplier and percent word first (see figureWords), so "6.52 percent" and "70 thousand" are left
// to the numeric check. Other number words ("thirty") are deliberately not on the list.
const FIGURE_WORD_RE =
  /\b(?:hundred|thousand|million|billion|percent)\b|\bpoint[\s-]+(?:zero|one|two|three|four|five|six|seven|eight|nine)\b/gi;
const figureWords = (text) => String(text).replace(FIGURE_RE, " ").match(FIGURE_WORD_RE) || [];

// True only for a reply that is ONE short question and asserts nothing: after one content-free
// opener is stripped it starts with a question/auxiliary word, ends with "?", has no sentence or
// clause break before that "?", no digit or spoken figure, and no capitalized word (other than its
// first word and "I") that the user's message did not already contain. A statement with a question
// tacked on ("Start with Robert Chen, want the numbers?") fails the first test; a made-up name
// fails the last. (Completion claims need no separate test here: a lone question is an offer, and
// claimsCompletion, which runs first, tests what follows its question word and pronoun.) The
// opener is NOT stripped when the user asked a
// yes/no or tag question (isYesNoQuestion, R5-1): "Is Chen my best?" + "Absolutely — want the numbers?"
// answers the question with the opener, so it is not a lone question.
// Pure: no I/O, no state.
function isLoneClarifyingQuestion(reply, userText) {
  const raw = String(reply == null ? "" : reply);
  const text = (isYesNoQuestion(userText) ? raw : stripOpener(raw)).trim();
  if (!text.endsWith("?")) return false;
  const body = text.slice(0, -1);
  if (!QUESTION_START_RE.test(body) || CLAUSE_BREAK_RE.test(body)) return false;
  if (/\d/.test(text) || figureWords(text).length > 0) return false;
  const said = new Set(lettersOf(userText).map((w) => w.toLowerCase()));
  return lettersOf(body).every(
    (w, i) => i === 0 || w === "I" || w[0] === w[0].toLowerCase() || said.has(w.toLowerCase())
  );
}

// What may be said when the model answered in text and no tool result this turn carried a
// citation (it called no tool, or every tool it called failed).
//   1. guideline-domain question  -> the fixed hand-off line;
//   2. the user asked a yes/no question (isYesNoQuestion, R5-1): the ONLY acceptable reply is a lone
//      clarifying question with no opener stripped ("Which Chen do you mean?"); anything else
//      ("He sure is.", "You did, on Monday.", "Absolutely — want the numbers?") -> the fixed
//      can't-verify line (R5-2; it subsumes the round-6b first-word yes/no check);
//   3. a lone clarifying question (isLoneClarifyingQuestion) -> unchanged: it asserts no fact,
//      and "what's their name?" must reach the user;
//   4. the model's text has a digit or a spoken figure, or the user's message OR the model's
//      own text names a book/market noun (rates, clients, pipeline, ...), or the user's message
//      names a glossary term (DTI, break-even, LLPA, ...: a definition comes from explainTerm, never
//      from the model's memory), or the model said
//      nothing                      -> the fixed can't-verify line (with no cited tool result, a
//      statement about the book can't be sourced, even if the user only said "good morning");
//   5. anything else (greetings, small talk, "how can I help") -> the model's text, unchanged.
// Safe ONLY after claimsCompletion(modelText, false) has run and returned false, as runTurn does:
// this function does not test for completion claims itself, so a lone question or a small-talk
// statement that claims an action ("Should I log it? Done.", "All set!") would pass through here.
// Pure: no I/O, no state.
function screenUngroundedText(userText, modelText) {
  const user = String(userText == null ? "" : userText);
  const text = String(modelText == null ? "" : modelText);
  if (isGuidelineQuestion(user)) return GUIDELINE_HANDOFF;
  // isLoneClarifyingQuestion does not strip an opener when the user asked a yes/no question
  if (isYesNoQuestion(user)) return isLoneClarifyingQuestion(text, user) ? text : CANT_VERIFY;
  if (isLoneClarifyingQuestion(text, user)) return text;
  if (!text.trim() || /\d/.test(text) || figureWords(text).length > 0) return CANT_VERIFY;
  if (BOOK_FACT_RE.test(user) || BOOK_FACT_RE.test(text) || mentionsGlossaryTerm(user)) return CANT_VERIFY;
  return text;
}

// ── Number grounding ─────────────────────────────────────────────────────────

// An integer (with optional thousands commas) and optional decimals.
const NUMBER_SRC = "(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?";
const MULTIPLIER = { hundred: 1e2, thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9 };
// A figure in a reply: $ prefix, number, then an optional K / hundred / thousand / M / million / billion multiplier
// and an optional % / percent / dollars suffix.
const FIGURE_RE = new RegExp(
  "(\\$)?" + NUMBER_SRC + "(?:\\s*(hundred|thousand|million|billion|k|m)\\b)?(\\s*%|\\s+(?:percent|dollars?)\\b)?", "gi"
);

// Every number appearing anywhere in the payload text (values, dates inside strings, even the
// digits in a key like rate_30yr_fixed), unsigned so a reply of "down 0.10" matches a delta
// of -0.1.
function payloadNumbers(payloads) {
  const out = [];
  for (const p of payloads) {
    const s = typeof p === "string" ? p : JSON.stringify(p);
    for (const m of String(s).matchAll(new RegExp(NUMBER_SRC, "g"))) {
      out.push(Number(m[1].replace(/,/g, "") + (m[2] || "")));
    }
  }
  return out;
}

// The figures in `replyText` that are NOT backed by a number in `payloads` (the tool_result
// contents sent to the model this turn; strings or objects). [] means every figure is grounded.
//   * "$" "," "%" are ignored; K/thousand and M/million scale the figure;
//   * a figure is grounded when some payload number, divided by the same scale, rounds to it at
//     the reply's own decimal places (6.46 and 6.5 both match 6.461; 412 matches 412.37;
//     485,000 and $485K match 485000; ties round either way);
//   * a standalone integer 0-10 (counts, ordinals) is exempt, unless it sits next to a $, a %,
//     "percent", "dollars" or a multiplier;
//   * a figure spoken in words (hundred, thousand, million, billion, percent, "point five") can't
//     be matched to anything, so it is always returned.
// Pure: no I/O, no state.
function ungroundedNumbers(replyText, payloads) {
  const known = payloadNumbers(Array.isArray(payloads) ? payloads : []);
  const text = String(replyText == null ? "" : replyText);
  const bad = [];
  for (const m of text.matchAll(FIGURE_RE)) {
    const [whole, dollar, int, frac, mult, suffix] = m;
    const value = Number(int.replace(/,/g, "") + (frac || ""));
    if (!dollar && !frac && !mult && !suffix && value <= 10) continue;
    const decimals = frac ? frac.length - 1 : 0;
    const scale = mult ? MULTIPLIER[mult.toLowerCase()] : 1;
    const tolerance = 0.5 * 10 ** -decimals + 1e-9;
    if (!known.some((p) => Math.abs(p / scale - value) <= tolerance)) bad.push(whole.trim());
  }
  bad.push(...figureWords(text));
  return bad;
}

// ── Messages ─────────────────────────────────────────────────────────────────

function messageText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

// The newest user message that carries text (a tool_result-only user turn has none).
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      const t = messageText(messages[i]);
      if (t.trim()) return t;
    }
  }
  return "";
}

// A user message that ANSWERS rather than asks: it does not end with "?" and, after filler, does not open
// with a question or auxiliary word ("Robert and Linda", "The first one", "Chen"; not "Robert and Linda?",
// "what are rates today", "Is Chen my best?"). Pure.
function isAnswerShaped(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t || t.endsWith("?")) return false;
  const opening = afterFiller(t);
  return !QUESTION_START_RE.test(opening) && !YES_NO_AUX_RE.test(opening);
}

// The action backstop must also hold while the user is answering a clarifying question about an action:
// "log a call with Chen" -> "Which Chen?" -> "Robert and Linda" is no action request on its own. The chain
// applies only while the user is ANSWERING: the latest user message must be answer-shaped (after an
// unconfirmed read-back, "what are rates today?" is a new request and is not held to the backstop). Walking
// back, each step is an (assistant message ending "?", user message) pair: if that user message is an
// action request, it is the origin and the backstop applies; otherwise the walk continues only if that user
// message is answer-shaped too ("log a call" -> "Who did you talk to?" -> "Chen" -> "Which Chen?" ->
// "Robert and Linda"). At most MAX_CHAIN_HOPS pairs are examined; anything that breaks the pattern, or a
// chain that does not reach an action request within the cap, does not apply the backstop. Pure.
const MAX_CHAIN_HOPS = 4;
function answersActionQuestion(messages) {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "user" || !isAnswerShaped(messageText(latest))) return false;
  for (let hop = 0, i = messages.length - 1; hop < MAX_CHAIN_HOPS && i >= 2; hop++, i -= 2) {
    const asked = messages[i - 1];
    const before = messages[i - 2];
    if (!asked || asked.role !== "assistant" || !messageText(asked).trim().endsWith("?")) return false;
    if (!before || before.role !== "user") return false;
    const text = messageText(before);
    if (isActionRequest(text)) return true;
    if (!isAnswerShaped(text)) return false;
  }
  return false;
}

// ── Stage claims ─────────────────────────────────────────────────────────────

// Nothing the model says changes the user's career stage: only a confirmed setCareerStageTool does (/api/assistant/confirm).
// So a reply that tells the user their stage IS this or that is true only if it is already their stored stage, and the
// screening is a TRUTH check like the figure check, on what the reply says, not on what the user said or on how the
// conversation went: claimsStage finds a USER-DIRECTED stage claim in the reply, and runTurn compares it with the stored
// stage (a claim that equals it is true and passes; any other is the nothing-changed line). Tool calls, their args, the
// sources and the data never depend on the stage; this only screens what is said.
//
// "new", "brand new", "developing" and "established" are also everyday words ("a new, lower payment", "brand new to this
// business", "a developing story", "you're developing a book", "an established name", "you're established in this market"):
// bare they name a stage only where the clause ends (NEW_STAGE_END), and after an article only before a stage noun.
const STAGE_NOUN_AHEAD = "(?=\\s+(?:stage|category|level|tier|bracket|broker|brokers|originator|loan\\s+officer|LO)\\b)";
const EVERYDAY_STAGE_WORDS = "(?:brand[\\s-]new|new|developing|established)";
// A possessive veteran's / veterans' is the stage only before a stage noun ("the veterans' tier", "the veterans' club"), not
// "the veterans' breakfast" or "a veteran's best option".
const VETERAN_WORD =
  "veterans?(?![\\u2019']s?\\s+(?!(?:stage|category|level|tier|bracket|club|group|ranks|track|status|mode|coaching)\\b)\\w)";
const STAGE_SRC =
  "((?<!\\b(?:an?|the)\\s)" + EVERYDAY_STAGE_WORDS + NEW_STAGE_END +
  "|(?<=\\b(?:an?|the)\\s)" + EVERYDAY_STAGE_WORDS + STAGE_NOUN_AHEAD +
  "|" + VETERAN_WORD + "|seasoned\\s+vets?)\\b";
const STAGE_WORDS_BARE = "(brand[\\s-]new|new|developing|established|veterans?|seasoned\\s+vets?)";
const STAGE_FORM_SRC = {
  // (a) you're / you are (+ now / still / all / any -ly adverb) (+ a / in the / one of the / at (the)) STAGE
  youAre: "\\byou(?:['\\u2019]re|\\s+are)\\s+(?:(?:now|still|all|\\w+ly)\\s+)*(?:(?:an?|in\\s+the|one\\s+of\\s+(?:the|our)|at(?:\\s+the)?)\\s+)?" + STAGE_SRC,
  // (b) coach / treat / move / put / got / bump ... you(rself) (up / down / back) as / like / in / into / to / at STAGE
  actionOnYou: "\\b(?:coach(?:es|ing|ed)?|treat(?:s|ing|ed)?|count(?:s|ing|ed)?|list(?:s|ing|ed)?|mark(?:s|ing|ed)?|tag(?:s|ging|ged)?" +
    "|puts?|putting|mov(?:e|es|ing|ed)|switch(?:es|ing|ed)?|chang(?:e|es|ing|ed)|ha(?:ve|s)|sees?|seeing|consider(?:s|ing|ed)?" +
    "|got|bump(?:s|ing|ed)?|upgrad(?:e|es|ing|ed)|plac(?:e|es|ing|ed)|land(?:s|ing|ed)?|not(?:e|es|ing|ed))" +
    "\\s+you(?:rself)?\\s+(?:(?:up|down|back)\\s+)?(?:as|like|in(?:to)?|to|at)\\s+(?:(?:an?|the|one\\s+of\\s+(?:the|our))\\s+)?" + STAGE_SRC,
  // (b2) make / call / consider you(rself) STAGE (no preposition: "That makes you Established.", "Consider yourself a Veteran.")
  makeYou: "\\b(?:makes?|making|call(?:s|ing)?|consider(?:s|ing)?)\\s+you(?:rself)?\\s+(?:(?:an?|the)\\s+)?" + STAGE_SRC,
  // you / that / this qualify / count as STAGE ("You qualify as a Veteran.", "That counts as Veteran.")
  qualifyAs: "\\b(?:you|that|this)\\s+(?:qualif(?:y|ies|ied)|count(?:s|ed)?)\\s+as\\s+(?:an?\\s+)?" + STAGE_SRC,
  // (c) STAGE it is, (d) STAGE coaching (a bare "new coaching" is a tip, not a stage)
  itIs: "\\b" + STAGE_WORDS_BARE + "\\s+it\\s+is\\b",
  coaching: "\\b(brand[\\s-]new|developing|established|veterans?|seasoned\\s+vets?)\\s+coaching\\b",
  // (e) your (career) stage is / 's / has been / was / will be (now) (set to / as) STAGE
  yourStage: "\\byour\\s+(?:career\\s+)?stage(?:\\s+(?:is|has\\s+been|was|will\\s+be)|['\\u2019]s)\\s+(?:now\\s+)?(?:set\\s+(?:to|as))?[\\s:\"'\\u201c\\u2018]*(?:(?:an?|the)\\s+)?" + STAGE_SRC,
  // that's / that is STAGE level / tier / territory / stage / bracket / status ("That's Veteran level, so I'll keep it terse."). An
  // article only before veteran(s) / seasoned vet(s): "that's a new level for rates", "the established level for cash-out" are not
  // stages; and bare new / developing / established keep their own allow-list ("that's new territory" is not one either)
  thatsLevel: "\\bthat(?:['\\u2019]s|\\s+is)\\s+(?:(?:an?|the)\\s+(?=(?:veterans?|seasoned\\s+vets?)\\b))?" + STAGE_SRC +
    "\\s+(?:level|tier|territory|stage|bracket|status)\\b",
  // STAGE status, said to the user only and where the clause ends ("You've got veteran status now."): "Robert's veteran status"
  // is VA eligibility, and "established status with the Chens" or "your veteran status with the VA" is no stage
  status: "\\b(?:you(?:['\\u2019]ve|\\s+have)?(?:\\s+(?:now|officially|already|just|got|earned|hit|reached|have))*|your" +
    "|(?:gives?|giving|gets?|got|earns?|earned|puts?)\\s+you)\\s+(?:(?:an?|the)\\s+)?(developing|established|veterans?|seasoned\\s+vets?)\\s+status\\b" +
    NEW_STAGE_END,
  // STAGE mode ("Veteran mode on!"; never a bare "new")
  mode: "\\b(brand[\\s-]new|developing|established|veterans?|seasoned\\s+vets?)\\s+mode\\b",
  // two acknowledgements the earlier rounds pinned: "Welcome to the veterans' tier." and a sentence that opens with the stage
  // ("Veteran, got it."; not "New, lower rates are out", so never a bare "new"), plus the vocative ("Welcome aboard, Veteran!").
  // `leading` is tested on whole sentences only (see stageClaims): an opener may be followed by "," or ":" ("Got it: Veteran."),
  // and the stage word by "(" ("Veteran (10+ years).")
  welcome: "\\bwelcome\\s+to\\s+(?:the\\s+)?" + STAGE_SRC,
  vocative: "\\b(?:welcome(?:\\s+aboard)?|congrats|congratulations)\\s*,?\\s+" + STAGE_SRC,
  leading: "^\\s*(?:(?:ok|okay|alright|great|got\\s+it|perfect|so|right|sure|yes|yep)[\\s,:]+)*(brand[\\s-]new|veteran|established|developing)\\s*(?:[,.!\\u2014\\u2013(]|$)",
};
const STAGE_FORMS = Object.fromEntries(Object.entries(STAGE_FORM_SRC).map(([name, src]) => [name, new RegExp(src, "gi")]));
// An offer keeps only the assertion forms; any other sentence part gets every form but `leading`.
const OFFER_STAGE_FORMS = [STAGE_FORMS.youAre, STAGE_FORMS.yourStage];
const STATEMENT_STAGE_FORMS = Object.entries(STAGE_FORMS).filter(([name]) => name !== "leading").map(([, re]) => re);
// Sentences in the leading form's sense: split only after . ! ? (an em or en dash, or a semicolon, starts no sentence).
const wholeSentencesOf = (text) => String(text).match(/[^.!?]+[.!?]*/g) || [];

// "veterans" / "seasoned vet" are veteran, "brand-new" / "new" are new
function stageIdOf(word) {
  const w = String(word).toLowerCase().replace(/\s+/g, " ");
  if (/^(?:brand[\s-])?new$/.test(w)) return "new";
  if (/^veterans?$|^seasoned vets?$/.test(w)) return "veteran";
  return STAGE_IDS.includes(w) ? w : null;
}

// The stage ids a reply claims for the USER, in order (one per claim): "You're a Veteran now.", "I'll coach you as a Veteran",
// "That puts you in the Veteran tier.", "You qualify as a Veteran.", "Veteran it is.", "Veteran coaching", "Your stage is now
// Veteran.", "That's Veteran level", "Veteran mode on!", and the acknowledgements above. Each sentence part (split like
// claimsCompletion, one opener stripped) is tested; an OFFER (a question-word sentence ending in "?") loses its lead and keeps
// only the assertion forms (a) and (e): "Want me to coach you as a Veteran?" proposes, "...now that you're a Veteran?" asserts.
// The leading form is tested on whole sentences only (the reply's first, or one after . ! ?), after one opener strip, and never
// on a sentence ending "?": "Call the Chens first — established, low-risk, ..." and "Veteran, Established, or Developing — which
// fits?" claim nothing. Subjects other than the user ("Chen is an established client", "VA loans for veterans", "a developing
// story", "Robert's veteran status") are not claims.
function stageClaims(text) {
  const claims = [];
  const add = (re, s) => {
    for (const m of s.matchAll(re)) {
      const id = stageIdOf(m[1]);
      if (id) claims.push(id);
    }
  };
  for (const sentence of wholeSentencesOf(String(text == null ? "" : text))) {
    const whole = stripOpener(sentence.trim()).trim();
    if (whole && !/\?\s*$/.test(whole)) add(STAGE_FORMS.leading, whole);
    for (const part of sentencesOf(sentence)) {
      let s = stripOpener(part.trim()).trim();
      if (!s) continue;
      const offer = isOffer(s);
      if (offer) s = s.replace(OFFER_LEAD_RE, "").trim();
      for (const re of offer ? OFFER_STAGE_FORMS : STATEMENT_STAGE_FORMS) add(re, s);
    }
  }
  return claims;
}
// The first stage id a reply claims for the user, or null. Pure.
const claimsStage = (text) => stageClaims(text)[0] || null;

// A set-claim (FIRST_PERSON_SET_RE, SET_PASSIVE_RE, STAGE_SET_BARE_RE) in one sentence part that is false for this user: it
// names no stage ("Your career stage is set.", "I've already set it."), or it names a stage other than the stored one (null or
// undefined = not set). "Your career stage is set to Veteran." is true for a stored veteran, like the stage claims above. Pure.
const STAGE_NAMED_RE = new RegExp("\\b" + STAGE_SRC, "gi");
function falseSetClaim(sentence, storedStage) {
  if (!FIRST_PERSON_SET_RE.test(sentence) && !SET_PASSIVE_RE.test(sentence) && !STAGE_SET_BARE_RE.test(sentence)) return false;
  const named = [...sentence.matchAll(STAGE_NAMED_RE)].map((m) => stageIdOf(m[1])).filter(Boolean);
  return named.length === 0 || named.some((id) => id !== storedStage);
}

// ── Tool execution ───────────────────────────────────────────────────────────

// Error results carry a parenthesised label like "(not found)": those are never cited.
const isCitation = (source) => typeof source === "string" && source.trim() !== "" && !/^\(.*\)$/.test(source.trim());

// The sweep result can run to hundreds of rows; the model gets the real totals plus the top
// opportunities (each with its best lens) and the first check-ins. "Top" is the engine's own
// order for picking a client's best lens (lib/refi.js: priority, then impact()), applied across
// clients; Array.sort is stable, so ties keep the sweep's name order.
function trimSweep(data) {
  if (!data || data.error || !Array.isArray(data.opportunities)) return data;
  const rank = (r) => refi.PRIORITY_RANK[r.best.priority] || 0;
  const top = data.opportunities
    .filter((r) => r && r.best)
    .sort((a, b) => rank(b) - rank(a) || refi.impact(b.best) - refi.impact(a.best))
    .slice(0, SWEEP_TOP_OPPORTUNITIES)
    .map((r) => ({ name: r.name, best: r.best }));
  const checkIns = (Array.isArray(data.checkIns) ? data.checkIns : [])
    .slice(0, SWEEP_TOP_CHECKINS)
    .map((r) => ({ name: r.name, monthsSince: r.checkIn && r.checkIn.monthsSince }));
  const out = { counts: data.counts, byLens: data.byLens, opportunities: top, checkIns };
  if (data.estimated) out.estimated = true;
  return out;
}

// PII minimization: the model sees at most five matches, without contact details or notes
// (those stay in the UI record), plus how many matched in total.
function trimFindClient(data) {
  if (!data || !Array.isArray(data.matches)) return data;
  const matches = data.matches
    .slice(0, FIND_CLIENT_MAX_MATCHES)
    .map(({ email, phone, notes, ...rest }) => rest);
  const out = { matches, totalMatches: data.matches.length };
  if (data.error) out.error = data.error;
  return out;
}

const forModel = (name, data) =>
  name === "runSweepTool" ? trimSweep(data) : name === "findClient" ? trimFindClient(data) : data;

const toolResultBlock = (id, source, data, isError) => {
  const block = { type: "tool_result", tool_use_id: id, content: JSON.stringify({ source, data }) };
  if (isError) block.is_error = true;
  return block;
};

const cleanName = (n) => (typeof n === "string" ? n.replace(/\s+/g, " ").trim() : "");

// Runs one tool and shapes what goes back to the model. A throwing tool never leaks its error
// text to the model: it becomes an is_error result the model can apologise for. Returns
// { source, sideEffect?, data, toolResult }.
function runTool(block, ctx) {
  try {
    const result = tools[block.name](block.input && typeof block.input === "object" ? block.input : {}, ctx);
    if (!result || typeof result !== "object") throw new Error("tool returned no result");
    let { sideEffect } = result;
    if (sideEffect && sideEffect.type === "addClient") {
      // The saved name must be the one the read-back speaks; no usable name means nothing to confirm.
      const fields = sideEffect.fields || {};
      const name = cleanName(fields.name);
      if (!name) {
        const error = { error: "a client name is required" };
        return { source: "(invalid input)", data: error, toolResult: toolResultBlock(block.id, "(invalid input)", error) };
      }
      sideEffect = { ...sideEffect, fields: { ...fields, name } };
    }
    return {
      source: result.source, sideEffect, data: result.data,
      toolResult: toolResultBlock(block.id, result.source, forModel(block.name, result.data)),
    };
  } catch (_err) {
    const error = { error: "that lookup failed" };
    return { source: "(error)", data: error, toolResult: toolResultBlock(block.id, "(error)", error, true) };
  }
}

// Code-authored confirmation question, built from the tool's own data (never from anything the
// model wrote), so what is read back is what would be saved.
function readBack(out) {
  const se = out.sideEffect;
  switch (se.type) {
    case "logContact":
      return `Just to confirm — log a contact for ${cleanName(out.data && out.data.client && out.data.client.name) || "that client"}?`;
    case "addClient":
      return `Just to confirm — add ${se.fields.name} as a new client?`;
    case "setCareerStage": {
      // the label comes from the stage the tool packaged, so what is read back is what would be saved
      const stage = stageById(se.stage);
      return stage ? `Just to confirm — set your career stage to ${stage.label}?` : "Just to confirm — go ahead with that?";
    }
    default:
      return "Just to confirm — go ahead with that?";
  }
}

// ── The turn ─────────────────────────────────────────────────────────────────

// runTurn({ messages, ctx, client }) -> { reply, sources, sideEffect?, usage }
//   messages: Messages API history ending with the user's latest message (not mutated)
//   ctx:      { user, rates, db }, handed to the tools
//   sources:  citing `source` strings of the tool results used (error labels are not cited)
async function runTurn({ messages, ctx, client } = {}) {
  if (!Array.isArray(messages)) throw new TypeError("runTurn: messages must be an array");
  if (!client || !client.messages || typeof client.messages.create !== "function") {
    throw new TypeError("runTurn: client must provide messages.create()");
  }
  const usage = { inputTokens: 0, outputTokens: 0 };
  const finish = (reply, cited, sideEffect) => {
    const out = { reply, sources: cited || [], usage };
    if (sideEffect) out.sideEffect = sideEffect;
    return out;
  };

  // Nothing to answer: no API call.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !messageText(last).trim()) return finish(DIDNT_CATCH);

  const convo = messages.slice();
  const userText = latestUserText(convo);
  // R5-3 applies to this turn if the user asked for an action now, or is answering a question about one.
  const actionTurn = isActionRequest(userText) || answersActionQuestion(messages);
  const sources = [];   // citing sources of the read tools run this turn
  const payloads = [];  // the tool_result contents of the book/market tools this turn: the figures a reply may use (never explainTerm's)
  let glossaryMiss = false;   // an explainTerm call this turn got no definition back
  const glossaryDefs = [];    // the definitions explainTerm returned this turn, once per term, in the order asked
  // The user's stored stage (null = not set; anything that is not a stage id reads as not set): what a reply may truthfully claim.
  const storedStage = (ctx && ctx.user && stageById(ctx.user.career_stage) && stageById(ctx.user.career_stage).id) || null;
  // CHARLI_SYSTEM plus the coaching block for this user's career stage: it tailors how she coaches. The screening below runs
  // on the model's text and this turn's tool results, and its stage check compares the stage a reply claims (stageClaims, and a
  // set-claim that names a stage) with the stored stage above: only a claim equal to it is true
  const system = buildCharliSystem(ctx && ctx.user);

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const lastCall = call === MAX_MODEL_CALLS - 1;
    // No temperature / tool_choice / thinking: CLAUDE_MODEL is configurable and newer models
    // reject forced tool use and non-default sampling.
    const response = await client.messages.create({
      model: modelName(), max_tokens: MAX_TOKENS, system, tools: TOOL_SCHEMA,
      messages: convo.slice(),
    });
    // A missing response is a fault upstream, not an answer: the route turns the throw into the error turn.
    if (!response || typeof response !== "object") throw new Error("the model returned no response");
    const u = response.usage || {};
    usage.inputTokens += Number.isFinite(u.input_tokens) ? u.input_tokens : 0;
    usage.outputTokens += Number.isFinite(u.output_tokens) ? u.output_tokens : 0;

    const content = response && Array.isArray(response.content) ? response.content : [];
    const toolUses = response && response.stop_reason === "tool_use"
      ? content.filter((b) => b && b.type === "tool_use")
      : [];

    // Final answer in text.
    if (toolUses.length === 0) {
      const text = content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (isGuidelineQuestion(userText)) return finish(GUIDELINE_HANDOFF);
      // R5-3, the action backstop: an action was asked for (now, or in the question this message
      // answers), and no change is being handed up for confirmation (a turn that ends in text never
      // carries a sideEffect), so whatever the model says, nothing was done. Only a question may
      // reach the user; anything else is replaced.
      if (actionTurn && !isQuestionShaped(text)) return finish(NOTHING_CHANGED);
      // I3: when the glossary is the only thing cited, the reply is the definition(s), code-authored from what explainTerm
      // returned (a term it did not know adds the can't-verify line), and the model's text is discarded: a glossary citation
      // must not carry a claim about the book. (On a turn that also cites a book source the model's text stands, and its figures
      // are checked against the book sources only: explainTerm's results are never in `payloads`, so the glossary's 80 or 36
      // cannot make a client's LTV or a rate a fact.)
      if (glossaryDefs.length > 0 && sources.length > 0 && sources.every((src) => src === GLOSSARY_SOURCE)) {
        const spoken = glossaryDefs.map((d) => d.definition);
        if (glossaryMiss) spoken.push(CANT_VERIFY);
        return finish(spoken.join(" "), [GLOSSARY_SOURCE]);
      }
      // A stage claim is a truth check against the stored stage (see claimsStage): no sideEffect backs it, so only the stored
      // stage may be claimed, on every turn, whatever the user said (a stored veteran hearing "you're a Veteran" is told the truth).
      // A set-claim that names a stage ("Your career stage is set to Veteran.") gets the same check inside claimsCompletion.
      if (stageClaims(text).some((id) => id !== storedStage)) return finish(NOTHING_CHANGED);
      if (claimsCompletion(text, sources.length > 0, storedStage)) return finish(NOTHING_CHANGED);
      // No cited tool result behind the text: it may only be conversation (screenUngroundedText
      // is stricter than the figure check: it refuses any digit).
      if (sources.length === 0) {
        // explainTerm came back empty-handed ("(not found)", invalid, failed): nothing may define the term instead
        // of it, whatever words the definition is made of. Only a question back to the user is allowed through.
        if (glossaryMiss && !isLoneClarifyingQuestion(text, userText)) return finish(CANT_VERIFY);
        return finish(screenUngroundedText(userText, text));
      }
      // Grounded: every figure the model speaks must be one the tools returned this turn.
      if (!text || ungroundedNumbers(text, payloads).length > 0) return finish(CANT_VERIFY);
      return finish(text, sources);
    }

    // Unknown tool name: execute nothing, not even the valid calls alongside it.
    if (toolUses.some((b) => typeof b.name !== "string" || typeof tools[b.name] !== "function")) {
      return finish(CANT_VERIFY);
    }

    convo.push({ role: "assistant", content });
    // On the last allowed call no narration can follow, so only a change to confirm matters.
    const runBlocks = lastCall ? toolUses.filter((b) => SIDE_EFFECT_TOOLS.has(b.name)) : toolUses;
    const outs = runBlocks.map((block) => runTool(block, ctx));
    runBlocks.forEach((b, i) => {
      if (b.name !== "explainTerm") return;
      const { source, data } = outs[i];
      if (!isCitation(source)) glossaryMiss = true;
      else if (data && typeof data.definition === "string" && !glossaryDefs.some((d) => d.term === data.term)) {
        glossaryDefs.push({ term: data.term, definition: data.definition });
      }
    });

    // The tools only package a change; here it is handed up for confirmation, not acted on.
    const changes = outs.filter((o) => o.sideEffect);
    if (changes.length > 1) return finish(ONE_AT_A_TIME);
    if (changes.length === 1) {
      const change = changes[0];
      return finish(readBack(change), isCitation(change.source) ? [change.source] : [], change.sideEffect);
    }
    if (lastCall) break;

    for (const [i, o] of outs.entries()) {
      if (isCitation(o.source) && !sources.includes(o.source)) sources.push(o.source);
      // a definition's own numbers (80 percent, 36 months) are product facts about the glossary, not figures the model may quote
      if (runBlocks[i].name !== "explainTerm") payloads.push(o.toolResult.content);
    }
    convo.push({ role: "user", content: outs.map((o) => o.toolResult) });
  }

  // The model kept calling tools and never produced an answer within the cap.
  return finish(CANT_VERIFY);
}

module.exports = {
  runTurn, screenUngroundedText, ungroundedNumbers, isLoneClarifyingQuestion, stripOpener, claimsCompletion,
  isYesNoQuestion, isBareYesNoAnswer, isActionRequest, isQuestionShaped, isCitation, claimsStage, stageClaims,
};
