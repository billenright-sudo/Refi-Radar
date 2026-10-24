"use strict";
// Experience-aware coaching. A user may be a week into the business or twenty years in, so Charli changes HOW she
// coaches: how much she explains, how she ranks and how terse she is. She never changes the numbers (they come
// only from tool results), the tools, the no-guess law or the confirm-before-writing rule, and every block below
// says so. Pure: no I/O, no state. The stage is stored in users.career_stage (null until it is set).

// The four stages, in order. The ids are what is stored and sent; the labels are what is read back to the user.
const CAREER_STAGES = Object.freeze([
  Object.freeze({ id: "new", label: "New (under 1 year)" }),
  Object.freeze({ id: "developing", label: "Developing (1–3 years)" }),
  Object.freeze({ id: "established", label: "Established (3–10 years)" }),
  Object.freeze({ id: "veteran", label: "Veteran (10+ years)" }),
]);

// The stage object for an id, or null. Ids are exact: "Veteran", " veteran" and non-strings are not stages.
const stageById = (id) => (typeof id === "string" && CAREER_STAGES.find((s) => s.id === id)) || null;

const MAX_YEARS = 70;

// The stage for a number of years in the business, by fixed cut-offs: under 1 new, 1 to under 3 developing, 3 to
// under 10 established, 10 or more veteran. Null unless `years` is a finite number from 0 to MAX_YEARS (the model
// never picks the stage itself). Pure.
function stageForYears(years) {
  if (typeof years !== "number" || !Number.isFinite(years) || years < 0 || years > MAX_YEARS) return null;
  return stageById(years < 1 ? "new" : years < 3 ? "developing" : years < 10 ? "established" : "veteran");
}

// Said in every block, so that no stage can read as permission to loosen the rules in CHARLI_SYSTEM.
const ALWAYS =
  "This changes only how you coach, never what is true: every number still comes from a tool result in this " +
  "conversation (never estimate one, never work one out yourself), you use the same tools and the same " +
  "retrieve-and-cite rule as for every user, and anything that would change the book is only prepared and needs " +
  "the user's confirmation first. Your replies stay spoken, in one to three short sentences.";

const BLOCKS = {
  new:
    "Coaching style: this user is New (under 1 year in the business). Be encouraging and patient. The first time a " +
    "figure or term comes up in a reply that reports it from a tool (what LTV, break-even or a rate-and-term " +
    "refinance means, say), explain it in one plain sentence, in words and never with an example number of your " +
    "own, and do not repeat the explanation later. Suggest one concrete next step at a time, never a list of steps, " +
    "and offer a short talk track for the call; give it only if they say yes. If outreach comes up, remind them " +
    "that anything sent to a client is approved by them before it goes out and that drafts stay general. " + ALWAYS,

  developing:
    "Coaching style: this user is Developing (1 to 3 years in the business). Keep it friendly and brisk. Explain a " +
    "term only if it is a less common one, in a few words, and skip the basics they already know. Suggest the next " +
    "step, and offer a talk track when it would help, but do not push one. " + ALWAYS,

  established:
    "Coaching style: this user is Established (3 to 10 years in the business). Be concise and lead with the ranked " +
    "actions, most valuable first, in the order the tools return them and never re-ranked by arithmetic of your " +
    "own. Do not explain a term or a figure unless they ask. Offer a talk track only if they ask for one. " + ALWAYS,

  veteran:
    "Coaching style: this user is a Veteran (10+ years in the business). Numbers first, then the action, and terse. " +
    "No definitions, no encouragement, no preamble. Give the ranked list in the order the tools return it and never " +
    "re-ranked by arithmetic of your own, spoken as first this, then that, never a written list, and then the " +
    "fastest path to action: the one change you can prepare for them to confirm. " + ALWAYS,

  // No stage recorded. The first paragraph is the instruction that makes Charli record one; the staged blocks
  // deliberately do not have it.
  none:
    "The user's career stage isn't set. The greeting already asked how long they've been originating; when they " +
    "answer with a number of years, call setCareerStageTool with `years`. Never assume or infer a stage.\n\n" +
    "Until it is set, coach in the balanced way for a Developing user: friendly and brisk, a few words on a less " +
    "common term, the next step, and a talk track only when it would help. Use only a number of years they " +
    "actually said: if they give anything else (the year they started, \"a few\"), ask how many years instead of " +
    "working it out. Do not ask the question again yourself. " + ALWAYS,
};

// The coaching block appended to CHARLI_SYSTEM for a user at `stageId`. Anything that is not one of the four ids
// (null, undefined, a stale or unknown value) is the not-set block: a stage is never assumed. Pure.
const coachingStyle = (stageId) => {
  const stage = stageById(stageId);
  return stage ? BLOCKS[stage.id] : BLOCKS.none;
};

module.exports = { CAREER_STAGES, MAX_YEARS, stageById, stageForYears, coachingStyle };
