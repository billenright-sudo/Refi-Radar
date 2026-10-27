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
//   * a client email is never written or sent here: a successful draftEmailTool ends the turn at once with a code-authored line
//     and its `compose` links (the model never sees the address or the body), and a Google / NMLS / no-email failure is a
//     code-authored line too (the model is not asked to put it into words);
//   * an unknown tool name, or a loop that never settles, resolves to the can't-verify line.
//
// `client` is anything with messages.create(params) -> a Messages API response (the real
// @anthropic-ai/sdk client in production, a scripted fake in tests); this file never imports it.
const refi = require("../refi");
const { tools, TOOL_SCHEMA } = require("./tools");
const {
  buildCharliSystem, CANT_VERIFY, GUIDELINE_HANDOFF, NOTHING_CHANGED, ONE_AT_A_TIME, DIDNT_CATCH, STAGE_REASK, TOOK_TOO_LONG,
  GOOGLE_NOT_CONNECTED, GOOGLE_RECONNECT, GOOGLE_UNAVAILABLE, NMLS_NEEDED, noEmailLine, NO_SEND,
} = require("./prompt");
const { PURPOSE_WORDS } = require("./outreach");
const { parseTime, toInstant, localTimeOf, localToday, spokenDay, spokenTime } = require("../google/time");
const { CAREER_STAGES, CAREER_QUESTION, stageById, spokenStageLabel } = require("./coaching");
const { GLOSSARY_SOURCE, mentionsGlossaryTerm } = require("./glossary");

const MAX_MODEL_CALLS = 4;   // model calls per turn, including the one that narrates
// The whole turn gets this long (up to four model calls, so without it a slow model holds the mic for minutes). A model call is
// not started with less than MIN_CALL_MS left: it could not plausibly finish.
const DEFAULT_TURN_DEADLINE_MS = 25_000;
const MIN_CALL_MS = 1_500;
const MAX_TOKENS = 600;      // replies are 1-3 spoken sentences
const SWEEP_TOP_OPPORTUNITIES = 10;
const SWEEP_TOP_CHECKINS = 10;
const FIND_CLIENT_MAX_MATCHES = 5;

// The tools that only PACKAGE a change (they never write; see tools.js).
const SIDE_EFFECT_TOOLS = new Set(["addClientTool", "logContactTool", "setCareerStageTool", "createEventTool"]);
// On the last allowed model call these are the only tools run, because nothing else's result could be used: a change to
// confirm, and an email to set up (its result ends the turn in code, so no later model call is needed to narrate it).
const LAST_CALL_TOOLS = new Set([...SIDE_EFFECT_TOOLS, "draftEmailTool"]);

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

// Process narration ahead of the answer: "I (actually) need to back up —", "Let me start fresh —", "Let me try that again —"
// (followed by , . ! : an em or en dash or a spaced hyphen), the model talking about its own earlier turns or retries, not about
// the book. On a GROUNDED turn only (a cited tool result this turn) such openers are removed from the start of the reply
// before it is screened, and the reply then gets every screen in full, so nothing they hide can carry a claim or a figure past
// them: "I actually need to back up — here are today's live rates: ..." is said "Here are today's live rates: ...". On an
// ungrounded turn they stay, and the ungrounded screens see the whole reply. Only the opener goes: a narration sentence after
// it is the model's own (the prompt tells it never to narrate its process). Pure.
const PROCESS_OPENER_RE = new RegExp(
  "^\\s*(?:I\\s+(?:actually\\s+)?need\\s+to\\s+back\\s+up|let\\s+me\\s+start\\s+fresh|let\\s+me\\s+try\\s+that\\s+again)" +
    "(?:\\s*[,.!:\\u2014\\u2013]|\\s+-(?=\\s))\\s*",
  "i"
);
function stripProcessOpeners(text) {
  const raw = String(text == null ? "" : text);
  let s = raw;
  while (PROCESS_OPENER_RE.test(s)) s = s.replace(PROCESS_OPENER_RE, "");
  // what is left is a sentence of its own: "here are today's live rates" -> "Here are today's live rates"
  return s && s !== raw ? s[0].toUpperCase() + s.slice(1) : s;
}

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
// Speech-to-text audio-event tags, "(background noise)", "[laughter]", anywhere in the text: they are not the user's words, and
// one at the start would hide the request behind it ("(background noise) Log a call with the Chens."). Removed, with the filler,
// before every test that reads how a sentence or clause opens.
const AUDIO_TAG_RE = /\([^()]*\)|\[[^[\]]*\]/g;
const afterFiller = (s) => String(s == null ? "" : s).replace(AUDIO_TAG_RE, " ").replace(FILLER_RE, "").trim();
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
// form): "update me / us / on ..." ("update me on rates") and "put together" ("put together a call list"). Writing to a client
// is an action like any other (draft / write / email / send), so a reply to "draft the Chens a check-in" that is not a question is
// held to the same backstop. The same kind of carve-out keeps the information requests that share those verbs answerable: "send me
// / us ..." ("send me what's on my calendar"), "email me / us ..." and "email on file ..." / "email address ..." (the noun), and
// "write me / us / down ...". Charli sends nothing, so a claim of "sent" or "emailed" is still caught by the every-turn claim screens.
// The polite leads "would you mind" and a clause-initial "mind" ("mind logging a call") take the -ing form.
// The filler list holds only words that cannot be a noun: "go log", "make sure to log", "try to log",
// "remember to log", and "make a note" (the "a" counts only when "note" follows). "remember" counts only
// before "to": "Can you remember logging a call with Chen?" asks about the past, it requests nothing.
// A first-person contact REPORT is an action request too (CONTACT_REPORT_RE): a clause that opens with "I (just / already)" or
// "I've" or "Just", or with the verb itself (the subject dropped: "Called the Chens this morning.", "Talked to the Chens", "Spoke
// with Robert Chen earlier"), then called / phoned / rang / talked to / talked with / spoke with / spoke to / met with / texted /
// emailed / left a message (or voicemail) for / left <someone> a message (or voicemail) / got off the phone with / had a call
// with / was (just) on the phone with / hung up with / caught up with / touched base with ("I called the Chens this morning",
// "Just got off the phone with the Chens", "I left the Chens a voicemail"). Saying it is how a broker asks for the contact to be
// logged, so the backstop then lets through only a question ("Want me to log that?") or the logContactTool read-back.
// A report counts only in a message that asks nothing (reportOnly): no "?" anywhere (audio tags removed first), and no clause
// that opens, after filler, with a question or auxiliary word (ASKING_START_RE: what / who / which / when / where / how / why /
// is / are / should / can / do / does ...). "I just spoke with the Chens, what's their balance?" and "I texted my wife — anyway,
// what are rates today?" are questions with a bit of news in front, not requests. "want" and "need" do not count as asking
// here: in the user's words they open a request ("I called the Chens, need to log that"), so such a report stays one. Pure.
// Coaching is no action either (Ruling 51): write / draft (and writing / drafting) followed, past up / out and a closed list of
// small words (a, an, the, me, quick, short, ...), by a talk track, a script, an opener, an opening line, a pitch, an intro, a
// voicemail script, "what to say" or "how to say" ("help me write an opener for the Chens", "write a talk track for a refi call",
// "Want me to write up a quick talk track for the call?"). A client's name in between keeps it a request ("write the Chens a
// check-in"), and so does an email, a note, a letter, a message or a text after the noun ("draft an intro email to the Chens").
const COACHING_OBJECT =
  "(?!(?:\\s+(?:up|out))?(?:\\s+(?:a|an|the|some|me|us|them|him|her|quick|short|brief|little|good|great|simple|solid|strong|new|better" +
  "|rough|first|catchy|friendly|casual|fresh|few|couple|of))*\\s+(?:talk\\s+tracks?|scripts?|openers?|opening\\s+lines?|pitch(?:es)?|intros?" +
  "|voicemail\\s+scripts?|what\\s+to\\s+say|how\\s+to\\s+say)(?![\\w'\\u2019-])(?!\\s+(?:e-?mails?|notes?|letters?|messages?|texts?)\\b))";
const ACTION_VERBS =
  "log|add|mark|record|note|update(?!\\s+(?:me|us|on)\\b)|set|book|schedule|save|create|enter|put(?!\\s+together\\b)" +
  "|draft" + COACHING_OBJECT + "|write(?!\\s+(?:me|us|down)\\b)" + COACHING_OBJECT +
  "|email(?!\\s+(?:address(?:es)?|me|us|on\\s+file)\\b)|send(?!\\s+(?:me|us)\\b)";
const ACTION_VERBS_ING =
  "logging|adding|marking|recording|noting|updating(?!\\s+(?:me|us|on)\\b)|setting|booking|scheduling|saving|creating|entering|putting(?!\\s+together\\b)" +
  "|drafting" + COACHING_OBJECT + "|writing(?!\\s+(?:me|us|down)\\b)" + COACHING_OBJECT +
  "|emailing(?!\\s+(?:address(?:es)?|me|us|on\\s+file)\\b)|sending(?!\\s+(?:me|us)\\b)";
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
const CONTACT_REPORT_RE = new RegExp(
  "^(?:I(?:['\\u2019]ve|\\s+have)?\\s+(?:(?:just|already)\\s+)?|just\\s+)?" +
    "(?:called|phoned|rang|talked\\s+(?:to|with)|spoke\\s+(?:with|to)|met\\s+with|texted|emailed" +
    "|left\\s+(?:a\\s+)?(?:message|voicemail)\\s+for|left\\s+(?:(?!an?\\b)[\\w&'\\u2019.-]+\\s+){1,4}?an?\\s+(?:message|voicemail)" +
    "|got\\s+off\\s+the\\s+phone\\s+with|had\\s+a\\s+call\\s+with|was\\s+(?:just\\s+)?on\\s+the\\s+phone\\s+with" +
    "|hung\\s+up\\s+with|caught\\s+up\\s+with|touched\\s+base\\s+with)\\b",
  "i"
);
const ASKING_START_RE = new RegExp(
  "^(?:(?:and|or|so)\\s+)?(?:" + QUESTION_WORDS.split("|").filter((w) => w !== "want" && w !== "need").join("|") + ")\\b", "i"
);
const reportOnly = (text) => {
  const t = text.replace(AUDIO_TAG_RE, " ");
  return !t.includes("?") && !t.split(USER_CLAUSE_BREAK_RE).some((clause) => ASKING_START_RE.test(afterFiller(clause)));
};
const STATE_QUESTION_LEAD_RE = /^(?:when|what|which|who|how|did|has|have|had|was|were)\b/i;
const isActionRequest = (text) => {
  const t = String(text == null ? "" : text);
  const reports = reportOnly(t);
  return t.split(USER_CLAUSE_BREAK_RE).some((clause) => {
    const c = afterFiller(clause);
    return !STATE_QUESTION_LEAD_RE.test(c) && (ACTION_LEAD_RE.test(c) || REQUEST_LEAD_RE.test(c) || (reports && CONTACT_REPORT_RE.test(c)));
  });
};

// R5-3's pass condition: after at most one opener strip, the reply's first clause (the text before
// its first . ! ; em dash, en dash or spaced hyphen) opens with a question/auxiliary word, and the
// reply ends with "?". The first clause begins where the reply begins and QUESTION_START_RE is
// anchored there, so it is tested on the stripped reply directly. A claim after the question word
// is the claim guard's job. Names are allowed ("Which Chen — Robert and Linda, or Chen Wei?"). Pure.
function isQuestionShaped(reply) {
  const s = stripOpener(reply).trim();
  return s.endsWith("?") && QUESTION_START_RE.test(s);
}
// Ruling 30: on an action turn the reply is ONE question: question-shaped, and one sentence after at most one opener ("Got it. Who
// did you talk to?" is one; "I see two Chens. Which one?" and "What else? The follow-up is on your calendar Friday. Want a reminder?"
// are not). A sentence ends at . ! ? followed by more words; not the point of a title (Mr. Dr. ...) or of a common abbreviation
// (e.g. i.e. vs. approx. etc. a.m. p.m.: Ruling 37). Pure.
const SENTENCE_END_RE = /(?<!\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|approx|etc)|\b[ap]\.m|\be\.g|\bi\.e)[.!?]+(?=\s+\S)/i;
const isOneQuestion = (reply) => isQuestionShaped(reply) && !SENTENCE_END_RE.test(stripOpener(reply).trim());

// A completion claim. runTurn never performs an action, so by construction anything the model
// says that reads as "it's done" is false. Each sentence (split on . ! ? ; and em/en dashes) is
// tested on its own, after one content-free opener is stripped from it:
//   * a completion opener at its start ("Done", "All set", "You're all set", "Consider it done / handled / sent",
//     "Logged", "Already saved", "Sent", "Sent over", "Scheduled!", "Created!", ...); a sentence that is only "done" /
//     "all done" / "all set" is the simplest case of this;
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
//     check against `storedStage` (falseSetClaim): one whose object of "set" is the stored stage, with nothing else set and no
//     other stage named, is true and is no claim ("Your career stage is set to Veteran." for a stored veteran); any other is a
//     claim ("I've set that, Robert's a veteran." names the stage, but did not set it);
//   * the simple past passive ("was logged", "were added", "was set") only on an ungrounded turn: it is the one
//     form a grounded turn may use to narrate a tool fact ("your last contact with Chen was logged on
//     2026-01-01"; the date still goes through the figure check);
//   * a completion opener at the start of a later clause, after a comma, colon, ellipsis, "--", a
//     spaced hyphen, "and" or "then" ("Sure thing, done!", "Yep, logged it.", "Found Chen and logged
//     the call", and in an offer "Should I set a follow-up, logged it already?"). There "updated" and
//     "marked" count only when an object or nothing follows them ("updated the record", "marked as
//     contacted"), so narration like "6.52 percent, updated this morning" is left alone;
//   * the shortened passive, a clause that opens with a short noun phrase and the participle ("Call logged for the Chens.",
//     "Chens marked as contacted."), plus "That's in for the Chens." and "... up to date now" (shortPassiveClaims), on every turn.
// An offer (a sentence that starts with a question/auxiliary word and ends with "?") loses only its
// question word and subject pronoun ("Should I", "Would you"), and the rest gets the same test,
// later clauses included (R5-4): "Should I get that marked as contacted?" is not a claim, "Would you
// like me to set a follow-up now that I've logged the call?" is. "changed" is not a claim verb: "I see
// rates changed overnight" is narration.
const CLAIM_VERBS = "logged|added|saved|booked|sent|scheduled|updated|created|recorded|marked|noted|handled|drafted|emailed|wrote|done";
const PASSIVE_VERBS = "logged|added|saved|recorded|updated|marked|noted|booked|sent|handled|drafted|emailed";
const NOT_A_CLAIM = "not|never|no|can|cannot|could|would|should|will|shall|may|might|must|to";
const FIRST_PERSON_CLAIM_RE = new RegExp(
  "\\b(?:I|we)(?:['\\u2019]ve|\\s+have)?(?:\\s+(?!(?:" + NOT_A_CLAIM + ")\\b)\\w+){0,4}\\s+(?:" + CLAIM_VERBS + ")\\b", "i"
);
const IN_PROGRESS_RE =
  /\b(?:I['\u2019]m|I\s+am|we['\u2019]re|we\s+are)\s+(?:(?:now|just|going\s+ahead\s+and)\s+)?(?:logging|saving|adding|booking|recording|marking|noting|updating|scheduling|sending|creating|drafting|emailing)\b/i;
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
// "has been set as an Established broker", "is set to: “Veteran (10+ years)”", "is already set to Veteran" and "You're
// now set / marked / listed as Veteran" are false on every turn. The object must be a stage ("Their ARM is set to adjust"
// is narration). "already" stands wherever "now" does. The first-person forms are FIRST_PERSON_SET_RE.
const SET_PASSIVE_RE = new RegExp(
  "(?:\\b(?:is|are|been)|['\\u2019](?:s|re))\\s+(?:(?:now|already)\\s+)?set\\s+(?:to|as)[\\s:\"'\\u201c\\u2018]*(?:(?:an?|the)[\\s:\"'\\u201c\\u2018]+)?(?:" +
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
  /^\s*(?:(?:just|already|also)\s+)?(?:done|all\s+done|all\s+set|you['\u2019]re\s+all\s+set|you\s+are\s+all\s+set|consider\s+it\s+(?:done|handled|sent)|logged|saved|added|booked|recorded|noted|updated|marked|handled|sent|scheduled|created|drafted|emailed)\b/i;
const CLAUSE_SPLIT_RE = /,|:|\u2026|--|\s-\s|\b(?:and|then)\b/i;
const LEADING_CONJ_RE = /^(?:(?:so|but|plus)\s+)+/i;
const TRAILING_PUNCT_RE = /[\s.!?;:,\u2026"\u201d)]+$/;
const CLAUSE_CLAIM_RE =
  /^(?:(?:just|already|also)\s+)?(?:(?:all\s+)?done|all\s+set|logged|saved|added|booked|recorded|noted|handled|sent|scheduled|created|drafted|emailed|(?:updated|marked)(?=$|\s+(?:it|that|them|him|her|the|your|their|as\s+contacted)\b))\b/i;

const sentencesOf = (text) => String(text).match(/[^.!?;\u2014\u2013]+[.!?;\u2014\u2013]*/g) || [];
const isOffer = (sentence) => /\?\s*$/.test(sentence) && QUESTION_START_RE.test(sentence.trim());
// A completion opener at the start of any clause after the first (the first is the sentence start).
const laterClauseClaims = (sentence) =>
  sentence.split(CLAUSE_SPLIT_RE).slice(1).some((c) =>
    CLAUSE_CLAIM_RE.test(stripOpener(c.trim().replace(LEADING_CONJ_RE, "")).trim().replace(TRAILING_PUNCT_RE, ""))
  );

// The shortened passive: a clause (the sentence, and each piece of it after a comma, colon, ellipsis, "--" or spaced hyphen, one
// opener and a leading so / but / plus / and / then stripped; not split on a bare "and", which joins names: "Robert and Linda Chen
// marked as contacted.", "You've got Robert and Linda Chen marked as a rate and term opportunity.") that OPENS with a short noun
// phrase (an optional article or numeral and one to five words) directly
// followed by logged / recorded / marked / added / saved / noted / booked / updated: "Call logged for the Chens.", "Contact logged
// — anything else?", "Chens marked as contacted.", "Jane Doe added to your book.", "All recorded — anything else?", "Got it,
// contact logged for Robert and Linda.", "2 calls logged.". Such a clause is a claim on every turn. Not one:
//   * the phrase holds no auxiliary, modal or subject pronoun (NOT_IN_SHORT_NP), so "Your last contact was logged on 2026-01-01."
//     stays the was/were narration a grounded turn may use (PASSIVE_PAST_RE), and "You logged a call on Monday" reports the user;
//   * the phrase opens with a negative or "any" ("Nothing logged yet — want me to?", "No contact logged since January", "Anything
//     logged for the Chens?");
//   * a clause that is itself a question ("Call logged?");
//   * "updated" counts only where the clause ends or "for" / "to" / "with" follows ("Record updated for the Chens."), so "Rates
//     updated this morning" is narration;
//   * count narration (countNarration), ON A SWEEP TURN ONLY (the turn cited the sweep engine): the phrase BEGINS with a cardinal
//     (digits, one to ninety-nine in words, hundred, dozen, "a dozen", "a hundred") and its first participle is "marked as / for" or
//     "added" followed by more than "to" (or "flagged", which is no claim anyway): what a sweep counted, not a change ("Three
//     clients marked as rate-and-term opportunities.", "Two opportunities added since yesterday.", "12 clients flagged for
//     check-ins."). On any other turn the same shape is a change claim ("One reminder added for the Chens.", "One check-in marked
//     for the Chens." after a client lookup — nothing counted anything). It stays a claim when the clause also holds a
//     contact participle (logged / recorded / noted / booked / saved: "Two calls logged.") or a contact or completion word
//     (contacted / called / reached / done / complete(d) / handled: "Three clients marked as contacted."), and so does a bare
//     "Two clients added." / "Three clients marked." and "One client added to your book.", which report a change. "updated" is
//     never exempt: it is a claim only where the clause ends or for / to / with follows, the change-report form ("Two records
//     updated for the Chens."), and "Two rates updated since Monday" is no claim to begin with. A phrase that opens with anything
//     but a cardinal ("All recorded — anything else?", "Chens marked as contacted.") is never count narration.
// Two narrow forms of the same claim sit beside it: a demonstrative or the call itself "is in" (IN_FOR_RE: "That's in for the
// Chens.", "It's in now.", "Everything's in."; not "That's in your pipeline" or "Rates are in for a rough week"), and "up to date"
// with "now" (UP_TO_DATE_NOW_RE, anywhere in the sentence: "The Chens are up to date now.", "Your book is now up to date."; the bare
// "up to date" can narrate a check-in that is not due).
const NOT_IN_SHORT_NP = "was|were|is|are|am|be|been|being|has|have|had|will|would|can|could|should|shall|may|might|must|do|does|did|get|gets|got|i|we|you|they|he|she";
const NP_WORD = "(?!(?:" + NOT_IN_SHORT_NP + ")\\b)(?:[A-Za-z\\u00c0-\\u024f][\\w'\\u2019-]*|&)";
const UPDATED_AS_CLAIM = "updated(?=\\s*(?:$|[.!?,;:\\u2014\\u2013])|\\s+(?:for|to|with)\\b)";
const SHORT_PASSIVE_RE = new RegExp(
  "^(?!(?:no|not|nothing|none|never|neither|nobody|any|anything|anyone)\\b)(?:(?:a|an|the|\\d[\\d,]*)\\s+)?(?:" + NP_WORD + "\\s+){0,4}" + NP_WORD +
    "\\s+(?:logged|recorded|marked|added|saved|noted|booked|drafted|emailed|sent|" + UPDATED_AS_CLAIM + ")\\b",
  "i"
);
const CARDINAL =
  "(?:\\d[\\d,]*|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?" +
  "|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen" +
  "|(?:a\\s+)?(?:hundred|dozen))";
// the cardinal, then up to four words that are not a participle, then the first participle: "marked as / for", "added <not to>",
// "flagged"
const COUNT_NARRATION_RE = new RegExp(
  "^" + CARDINAL + "\\s+(?:(?!(?:logged|recorded|marked|added|saved|noted|booked|updated|flagged)\\b)" + NP_WORD + "\\s+){0,4}" +
    "(?:marked(?=\\s+(?:as|for)\\b)|added(?=\\s+(?!to\\b)\\w)|flagged)\\b",
  "i"
);
const NOT_COUNT_NARRATION_RE = /\b(?:logged|recorded|noted|booked|saved|contacted|called|reached|done|completed?|handled)\b/i;
const countNarration = (clause) => COUNT_NARRATION_RE.test(clause) && !NOT_COUNT_NARRATION_RE.test(clause);
const IN_FOR_RE =
  /^(?:that|it|this|everything|all(?:\s+of\s+(?:it|that))?|the\s+(?:call|contact|note|record))(?:['’]s|\s+is|\s+are)\s+(?:all\s+)?in(?=\s*(?:$|[.!,;:—–])|\s+(?:for|now)\b)/i;
const UP_TO_DATE_NOW_RE =
  /\b(?:is|are|['’](?:s|re))\s+(?:all\s+)?(?:now\s+(?:all\s+)?up\s+to\s+date|up\s+to\s+date\s+now)\b/i;
const SHORT_CLAUSE_SPLIT_RE = /,|:|…|--|\s-\s/;
const SHORT_LEADING_CONJ_RE = /^(?:(?:so|but|plus|and|then)\s+)+/i;
// `sweep` = this turn cited the sweep engine: only then is count narration exempt ("One reminder added for the Chens." on any
// other turn is a change claim like the rest).
const shortPassiveClaims = (sentence, sweep) =>
  UP_TO_DATE_NOW_RE.test(sentence) ||
  sentence.split(SHORT_CLAUSE_SPLIT_RE).some((piece) => {
    const c = stripOpener(piece.trim().replace(SHORT_LEADING_CONJ_RE, "")).trim();
    return !/\?\s*$/.test(c) && ((SHORT_PASSIVE_RE.test(c) && !(sweep && countNarration(c))) || IN_FOR_RE.test(c));
  });

// A booking is never made here (createEventTool only packages one for /confirm), so a first-person "I put it on your calendar" /
// "I've put a follow-up on your calendar" and the "now" forms, "it's on your calendar now" / "that's now on your calendar", are
// false on every turn. (The verbs added / booked / scheduled are FIRST_PERSON_CLAIM_RE's.) Only these forms: a calendar FACT read
// from getCalendarTool ("Follow-up: Robert & Linda Chen is on your calendar Friday at 10:00 AM.") is true and is no claim. The
// "now" forms are no claim after a negative ("Nothing's on your calendar now.") or after "nothing / anything / none", with or
// without "else" and a copula ("You have nothing on your calendar now.", "Nothing else is on your calendar now."); only those carry
// the copula, so "Everything else is now on your calendar." is a claim on any turn. They are no claim as the COMPLEMENT OF THE ACT
// OFFERED: in a question, a "now" form directly after a placing verb and its short object ("Should I put it on your calendar now?",
// "... or put a follow-up on your calendar now?", "Since Friday's open, want me to get it on your calendar now?"). Anywhere else, in
// any sentence, it is a claim, whatever connective leads up to it: "Should I draft a check-in as it's on your calendar now?", "Want
// me to let the Chens know it's on your calendar now?", "Should I tell the Chens the follow-up is now on your calendar?", "... for
// the follow-up that's now on your calendar?" (R5-4: what an offer says is said). The object is at most PLACING_OBJECT_WORDS words
// with no clause break (the colon of a clock time, "a 10:00 AM follow-up", is no break) and none of the words that open a clause of
// its own (that, which, who, as, since, so, while, because, given, now, know, tell, is / are, it's ...), except a bare "that" as the
// whole object ("Want me to put that on your calendar now?"); and a word ending in 's right before the "now" form is "<noun> is"
// ("... a call given the follow-up's now on your calendar?"), so the complement is the verb's own and not something said beside
// it. A statement is never exempt, so "I'll put it on your calendar now." and "Let me put it on your calendar now." stay claims, as
// does the first-person past (CALENDAR_PLACED_ALL_RE). This exemption serves turns that are not action turns only: on an action turn
// runTurn holds any "now" form a reply carries, question or not, placing verb or not, negative or not (Rulings 19 and 23, in the
// R5-3 backstop). CALENDAR_PLACED_ALL_RE's I / we is not the subject of a past act when it is really inverted (Rulings 22 and 24):
// the sentence ends with "?" and a should / shall / can / could / would / will / do / did stands right before the I / we, opening the
// sentence, opening a clause (after , : ; or a dash, and an optional and / so / then: Ruling 32), or after a wh-word and at most three
// more words: "What time should I put it on your calendar?", "Where should we put it on your calendar?", "What time on Friday should
// I put it on your calendar?", "Friday's open, so should I put it on your calendar?", "For the Chens, should I put it on your
// calendar?" are questions. A modal anywhere else is no inversion: "Just as I said I would I put the follow-up on your calendar." and
// "Whatever you'd like me to do I put on your calendar." are claims, as are "I put it on your calendar." and "We've put it on your
// calendar.".
const CALENDAR_PLACED_ALL_RE = new RegExp(
  "\\b(?:I|we)(?:['\\u2019]ve|\\s+have)?(?:\\s+(?:just|already|now|also|went\\s+ahead\\s+and|gone\\s+ahead\\s+and))*" +
    "\\s+(?:put|placed|blocked|penciled|pencilled|slotted|dropped)\\b[^.!?;\\u2014\\u2013]*?\\b(?:on|in|onto|into)\\s+your\\s+(?:google\\s+)?calendar\\b",
  "gi"
);
// the text before the I / we ends with the inverted modal: at the start of the sentence, at the start of a clause, or after a wh-word
// and up to three words
const INVERTED_MODAL_BEFORE_RE = new RegExp(
  "(?:^\\s*(?:(?:and|or|so|then)\\s+)?|[,:;\\u2014\\u2013]\\s*(?:(?:and|so|then)\\s+)?" +
    "|\\b(?:what|which|when|where|why|how|who|whom|whose)\\b(?:\\s+[\\w'\\u2019-]+){0,3}?\\s+)" +
    "(?:should|shall|can|could|would|will|do|did)\\s+$",
  "i"
);
const placedClaim = (s) =>
  [...s.matchAll(CALENDAR_PLACED_ALL_RE)].some((m) => !(/\?\s*$/.test(s) && INVERTED_MODAL_BEFORE_RE.test(s.slice(0, m.index))));
// the "now" form itself, with no negative lookbehind: what runTurn holds on an action turn (Rulings 19 and 23)
const CALENDAR_NOW_FORM_RE = /\b(?:now\s+on\s+your\s+(?:google\s+)?calendar|on\s+your\s+(?:google\s+)?calendar\s+now)\b/i;
const CALENDAR_NOW_RE = new RegExp(
  "(?<!\\b(?:nothing|anything|none)(?:\\s+else)?(?:['\\u2019]s|\\s+is|\\s+are)?\\s)" + CALENDAR_NOW_FORM_RE.source, "i"
);
const CALENDAR_NOW_ALL_RE = new RegExp(CALENDAR_NOW_RE.source, "gi");
const NEGATIVE_START_RE = /^(?:no|not|nothing|none|never|nobody|neither)\b/i;
const PLACING_VERB = "(?:put(?:ting)?|add(?:ing)?|book(?:ing)?|schedul(?:e|ing)|get(?:ting)?|pencil(?:l?ing)?|slot(?:ting)?|mov(?:e|ing))";
const NOT_AN_OBJECT =
  "(?:that|which|who|as|since|so|while|because|given|now|know|tell|let|note|say|says|said|is|are|was|were|be|been|if|when|where" +
  "|after|once|(?:it|that|this|they|there|he|she|we|you|everything)['\\u2019](?:s|re|ve))";
const PLACING_OBJECT_WORDS = 8;
// one word of the object: no punctuation, except the colon inside a clock time ("10:00")
const PLACING_OBJECT_WORD = "(?:[^\\s.,;:!?()\\u2014\\u2013]|(?<=\\d):(?=\\d\\d))+";
// the end of the text before a "now" form: a placing verb and a short object, nothing else (no punctuation, no clause of its own),
// or the placing verb and a bare "that"
const PLACING_COMPLEMENT_RE = new RegExp(
  "\\b" + PLACING_VERB + "(?:\\s+that|(?:\\s+(?!" + NOT_AN_OBJECT + "\\b)" + PLACING_OBJECT_WORD + "){0," + PLACING_OBJECT_WORDS + "})\\s*$",
  "i"
);
// a word ending in 's right before the "now" form: "the follow-up's now on your calendar" is "the follow-up is ..."
const IS_CONTRACTED_BEFORE_RE = /['’]s\s*$/;
const placingComplement = (s, at) => {
  const before = s.slice(0, at);
  return /\?\s*$/.test(s) && !IS_CONTRACTED_BEFORE_RE.test(before) && PLACING_COMPLEMENT_RE.test(before);
};
// `plainRead` (Ruling 50): the turn read the calendar and is neither an action turn nor a reply to an offer, so a "now" form
// narrates what the read returned ("Here's what's on your calendar now: ...", "Right now on your calendar you have ...") and only
// the first-person placing claims count.
const calendarClaim = (s, plainRead) =>
  placedClaim(s) ||
  (!plainRead && !NEGATIVE_START_RE.test(s) && [...s.matchAll(CALENDAR_NOW_ALL_RE)].some((m) => !placingComplement(s, m.index)));

// `grounded` = a cited tool result backs this turn; `storedStage` = the user's stored stage id (null / omitted = not set);
// `sweep` = the sweep engine is among the cited sources (count narration is exempt on that turn only); `plainRead` = the turn cited
// a calendar read and is neither an action turn nor a reply to an offer (the "now" forms are then no claim: Ruling 50). Pure: no
// I/O, no state.
function claimsCompletion(text, grounded, storedStage, sweep, plainRead) {
  return sentencesOf(String(text == null ? "" : text)).some((part) => {
    let s = stripOpener(part.trim()).trim();
    if (isOffer(s)) s = s.replace(OFFER_LEAD_RE, "").trim();
    return COMPLETION_OPENER_RE.test(s) || calendarClaim(s, plainRead) ||
      FIRST_PERSON_CLAIM_RE.test(s) || IN_PROGRESS_RE.test(s) ||
      PASSIVE_RE.test(s) || PASSIVE_JUST_RE.test(s) || GOT_IT_DONE_RE.test(s) || DONE_RE.test(s) ||
      falseSetClaim(s, storedStage) || YOURE_SET_RE.test(s) ||
      (!grounded && PASSIVE_PAST_RE.test(s)) ||
      laterClauseClaims(s) || shortPassiveClaims(s, sweep);
  });
}

// Spoken figures that no payload can ground: hundred / thousand / million / billion / percent, "point"
// followed by a digit word ("six point five", "six-point-two"), the number words eleven to ninety-nine
// ("twenty", "forty-five", "thirty one"), and a fraction after a number or number word ("seven and a half",
// "6 and a quarter", "five and three quarters"). A numeral consumes its own multiplier and percent word first
// (see figureWords), so "6.52 percent" and "70 thousand" are left to the numeric check. One to ten stay
// counts ("one at a time", "two Chens"), and the product labels "thirty-year" and "fifteen-year" (singular
// "year", hyphen or space) name a loan, not a figure, so they are taken out first.
const TEENS_AND_TENS =
  "eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const DIGIT_WORD = "one|two|three|four|five|six|seven|eight|nine";
const FIGURE_WORD_RE = new RegExp(
  "\\b(?:hundred|thousand|million|billion|percent)\\b|\\bpoint[\\s-]+(?:zero|" + DIGIT_WORD + ")\\b" +
    "|\\b(?:" + TEENS_AND_TENS + ")(?:[\\s-](?:" + DIGIT_WORD + "))?\\b",
  "gi"
);
const FRACTION_WORDS_RE = new RegExp(
  "(?:\\b\\d+(?:\\.\\d+)?|\\b(?:zero|ten|" + DIGIT_WORD + "|" + TEENS_AND_TENS + ")(?:[\\s-](?:" + DIGIT_WORD + "))?)" +
    "\\s+and\\s+(?:a\\s+half|a\\s+quarter|three\\s+quarters)\\b",
  "gi"
);
const LABEL_WORDS_RE = /\b(?:thirty|fifteen)[\s-](?:year|yr)(?![a-z])/gi;
function figureWords(text) {
  const t = String(text).replace(LABEL_WORDS_RE, " ");
  const fractions = t.match(FRACTION_WORDS_RE) || [];
  return [...fractions, ...(t.replace(FRACTION_WORDS_RE, " ").replace(FIGURE_RE, " ").match(FIGURE_WORD_RE) || [])];
}

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

// Every number in the payloads' JSON VALUES: a number value, and every number inside a string value (a date like
// "2026-01-01", a "since" label like "October 18", a loan type like "30yr_fixed"), unsigned so a reply of "down 0.10"
// matches a delta of -0.1. Never the digits of a KEY: rate_30yr_fixed grounds no "30" ("about 30 basis points under where
// the Chens are" is a figure no tool gave). A payload is a tool_result content string (parsed as JSON; one that does not
// parse is a single string value) or an object.
function payloadNumbers(payloads) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "number") { if (Number.isFinite(v)) out.push(Math.abs(v)); }
    else if (typeof v === "string") {
      for (const m of v.matchAll(new RegExp(NUMBER_SRC, "g"))) out.push(Number(m[1].replace(/,/g, "") + (m[2] || "")));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const p of payloads) {
    let value = p;
    if (typeof p === "string") { try { value = JSON.parse(p); } catch (_err) { value = p; } }
    walk(value);
  }
  return out;
}

// The tool labels a reply may use as names, not figures: "30-year" / "30-yr" / "30yr" / "30 year" (singular) and the same for
// 15, when a payload this turn names that product (a rate key such as rate_30yr_fixed, or a loan type value such as
// "30yr_fixed"). Only the label is allowed, never the bare number. ("5/1 ARM" needs nothing: 5 and 1 are counts under the 0-10
// exemption.)
const DIGIT_LABEL_RE = /\b(30|15)[\s-]?(?:year|yr)(?![a-z]|-old\b)/gi;
function payloadLabels(payloads) {
  const named = new Set();
  for (const p of payloads) {
    const s = typeof p === "string" ? p : JSON.stringify(p);
    for (const n of ["30", "15"]) if (new RegExp(`${n}yr`, "i").test(String(s))) named.add(n);
  }
  return named;
}

// The figures in `replyText` that are NOT backed by a number in `payloads` (the tool_result
// contents sent to the model this turn; strings or objects). [] means every figure is grounded.
//   * "$" "," "%" are ignored; K/thousand and M/million scale the figure;
//   * a figure is grounded when some payload number, divided by the same scale, rounds to it at
//     the reply's own decimal places (6.46 and 6.5 both match 6.461; 412 matches 412.37;
//     485,000 and $485K match 485000; ties round either way);
//   * a standalone integer 0-10 (counts, ordinals) is exempt, unless it sits next to a $, a %,
//     "percent", "dollars" or a multiplier;
//   * only JSON values ground a figure (payloadNumbers); a "30-year" / "15-year" label is not a figure when a payload
//     names that product (payloadLabels);
//   * a figure spoken in words (hundred, thousand, million, billion, percent, "point five", eleven to ninety-nine,
//     "seven and a half") can't be matched to anything, so it is always returned.
// Pure: no I/O, no state.
function ungroundedNumbers(replyText, payloads) {
  const list = Array.isArray(payloads) ? payloads : [];
  const known = payloadNumbers(list);
  const labels = payloadLabels(list);
  const text = String(replyText == null ? "" : replyText).replace(DIGIT_LABEL_RE, (label, n) => (labels.has(n) ? " " : label));
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
// "what are rates today", "Is Chen my best?"). "do it" / "do that" / "do this" / "do them" with no "?" opens with "do" but asks
// nothing: it tells Charli to go ahead with what was just said, so it answers (DO_PRONOUN_RE). Pure.
const DO_PRONOUN_RE = /^do\s+(?:it|that|this|them)\b/i;
function isAnswerShaped(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t || t.endsWith("?")) return false;
  const opening = afterFiller(t);
  return DO_PRONOUN_RE.test(opening) || (!QUESTION_START_RE.test(opening) && !YES_NO_AUX_RE.test(opening));
}

// The action backstop must also hold while the user is answering a clarifying question about an action:
// "log a call with Chen" -> "Which Chen?" -> "Robert and Linda" is no action request on its own. The chain
// applies only while the user is ANSWERING: the latest user message must be answer-shaped (after an
// unconfirmed read-back, "what are rates today?" is a new request and is not held to the backstop). Walking
// back, each step is an (assistant message ending "?", user message) pair: if that user message is an
// action request, it is the origin and the backstop applies; otherwise the walk continues only if that user
// message is answer-shaped too ("log a call" -> "Who did you talk to?" -> "Chen" -> "Which Chen?" ->
// "Robert and Linda"). At most MAX_CHAIN_HOPS pairs are examined; anything that breaks the pattern, or a
// chain that does not reach an action request within the cap, does not apply the backstop.
// A code-authored read-back counts as the question even when it no longer ends in "?": the browser appends its own
// "Okay — I'll leave that." when the user's reply was not a plain yes or no, and the two assistant lines merge
// ("Just to confirm — log a contact for ...?\nOkay — I'll leave that."). So an assistant message that CONTAINS
// READ_BACK_PREFIX and not CONFIRMED_PREFIX (the change was confirmed: routes/assistant.js confirmReply) is asked, as
// long as the user's reply to it is not a new instruction (isNewInstruction) or an acknowledgement (isAcknowledgement): an
// unrecognised "absolutely" after a read-back stays held to the backstop, while "run a sweep", "thanks" or "what are rates
// today?" after it is a normal turn.
// A new instruction opens with an imperative (IMPERATIVE_LEAD_RE, or "tell": "run a sweep", "pull up the Chens", "tell me about
// Patel", "give me a market update") whose object is more than a lone it / that / this / them (PRONOUN_OBJECT_RE): "send it",
// "send that", "run that" and "tell them" point back at the change just read back, so they answer it and the walk goes on
// ("do it" is held the same way: see isAnswerShaped).
// Nor is an acknowledgement an answer to it (isAcknowledgement): thanks / thank you / ok / okay / got it / never mind / nevermind
// / no worries / cool / alright (one or more; a leading oh / um / uh / well and a trailing "so much" or "Charli" allowed), alone or
// followed by a new request, which is a question (it ends with "?" or opens with a question word, "do it" being none) or a new
// instruction: "thanks" and "never mind, what are rates" are normal turns (the every-turn claim screens still run), while "okay,
// send it" and "alright, absolutely" still answer the read-back. A bare name ("Patel") is held, like any answer. Pure.
const MAX_CHAIN_HOPS = 4;
const READ_BACK_PREFIX = "Just to confirm —";
const CONFIRMED_PREFIX = "Done —";
const TELL_LEAD_RE = /^tell(?![\w'’-])/i;
const PRONOUN_OBJECT_RE = /^\w+\s+(?:it|that|this|them)\b/i;
const isNewInstruction = (text) => {
  const a = afterFiller(text);
  return (IMPERATIVE_LEAD_RE.test(a) || TELL_LEAD_RE.test(a)) && !PRONOUN_OBJECT_RE.test(a);
};
const ACK_LEAD_RE = new RegExp(
  "^(?:(?:oh|um|uh|well)[\\s,]+)*" +
    "(?:(?:thanks|thank\\s+you|ok|okay|got\\s+it|never\\s*mind|no\\s+worries|cool|alright)(?![\\w'\\u2019-])" +
    "(?:\\s+(?:so\\s+much|charli|charlie)(?![\\w'\\u2019-]))?[\\s,.!;:\\u2014\\u2013-]*)+",
  "i"
);
const isAcknowledgement = (text) => {
  const t = String(text == null ? "" : text).replace(AUDIO_TAG_RE, " ").trim();
  const lead = t.match(ACK_LEAD_RE);
  if (!lead) return false;
  const rest = t.slice(lead[0].length).trim();
  if (!rest) return true;
  const opening = afterFiller(rest);
  return isNewInstruction(rest) || ((rest.endsWith("?") || QUESTION_START_RE.test(opening)) && !DO_PRONOUN_RE.test(opening));
};
const askedOf = (asked, answer) => {
  const said = messageText(asked);
  const reply = messageText(answer);
  return said.trim().endsWith("?") ||
    (said.includes(READ_BACK_PREFIX) && !said.includes(CONFIRMED_PREFIX) && !isNewInstruction(reply) && !isAcknowledgement(reply));
};

// An OFFER to act, and a yes to it. Charli may offer to book a follow-up or write a check-in ("Want me to write them a check-in?",
// "Should I book another follow-up Friday?"), and the user's "yes" is then a request to do it, though nothing in the user's own
// words is an action request (the offer followed a calendar read or a sweep). So that "yes" turn is held to the action backstop like
// any other, and the chain walk below counts it as the origin. An assistant message OFFERS when its last sentence ends with "?" and
// opens, after at most one opener or a comma / colon / "and" / "so", with an offer lead (want me to, do you want me to, should I,
// shall I, would you like me to, can I, could I, may I, shall we, should we, want to ...) followed by an action verb
// (ACTION_VERBS, with its carve-outs: "Want me to run a sweep?" and "Want me to update you on rates?" offer no change); or when that
// sentence is only the lead ("... — want me to?", "..., want me to?") and what is offered, said just before it (the sentence before,
// or the start of the same one), is an offer of the same kind: "I / we can | could | 'd be happy to | 'd like to | 'm happy to" or
// "happy to" and an action verb, with the same carve-outs ("I can book the Chens a follow-up Friday — want me to?" offers a change,
// "I can run a sweep of your book — want me to?" and "I can update you on rates — want me to?" do not: a bare search for the verb
// would take the noun "book").
// The user's message right after such an offer is one of three (offerReplyClass, Rulings 24 and 26):
//   * YES: a correction of the offered act ("no, make it Thursday", "make it 10", "Thursday instead", "do Friday at 10", "do the 10
//     o'clock", "have it at 10", "have them come in Friday", "might as well", "Friday at 10 works", "Thursday at 10", and after no /
//     nah / actually / not: a day or an act, "no, Thursday", "no, just a reminder"), or "what a great idea"; or a yes word, alone or
//     leading (yes, yeah, yep, sure, ok, okay, alright, please, go ahead, do it, sounds good, perfect, great, that'd be great, would be
//     great, that works, works for me, let's do it, book it, send it, why not, will do, absolutely, of course, ...), followed by nothing
//     or by anything that asks nothing and requests nothing new ("sure, no problem", "yeah, no worries", "yeah, that's fine, no
//     worries"). It asks for the act: the turn is an action turn (R5-3 and the Ruling 19 / 23 hold, and the claim guard beside them),
//     and the chain walk takes it as the origin. Not a yes (Ruling 26): an acknowledgement with only thanks after it ("ok thanks",
//     "okay, thanks", "great, thanks", "perfect, thank you"), and a yes word followed by a new request ("ok, pull up the Chens", "yeah,
//     run a sweep first") or a question ("sure, what's their balance"): those are OTHER.
//   * DECLINE (isDecline): every clause a decline or words that add nothing ("no thanks", "ok, never mind", "let's not", "I'd rather
//     not", "not today", "I'm all set", "forget it", "thanks, I'm good", "don't worry about it"). A plain turn.
//   * OTHER: anything else, a new request ("pull up the Chens", "run a sweep"), a question with or without "?" ("when you get a
//     chance"), small talk ("thanks"), a bare day ("tomorrow"), a choice ("the afternoon", "Robert and Linda"). A plain turn, answered
//     under the claim guard (offeredActClaimed, in runTurn), unless the chain walk below makes it an action turn.
// In the chain walk (Ruling 29, superseding Ruling 27) a decline ends the walk, and so does an OTHER reply that moves on (movesOn: a
// new request or a question: "book the Chens Friday" -> "What time — and want me to draft a check-in too?" -> "pull up their loan
// first" is a plain turn). An OTHER reply that only answers (a choice: "the afternoon", "Robert and Linda", "Pat", "Friday at 10") is
// walked through like any answer, so an action request before the offer holds the turn: "book the Chens a follow-up Friday" ->
// "Should I book it for the morning or the afternoon?" -> "the afternoon" is an action turn.
// A reply that holds a "?", or has a clause that opens a question (opensQuestion), is never a yes. An auxiliary or a modal opens a
// question only with a subject after it (I, you, we, they, he, she, it, there, a name; "it" not after do / have, which agree with I /
// you / we / they): "do Thursday instead", "have it at 10", "will do", "would be great" ask nothing, "can you make it 10" and "does it
// work" do. "what a ...", "why not" and "how nice" are no questions.
const OFFER_LEAD =
  "(?:do\\s+you\\s+want\\s+me\\s+to|would\\s+you\\s+like\\s+me\\s+to|want\\s+me\\s+to|should\\s+I|shall\\s+I|can\\s+I|could\\s+I|may\\s+I" +
  "|shall\\s+we|should\\s+we|would\\s+you\\s+like\\s+to|do\\s+you\\s+want\\s+to|want\\s+to)";
// (An offer to update, send, email or write TO THE USER, "Want me to update you on rates?", asks the user for no change.)
const OFFER_FILLER = "(?:\\s+(?:also|just|quickly|maybe|go\\s+ahead\\s+and)){0,2}\\s+";
const NOT_TO_THE_USER = "(?!(?:update|send|email|write|text)\\s+you\\b)";
const OFFER_START = "(?:^|[,:]\\s*)(?:(?:and|or|so)\\s+)?";
const OFFER_TO_ACT_RE = new RegExp(
  OFFER_START + OFFER_LEAD + OFFER_FILLER + NOT_TO_THE_USER + "(?:" + ACTION_VERBS + ")(?![\\w'\\u2019-])", "i"
);
// "I can ...", "we could ...", "I'd be happy to ...", "happy to ...": the offer made in the statement before a bare "want me to?"
const SELF_OFFER_LEAD =
  "(?:(?:I|we)\\s+(?:can|could)|(?:I|we)['\\u2019]d\\s+(?:be\\s+(?:happy|glad)\\s+to|like\\s+to)|(?:I|we)['\\u2019]m\\s+(?:happy|glad)\\s+to" +
  "|(?:happy|glad)\\s+to)";
const SELF_OFFER_TO_ACT_RE = new RegExp(
  OFFER_START + SELF_OFFER_LEAD + OFFER_FILLER + NOT_TO_THE_USER + "(?:" + ACTION_VERBS + ")(?![\\w'\\u2019-])", "i"
);
// a sentence that ends with only the lead: "want me to?", or "..., want me to?"
const BARE_TAIL_RE = new RegExp(OFFER_START + OFFER_LEAD + "\\s*\\?$", "i");
// The lead words a decline may open with ("ok, never mind", "please don't", "yeah no", "sure, maybe later", "thanks, but not now",
// "let's hold off", "eh, not now"), the decline itself, and the closed list of words that add nothing to it ("no thanks, I'm good",
// "skip it for now", "not yet, thanks Charli", "no, that's fine", "don't worry about it", "leave it for now"). No day, time, verb or
// name is on that list, so a clause that says more ("no, make it Thursday", "later today", "wait, yes") is no decline; nor are
// "problem" and "worries", so "sure, no problem" and "yeah, no worries" are no declines either (they are yeses).
const DECLINE_LEAD =
  "(?:ok|okay|please|yeah|sure|eh|thanks|thank\\s+you|but|let['\\u2019]?s|oh|um|uh|well|hmm|actually|so|and|hey|charli|charlie)";
const DECLINE_HEAD =
  "(?:no|nope|nah|not\\s+(?:right\\s+)?now|not\\s+yet|not\\s+today|not\\s+really|don['\\u2019]?t(?:\\s+do)?|do\\s+not(?:\\s+do)?" +
  "|never\\s*mind|maybe\\s+later|later|skip|cancel|hold\\s+off|wait|stop|let['\\u2019]?s\\s+not|i(?:['\\u2019]d|\\s+would)\\s+rather\\s+not" +
  "|(?:i['\\u2019]?m\\s+)?all\\s+set|i['\\u2019]?m\\s+(?:good|fine|ok(?:ay)?)|forget|leave\\s+it|(?:i['\\u2019]?ll\\s+)?pass" +
  "|i(?:['\\u2019]ll|\\s+will)\\s+handle)";
const DECLINE_PAD =
  "(?:ok|okay|please|yeah|sure|eh|thanks|thank|you|but|oh|um|uh|well|hmm|actually|so|and|hey|charli|charlie|alright|all|right|good|fine" +
  "|i['\\u2019]?m|i|am|(?:that|it)['\\u2019]?s|it|that|this|them|on|about|for|now|then|yet|either|though|just|really|maybe" +
  "|no|nope|nah|not|need|bother|worry)";
const DECLINE_CLAUSE_RE = new RegExp(
  "^(?:" + DECLINE_LEAD + "(?![\\w'\\u2019-])\\s*)*" + DECLINE_HEAD + "(?:\\s+" + DECLINE_PAD + ")*(?![\\w'\\u2019-])\\s*$", "i"
);
const DECLINE_PAD_RE = new RegExp("^" + DECLINE_PAD + "(?:\\s+" + DECLINE_PAD + ")*(?![\\w'\\u2019-])\\s*$", "i");
const isDecline = (text) => {
  const clauses = String(text == null ? "" : text).split(USER_CLAUSE_BREAK_RE).map((c) => c.trim()).filter(Boolean);
  return clauses.some((c) => DECLINE_CLAUSE_RE.test(c)) && clauses.every((c) => DECLINE_CLAUSE_RE.test(c) || DECLINE_PAD_RE.test(c));
};

// The classes of a reply to an offer to act (see above).
const OFFER_YES = "yes";
const OFFER_DECLINE = "decline";
const OFFER_OTHER = "other";
// Words ahead of what a reply says that say nothing themselves. Unlike FILLER_RE this never takes ok / okay / alright, which say
// yes here.
const REPLY_FILLER_RE = new RegExp(
  "^(?:(?:hey|hi|hello|oh|ah|um|uh|hmm|well|so|and|but|or|then|actually|wait|charli|charlie|good\\s+(?:morning|afternoon|evening))" +
    "(?![\\w'\\u2019-])[\\s,.!;:\\u2014\\u2013-]*)+",
  "i"
);
const afterReplyFiller = (s) => String(s == null ? "" : s).trim().replace(REPLY_FILLER_RE, "").trim();
// The yes words. A bare "please" says yes only on its own ("please", "please, no rush"), never ahead of a request: "please pull up
// the Chens" asks for that and nothing else.
const YES_WORDS =
  "yes\\s+please|yes|yeah|yea|yep|yup|sure(?:\\s+thing)?|ok(?:ay)?|alright|all\\s+right|please\\s+do|go\\s+ahead|go\\s+for\\s+it" +
  "|do\\s+(?:it|that)|(?:that\\s+)?sounds\\s+(?:good|great|perfect)|perfect|great|awesome|excellent|fine|that['\\u2019]?s\\s+fine" +
  "|(?:that|it)(?:['\\u2019]d|\\s+would)\\s+be\\s+(?:great|good|nice|perfect|awesome|helpful)|would\\s+be\\s+great|that\\s+works" +
  "|works\\s+for\\s+me|let['\\u2019]?s\\s+do\\s+(?:it|that)|book\\s+it|send\\s+it|draft\\s+it|why\\s+not|will\\s+do|absolutely" +
  "|definitely|of\\s+course|you\\s+bet|sounds\\s+like\\s+a\\s+plan";
const YES_LEAD_RE = new RegExp("^(?:" + YES_WORDS + ")(?![\\w'\\u2019-])", "i");
const PLEASE_ALONE_RE = /^please[\s.!]*$/i;
const saysYes = (clause) => {
  const c = afterReplyFiller(clause);
  return YES_LEAD_RE.test(c) || PLEASE_ALONE_RE.test(c);
};
// Strips, again and again, filler, yes words (and "please") and, for `corrections`, the words a correction opens with: what is left
// is what the clause says beyond them ("sure, can you make it 10" -> "can you make it 10", "no, just a reminder" -> "a reminder").
const YES_STRIP_RE = new RegExp("^(?:" + YES_WORDS + "|please)(?![\\w'\\u2019-])[\\s,.!;:\\u2014\\u2013-]*", "i");
const CORRECTION_LEAD = "no|nope|nah|actually|not|rather|later|instead";
// a reply that opens with a correction lead, after filler or a yes word ("yeah no, Thursday", "oh, actually Thursday")
const CORRECTED_RE = new RegExp(
  "^(?:(?:hey|hi|oh|ah|um|uh|hmm|well|so|and|but|charli|charlie|ok|okay|yeah)(?![\\w'\\u2019-])[\\s,]*)*(?:" + CORRECTION_LEAD +
    ")(?![\\w'\\u2019-])",
  "i"
);
const CORRECTION_STRIP_RE = new RegExp("^(?:" + CORRECTION_LEAD + "|just|only)(?![\\w'\\u2019-])[\\s,.!;:\\u2014\\u2013-]*", "i");
const coreOf = (clause, corrections) => {
  let c = String(clause).trim();
  for (let prev = null; c !== prev;) {
    prev = c;
    c = afterReplyFiller(c).replace(YES_STRIP_RE, "").trim();
    if (corrections) c = c.replace(CORRECTION_STRIP_RE, "").trim();
  }
  return c;
};

// Does a clause open a question? A wh-word does (but "what a ...", "why not", "how nice"), and an auxiliary or a modal does when a
// subject follows it: I / you / we / they / he / she / it / there / y'all, or a name (a capitalized word that is no day, month or
// article). "it" is no subject after do / have (and don't / haven't), which agree with I / you / we / they: "do it", "have it at 10"
// tell Charli what to do. With no subject the auxiliary asks nothing: "do Friday at 10", "will do", "would be great", "is fine".
const WH_OPEN_RE = /^(?:(?:and|or|so)\s+)?(?:what|which|who|whom|whose|when|where|why|how)(?:['’](?:s|re|d|ll|ve))?(?![\w'’-])/i;
const WH_NOT_ASKING_RE =
  /^(?:(?:and|or|so)\s+)?(?:what\s+an?|why\s+not|how\s+(?:nice|great|cool|lovely|wonderful|kind|sweet|perfect|thoughtful|awesome|fun))(?![\w'’-])/i;
const AUX_OPEN_RE = new RegExp(
  "^(?:(?:and|or|so)\\s+)?(do|does|did|have|has|had|might|may|can|could|will|would|should|shall|is|are|am|was|were" +
    "|don['\\u2019]?t|doesn['\\u2019]?t|didn['\\u2019]?t|haven['\\u2019]?t|hasn['\\u2019]?t|hadn['\\u2019]?t|can['\\u2019]?t|cannot|couldn['\\u2019]?t" +
    "|won['\\u2019]?t|wouldn['\\u2019]?t|shouldn['\\u2019]?t|isn['\\u2019]?t|aren['\\u2019]?t|wasn['\\u2019]?t|weren['\\u2019]?t)" +
    "\\s+([A-Za-z\\u00c0-\\u024f][\\w'\\u2019-]*)",
  "i"
);
const SUBJECT_WORDS = new Set(["i", "you", "we", "they", "he", "she", "it", "there", "y'all", "y’all", "yall"]);
const PLURAL_AUX_RE = /^(?:do|don['’]?t|have|haven['’]?t)$/i;
const DAY_OR_MONTH_RE =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december)(?:['’]s)?$/i;
const isSubjectAfter = (aux, word) => {
  const w = word.toLowerCase();
  if (SUBJECT_WORDS.has(w)) return !(w === "it" && PLURAL_AUX_RE.test(aux));
  return /^[A-ZÀ-Þ]/.test(word) && !DAY_OR_MONTH_RE.test(word) && !/^(?:the|a|an|that|this|these|those)$/i.test(word);
};
// (tested past filler, yes words and correction leads: "sure, can you make it 10", "not sure what time works" ask)
const opensQuestion = (clause) => {
  const c = coreOf(clause, true);
  if (WH_OPEN_RE.test(c)) return !WH_NOT_ASKING_RE.test(c);
  const m = AUX_OPEN_RE.exec(c);
  return !!m && isSubjectAfter(m[1], m[2]);
};

// A correction of the offered act (or a yes that is no yes word), tested on what a clause says beyond its yes words and correction
// leads. On its own: "make it 10", "might as well", "would be nice" / "will do" / "can do", "pencil it in", "what a great idea", "if
// you can", "I think so", "I'm good with that" ("I'm good" alone is a decline), "do Thursday instead" / "do the 10 o'clock" /
// "have them come in Friday" (do / have with no subject), "10 instead" / "a check-in instead" (but not "I'll call them instead"),
// "Friday at 10 works" / "10 is fine" (but not "nothing works"),
// and a day or time that names a clock time ("Thursday at 10", "the 10 o'clock", "tomorrow at 10"). After a correction lead (the
// reply opens with no / nope / nah / actually / not / rather / later): any day or time ("no, Thursday", "not Friday, Thursday",
// "later today") and an act ("no, just a reminder"). A bare day ("tomorrow", "Thursday") is no correction: it may ask what is on it.
const CORRECTION_CORE_RE = new RegExp(
  "^(?:make\\s+(?:it|that|them|this)|(?:might|may)\\s+as\\s+well|(?:would|will|could|can|should)\\s+(?:be|do|love|work|help)" +
    "|(?:pencil|lock|slot|block|move|get|give|run\\s+with|go\\s+with)\\s+(?:it|that|this|them)|what\\s+an?" +
    "|if\\s+(?:you\\s+(?:can|could|want|like|would|don['\\u2019]?t\\s+mind|have\\s+(?:the\\s+)?time)|it(?:['\\u2019]s|\\s+is)\\s+(?:open|free))" +
    "|i\\s+(?:think|guess|suppose)\\s+so|i\\s+(?:guess|suppose)\\s*$|probably\\s*$" +
    "|i['\\u2019]?m\\s+(?:good|fine|ok(?:ay)?|happy)\\s+with)(?![\\w'\\u2019-])",
  "i"
);
const DO_HAVE_RE = /^(do|have)\s+([^\s,.!;:]+)/i;
const doHaveImperative = (core) => {
  const m = DO_HAVE_RE.exec(core);
  return !!m && !/^not$/i.test(m[2]) && !isSubjectAfter(m[1], m[2]);
};
const SUBJECT_START_RE = /^(?:i|we|you|they|he|she|let\s+me)(?:['’](?:ll|m|ve|d|re))?(?![\w'’-])/i;
const insteadClause = (core) => /\binstead[\s.!]*$/i.test(core) && !SUBJECT_START_RE.test(core);
const WORKS_RE =
  /^(?!(?:nothing|no|none|neither|not|never)(?![\w'’-])).*\b(?:works?(?:\s+for\s+me)?|is\s+(?:fine|good|great|perfect)|sounds\s+(?:good|great|perfect))[\s.!]*$/i;
// the words of a day or a time ("Thursday at 10", "the 10 o'clock", "tomorrow morning", "next week"), and which of them are a clock time
const DAY_TIME_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tonight", "tomorrow", "next", "this", "week",
  "weekend", "morning", "afternoon", "evening", "night", "noon", "midnight", "at", "on", "in", "the", "a", "around", "about", "by", "for",
  "instead", "then", "early", "late", "later", "o'clock", "o’clock", "am", "pm", "half", "past", "quarter", "thirty", "fifteen",
  "forty-five", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
]);
// what makes the words a day or a time at all ("at the", "maybe" are neither)
const DAY_TIME_ANCHOR_RE =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|week|weekend|morning|afternoon|evening|night)$/i;
const NUMBER_WORD_RE = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i;
const CLOCK_WORD_RE = /^(?:\d{1,2}(?::\d{2})?(?:am|pm)?|noon|midnight|o['’]clock|am|pm)$/i;
const dayTime = (core) => {
  const words = core.toLowerCase().replace(/\b([ap])\.\s?m\b\.?/g, "$1m").replace(/[\s.!]+$/, "").split(/\s+/).filter(Boolean);
  if (words.length === 0 || !words.every((w) => DAY_TIME_WORDS.has(w) || CLOCK_WORD_RE.test(w))) return null;
  const clock = words.some((w, i) => CLOCK_WORD_RE.test(w) || (NUMBER_WORD_RE.test(w) && ((i > 0 && words[i - 1] === "at") || words.length === 1)));
  return clock || words.some((w) => DAY_TIME_ANCHOR_RE.test(w)) ? { clock } : null;
};
const ACT_NOUN_RE =
  /^(?:(?:an?|the)\s+)?(?:quick\s+)?(?:reminder|check[\s-]?in|call|follow[\s-]?up|note|email|text|meeting|event|appointment)s?(?![\w'’-])/i;
// A clause that negates its day or act ("not this week", "not Friday") names no correction itself, like "not today" (a decline): in
// "not Friday, Thursday" the correction is the clause after it.
const correction = (clause, corrected) => {
  const core = coreOf(clause, true);
  if (!core) return false;
  if (CORRECTION_CORE_RE.test(core) || doHaveImperative(core) || insteadClause(core) || WORKS_RE.test(core)) return true;
  if (/^not(?![\w'’-])/i.test(coreOf(clause, false))) return false;
  const when = dayTime(core);
  if (when && (when.clock || corrected)) return true;
  return corrected && ACT_NOUN_RE.test(core);
};

// Ruling 26. An acknowledgement word (ok / okay / alright / great / perfect / awesome / excellent / fine / cool / nice) with nothing
// after it but thanks ("ok thanks", "great, thanks", "perfect, thank you") says thanks, not yes: an explicit yes ("yes, thanks", "sure,
// thanks", "go ahead, thanks") still is one. And a yes word followed by a new request (a clause that opens with an imperative of its
// own, not one pointing back at the act: "ok, pull up the Chens", "yeah, run a sweep first"; "ok, send it" points back) moves on.
const ACK_WORD_RE =
  /^(?:ok(?:ay)?|alright|all\s+right|great|perfect|awesome|excellent|fine|cool|nice)(?![\w'’-])[\s,.!;:—–-]*/i;
const THANKS_WORD_RE =
  /^(?:thanks|thank\s+(?:you|u)|thx|ty|cheers)(?:\s+(?:so\s+much|a\s+lot|again))?(?:\s+(?:charli|charlie))?(?![\w'’-])[\s,.!;:—–-]*/i;
const thanksOnly = (t) => {
  let c = String(t).trim();
  let thanked = false;
  for (let prev = null; c !== prev;) {
    prev = c;
    c = c.replace(REPLY_FILLER_RE, "").replace(ACK_WORD_RE, "");
    const before = c;
    c = c.replace(THANKS_WORD_RE, "").trim();
    if (c !== before.trim()) thanked = true;
  }
  return thanked && c === "";
};
// (IMPERATIVE_LEAD_RE's verbs and the other ways a broker asks for something next)
const NEW_REQUEST_RE = new RegExp(
  "^(?:add|log|mark|record|note|update|set|book|schedule|save|create|enter|put|pull|run|show|find|give|send|draft|tell|read|check" +
    "|look|walk|go\\s+over|remind|take|move\\s+on|next\\s+(?:client|one|up)|let['\\u2019]?s\\s+(?:talk|look|go|see|check)|let\\s+me)" +
    "(?![\\w'\\u2019-])",
  "i"
);
const asksSomethingNew = (clause) => {
  const c = coreOf(clause, false);
  return NEW_REQUEST_RE.test(c) && !PRONOUN_OBJECT_RE.test(c);
};
// Ruling 29: a reply moves on when it asks something (a "?", a clause that opens a question, or it is shaped as no answer at all:
// isAnswerShaped) or makes a new request (asksSomethingNew); a choice ("the afternoon", "Robert and Linda") only answers.
const movesOn = (text) => {
  const t = String(text == null ? "" : text).replace(AUDIO_TAG_RE, " ").replace(/\s+/g, " ").trim();
  const clauses = t.split(USER_CLAUSE_BREAK_RE).map((c) => c.trim()).filter(Boolean);
  return t.includes("?") || !isAnswerShaped(t) || clauses.some(opensQuestion) || clauses.some(asksSomethingNew);
};

// The class of a reply to an offer to act: OFFER_YES, OFFER_DECLINE or OFFER_OTHER (Rulings 24 and 26). Pure.
function offerReplyClass(text) {
  const t = String(text == null ? "" : text).replace(AUDIO_TAG_RE, " ").replace(/\s+/g, " ").trim();
  if (!t || t.includes("?")) return OFFER_OTHER;
  if (isDecline(t)) return OFFER_DECLINE;
  const clauses = t.split(USER_CLAUSE_BREAK_RE).map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0 || clauses.some(opensQuestion)) return OFFER_OTHER;
  const corrected = CORRECTED_RE.test(clauses[0]);
  // a correction is a yes whatever else the reply says
  if (clauses.some((c) => correction(c, corrected))) return OFFER_YES;
  if (!clauses.some(saysYes) || thanksOnly(t) || clauses.some(asksSomethingNew)) return OFFER_OTHER;
  return OFFER_YES;
}
function offersAction(message) {
  const pieces = sentencesOf(messageText(message)).map((p) => p.trim()).filter(Boolean);
  const last = pieces[pieces.length - 1];
  if (!last || !last.endsWith("?")) return false;
  const s = stripOpener(last).trim();
  if (OFFER_TO_ACT_RE.test(s)) return true;
  const bare = BARE_TAIL_RE.exec(s);
  if (!bare) return false;
  return [s.slice(0, bare.index), pieces[pieces.length - 2]].some((before) => !!before && SELF_OFFER_TO_ACT_RE.test(before));
}
// The class of `answer` as the reply to `asked`, or null when `asked` is no assistant offer to act (or `answer` no user message).
const offerReplyOf = (asked, answer) =>
  asked && asked.role === "assistant" && answer && answer.role === "user" && offersAction(asked)
    ? offerReplyClass(messageText(answer))
    : null;

function answersActionQuestion(messages) {
  const latest = messages[messages.length - 1];
  if (!latest || latest.role !== "user") return false;
  // a yes to an offer to act is the origin by itself (it need not be answer-shaped: "would be great", "have it at 10"); a decline,
  // or another reply that moves on, ends the walk (Ruling 29)
  const first = offerReplyOf(messages[messages.length - 2], latest);
  if (first === OFFER_YES) return true;
  if (first === OFFER_DECLINE || (first === OFFER_OTHER && movesOn(messageText(latest)))) return false;
  if (!isAnswerShaped(messageText(latest))) return false;
  for (let hop = 0, i = messages.length - 1; hop < MAX_CHAIN_HOPS && i >= 1; hop++, i -= 2) {
    const asked = messages[i - 1];
    if (!asked || asked.role !== "assistant") return false;
    // a reply to an offer: a yes is the origin; a decline, or another reply that moves on, ends the walk; a reply that only answers
    // (a choice) is walked through like any answer (Ruling 29)
    const reply = offerReplyOf(asked, messages[i]);
    if (reply === OFFER_YES) return true;
    if (reply === OFFER_DECLINE || (reply === OFFER_OTHER && movesOn(messageText(messages[i])))) return false;
    const before = messages[i - 2];
    if (i < 2 || !askedOf(asked, messages[i])) return false;
    if (!before || before.role !== "user") return false;
    const text = messageText(before);
    if (isActionRequest(text)) return true;
    if (!isAnswerShaped(text)) return false;
  }
  return false;
}

// The claim guard (Rulings 24, 25, 30, 31, 33). A reply to an offer to act that is no yes makes a plain turn, so the action
// backstop does not hold what Charli says on it, and this does instead; on every action turn (a yes to an offer, a request) it runs
// beside the backstop, which lets through one question, and a question can carry a claim. The reply is a claim nothing backs when
//   * it holds a "now on your calendar" form anywhere (CALENDAR_NOW_FORM_RE, as on an action turn), or says the act is on the calendar
//     or scheduled with "it" / "that" / "they" ... as its subject (IT_ON_CALENDAR_RE: "Okay, it's on your calendar Friday.", "...
//     since that's on your calendar?"), anywhere, question or not, read or not: a read narrates its events by their titles;
//   * a statement (a sentence that is no question: it does not end with "?" after a question or auxiliary word) has a clause that
//     says the act was carried out in words no read narrates (ACT_DONE_RE: "you're set", "locked in", "got them down for", "went out",
//     "ready to go", an invite, "is in for Friday"), or a state no read can ground (UNGROUNDED_STATE: "drafted", "sent", "emailed",
//     "in your (Gmail) drafts", "on its way", "notified", "on file"), or a calendar state (CALENDAR_STATE: "on / in your calendar", "on
//     the calendar", "on your schedule", "on the books", "booked", "scheduled", "set for / up", "confirmed", "penciled in", "reserved",
//     "in place", "lined up") that the clause does not ground (Rulings 31, 36 and 39): the clause must name an event this turn's
//     calendar reads returned by its title, a whole word or words, in its own case but for its first letter (titlePattern: a title of
//     more than one word that begins in lower case may be said with a capital, "Team standup" for "team standup"; one that begins with
//     a capital may be said in lower case only when it is distinctive, "follow-up: Robert & Linda Chen" for "Follow-up: Robert & Linda
//     Chen", so "follow-up call" is no "Follow-up call"; a one-word title keeps its case, so "call" is not a "Call"), and every day the
//     clause names (a weekday, today / tonight / tomorrow / yesterday, a month and day) must be the day that
//     event was read for. So "Follow-up: Robert & Linda Chen is on your calendar tomorrow at 10:00 AM." and "Here's what's on your
//     calendar Friday: Follow-up: Robert & Linda Chen at 10:00 AM." pass after a read that returned that event for that day, while after
//     a read of an empty Friday "The follow-up is on your calendar Friday." does not, nor does that title said for Friday when it was
//     read for today, nor "... and a second one is on your calendar Friday" in a clause of its own;
//   * a question carries such a state (Ruling 30): in the clause after since / now that / because / given that / know / tell / a "that"
//     that opens a clause / an "as" that opens a clause with its subject (Ruling 34: ", as the check-in went out", not "add it as a
//     reminder"), any of those words ("Should I let the Chens know the follow-up is scheduled for Friday?"); anywhere past the offer
//     lead, a state said as a state, after a copula ("now that the follow-up is on your calendar", "since the check-in was sent",
//     "since the follow-up's on the books"), or in the first person ("the Friday follow-up I set up"). The act a question offers is no
//     state: "Should I put it on your calendar?", "When should I set up the call?" pass;
//   * on an action turn (Ruling 35), any piece of the one question (split at ; a dash, "--" or a spaced hyphen; a question with none is
//     one piece) has any of those words, as a statement would, copula or not ("What else — the invite went out — want a reminder?",
//     "Want a reminder too — the check-in is waiting in your drafts?"), but for a placing verb's own complement ("put it on your
//     calendar", "add it as a reminder on your calendar") and "set up" / "set for" used as a verb ("When should I set up the call?").
//     The accepted cost: a clarifier that names a state word is held ("Should I send it to the address that's on file?").
// Clauses split at , ; : a dash, "but" and "and" (Ruling 38: not at the colon of a clock time or one right before a read title), with
// the read titles kept whole; a clause where a negative stands before the words is skipped ("Okay, I won't put it on your calendar.", "Okay, nothing is on your calendar for them."; "no
// problem" / "no worries" are no negative). claimsCompletion runs on this turn too, as on every turn. Pure but for `reads.now`.
const IT_ON_CALENDAR_RE = new RegExp(
  "\\b(?:it|that|this|they|those|these|everything|all\\s+of\\s+(?:it|that|them))(?:['\\u2019](?:s|re)|\\s+(?:is|are|was|were|has\\s+been|have\\s+been))" +
    "\\s+(?:(?:now|already|all|also|officially|safely)\\s+)*" +
    "(?:(?:on|in)\\s+(?:your|the)\\s+(?:google\\s+)?calendar|scheduled|set\\s+up|set\\s+for|locked\\s+in)\\b",
  "i"
);
const ACT_DONE_RE = new RegExp(
  "\\b(?:you['\\u2019]re\\s+(?:all\\s+)?set|locked\\s+in|(?:got|have|put)\\s+(?:\\w+\\s+){0,2}down\\s+for|went\\s+out|gone\\s+out" +
    "|(?:ready|good)\\s+to\\s+(?:go|send)|invit(?:e|es|ed|ation)s?" +
    "|(?:is|are|['\\u2019]s|['\\u2019]re)\\s+(?:all\\s+)?in\\s+for\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|next|this))\\b",
  "i"
);
// "consider it done / handled / ..." reports the act only where it opens a clause (Ruling 43): "— no rush, consider it handled —", not
// "I'd consider it done once they sign the disclosures."
const CONSIDER_IT_RE = /^\s*(?:(?:so|and|then|just|please)\s+)*consider\s+it\s+(?:done|handled|sent|booked|scheduled)\b/i;
const actDoneIn = (clause) => unnegated(clause, ACT_DONE_RE) || CONSIDER_IT_RE.test(clause);
const UNGROUNDED_STATE = "drafted|sent|emailed|in\\s+your\\s+(?:gmail\\s+)?drafts|on\\s+its\\s+way|notified|on\\s+file";
const CALENDAR_STATE =
  "(?:on|in)\\s+(?:your|the)\\s+(?:google\\s+)?calendar|on\\s+(?:your|the)\\s+schedule|on\\s+the\\s+books|booked|scheduled|set\\s+(?:for|up)" +
  "|confirmed|pencil(?:l)?ed\\s+in|reserved|in\\s+place|lined\\s+up";
// the same said as a state: after a copula (and its adverbs)
const STATE_LEAD =
  "(?:\\b(?:is|are|was|were|been|being|got)|['\\u2019](?:s|re))\\s+(?:(?:now|already|all|also|just|officially|safely|still)\\s+)*";
const UNGROUNDED_STATE_RE = new RegExp("\\b(?:" + UNGROUNDED_STATE + ")\\b", "i");
const CALENDAR_STATE_RE = new RegExp("\\b(?:" + CALENDAR_STATE + ")\\b", "i");
const UNGROUNDED_AS_STATE_RE = new RegExp(STATE_LEAD + "(?:" + UNGROUNDED_STATE + ")\\b", "i");
const CALENDAR_AS_STATE_RE = new RegExp(STATE_LEAD + "(?:" + CALENDAR_STATE + ")\\b", "i");
// ... or in the first person ("the follow-up I set up"); an inverted modal before the I makes it a question ("When should I set up the
// call?")
const FIRST_PERSON_STATE_RE = new RegExp(
  "\\b(?:I|we)(?:['\\u2019](?:ve|d)|\\s+(?:have|had))?(?:\\s+(?:just|already|also|now))*" +
    "\\s+(?:set\\s+up|booked|scheduled|drafted|sent|emailed|pencil(?:l)?ed(?:\\s+in)?|reserved|confirmed|lined\\s+up|arranged)\\b",
  "gi"
);
// the words that open the clause a question presupposes
const QUESTION_CONNECTIVE_RE = new RegExp(
  "\\b(?:since|now\\s+that|because|given\\s+that|know|tell|that(?=['\\u2019](?:s|re)\\b|\\s+(?:is|are|was|were|has|have|had|got|I|we|you|they" +
    "|he|she|it|the|their|your|his|her|our|its|this|these|those)\\b))\\b",
  "gi"
);
// Ruling 34: an "as" opens such a clause only at a clause start (the sentence's, or after , ; a dash) and with its subject after it
// (a pronoun, a determiner, a name): ", as the check-in went out", ", as it's booked", "As Friday's follow-up was emailed"; not "add it
// as a reminder". Case-sensitive, so that a name is a capitalized word (each pronoun / determiner takes either case first).
const eitherCase = (w) => `[${w[0].toLowerCase()}${w[0].toUpperCase()}]${w.slice(1)}`;
const AS_SUBJECT =
  "(?:I|" + ["we", "you", "they", "he", "she", "it", "there", "the", "their", "your", "his", "her", "our", "its", "this", "that", "these",
    "those"].map(eitherCase).join("|") + "|[A-Z][\\w'\\u2019-]*)(?![\\w])";
const AS_CLAUSE_RE = new RegExp("(?<=(?:^|[,;\\u2014\\u2013])\\s*)" + eitherCase("as") + "(?=\\s+" + AS_SUBJECT + ")", "g");
const NEGATIVE_WORD_RE =
  /\b(?:not|never|nothing|none|nobody|neither|nor|without|cannot|no(?!\s+(?:problem|worries)\b))\b|n['’]t\b/i;
// a clause break: , ; : a dash, a spaced hyphen, "but", "and" (Ruling 38). Not a colon between the digits of a clock time, and not a
// colon right before a read title (titles are marked before the split: Ruling 36's "Here's what's on your calendar Friday: <title> at
// 10:00 AM." is one clause), so a negative or a title before any other colon covers nothing after it ("No rush: the Chens are
// penciled in for Friday.", "Team meeting is at 9:00 AM Friday: the follow-up is on your calendar right after.").
const GUARD_CLAUSE_SPLIT_RE = /[,;—–]|(?<!\d):(?!\s*\u0001)|:(?!\d)(?!\s*\u0001)|\s-\s|\b(?:but|and)\b/i;
// sentences split at . ! ? (not at the point of a decimal: "7.85 percent"), each marked as a question or a statement
const guardSentencesOf = (text) =>
  (String(text).match(/(?:[^.!?]|\.(?=\d))+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean)
    .map((s) => ({ s, question: /\?\s*$/.test(s) && QUESTION_START_RE.test(stripOpener(s).trim()) }));
// the read events, grouped by title, and each title in a sentence replaced by a mark that no clause break or word test sees into
const TITLE_MARK_RE = /\u0001(\d+)\u0002/g;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const titleGroups = (reads) => {
  const groups = [];
  for (const e of (reads && reads.events) || []) {
    if (!e || typeof e.title !== "string" || e.title.length < 3) continue;
    const group = groups.find((g) => g.title === e.title);
    if (group) group.events.push(e);
    else groups.push({ title: e.title, events: [e] });
  }
  return groups;
};
// a title as a whole word or words, in its own case, but for its first letter (Rulings 36 and 39): a title of more than one word that
// begins in lower case may be said with a capital ("Team standup" for "team standup"), and one that begins with a capital may be said
// in lower case only when it is distinctive, holding a colon, a digit or a later capitalised word ("follow-up: Robert & Linda Chen"
// for "Follow-up: Robert & Linda Chen"). So a generic title grounds no generic phrase ("follow-up call" is no "Follow-up call",
// "client meeting" no "Client meeting"), and a one-word title keeps its case ("call" is no "Call").
const titlePattern = (title) => {
  const first = title[0];
  const distinctive = /[:\d]|\s[A-Z]/.test(title.slice(1));
  const lead = /\s/.test(title) && first.toLowerCase() !== first.toUpperCase() && (first === first.toLowerCase() || distinctive)
    ? `[${escapeRegExp(first.toLowerCase())}${escapeRegExp(first.toUpperCase())}]`
    : escapeRegExp(first);
  return "(?<![\\w])" + lead + escapeRegExp(title.slice(1)) + "(?![\\w])";
};
const markTitles = (s, groups) => groups
  .map((g, i) => [g, i]).sort(([a], [b]) => b.title.length - a.title.length)
  .reduce((out, [g, i]) => out.replace(new RegExp(titlePattern(g.title), "g"), `\u0001${i}\u0002`), s);
// a day a clause names, and whether it is the day an event was read for
const DAY_NAMED_RE = new RegExp(
  "\\b(?:(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(today|tonight|tomorrow|yesterday)" +
    "|(january|february|march|april|may|june|july|august|september|october|november|december)\\s+(\\d{1,2})(?:st|nd|rd|th)?)\\b",
  "gi"
);
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const dayIsEvents = (m, event, now) => {
  try {
    const at = new Date(Date.parse(`${event.date}T12:00:00Z`));
    if (m[1]) return WEEKDAY_NAMES[at.getUTCDay()] === m[1].toLowerCase();
    if (m[2]) {
      const today = Date.parse(`${localToday(event.timeZone, now)}T12:00:00Z`);
      return at.getTime() - today === RELATIVE_DAY_OFFSET[m[2].toLowerCase()] * DAY_MS;
    }
    return at.getUTCMonth() === MONTH_NAMES.indexOf(m[3].toLowerCase()) && at.getUTCDate() === Number(m[4]);
  } catch (_err) {
    return false;
  }
};
// a clause grounds its calendar state when it names a read title and every day it names is that event's read day
const groundedClause = (clause, groups, now) => {
  const days = [...clause.matchAll(DAY_NAMED_RE)];
  return [...clause.matchAll(TITLE_MARK_RE)].some((t) =>
    groups[Number(t[1])].events.some((event) => days.every((d) => dayIsEvents(d, event, now))));
};
const unnegated = (clause, re) => {
  const m = re.exec(clause);
  return !!m && !NEGATIVE_WORD_RE.test(clause.slice(0, m.index));
};
// does a clause claim a state? `asState`: only a state said as one (after a copula)
const clauseClaims = (clause, groups, now, asState) =>
  unnegated(clause, asState ? UNGROUNDED_AS_STATE_RE : UNGROUNDED_STATE_RE) ||
  (unnegated(clause, asState ? CALENDAR_AS_STATE_RE : CALENDAR_STATE_RE) && !groundedClause(clause, groups, now));
const questionClaims = (marked, groups, now) => {
  const s = stripOpener(marked).trim();
  const body = isOffer(s) ? s.replace(OFFER_LEAD_RE, "") : s;
  if (body.split(GUARD_CLAUSE_SPLIT_RE).some((c) => clauseClaims(c, groups, now, true))) return true;
  if ([...body.matchAll(FIRST_PERSON_STATE_RE)].some((m) => !INVERTED_MODAL_BEFORE_RE.test(body.slice(0, m.index)))) return true;
  return [...body.matchAll(QUESTION_CONNECTIVE_RE), ...body.matchAll(AS_CLAUSE_RE)].some((m) => {
    // (Ruling 43: a break right after the connective, or after its object, opens its clause, it does not end it: "let the Chens know:
    // the invite went out", "tell them: the check-in went out")
    const clause = body.slice(m.index + m[0].length)
      .replace(/^\s*(?:(?:them|him|her|us|you|me|the\s+[\w'’-]+|[A-Z][\w'’-]*(?:\s+(?:and|&)\s+[A-Z][\w'’-]*)?)\s*)?(?:[,;:—–]|-\s)\s*/, "")
      .split(GUARD_CLAUSE_SPLIT_RE)[0];
    return actDoneIn(clause) || clauseClaims(clause, groups, now, false);
  });
};
// Ruling 35: the pieces of the one question of an action turn, each screened in full. A calendar word that is a placing verb's own
// complement ("put it on your calendar", "add it as a reminder on your calendar": the verb and up to eight words with no punctuation
// and no clause of their own before the destination), and "set up" / "set for" as a verb (after to, a subject, a modal, "let me" or
// "please"), are the act offered, not a state.
const QUESTION_PIECE_SPLIT_RE = /[;—–]|--|\s-\s/;
const GUARD_CLAUSE_BREAK_ALL_RE = new RegExp(GUARD_CLAUSE_SPLIT_RE.source, "gi");
const ACT_DONE_ALL_RE = new RegExp(ACT_DONE_RE.source, "gi");
const UNGROUNDED_STATE_ALL_RE = new RegExp(UNGROUNDED_STATE_RE.source, "gi");
const CALENDAR_STATE_ALL_RE = new RegExp(CALENDAR_STATE_RE.source, "gi");
const DESTINATION_RE = /^(?:on|in)\s+(?:your|the)\s+(?:google\s+)?(?:calendar|schedule)$/i;
const PLACING_DESTINATION_BEFORE_RE = new RegExp(
  "\\b" + PLACING_VERB + "(?:\\s+(?!(?:that|which|who|since|because|while|now|is|are|was|were|be|been" +
    "|(?:it|that|this|they|there|he|she|we|you|everything)['\\u2019](?:s|re|ve))\\b)[^\\s.,;:!?()\\u2014\\u2013]+){0,8}\\s*$",
  "i"
);
const BASE_FORM_BEFORE_RE = /(?:\b(?:to|I|we|you|they|can|could|should|shall|will|would|may|might|must|please|let\s+me)|['’]ll)\s+$/i;
// the clause of `s` around position `at`
const clauseAround = (s, at) => {
  let start = 0;
  let end = s.length;
  for (const m of s.matchAll(GUARD_CLAUSE_BREAK_ALL_RE)) {
    if (m.index + m[0].length <= at) start = m.index + m[0].length;
    else if (m.index > at) { end = m.index; break; }
  }
  return { text: s.slice(start, end), offset: start };
};
const pieceClaims = (piece, groups, now) => {
  const said = (re, isTheAct) => [...piece.matchAll(re)].some((m) => {
    const clause = clauseAround(piece, m.index);
    if (NEGATIVE_WORD_RE.test(clause.text.slice(0, m.index - clause.offset))) return false;
    return !(isTheAct && isTheAct(m, clause));
  });
  return said(ACT_DONE_ALL_RE) || piece.split(GUARD_CLAUSE_SPLIT_RE).some((c) => CONSIDER_IT_RE.test(c)) ||
    said(UNGROUNDED_STATE_ALL_RE) || said(CALENDAR_STATE_ALL_RE, (m, clause) =>
    (DESTINATION_RE.test(m[0]) && PLACING_DESTINATION_BEFORE_RE.test(piece.slice(0, m.index))) ||
    (/^set\s/i.test(m[0]) && BASE_FORM_BEFORE_RE.test(piece.slice(0, m.index))) ||
    groundedClause(clause.text, groups, now));
};
// A piece after the first that is a statement of its own about a booking ("What else — friday it is — want a reminder?", "Want a
// reminder too — the Chens got your check-in?"): it names a booking or email noun, a day or a clock time (BOOKING_TOPIC_RE, Ruling 40),
// opens with no question or auxiliary word, and has a finite verb, or opens with an acknowledgement ("— okay, Friday morning with the
// Chens —"), or is a shortened passive ("— calendar updated?"). A negative does not excuse it ("— no rush, the follow-up is on your
// calendar Friday —"). An option list ("— Robert and Linda, or Chen Wei?", "— 9 a.m. or 10 a.m.?") and a time ("— 10:00 AM?") are no
// statement, and a piece about no booking is not screened here ("— I don't see a Zed?", "— the one who has the HELOC, or Chen
// Wei?"). The accepted cost: a clarifier whose statement piece names a time, a day or a booking noun is held ("What time works —
// you're free after 10?"). (No "am" on the verb list: it is also the AM of a clock time; "I'm" is the 'm.)
const BOOKING_TOPIC_RE = new RegExp(
  "\\b(?:calendars?|schedules?|follow[\\s-]?ups?|check[\\s-]?ins?|e-?mails?|drafts?|notes?|invit(?:e|es|ation|ations)|meetings?|calls?" +
    "|appointments?|reminders?|events?|inbox(?:es)?)\\b" +
    "|\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|(?:this|next)\\s+week)\\b" +
    "|\\b\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\b\\.?)|\\b\\d{1,2}:\\d{2}\\b|\\b(?:at|after|before|by|around|until|till|from)\\s+\\d{1,2}\\b" +
    "|\\b(?:noon|midnight|o['\\u2019]clock)\\b|\\u0001",
  "i"
);
const FINITE_VERB_RE = new RegExp(
  "\\b(?:is|are|was|were|has|have|had|do|does|did|will|would|can|could|should|shall|may|might|must|got|gets|goes|went|comes|came" +
    "|sits|shows|appears|seems|looks|stands|waits|holds|lists|reads|says|includes|contains)\\b" +
    "|\\b(?:it|that|there|here|what|who|he|she|everything|this)['\\u2019]s\\b|['\\u2019](?:re|ve|d|ll|m)\\b" +
    "|['\\u2019]s\\s+(?:all|now|already|just|still|also|officially|on|in|set|done|good|fine|ready|out|booked|scheduled|arranged|squared" +
    "|taken|a\\s+go)\\b",
  "i"
);
const ACK_PIECE_RE = /^(?:okay|ok|great|perfect|alright|all\s+right|done|got\s+it|sure|good|nice|excellent)(?![\w'’-])/i;
const statementPiece = (piece) => {
  const p = piece.trim().replace(/^(?:(?:and|but|so|then|plus)\s+)+/i, "");
  if (!p || !BOOKING_TOPIC_RE.test(p) || QUESTION_START_RE.test(p)) return false;
  // (an acknowledgement opening the piece, or opening a clause with another clause after it, Ruling 43: "— no rush, okay, Friday
  // morning with the Chens —", not the tag of "— at 10, okay?"; and the shortened passive, which claimsCompletion leaves to a clause
  // that does not end in "?": "— calendar updated?")
  return FINITE_VERB_RE.test(p) || ACK_PIECE_RE.test(p) ||
    p.split(GUARD_CLAUSE_SPLIT_RE).slice(0, -1).some((c) => ACK_PIECE_RE.test(c.trim())) ||
    SHORT_PASSIVE_RE.test(p.replace(/[?\s]+$/, ""));
};
// `reads`: null when the turn cited no calendar read, else { events: [{ title, date, timeZone }] (each event this turn's calendar
// reads returned, its title as the model saw it and the day it was read for), now }; `actionTurn`: the turn is one (Ruling 35)
function offeredActClaimed(text, reads, actionTurn) {
  if (CALENDAR_NOW_FORM_RE.test(text) || IT_ON_CALENDAR_RE.test(text)) return true;
  const groups = titleGroups(reads);
  const now = reads && Number.isFinite(reads.now) ? reads.now : Date.now();
  if (actionTurn) {
    const pieces = markTitles(stripOpener(String(text)).trim(), groups).split(QUESTION_PIECE_SPLIT_RE);
    if (pieces.some((p) => pieceClaims(p, groups, now)) || pieces.slice(1).some(statementPiece)) return true;
  }
  return guardSentencesOf(text).some(({ s, question }) => {
    const marked = markTitles(s, groups);
    if (question) return questionClaims(marked, groups, now);
    return marked.split(GUARD_CLAUSE_SPLIT_RE).some((c) => actDoneIn(c) || clauseClaims(c, groups, now, false));
  });
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
// where a clause ends, right after a stage word ("That counts as Veteran.", "That's Veteran, so ...", "so Veteran (10+ years)")
const STAGE_CLAUSE_END = "(?=\\s*(?:[.!?;:,\\u2014\\u2013(]|$))";
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
  // you qualify / count as (a) STAGE ("You qualify as a Veteran."); that / this ... with no article and only where the clause ends
  // ("That counts as Veteran."): on a client lookup "that counts as a veteran for VA purposes" and "that qualifies as veteran
  // service" are VA eligibility, not the user's stage
  qualifyAs: "\\byou\\s+(?:qualif(?:y|ies|ied)|count(?:s|ed)?)\\s+as\\s+(?:an?\\s+)?" + STAGE_SRC,
  qualifyAsThat: "\\b(?:that|this)\\s+(?:qualif(?:y|ies|ied)|count(?:s|ed)?)\\s+as\\s+" + STAGE_SRC + STAGE_CLAUSE_END,
  // (c) STAGE it is, (d) STAGE coaching (a bare "new coaching" is a tip, not a stage)
  itIs: "\\b" + STAGE_WORDS_BARE + "\\s+it\\s+is\\b",
  coaching: "\\b(brand[\\s-]new|developing|established|veterans?|seasoned\\s+vets?)\\s+coaching\\b",
  // (e) your (career) stage is / 's / has been / was / will be (now / already) (set to / as) STAGE ("Your career stage is
  // already set to Veteran.")
  yourStage: "\\byour\\s+(?:career\\s+)?stage(?:\\s+(?:is|has\\s+been|was|will\\s+be)|['\\u2019]s)\\s+(?:(?:now|already)\\s+)?(?:set\\s+(?:to|as))?[\\s:\"'\\u201c\\u2018]*(?:(?:an?|the)\\s+)?" + STAGE_SRC,
  // (f) got you / your (career) stage set / marked / listed as / to STAGE ("I've got you set as a Veteran."): like (e), true only
  // for the stored stage
  gotYouSet: "\\bgot\\s+you(?:r\\s+(?:career\\s+)?stage)?\\s+(?:set|marked|listed)\\s+(?:as|to)\\s+(?:(?:an?|the)\\s+)?" + STAGE_SRC,
  // that's / that is STAGE level / tier / territory / stage / bracket ("That's Veteran level, so I'll keep it terse."). An
  // article only before veteran(s) / seasoned vet(s): "that's a new level for rates", "the established level for cash-out" are not
  // stages; and bare new / developing / established keep their own allow-list ("that's new territory" is not one either). Not
  // "status": "so that's veteran status confirmed for the IRRRL" is a client's VA eligibility (the `status` form below is the user's)
  thatsLevel: "\\bthat(?:['\\u2019]s|\\s+is)\\s+(?:(?:an?|the)\\s+(?=(?:veterans?|seasoned\\s+vets?)\\b))?" + STAGE_SRC +
    "\\s+(?:level|tier|territory|stage|bracket)\\b",
  // that's STAGE with no article, where the clause ends ("That's Veteran.", "Twenty years — that's Veteran."): "That's a veteran —
  // VA streamline is his best path." is about a client, and a bare "new" is never the stage here ("Rates dropped — that's new.")
  thatsStage: "\\bthat['\\u2019]s\\s+(brand[\\s-]new|developing|established|veterans?|seasoned\\s+vets?)\\b" + STAGE_CLAUSE_END,
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
  // (the vocative needs its comma: "Lenders that welcome veterans with lower scores" addresses no one)
  vocative: "\\b(?:welcome(?:\\s+aboard)?|congrats|congratulations)\\s*,\\s*" + STAGE_SRC,
  // a trailing ", so STAGE" where the clause ends ("Twenty years, so Veteran."), the comma form of LONE_STAGE_RE below
  soStage: ",\\s*so[\\s,]+(brand[\\s-]new|veteran|established|developing)\\b" + STAGE_CLAUSE_END,
  leading: "^\\s*(?:(?:ok|okay|alright|great|got\\s+it|perfect|so|right|sure|yes|yep)[\\s,:]+)*(brand[\\s-]new|veteran|established|developing)\\s*(?:[,.!\\u2014\\u2013(]|$)",
};
const STAGE_FORMS = Object.fromEntries(Object.entries(STAGE_FORM_SRC).map(([name, src]) => [name, new RegExp(src, "gi")]));
// An offer keeps only the assertion forms; any other sentence part gets every form but `leading`.
const OFFER_STAGE_FORMS = [STAGE_FORMS.youAre, STAGE_FORMS.yourStage];
const STATEMENT_STAGE_FORMS = Object.entries(STAGE_FORMS).filter(([name]) => name !== "leading").map(([, re]) => re);
// Sentences in the leading form's sense: split only after . ! ? (an em or en dash, or a semicolon, starts no sentence).
const wholeSentencesOf = (text) => String(text).match(/[^.!?]+[.!?]*/g) || [];
// A piece of a sentence (split on . ! ? ; an em or en dash, and a colon) that is ONLY a stage word, an opener allowed: "Twenty
// years — Veteran.", "Twenty years; Veteran.", "Twenty years: Veteran.", "Twenty years — so, Veteran." (never a bare "new", and
// never in an offer). "Call the Chens first — established, low-risk, ..." and "Veteran, Established, or Developing — which fits?"
// have more than the stage word in the piece.
const LONE_STAGE_RE =
  /^(?:(?:ok|okay|alright|great|got\s+it|perfect|so|right|sure|yes|yep)[\s,:]+)*(brand[\s-]new|veteran|established|developing)\s*[.!,;:\u2014\u2013]*$/gi;

// "veterans" / "seasoned vet" are veteran, "brand-new" / "new" are new
function stageIdOf(word) {
  const w = String(word).toLowerCase().replace(/\s+/g, " ");
  if (/^(?:brand[\s-])?new$/.test(w)) return "new";
  if (/^veterans?$|^seasoned vets?$/.test(w)) return "veteran";
  return STAGE_IDS.includes(w) ? w : null;
}

// The stage ids a reply claims for the USER, in order (one per claim): "You're a Veteran now.", "I'll coach you as a Veteran",
// "That puts you in the Veteran tier.", "You qualify as a Veteran.", "Veteran it is.", "Veteran coaching", "Your stage is now
// Veteran.", "I've got you set as a Veteran.", "That's Veteran level", "Veteran mode on!", and the acknowledgements above. Each sentence part (split like
// claimsCompletion, one opener stripped) is tested; an OFFER (a question-word sentence ending in "?") loses its lead and keeps
// only the assertion forms (a) and (e): "Want me to coach you as a Veteran?" proposes, "...now that you're a Veteran?" asserts.
// The leading form is tested on whole sentences only (the reply's first, or one after . ! ?), after one opener strip, and never
// on a sentence ending "?": "Call the Chens first — established, low-risk, ..." and "Veteran, Established, or Developing — which
// fits?" claim nothing. A part that is not an offer is also split on ":" and each piece tested with LONE_STAGE_RE ("Twenty
// years — Veteran.", "Twenty years: Veteran."). Subjects other than the user ("Chen is an established client", "VA loans for
// veterans", "a developing story", "Robert's veteran status", "that counts as a veteran for VA purposes") are not claims.
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
      if (!offer) for (const piece of s.split(":")) add(LONE_STAGE_RE, piece.trim());
    }
  }
  return claims;
}
// The first stage id a reply claims for the user, or null. Pure.
const claimsStage = (text) => stageClaims(text)[0] || null;

// A set-claim (FIRST_PERSON_SET_RE, SET_PASSIVE_RE, STAGE_SET_BARE_RE) in one sentence part that is false for this user. It is
// true only when the OBJECT of "set" is a stage (SET_STAGE_OBJECT_RE: "set (you / your (career) stage) to / as (a / the) STAGE",
// and the gotYouSet shape "got you (r stage) set / marked / listed as STAGE"),
// every such object and every other stage named in the part is the stored stage (null or undefined = not set), and once those
// objects are removed nothing set-like is left. So "Your career stage is set to Veteran." and "I've set you as a veteran." are true
// for a stored veteran, like the stage claims above, while "I've set that, Robert's a veteran." (the stage is not what was set),
// "Your career stage is set." (no stage) and "... set to Veteran and I've set your follow-up" (a second set) are false for every
// user. Pure.
const STAGE_NAMED_RE = new RegExp("\\b" + STAGE_SRC, "gi");
const SET_STAGE_OBJECT_RE = new RegExp(
  "\\b(?:got\\s+you(?:r\\s+(?:career\\s+)?stage)?\\s+(?:set|marked|listed)|set(?:\\s+(?:you|your\\s+(?:career\\s+)?stage))?)\\s+(?:to|as)" +
    "[\\s:\"'\\u201c\\u2018]*(?:(?:an?|the)[\\s:\"'\\u201c\\u2018]+)?" + STAGE_SRC, "gi"
);
const isSetClaim = (s) => FIRST_PERSON_SET_RE.test(s) || SET_PASSIVE_RE.test(s) || STAGE_SET_BARE_RE.test(s);
function falseSetClaim(sentence, storedStage) {
  if (!isSetClaim(sentence)) return false;
  const stagesIn = (re) => [...sentence.matchAll(re)].map((m) => stageIdOf(m[1])).filter(Boolean);
  // every stage in the part, the objects of "set" among them, is the stored one ("Your stage is set to Veteran, not Established.")
  if (stagesIn(STAGE_NAMED_RE).some((id) => id !== storedStage)) return true;
  // and nothing set-like is left once the stage objects are removed ("... set to Veteran and I've set your follow-up"). With no
  // stage object nothing is removed, so the set-claim is still there: "I've set that, Robert's a veteran.", "Your career stage is set."
  return isSetClaim(sentence.replace(SET_STAGE_OBJECT_RE, " "));
}

// ── The answer to the career question ────────────────────────────────────────

// A user with no stored stage is asked CAREER_QUESTION at the end of the code-authored greeting (routes/assistant.js), so the
// turn that answers it is known exactly: the user's stored stage is null, and the assistant message right before the user's
// latest one ends with CAREER_QUESTION. On that turn a reply could claim a stage in endless ways ("Twenty years — Veteran, then.",
// "Congratulations veteran!"), so it is screened by what the turn did, not by how the reply is phrased:
//   Tier 1: the user's message is a plain duration code can read (plainYears: "about 20 years", "6 months", "eighteen months",
//     "a year", "half a year", "two and a half years", "since 2006"): the setCareerStage change is packaged right away by
//     setCareerStageTool({ years }) (which alone maps years to a stage) with its code-authored read-back, and no model is called;
//   Tier 2: any other answer that gives a duration (givesDuration: "a while", "forever", "since the crash", "almost ten years",
//     "a couple of years", "Twenty."), with no read tool cited this turn: the model's reply must be question-shaped or come with
//     the setCareerStage change; anything else is replaced by STAGE_REASK.
// An answer that gives no duration ("what are rates today?") is an ordinary turn.
const answersCareerQuestion = (messages, storedStage) => {
  const asked = messages[messages.length - 2];
  return storedStage === null && !!asked && asked.role === "assistant" && messageText(asked).trim().endsWith(CAREER_QUESTION);
};

const NUMBER_WORD_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
};
const TENS_WORDS = "twenty|thirty|forty|fifty|sixty|seventy";
const UNIT_WORDS = "one|two|three|four|five|six|seven|eight|nine";
const COUNT_WORDS =
  "(?:(?:" + TENS_WORDS + ")(?:[\\s-](?:" + UNIT_WORDS + "))?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve" +
  "|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
// What may come before the amount: "I've been originating (for)", "been doing this", "it's been", and the approximations "about",
// "around", "roughly", "over", "more than"... ("almost", "nearly", "under", "less than" and "close to" are left to Tier 2: their
// number is not the number of years).
const DURATION_LEAD =
  "(?:(?:(?:i(?:['\\u2019]ve|\\s+have)|have|i['\\u2019]m)\\s+)?been\\s+(?:originating|doing\\s+(?:this|it)|at\\s+(?:it|this)" +
    "|in\\s+(?:the\\s+business|this\\s+business|mortgages|lending))(?:\\s+for)?" +
  "|it(?:['\\u2019]s|\\s+has|\\s+is)\\s+been|about|around|roughly|approximately|probably|maybe|like|just|over|more\\s+than" +
  "|a\\s+(?:little|bit)\\s+over|i['\\u2019]d\\s+say|i\\s+would\\s+say|for|oh|so|well)";
const DURATION_TRAIL =
  "(?:[\\s,]+(?:now|or\\s+so|give\\s+or\\s+take|in\\s+the\\s+business|in\\s+this\\s+business|in\\s+mortgages|originating" +
  "|of\\s+originating|total|already|i\\s+think|i\\s+guess))*";
const PLAIN_DURATION_RE = new RegExp(
  "^(?:" + DURATION_LEAD + "[\\s,]+)*" +
  "(?:(\\d+(?:\\.\\d+)?|" + COUNT_WORDS + "|an?|half\\s+an?)(\\s+and\\s+a\\s+half)?\\s*(years?|yrs?|months?)(\\s+and\\s+a\\s+half)?" +
  "|since\\s+((?:19|20)\\d{2}))" + DURATION_TRAIL + "[\\s.!]*$",
  "i"
);
const GIVES_DURATION_RE = new RegExp(
  "\\b(?:years?|yrs?|months?|decades?|since|while|forever|ages|long\\s+time|a\\s+(?:few|couple)|half|\\d+|" + COUNT_WORDS + ")\\b", "i"
);
const givesDuration = (text) => GIVES_DURATION_RE.test(afterFiller(text));

// "twenty-five" -> 25, "a" -> 1, "half a" -> 0.5, "12" -> 12; null for anything else.
function amountOf(word) {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (/^\d+(?:\.\d+)?$/.test(w)) return Number(w);
  if (/^an?$/.test(w)) return 1;
  if (/^half an?$/.test(w)) return 0.5;
  const [tens, unit] = w.split(/[\s-]/);
  if (!(tens in NUMBER_WORD_VALUES) || (unit !== undefined && !(unit in NUMBER_WORD_VALUES))) return null;
  return NUMBER_WORD_VALUES[tens] + (unit === undefined ? 0 : NUMBER_WORD_VALUES[unit]);
}

// The number of years in a plain-duration answer (months / 12; "and a half" adds 0.5 of the unit; "since YYYY" is this UTC
// year minus YYYY), or null when the message is anything more or less than a plain duration. Tags, filler and a trailing
// "." / "!" are ignored. Pure (but for "since YYYY", which reads the clock).
function plainYears(text) {
  const m = afterFiller(text).match(PLAIN_DURATION_RE);
  if (!m) return null;
  const [, amount, halfBefore, unit, halfAfter, sinceYear] = m;
  if (sinceYear) {
    const years = new Date().getUTCFullYear() - Number(sinceYear);
    return years >= 0 ? years : null;
  }
  const n = amountOf(amount);
  if (n === null || (halfBefore && halfAfter)) return null;
  const count = n + (halfBefore || halfAfter ? 0.5 : 0);
  return /^m/i.test(unit) ? count / 12 : count;
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

// A calendar event's title is text somebody else wrote (an invite, a note-to-self), and it is the one free-text field of a
// calendar read: it reaches the model on one line, trimmed, and at most CALENDAR_TITLE_MAX characters long.
const CALENDAR_TITLE_MAX = 200;
const oneLine = (t) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, CALENDAR_TITLE_MAX).trim() : "");

// The calendar day as the model sees it: the spoken day, its date, how many events there are and the events. Nothing else
// (not the time zone, not the connected account). An error result passes through untouched.
function trimCalendar(data) {
  if (!data || data.error || !Array.isArray(data.events)) return data;
  const events = data.events.map((e) => {
    const event = e && typeof e === "object" ? e : {};
    return { title: oneLine(event.title), start: event.start, end: event.end, allDay: event.allDay };
  });
  return { day: data.day, date: data.date, count: data.count, events };
}

// The model never sees a client's address or the email text: it is told which client and which purpose, and the email itself
// goes to the screen as `compose` (runTool carries it past this step).
function trimDraft(data) {
  if (!data || typeof data !== "object") return data;
  const { email, body, ...rest } = data;
  return rest;
}

const forModel = (name, data) =>
  name === "runSweepTool" ? trimSweep(data)
    : name === "findClient" ? trimFindClient(data)
      : name === "getCalendarTool" ? trimCalendar(data)
        : name === "draftEmailTool" ? trimDraft(data)
          : data;

const toolResultBlock = (id, source, data, isError) => {
  const block = { type: "tool_result", tool_use_id: id, content: JSON.stringify({ source, data }) };
  if (isError) block.is_error = true;
  return block;
};

const cleanName = (n) => (typeof n === "string" ? n.replace(/\s+/g, " ").trim() : "");

// Runs one tool and shapes what goes back to the model. A throwing tool never leaks its error
// text to the model: it becomes an is_error result the model can apologise for (a tool that returns a Promise, as the Google
// ones do, is awaited, and one that rejects is the same). Returns { source, sideEffect?, compose?, data, toolResult }; `compose`
// is the email draftEmailTool set up, carried to the caller and never shown to the model.
async function runTool(block, ctx) {
  try {
    const result = await tools[block.name](block.input && typeof block.input === "object" ? block.input : {}, ctx);
    if (!result || typeof result !== "object") throw new Error("tool returned no result");
    let { sideEffect } = result;
    const compose = result.compose && typeof result.compose === "object" ? result.compose : undefined;
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
      source: result.source, sideEffect, compose, data: result.data,
      toolResult: toolResultBlock(block.id, result.source, forModel(block.name, result.data)),
    };
  } catch (_err) {
    const error = { error: "that lookup failed" };
    return { source: "(error)", data: error, toolResult: toolResultBlock(block.id, "(error)", error, true) };
  }
}

// The loan types as they are said ("30yr_fixed" is the stored id).
const LOAN_TYPE_WORDS = { "30yr_fixed": "30-year fixed", "15yr_fixed": "15-year fixed", "5_1_arm": "5/1 ARM" };
// 300000 -> "300,000", 300000.5 -> "300,000.5": every digit kept, so what is read back is the number that is written.
const withCommas = (n) => {
  const [whole, fraction] = String(n).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
};
const spokenList = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);
// The addClient read-back speaks every field that will be written (addClientTool packaged exactly those), in the order a broker
// says them: "Just to confirm — add Jane Doe, 30-year fixed at 7.1 percent, balance $300,000, value $450,000, closed 2024-03-01;
// no credit score given, so 700 will be used?". An optional field that is absent is left out, except the credit score, whose 700
// default IS written and so is said. The email, phone and notes are named, never read out (borrower contact details and notes do
// not go into the conversation the model is sent): "...; plus the email and phone shown on screen?"; the card shows their values.
function addClientReadBack(fields) {
  const said = [
    `add ${fields.name}`,
    `${LOAN_TYPE_WORDS[fields.loanType] || fields.loanType} at ${fields.currentRate} percent`,
    `balance $${withCommas(fields.loanBalance)}`,
    `value $${withCommas(fields.propertyValue)}`,
  ];
  if (fields.closeDate) said.push(`closed ${fields.closeDate}`);
  if (fields.creditScore != null) said.push(`credit score ${fields.creditScore}`);
  let text = `${READ_BACK_PREFIX} ${said.join(", ")}`;
  if (fields.creditScore == null) text += "; no credit score given, so 700 will be used";
  const contact = ["email", "phone", "notes"].filter((key) => fields[key]);
  if (contact.length) text += `; plus the ${spokenList(contact)} shown on screen`;
  return text + "?";
}

// A packaged booking in words, all of it from the event createEventTool packaged (never from the model): the spoken day and start
// time, and the end time on the calendar's own wall clock (the start instant plus the length, so a clock change in between shows
// as it will be on the calendar; an end on another day names that day). null when the event is not something the tool could have
// packaged, and the caller falls back to the generic read-back.
function eventSpeech(event) {
  try {
    const time = parseTime(event.time);
    if (!time || !Number.isInteger(event.durationMinutes)) return null;
    const end = localTimeOf(new Date(toInstant(event.date, time, event.timeZone) + event.durationMinutes * 60_000).toISOString(), event.timeZone);
    const endAt = spokenTime({ hour: end.hour, minute: end.minute });
    return {
      day: spokenDay(event.date), at: spokenTime(time),
      until: end.date === event.date ? endAt : `${spokenDay(end.date)}, ${endAt}`,
    };
  } catch (_err) {
    return null;
  }
}

// Code-authored confirmation question, built from the tool's own data (never from anything the
// model wrote), so what is read back is what would be saved. Every read-back opens with READ_BACK_PREFIX
// (answersActionQuestion keys on it).
function readBack(out) {
  const se = out.sideEffect;
  switch (se.type) {
    case "createEvent": {
      const event = se.event || {};
      const said = eventSpeech(event);
      return said
        ? `${READ_BACK_PREFIX} put "${event.title}" on your calendar for ${said.day} at ${said.at}, ${event.durationMinutes} minutes? Nobody gets an invite.`
        : `${READ_BACK_PREFIX} go ahead with that?`;
    }
    case "logContact":
      return `${READ_BACK_PREFIX} log a contact for ${cleanName(out.data && out.data.client && out.data.client.name) || "that client"}?`;
    case "addClient":
      return addClientReadBack(se.fields);
    case "setCareerStage": {
      // the label comes from the stage the tool packaged, so what is read back is what would be saved; it is the spoken
      // label ("Veteran, ten or more years"), the screen's "(10+ years)" being no way to say it
      const spoken = spokenStageLabel(se.stage);
      return spoken ? `${READ_BACK_PREFIX} set your career stage to ${spoken}?` : `${READ_BACK_PREFIX} go ahead with that?`;
    }
    default:
      return `${READ_BACK_PREFIX} go ahead with that?`;
  }
}

// What the pending card shows under the read-back: [{ label, value }], code-authored from the same packaged change. addClient
// lists every field of sideEffect.fields (the object /confirm will write), the credit-score default included; logContact the
// client and the date (the write sets the last contact to now); setCareerStage the stage; createEvent the title, the day with its
// start and end time on the calendar's clock, and that nobody is invited. Never sent to the model.
const CLIENT_FIELD_LABELS = [
  ["name", "Name"], ["loanType", "Loan type"], ["currentRate", "Rate"], ["loanBalance", "Balance"], ["propertyValue", "Property value"],
  ["closeDate", "Close date"], ["creditScore", "Credit score"], ["email", "Email"], ["phone", "Phone"], ["notes", "Notes"],
];
function changeDetails(out) {
  const se = out.sideEffect;
  if (se.type === "addClient") {
    const f = se.fields;
    const shown = {
      loanType: LOAN_TYPE_WORDS[f.loanType] || f.loanType, currentRate: `${f.currentRate}%`,
      loanBalance: `$${withCommas(f.loanBalance)}`, propertyValue: `$${withCommas(f.propertyValue)}`,
      creditScore: f.creditScore == null ? "700 (none given)" : f.creditScore,
    };
    return CLIENT_FIELD_LABELS.filter(([key]) => key === "creditScore" || (f[key] != null && f[key] !== ""))
      .map(([key, label]) => ({ label, value: String(key in shown ? shown[key] : f[key]) }));
  }
  if (se.type === "logContact") {
    return [
      { label: "Client", value: cleanName(out.data && out.data.client && out.data.client.name) || "that client" },
      { label: "Contact date", value: "Today" },
    ];
  }
  if (se.type === "setCareerStage") {
    const stage = stageById(se.stage);
    return stage ? [{ label: "Career stage", value: stage.label }] : [];
  }
  if (se.type === "createEvent") {
    const event = se.event || {};
    const said = eventSpeech(event);
    return said ? [
      { label: "Title", value: String(event.title) },
      { label: "When", value: `${said.day}, ${said.at} – ${said.until}` },
      { label: "Invites", value: "None — your calendar only" },
    ] : [];
  }
  return [];
}

// ── The turn ─────────────────────────────────────────────────────────────────

// Thrown by createWithin when the turn's deadline passed during (or just before) a model call.
class TurnDeadline extends Error {}
// The SDK's own way of saying a request was aborted or timed out (matched by name: this file does not load the SDK).
const isTimeoutError = (err) => Boolean(err) && (
  err.name === "AbortError" || err.name === "TimeoutError" ||
  (err.constructor && (err.constructor.name === "APIUserAbortError" || err.constructor.name === "APIConnectionTimeoutError"))
);
// One model call that is cut off after `ms`: the request is aborted through its signal (the SDK honors `signal` in its request
// options) AND raced against a timer, so a client that ignores the signal, or an SDK retry sleeping on a Retry-After, still cannot
// hold the turn past the deadline. Anything that is not a timeout (a 4xx, a network fault) is rethrown as it was.
async function createWithin(client, params, ms) {
  const controller = new AbortController();
  let timer;
  let fired = false;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => { fired = true; controller.abort(); reject(new TurnDeadline("model call timed out")); }, ms);
  });
  try {
    return await Promise.race([client.messages.create(params, { signal: controller.signal }), clock]);
  } catch (err) {
    if (fired || isTimeoutError(err)) throw new TurnDeadline("model call timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The tools of one model response, raced against what is left of the turn: a Google call goes out to the network, and the turn's
// deadline covers it as it covers the model calls. When the time runs out the tools still in flight are abandoned (runTool never
// rejects, so nothing is left unhandled, and nothing they return is used). The timer is always cleared.
async function withinTurn(promise, ms) {
  let timer;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TurnDeadline("tool calls timed out")), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, clock]);
  } finally {
    clearTimeout(timer);
  }
}

// ── What a calendar read grounds beyond its figures ──────────────────────────────────────────────────────────────────────────
//
// On a turn that read the calendar, the figure check lets any number through that appears in the payload, so "10:00 PM" for a 10:00 AM
// event, "Saturday" on a Tuesday read and "tomorrow" on a read of today would all pass it. So, on such a turn (Ruling 13):
//   * every clock time in the reply ("10:00 AM", "10 PM", "9:30 a.m.") must be a time this turn's payloads hold, compared as H:MM and
//     AM / PM, case and spacing aside ("10 AM" reads as 10:00 AM);
//   * every weekday name in the reply must appear in this turn's payloads (the read's `day`, "Friday, October 30th", or an event title);
//   * every today / tonight / tomorrow / yesterday must agree with a day this turn read: its date is the calendar's local today (+0),
//     today plus one, or today minus one, in the time zone of that read (localToday, lib/google/time.js), at the turn's clock.
// Times are checked wherever they stand; the weekday and relative-day words are checked in the sentences that state something, not in
// a question: the offer "Want me to book another follow-up Friday?" after a read of today names a day to book, not a day the calendar
// showed. Anything that does not hold, or a time zone that cannot be read, fails closed (the caller says CANT_VERIFY). Pure but for
// the clock (ctx.now when a test sets it).
const CLOCK_TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/gi;
const WEEKDAY_NAME_RE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const RELATIVE_DAY_RE = /\b(today|tonight|tomorrow|yesterday)\b/gi;
const RELATIVE_DAY_OFFSET = { today: 0, tonight: 0, tomorrow: 1, yesterday: -1 };
const DAY_MS = 86_400_000;
const clockTimesIn = (text) =>
  [...String(text).matchAll(CLOCK_TIME_RE)].map((m) => `${Number(m[1])}:${m[2] || "00"} ${m[3].toUpperCase()}M`);
function calendarFactsHold(text, reads, payloads, ctx) {
  const seen = payloads.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\n");
  const known = new Set(clockTimesIn(seen));
  if (clockTimesIn(text).some((t) => !known.has(t))) return false;
  const statements = sentencesOf(text).filter((s) => !/\?\s*$/.test(s.trim())).join(" ");
  const weekdays = new Set((seen.match(WEEKDAY_NAME_RE) || []).map((w) => w.toLowerCase()));
  if ((statements.match(WEEKDAY_NAME_RE) || []).some((w) => !weekdays.has(w.toLowerCase()))) return false;
  const now = ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now();
  return (statements.match(RELATIVE_DAY_RE) || []).every((word) => {
    const offset = RELATIVE_DAY_OFFSET[word.toLowerCase()];
    return reads.some((read) => {
      try {
        return Date.parse(`${read.date}T00:00:00Z`) - Date.parse(`${localToday(read.timeZone, now)}T00:00:00Z`) === offset * DAY_MS;
      } catch (_err) {
        return false;
      }
    });
  });
}

// ── A calendar fact with no calendar read (Ruling 49) ────────────────────────────────────────────────────────────────────────────
//
// Only getCalendarTool can tell what is on the calendar, so on a turn that cited no "google calendar ..." read:
//   * a sentence that names the calendar or availability (CALENDAR_WORD_RE: calendar, schedule, meeting, appointment, free, busy,
//     available, availability, booked, wide open, clear, an open slot, and "open" said of a time: "Friday is open") together with a
//     day or a time (DAY_OR_TIME_RE: today, tonight, tomorrow, yesterday, a morning / afternoon / evening, a weekday, a date, a clock
//     time, all day, this / next week, the weekend) states a calendar fact nothing backs: "Your sweep is ready, and you're free all
//     day Friday." on a sweep turn, "Friday afternoon is clear, nothing on your calendar." after a client lookup;
//   * on a turn that cited nothing at all, any such word does ("Your week looks light — just a couple of meetings.").
// Either is the can't-verify line, or, when the user's message is about the calendar or availability and Google is not usable for
// this user (ctx.google.connection() says { code }), the Google line that says why; the same goes for the ungrounded screen's
// can't-verify ("am I free Friday afternoon?" -> "Yes."). A day with no such word is no calendar fact: "Call the Chens today." on a
// sweep turn passes, and so do a rates or a client answer that says "today" ("at 6.52 percent" is no clock time).
// Not facts, and so not screened:
//   * a question (it ends with "?" and opens with a question word) asks for a day or a slot rather than stating one, so only what it
//     says after its first clause (a comma, colon, semicolon or dash, or since / because / now that / given / an "as" with its
//     subject) is screened: "What time should I put it on your calendar?" passes, "Want me to book them Friday, since you're free all
//     afternoon?" does not;
//   * a calendar word whose own clause (split at , ; : a dash, but / and / so, since / because / given / now that) says before it what
//     Charli did not or cannot do ("I couldn't read your calendar just now.", "Okay, I won't put it on your calendar.", "I haven't
//     booked anything.", "No problem, I'll leave your calendar alone."), what she offers or is able to do ("I can schedule a follow-up
//     for Friday if you like.", "..., want me to book a meeting Friday?"), or a condition ("a good one to call today if you're free"):
//     "I couldn't read your calendar, but you're free Friday." and "I can book them Friday, since you're free then." still say the
//     rest, and "I can't see anything on your calendar today." is a reading, not an inability;
//   * "feel free", "free and clear", "loud and clear", "crystal clear", "clear of", "clear to close", a rate or a loan that is
//     "available".
const CALENDAR_WORD_RE = new RegExp(
  "(?<![\\w'\\u2019-])(?:calendars?|schedul(?:e|es|ed|ing)|meetings?|appointments?|busy|availability|booked|wide\\s+open|open\\s+slots?" +
    "|(?<!\\bfeel\\s+)free(?!\\s+(?:and\\s+clear|of)\\b)|(?<!\\b(?:(?:loud|free)\\s+and|crystal)\\s+)clear(?!\\s+(?:to\\s+close|of)\\b)" +
    "|(?<!\\b(?:rates?|loans?|options?|products?|programs?|terms?|pricing)\\s+)available(?!\\s+(?:rates?|loans?|options?|products?|programs?|terms?)\\b)" +
    "|(?:is|are|['\\u2019]s|['\\u2019]re|looks?|stays?|still|completely|totally|all)\\s+open)(?![\\w'\\u2019-])",
  "i"
);
const CALENDAR_WORD_ALL_RE = new RegExp(CALENDAR_WORD_RE.source, "gi");
const DAY_OR_TIME_RE = new RegExp(
  "\\b(?:today|tonight|tomorrow|yesterday|mornings?|afternoons?|evenings?|noon|midnight|all\\s+day|weekends?|(?:this|next)\\s+week" +
    "|(?:mon|tues|wednes|thurs|fri|satur|sun)days?" +
    "|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)" +
    "\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|the\\s+\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|\\d{4}-\\d{2}-\\d{2}" +
    "|\\d{1,2}(?::\\d{2})?\\s*[ap]m|\\d{1,2}:\\d{2}|o['\\u2019]clock" +
    "|(?:at|after|before|by|until|till|from|around)\\s+(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)" +
    "(?![\\d,%]|\\.\\d|\\s*(?:percent|basis|bps|points?)\\b))\\b",
  "i"
);
// where a question's first clause ends (not at its first character)
const FIRST_CLAUSE_END_RE =
  /[,;:—–]|--|\s-\s|\b(?:since|because|now\s+that|given|as(?=\s+(?:you|your|it|the|that|there|they|we|I)\b))\b/i;
const FACT_CLAUSE_BREAK_ALL_RE = /[,;:—–]|--|\s-\s|\b(?:but|and|so|since|because|given|now\s+that)\b/gi;
// what Charli did not or cannot do to the calendar
const SHE_DID_NOT_RE = new RegExp(
  "\\bI(?:\\s+(?:won['\\u2019]?t|will\\s+not|didn['\\u2019]?t|did\\s+not|haven['\\u2019]?t|have\\s+not|can['\\u2019]?t|cannot|can\\s+not" +
    "|couldn['\\u2019]?t|could\\s+not|wasn['\\u2019]?t\\s+able\\s+to|was\\s+unable\\s+to|am\\s+unable\\s+to|am\\s+not\\s+able\\s+to)" +
    "|['\\u2019]m\\s+(?:unable|not\\s+able)\\s+to)\\s+(?:just\\s+|even\\s+|yet\\s+)?" +
    "(?:read|reach|check|access|load|open|connect\\s+to|get\\s+(?:to|into)|look\\s+at|put|add(?:ed)?|book(?:ed)?|schedul(?:e|ed)" +
    "|plac(?:e|ed)|pencil(?:l?ed)?|block(?:ed)?|set\\s+up|ma(?:k|d)e|chang(?:e|ed))\\b" +
    "|\\bI(?:['\\u2019]ll|\\s+will)\\s+(?:just\\s+)?leave\\b",
  "i"
);
// what she offers or is able to do ("I can schedule ...", "want me to book ...", "should I put ...")
const SHE_OFFERS_RE = new RegExp(
  "\\b(?:(?:I|we)\\s+(?:can|could)|(?:I|we)['\\u2019](?:d\\s+be|m)\\s+(?:happy|glad)\\s+to|(?:do\\s+you\\s+want|want|would\\s+you\\s+like)\\s+me\\s+to" +
    "|(?:should|shall|can|could|may)\\s+(?:I|we))\\s+(?:also\\s+|just\\s+|go\\s+ahead\\s+and\\s+)?" +
    "(?:read|check|look\\s+at|look\\s+up|pull\\s+up|open|access|book|put|add|schedule|set\\s+up|pencil|block|move)\\b",
  "i"
);
// a condition ("if you're free", "whenever you're free")
const CONDITION_RE = /\b(?:if|whenever|unless|when)\b/i;
// sentences split at . ! ? (not at a decimal point), with "a.m." / "p.m." read as "am" / "pm" so they end no sentence
const factSentencesOf = (text) =>
  (String(text).replace(/\b([ap])\.\s?m\b\.?/gi, "$1m").match(/(?:[^.!?]|\.(?=\d))+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean);
// `cited`: some tool result this turn was cited (then a calendar word needs a day or a time beside it to be a fact). Pure.
function ungroundedCalendarFact(text, cited) {
  return factSentencesOf(text).some((sentence) => {
    const s = stripOpener(sentence).trim();
    let screened = s;
    if (/\?\s*$/.test(s) && QUESTION_START_RE.test(s)) {
      const end = FIRST_CLAUSE_END_RE.exec(s.slice(1));
      if (!end) return false;
      screened = s.slice(end.index + 1);
    }
    const said = [...screened.matchAll(CALENDAR_WORD_ALL_RE)].some((m) => {
      const before = screened.slice(0, m.index);
      const breaks = [...before.matchAll(FACT_CLAUSE_BREAK_ALL_RE)];
      // (its clause up to and with the word: "I can schedule", "I haven't booked")
      const clause = (breaks.length ? before.slice(breaks[breaks.length - 1].index + breaks[breaks.length - 1][0].length) : before) + m[0];
      return !SHE_DID_NOT_RE.test(clause) && !SHE_OFFERS_RE.test(clause) && !CONDITION_RE.test(clause);
    });
    return said && (!cited || DAY_OR_TIME_RE.test(s));
  });
}
// The code ctx.google's connection gives (null when it is usable or cannot be read, or there is no adapter: the route always
// builds one).
const googleCodeOf = (ctx) => {
  const google = ctx && ctx.google;
  if (!google || typeof google.connection !== "function") return null;
  try {
    const connection = google.connection();
    return connection && typeof connection.code === "string" ? connection.code : null;
  } catch (_err) {
    return null;
  }
};

// The line code speaks when a tool this turn came back with a `data.code` that has one (null otherwise): Google not connected,
// expired or unreachable (the calendar tools), no NMLS ID saved or no email on the client's record (draftEmailTool). Only the
// non-citing error results carry these codes. The first such result, in the order the tools ran, decides.
// Ruling 55: a calendar READ the user did not ask for does not decide the turn. When getCalendarTool came back with a Google code
// beside a tool that is no calendar tool, and the user's message is not about the calendar or availability (`aboutCalendar`), its
// result is handed back to the model like any other ("who should I call today?" with the sweep and a read in parallel, Google not
// connected: the call list is answered, and what the model says is screened as on any turn). A booking (createEventTool) the user
// asked for always hears why it cannot be made. `blocks[i]` is the tool call `outs[i]` answers.
const GOOGLE_LINES = new Map([
  ["not_connected", GOOGLE_NOT_CONNECTED], ["reconnect", GOOGLE_RECONNECT], ["unavailable", GOOGLE_UNAVAILABLE],
]);
const CALENDAR_TOOLS = new Set(["getCalendarTool", "createEventTool"]);
function codeAuthoredLine(outs, blocks, aboutCalendar) {
  const onlyCalendar = blocks.every((b) => CALENDAR_TOOLS.has(b.name));
  for (const [i, o] of outs.entries()) {
    if (isCitation(o.source) || !o.data || typeof o.data !== "object") continue;
    const { code } = o.data;
    if (GOOGLE_LINES.has(code)) {
      if (blocks[i].name === "getCalendarTool" && !onlyCalendar && !aboutCalendar) continue;
      return GOOGLE_LINES.get(code);
    }
    if (code === "nmls_missing") return NMLS_NEEDED;
    if (code === "no_email") return noEmailLine(cleanName(o.data.client) || "that client");
  }
  return null;
}

// What is said once an email is set up: the kind of email and the client, from the tool's own data. The address and the text
// are on the screen (`compose`), and nothing here says or implies that anything was sent.
const draftReply = (out) => {
  const purpose = out.data && Object.hasOwn(PURPOSE_WORDS, out.data.purpose) ? PURPOSE_WORDS[out.data.purpose] : "client";
  return `Here's a ${purpose} email for ${cleanName(out.data && out.data.client) || "that client"}, ready on your screen. ` +
    "Open it in your email to review it and send it yourself — I don't send anything.";
};

// Ruling 52: Charli never sends email, so when the user asks her to send it ("send it", "ok send it", "can you send it for me?",
// "email it to them", "send the draft") or asks whether she did ("did you send it?", "was it sent?", "has it gone out?") and the
// turn sets up no email, code says so (NO_SEND): the model's own words for it ("I can't send email — open it in Gmail") would be
// held to the action backstop and come out as the nothing-changed line, whose "I'll confirm it with you first" implies she could
// send it after a yes. Only the email in front of them is meant: "send the Chens a check-in" asks for a draft, and drafts. The
// email is named ("the email", "the draft", "the note", "the check-in"), or emailed ("email it", "did you email them?"), or it is
// a bare it / that / this while the email is in view (`emailInView`: the assistant message right before is about an email or a
// draft, and is neither an offer to act nor a read-back). So "send it" after "Want me to write them a check-in?" or after a
// cancelled read-back still says yes to that, as before.
const PRONOUN_MESSAGE = "(?:it|that|this|they)";
const NAMED_MESSAGE = "the\\s+(?:email|e-mail|draft|note|check[\\s-]?in)";
const sendRe = (object) => new RegExp(
  "\\bsend\\s+" + object + "(?![\\w'\\u2019-])" +
    "|\\bdid\\s+you\\s+send\\s+" + object + "(?![\\w'\\u2019-])" +
    "|\\b(?:was|were|is|has|have)\\s+" + object + "\\s+(?:(?:been|already|just)\\s+)*sent\\b" +
    "|\\b(?:has|have|did)\\s+" + object + "\\s+(?:already\\s+)?(?:gone|go)\\s+out\\b",
  "i"
);
const SEND_NAMED_RE = sendRe(NAMED_MESSAGE);
const SEND_PRONOUN_RE = sendRe(PRONOUN_MESSAGE);
const EMAILED_RE = /\be-?mail\s+(?:it|that|this)(?![\w'’-])|\bdid\s+you\s+e-?mail\b/i;
const EMAIL_WORD_RE = /\b(?:e-?mails?|drafts?)\b/i;
// `before`: the message right before the user's latest one
const asksToSend = (text, before) => {
  const prev = messageText(before);
  const emailInView = !!before && before.role === "assistant" && EMAIL_WORD_RE.test(prev) && !offersAction(before) &&
    !prev.includes(READ_BACK_PREFIX);
  return SEND_NAMED_RE.test(text) || EMAILED_RE.test(text) || (emailInView && SEND_PRONOUN_RE.test(text));
};

// runTurn({ messages, ctx, client, deadlineMs }) -> { reply, sources, sideEffect?, details?, compose?, error?, usage }
//   messages:   Messages API history ending with the user's latest message (not mutated)
//   ctx:        { user, rates, db, google? }, handed to the tools (google = the per-user Google adapter; without one the calendar
//               tools say Google is not connected)
//   deadlineMs: how long the whole turn may take (default 25 s). When it runs out, in a model call, in the tool calls of a response
//               (Google ones go out to the network) or before the next model call, the turn is the code-authored TOOK_TOO_LONG
//               with error:true (like the route's ERROR_TURN, but no throw): no sources, no change, and `usage` counts the model
//               calls that did finish. `minCallMs` (default 1.5 s) is how little time left is still worth a model call; it is a
//               test seam.
//   sources:    citing `source` strings of the tool results used (error labels are not cited)
//   details:    with a sideEffect, the rows the pending card shows under the read-back (changeDetails)
//   compose:    with a successful draftEmailTool, the email it set up ({ to, subject, body, links }) for the screen to open in the
//               user's own mail app; it is never sent to the model, and nothing is sent by anyone
async function runTurn({ messages, ctx, client, deadlineMs = DEFAULT_TURN_DEADLINE_MS, minCallMs = MIN_CALL_MS } = {}) {
  if (!Array.isArray(messages)) throw new TypeError("runTurn: messages must be an array");
  if (!client || !client.messages || typeof client.messages.create !== "function") {
    throw new TypeError("runTurn: client must provide messages.create()");
  }
  const deadline = Date.now() + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : DEFAULT_TURN_DEADLINE_MS);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const finish = (reply, cited, sideEffect, details, compose) => {
    const out = { reply, sources: cited || [], usage };
    if (sideEffect) out.sideEffect = sideEffect;
    if (sideEffect && details) out.details = details;
    if (compose) out.compose = compose;
    return out;
  };
  const tookTooLong = () => ({ ...finish(TOOK_TOO_LONG), error: true });
  // The can't-verify line, or (Ruling 49) the Google line when the user's message is about the calendar or availability and
  // Google is not usable for them: then the reason nothing could be checked is that one.
  const cantVerifyCalendar = () =>
    (CALENDAR_WORD_RE.test(latestUserText(messages)) && GOOGLE_LINES.get(googleCodeOf(ctx))) || CANT_VERIFY;

  // Nothing to answer: no API call.
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !messageText(last).trim()) return finish(DIDNT_CATCH);

  const convo = messages.slice();
  const userText = latestUserText(convo);
  // R5-3 applies to this turn if the user asked for an action now, or is answering a question about one (a yes to an offer to act
  // included).
  const actionTurn = isActionRequest(userText) || answersActionQuestion(messages);
  // the class of the user's message when the assistant message right before it offered to act (null otherwise, Ruling 24)
  const afterOffer = offerReplyOf(messages[messages.length - 2], last);
  const sources = [];   // citing sources of the read tools run this turn
  const payloads = [];  // the tool_result contents of the book/market tools this turn: the figures a reply may use (never explainTerm's)
  const calendarReads = [];   // { date, timeZone } of each calendar day read this turn
  const calendarEvents = [];  // { title, date, timeZone } of each event those reads returned (the title as the model saw it)
  let glossaryMiss = false;   // an explainTerm call this turn got no definition back
  const glossaryDefs = [];    // the definitions explainTerm returned this turn, once per term, in the order asked
  // The user's stored stage (null = not set; anything that is not a stage id reads as not set): what a reply may truthfully claim.
  const storedStage = (ctx && ctx.user && stageById(ctx.user.career_stage) && stageById(ctx.user.career_stage).id) || null;
  // CHARLI_SYSTEM plus the coaching block for this user's career stage: it tailors how she coaches. The screening below runs
  // on the model's text and this turn's tool results, and its stage check compares the stage a reply claims (stageClaims, and a
  // set-claim that names a stage) with the stored stage above: only a claim equal to it is true
  const system = buildCharliSystem(ctx && ctx.user);

  // The answer to the greeting's career question (answersCareerQuestion). Tier 1: a plain duration is packaged by code, with
  // no model call (a zero-token turn, metered like the greeting). Tier 2 (`careerAnswerTurn`) screens the model's reply below.
  const careerAnswer = answersCareerQuestion(messages, storedStage);
  if (careerAnswer) {
    const years = plainYears(userText);
    if (years !== null) {
      const out = tools.setCareerStageTool({ years }, ctx);
      if (out && out.sideEffect) return finish(readBack(out), [], out.sideEffect, changeDetails(out));
    }
  }
  const careerAnswerTurn = careerAnswer && givesDuration(userText);

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const lastCall = call === MAX_MODEL_CALLS - 1;
    // No temperature / tool_choice / thinking: CLAUDE_MODEL is configurable and newer models
    // reject forced tool use and non-default sampling.
    const remaining = deadline - Date.now();
    if (remaining < minCallMs) return tookTooLong();
    let response;
    try {
      response = await createWithin(client, {
        model: modelName(), max_tokens: MAX_TOKENS, system, tools: TOOL_SCHEMA,
        messages: convo.slice(),
      }, remaining);
    } catch (err) {
      if (err instanceof TurnDeadline) return tookTooLong();
      throw err;
    }
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
      const said = content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ")
        .trim();
      // grounded turns only: process narration ahead of the answer is not said (stripProcessOpeners), and every screen below
      // runs on what is left
      const text = sources.length > 0 ? stripProcessOpeners(said).trim() : said;
      if (isGuidelineQuestion(userText)) return finish(GUIDELINE_HANDOFF);
      // Ruling 52: asked to send the email, or whether it was sent, and no email was set up this turn: Charli doesn't send
      if (asksToSend(userText, messages[messages.length - 2])) return finish(NO_SEND);
      // R5-3, the action backstop: an action was asked for (now, or in the question this message
      // answers), and no change is being handed up for confirmation (a turn that ends in text never
      // carries a sideEffect), so whatever the model says, nothing was done. Only ONE question may
      // reach the user (Ruling 30: one sentence past one opener, as the prompt asks); anything else is replaced, a statement and
      // a question beside it included ("What else? The follow-up is on your calendar Friday. Want a reminder?").
      if (actionTurn && !isOneQuestion(text)) return finish(NOTHING_CHANGED);
      // Rulings 19 and 23: and on that turn no "now on your calendar" wording reaches the user at all (CALENDAR_NOW_FORM_RE anywhere
      // in the reply, question or statement, with no placing-verb exemption and no negative lookbehind): "Should I add a reminder for
      // the follow-up now on your calendar?" after "yes" to a booking offer reads as the booking having been made, and so does
      // "... since nothing else is on your calendar now but the follow-up?". A question without the form still passes ("Should I
      // put it on your calendar?"); the accepted cost is that "... since nothing else is on your calendar now?" is held there too.
      if (actionTurn && CALENDAR_NOW_FORM_RE.test(text)) return finish(NOTHING_CHANGED);
      // Ruling 24: a reply to an offer to act that is no yes (a decline, or anything else) is a plain turn, answered under the
      // claim guard: no "now on your calendar" form, no "it's on your calendar" / "it's scheduled", no "you're set" / "locked in" /
      // "went out", no statement that something was drafted or sent, and none that something is on the calendar, booked or scheduled
      // unless the clause names an event this turn's calendar read returned, for the day it was read (offeredActClaimed, Rulings 31
      // and 33). The guard holds on every action turn too, a yes to an offer or a request in the user's own words (Ruling 25), and in
      // a question it reads the clause a question presupposes ("Should I add a reminder, since it's on your calendar Friday?",
      // "Should I let the Chens know the follow-up is scheduled for Friday?": Ruling 30); on an action turn it screens every piece of
      // the one question in full ("What else — the invite went out — want a reminder?": Ruling 35).
      const calendarCited = sources.some((src) => src.startsWith("google calendar"));
      const reads = calendarCited
        ? { events: calendarEvents, now: ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now() }
        : null;
      if ((afterOffer || actionTurn) && offeredActClaimed(text, reads, actionTurn)) {
        return finish(NOTHING_CHANGED);
      }
      // Tier 2 of the career answer: a duration code could not read, no read tool cited, and no setCareerStage change handed
      // up (a turn that ends in text carries none): only a question may reach the user, anything else is the re-ask.
      if (careerAnswerTurn && sources.length === 0 && !isQuestionShaped(text)) return finish(STAGE_REASK);
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
      // (Ruling 50: on a plain turn that read the calendar, a "now" form narrates the read and only placing claims count)
      const plainRead = calendarCited && !actionTurn && !afterOffer;
      if (claimsCompletion(text, sources.length > 0, storedStage, sources.some((src) => src.startsWith("sweep engine")), plainRead)) {
        return finish(NOTHING_CHANGED);
      }
      // Ruling 49: a calendar or availability fact on a turn that read no calendar is can't-verify, or, when the user asked about
      // the calendar and Google is not usable, the Google line that says why (ungroundedCalendarFact)
      if (!calendarCited && ungroundedCalendarFact(text, sources.length > 0)) return finish(cantVerifyCalendar());
      // No cited tool result behind the text: it may only be conversation (screenUngroundedText
      // is stricter than the figure check: it refuses any digit).
      if (sources.length === 0) {
        // explainTerm came back empty-handed ("(not found)", invalid, failed): nothing may define the term instead
        // of it, whatever words the definition is made of. Only a question back to the user is allowed through.
        if (glossaryMiss && !isLoneClarifyingQuestion(text, userText)) return finish(CANT_VERIFY);
        const screened = screenUngroundedText(userText, text);
        return finish(screened === CANT_VERIFY ? cantVerifyCalendar() : screened);
      }
      // Grounded: every figure the model speaks must be one the tools returned this turn.
      if (!text || ungroundedNumbers(text, payloads).length > 0) return finish(CANT_VERIFY);
      // A calendar read also grounds the clock times, the weekday names and the relative days a reply names (Ruling 13).
      if (calendarReads.length > 0 && !calendarFactsHold(text, calendarReads, payloads, ctx)) return finish(CANT_VERIFY);
      return finish(text, sources);
    }

    // Unknown tool name: execute nothing, not even the valid calls alongside it.
    if (toolUses.some((b) => typeof b.name !== "string" || typeof tools[b.name] !== "function")) {
      return finish(CANT_VERIFY);
    }

    convo.push({ role: "assistant", content });
    // On the last allowed call no narration can follow, so only a change to confirm (or an email to set up) matters.
    const runBlocks = lastCall ? toolUses.filter((b) => LAST_CALL_TOOLS.has(b.name)) : toolUses;
    // The tools get what is left of the turn, like the model calls do: a Google call that hangs cannot hold the mic past the deadline.
    let outs;
    try {
      outs = await withinTurn(Promise.all(runBlocks.map((block) => runTool(block, ctx))), deadline - Date.now());
    } catch (err) {
      if (err instanceof TurnDeadline) return tookTooLong();
      throw err;
    }
    runBlocks.forEach((b, i) => {
      if (b.name !== "explainTerm") return;
      const { source, data } = outs[i];
      if (!isCitation(source)) glossaryMiss = true;
      else if (data && typeof data.definition === "string" && !glossaryDefs.some((d) => d.term === data.term)) {
        glossaryDefs.push({ term: data.term, definition: data.definition });
      }
    });

    // Google not connected / expired / unreachable, no NMLS ID, no email on the client's record: code says so, before anything
    // below and before the model is handed the results (it would only put it into its own words). It wins over a change another
    // tool packaged in the same response: the user asked for both, so nothing is handed up and they ask again. (A calendar read the
    // user did not ask for, beside other tools, is the exception: its result goes back to the model like any other, Ruling 55.)
    const line = codeAuthoredLine(outs, runBlocks, CALENDAR_WORD_RE.test(userText));
    if (line) return finish(line);

    // The tools only package a change; here it is handed up for confirmation, not acted on. An email set up by draftEmailTool
    // counts as a change for the one-at-a-time rule (it changes what is on the user's screen), though it has nothing to confirm:
    // it ends the turn at once with a code-authored reply and its compose links, and the model never narrates it.
    const changes = outs.filter((o) => o.sideEffect || o.compose);
    if (changes.length > 1) return finish(ONE_AT_A_TIME);
    if (changes.length === 1) {
      const change = changes[0];
      const cited = isCitation(change.source) ? [change.source] : [];
      if (change.compose) {
        // An email is set up only for a user who asked for one (or said yes to the offer of one): on any other turn the model
        // drafted unasked (an instruction planted in a calendar title or a note can do that), so nothing is handed up.
        if (!actionTurn) return finish(NOTHING_CHANGED);
        return finish(draftReply(change), cited, undefined, undefined, change.compose);
      }
      // The event title is the model's own words and is spoken and written as it is: a figure in it must be one the tools
      // returned this turn (this round's results included) or one the user just said ("Chens refi — 5.99%, saves $400" is neither).
      if (change.sideEffect.type === "createEvent") {
        // (not the booking's own result: its preview repeats the title, which would ground itself)
        const reads = outs.filter((o, i) => !o.sideEffect && !o.compose && runBlocks[i].name !== "explainTerm");
        const seen = [...payloads, ...reads.map((o) => o.toolResult.content), userText];
        if (ungroundedNumbers(String((change.sideEffect.event || {}).title), seen).length > 0) return finish(CANT_VERIFY);
      }
      return finish(readBack(change), cited, change.sideEffect, changeDetails(change));
    }
    if (lastCall) break;

    for (const [i, o] of outs.entries()) {
      if (isCitation(o.source) && !sources.includes(o.source)) sources.push(o.source);
      // a calendar read: its date and the calendar's own time zone, which the model is not shown (forModel), are what a "today" or a
      // "tomorrow" in the reply is checked against (calendarFactsHold)
      if (isCitation(o.source) && o.source.startsWith("google calendar") && o.data && typeof o.data === "object") {
        calendarReads.push({ date: o.data.date, timeZone: o.data.timeZone });
        // and its events, each title as the model saw it and the day it was read for: what a reply under the claim guard may say is
        // on the calendar, and for which day (Ruling 31)
        if (Array.isArray(o.data.events)) {
          for (const e of o.data.events) {
            const title = oneLine(e && e.title);
            if (title) calendarEvents.push({ title, date: o.data.date, timeZone: o.data.timeZone });
          }
        }
      }
      // a definition's own numbers (80 percent, 36 months) are product facts about the glossary, not figures the model may quote
      if (runBlocks[i].name !== "explainTerm") payloads.push(o.toolResult.content);
    }
    convo.push({ role: "user", content: outs.map((o) => o.toolResult) });
  }

  // The model kept calling tools and never produced an answer within the cap.
  return finish(CANT_VERIFY);
}

module.exports = {
  runTurn, DEFAULT_TURN_DEADLINE_MS, MIN_CALL_MS, screenUngroundedText, ungroundedNumbers, isLoneClarifyingQuestion, stripOpener, claimsCompletion,
  isYesNoQuestion, isActionRequest, isQuestionShaped, isCitation, claimsStage, stageClaims, forModel,
};
