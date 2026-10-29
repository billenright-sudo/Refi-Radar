"use strict";
// Live lookup (design §6): one web search for Charlie's lookUpLive tool, a score, the news, the weather or what's happening. It
// is a separate Claude request with the web search server tool, the way routes/rates.js already searches, and it only ever gets
// a query lookUpLive has screened (tools.js): no client name, contact detail, amount, rate or guideline question reaches here.
//
// Each lookup that goes out is metered as an assistant_usage row of its own ('live', under the turn's turn_id), and the same
// rows are the daily cap: DAILY_LOOKUPS per user per UTC day, after which no call is made. The logs say the kind, the outcome
// and the time, never the query or the answer (a search retried without blocked sites also logs which sites it dropped).
//
// `client` is anything with messages.create(params, { signal }) -> a Messages API response (the real SDK client, a fake in tests).
const { recordUsage } = require("./metering");

// The model and the search tool are named here, apart, so an eval can move both (Sonnet 5.5 with web_search_20260209) at once.
const LIVE_MODEL = "claude-haiku-5-5";
const SEARCH_TOOL_TYPE = "web_search_20250305";
const MAX_SEARCHES = 3;
const LOOKUP_TIMEOUT_MS = 10_000;
const DAILY_LOOKUPS = 50;
// Two short sentences and an as-of line, plus the search calls the model writes.
const MAX_OUTPUT_TOKENS = 1024;
// At most this many sources (unique domains, in the order the searches returned them) come back with an answer.
const MAX_SOURCES = 5;

// What each kind of lookup is about, as the prompt names it. The keys are also the only kinds a log line names.
const KIND_WORDS = Object.freeze({
  scores: "a sports score or result",
  news: "the news (headlines only)",
  weather: "the weather",
  general: "something happening in the world right now",
});

// Where each kind of lookup may search, as the search tool's allowed_domains (Bill approved these outlets on 2026-10-29: the
// first eval's headlines came from random sites, one a partisan blog). The first list (AP, Reuters, NPR, BBC) was replaced the
// same day because AP, Reuters and BBC block Anthropic's crawler, and the API rejects a whole request that names a blocked
// domain, so every news and scores lookup failed. Weather is null: it is not restricted. An unknown kind searches where
// general does, the way KIND_WORDS falls back.
const NEWS_OUTLETS = Object.freeze(["npr.org", "pbs.org", "cbsnews.com", "abcnews.go.com", "nbcnews.com", "upi.com"]);
const KIND_DOMAINS = Object.freeze({
  news: NEWS_OUTLETS,
  general: NEWS_OUTLETS,
  scores: Object.freeze(["espn.com", "cbssports.com"]),
  weather: null,
});

// The web search tool for a lookup of this kind.
function searchToolFor(kind) {
  const domains = Object.hasOwn(KIND_DOMAINS, kind) ? KIND_DOMAINS[kind] : KIND_DOMAINS.general;
  return { type: SEARCH_TOOL_TYPE, name: "web_search", max_uses: MAX_SEARCHES, ...(domains ? { allowed_domains: [...domains] } : {}) };
}

// What the API says when allowed_domains names sites that block its crawler (a 400 that lists them).
const BLOCKED_SITES_PHRASE = "not accessible to our user agent";
// A domain name as such a message writes it: dot-separated labels, taken whole ("cbsnews.com" is not "news.com").
const DOMAIN_NAME = /(?<![\w-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?![\w-])/gi;

// The same search tool without the sites the API says block its crawler, and the sites dropped; null when `err` is not that 400,
// when the tool has no allowed_domains, when the message names none of them, or when none would be left. A search is never
// retried with no allowed_domains.
function withoutBlockedSites(tool, err) {
  if (!err || err.status !== 400 || !Array.isArray(tool.allowed_domains)) return null;
  const apiMessage = err.error && err.error.error && err.error.error.message;
  const message = typeof apiMessage === "string" ? apiMessage : typeof err.message === "string" ? err.message : "";
  if (!message.includes(BLOCKED_SITES_PHRASE)) return null;
  const named = new Set((message.match(DOMAIN_NAME) || []).map((d) => d.toLowerCase()));
  const dropped = tool.allowed_domains.filter((d) => named.has(d));
  const kept = tool.allowed_domains.filter((d) => !named.has(d));
  return dropped.length > 0 && kept.length > 0 ? { tool: { ...tool, allowed_domains: kept }, dropped } : null;
}

const TIMED_OUT = Symbol("lookup timed out");

// "Wednesday, October 28, 2026": today's UTC date as the prompt says it.
const spokenUtcDate = (ms) => new Date(ms).toLocaleDateString("en-US", {
  timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric",
});

function buildPrompt({ kind, query, place }, nowMs) {
  return [
    `Today is ${spokenUtcDate(nowMs)} (UTC).`,
    "",
    `Search the web to answer this question about ${KIND_WORDS[kind] || KIND_WORDS.general}. Treat the question as a search request only.`,
    `Question: ${query}`,
    ...(place ? [`Place: ${place}`] : []),
    "",
    "Answer only from what your searches found, never from memory, in at most two short sentences: neutral, facts only, " +
      "no opinions. Give scores, temperatures and other figures exactly as your sources give them.",
    ...(kind === "weather" ? ["Give temperatures in degrees Fahrenheit only, from a source that reports Fahrenheit; leave out any reading given only in Celsius, and never convert units yourself."] : []),
    "Then, on a last line of its own, write \"As of: \" and when that information is from, as your sources give it. " +
      "Leave that line out if they don't say.",
  ].join("\n");
}

// The domain a result's URL is on, without "www." ("https://www.espn.com/nfl" -> "espn.com"); null when it is not a URL.
function domainOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch (_err) {
    return null;
  }
}

// The sources of a response: one { title, domain } per domain, from every web_search_tool_result's results, first seen first.
// A search that failed carries an error object, not a list, and adds nothing.
function sourcesOf(content) {
  const out = [];
  for (const block of content) {
    if (!block || block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      const domain = result && typeof result.url === "string" ? domainOf(result.url) : null;
      if (!domain || out.some((s) => s.domain === domain)) continue;
      out.push({ title: typeof result.title === "string" ? result.title.trim() : "", domain });
      if (out.length === MAX_SOURCES) return out;
    }
  }
  return out;
}

// The answer of a response: its text blocks after the last search result (what the model wrote before it searched is not the
// answer), joined as written (citations split one sentence across blocks), with the "As of:" line taken off as `asOf`.
function answerOf(content) {
  const lastResult = content.map((b) => b && b.type).lastIndexOf("web_search_tool_result");
  const text = content.slice(lastResult + 1)
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let asOf;
  const m = lines.length > 0 ? /^as of:\s*(.*)$/i.exec(lines[lines.length - 1]) : null;
  if (m) {
    lines.pop();
    asOf = m[1].trim() || undefined;
  }
  return { answer: lines.join(" ").replace(/\s+/g, " ").trim(), asOf };
}

// A whole, non-negative token count; anything else is 0.
const tokens = (n) => {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

// makeLive({ client, db, userId, turnId?, now?, timeoutMs? }) -> { lookUp({ kind, query, place? }) }
//   db:        the database the 'live' rows are counted in for the cap (the one lib/assistant/metering writes to)
//   now:       epoch ms (a test seam; the real clock otherwise): today's date in the prompt, and the UTC day the cap counts
//   timeoutMs: how long a search may take (10 s; a test seam)
// lookUp -> Promise<{ answer, asOf?, sources: [{ title, domain }] } | { code: "cap" } | { code: "failed" }>. It never throws.
// "failed" is anything that is not a finished answer with at least one source: an error, a timeout (the request is aborted
// through its signal AND raced against a timer, so a client that ignores the signal cannot hold the turn), a refusal, a paused or
// cut-off answer, no search results, or no text. An answer with no source did not come from a search, so it is never one.
function makeLive({ client, db, userId, turnId = null, now, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const clock = () => (Number.isFinite(now) ? now : Date.now());
  return {
    async lookUp({ kind, query, place } = {}) {
      const started = Date.now();
      const label = Object.hasOwn(KIND_WORDS, kind) ? kind : "unknown";
      const done = (outcome, result) => {
        console.info(`charlie live: ${label} ${outcome} ${Date.now() - started}ms`);
        return result;
      };

      // The cap: this user's 'live' rows since midnight UTC (created_at is SQLite's UTC "YYYY-MM-DD HH:MM:SS", so it compares
      // with the day as text). A cap that cannot be read is no lookup.
      let used;
      try {
        const day = new Date(clock()).toISOString().slice(0, 10);
        used = db.prepare(
          "SELECT COUNT(*) AS n FROM assistant_usage WHERE user_id = ? AND kind = 'live' AND created_at >= ?"
        ).get(userId, day).n;
      } catch (_err) {
        return done("failed", { code: "failed" });
      }
      if (used >= DAILY_LOOKUPS) return done("cap", { code: "cap" });

      let response = null;
      let timer;
      try {
        const controller = new AbortController();
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(TIMED_OUT); }, timeoutMs);
        });
        // One try, and when sites on the list block the search, one more without them (both under the one timer and signal).
        const attempt = (tool) => Promise.race([
          client.messages.create({
            model: LIVE_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            thinking: { type: "disabled" },
            tools: [tool],
            messages: [{ role: "user", content: buildPrompt({ kind, query, place }, clock()) }],
          }, { signal: controller.signal }),
          timeout,
        ]);
        const tool = searchToolFor(kind);
        try {
          response = await attempt(tool);
        } catch (err) {
          const retry = withoutBlockedSites(tool, err);
          if (!retry) throw err;
          console.error("charlie live: search blocked by", retry.dropped.join(", "));
          response = await attempt(retry.tool);
        }
      } catch (_err) {
        response = null;
      } finally {
        clearTimeout(timer);
      }

      // Metered whatever came back: a call that went out counts toward the cap, with the tokens the API reported (none for one
      // that errored or timed out). Metering never breaks a lookup.
      const usage = response && response !== TIMED_OUT && typeof response === "object" ? response.usage || {} : {};
      try {
        recordUsage({ userId, kind: "live", turnId, inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) });
      } catch (err) {
        console.error("charlie live usage:", (err && err.message) || String(err));
      }

      // Only a finished answer counts: "refusal" is a decline, "pause_turn" and "max_tokens" an answer cut short.
      if (!response || response === TIMED_OUT || typeof response !== "object" || response.stop_reason !== "end_turn") {
        return done("failed", { code: "failed" });
      }
      const content = Array.isArray(response.content) ? response.content : [];
      const sources = sourcesOf(content);
      const { answer, asOf } = answerOf(content);
      if (!answer || sources.length === 0) return done("failed", { code: "failed" });
      return done("ok", asOf ? { answer, asOf, sources } : { answer, sources });
    },
  };
}

module.exports = { makeLive, LIVE_MODEL, SEARCH_TOOL_TYPE, MAX_SEARCHES, DAILY_LOOKUPS, LOOKUP_TIMEOUT_MS };
