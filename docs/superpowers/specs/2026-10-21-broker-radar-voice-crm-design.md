# Broker Radar — Voice-First AI CRM ("Charli") — Design

_Status: draft for approval · Owner: Bill Enright · Date: 2026-10-21_

## 1. Intent & why

Turn Broker Radar from a dashboard you look at into a **voice-first AI CRM you talk to**.
You open the app and a real spoken voice — **Charli**, in her own warm, professional
ElevenLabs voice — greets you by name and offers to drive your morning:

> "Good morning, Bill. How are you this morning? Where would you like to start — a market
> update, a sweep of your book for the best opportunities, some marketing ideas, or is there
> something you need?"

From there you run the entire book **hands-free, by talking**: market updates with real
rates, a live sweep that names your best opportunities, pulling up and updating clients,
logging contacts, and staying on top of relationships. Charli also lives in your day — she
reads your Google calendar, books the check-ins she surfaces, and drafts refi outreach in
Gmail that **you approve before it ever sends**.

The point is the feeling of a capable co-pilot ("Jarvis") that is always a step ahead — but
one that **never guesses**. Every number comes from the engine; every fact comes from a
source she can cite; when she can't verify something, she says so instead of making it up.

**Why now:** the deterministic opportunity engine (Sweeps) shipped 2026-10-21. The CRM bones
already exist (clients, LOs, portfolios, opportunities, notifications, import). Adding a
grounded voice layer is what turns a good tool into a product a broker runs their day on, and
it is the concrete realization of the broker/LO CRM from the UWM pitch.

## 2. Goals

- A broker opens Broker Radar and **runs their morning by talking to Charli, hands-free.**
- **v1 proves the "wow"** end to end: greet → market update → sweep that names opportunities
  → pull up / add a client → log a contact → read today's calendar + book a follow-up →
  draft a Gmail outreach for approval.
- **Every answer is grounded and citeable.** Charli's replies trace to a real source (a
  client record, a live rate, the sweep engine, a calendar event, an email). Nothing stated
  as fact is invented. _(Enforced in code in v1 for figures, completion claims and
  career-stage claims — the orchestrator's screens. A non-numeric invention on a turn where a
  tool WAS called, e.g. "the Chens are VA eligible", is not caught by code in v1; the source
  chip and the guideline hand-off are the mitigations. Flagged in the final review 2026-10-25.)_
- The experience feels **natural and low-latency** — real turn-taking, Charli's real voice,
  not a robotic toy.

## 3. Non-goals (explicitly deferred past v1)

- **Marketing-ideas generation** (freeform brainstorm) — phase 2.
- **Reading / summarizing inbound email and auto-logging threads** to a client — phase 2.
- **"Hey Charli" wake word** / summon-while-away — phase 2. v1 uses the live-session model.
- **Outlook / Microsoft 365** email + calendar — later. v1 is Google only (built so a second
  provider can slot in behind the same interface).
- **Self-serve multi-broker onboarding at scale** — later. v1 connects one account (Bill /
  the demo broker).
- **The Loan Decision & Guideline Expert corpus** (UWM overlays, agency rules, AUS
  interpretation) — later, as its own module (see §9).

## 4. Anti-goals (these make it a failure even if it "works")

1. **Charli guesses.** Any fabricated number, fact, or guideline stated as truth — or any
   confident answer she couldn't verify — is a failure, not a bug. "I can't verify that" is a
   correct answer.
2. **Anything is sent without explicit per-send approval.** No email, text, or invite leaves
   on Charli's own initiative. Ever. (Standing rule.)
3. **The math diverges from the engine.** If a spoken number doesn't match
   `server/lib/refi.js` / the rates engine, the feature is broken.
4. **It feels like a toy** — laggy, stilted, wrong-voice, or constantly mis-hearing.
5. **Sensitive borrower PII is stored or spoken unnecessarily** (full SSNs, account numbers).

## 5. The core law: retrieve and cite, never guess

This is the organizing principle of the whole build, and it extends the rule Broker Radar
already lives by.

- **Today:** no LLM ever computes a *number*. Savings, payments, LTV, break-even, rates come
  from `server/lib/refi.js` and the rates engine.
- **Added here:** no LLM ever invents a *fact or guideline* either. Charli answers only from a
  source she can check and cite. If nothing she can query answers the question, she says she
  can't confirm it rather than guessing.

**How it's enforced in the build:** Charli's LLM turn does not answer factual questions from
its own knowledge. It **calls a tool**, and the tool returns structured data from a real
source. The LLM's job is to *route to the right tool, narrate the result in Charli's voice,
and decide the next action* — never to supply the facts or the figures itself. Every spoken
claim is backed by a tool result that is also shown in the on-screen transcript as its source.

### v1 sources of truth (all retrievable, all citeable)

| Question type | Source of truth |
|---|---|
| Today's rates / market | the rates engine (`/api/rates`) |
| Opportunities / savings | the Sweeps engine (`server/lib/refi.js` via `/api/sweeps`) |
| Client facts (rate, balance, value, LTV, history) | the CRM database |
| Schedule / availability | Google Calendar (the connected account) |
| Outreach drafts | generated text staged as a Gmail **draft**, shown for approval |

If a question falls outside these (e.g. "what's Fannie's reserve requirement on a 2-unit
investment?"), v1 Charli says she can't verify that yet — that's the loan-guideline module
(§9), switched on later.

**One engine, canonical.** The voice layer uses the **server** engine
(`server/lib/refi.js`) as the single source for all math, with a parity test against the
dashboard's `App.jsx analyze()` so the screen and the voice can never diverge. _(Builder
call.)_

## 6. The experience (decided)

- **Live session, greet on open.** When the app opens, Charli greets you and the mic begins
  listening; you talk, she talks back, natural turn-taking, until you pause. A visible
  **pause / mute** control is always present. (Note for builder: browsers block audio autoplay
  until a user gesture, so the very first greeting may require a single "Start" tap or the
  login click as the gesture — acceptable; after that it's hands-free. This is a builder call,
  flagged in §11.)
- **Charli's voice is Bella** (ElevenLabs voice `hpp4J3VqNfWAUOO0d1Us`, "Professional, Bright,
  Warm") on the low-latency `eleven_v4_turbo` model — chosen by Bill on 2026-10-25 from an
  audition of four voices. Teresa (North Star's on-camera presenter) turned out to be a HeyGen
  voice whose speech API returns finished files only: measured 4.5 s of silence before a short
  reply and 8.9 s before the greeting, at ~4–5× the cost — too slow for live conversation. The
  voice is one env var (`ELEVENLABS_VOICE_ID_CHARLI`), so changing it later is trivial.
- **What she can do by voice in v1:**
  - **Market update** — reads today's real rates, plus the day's movement once a prior
    snapshot exists (we persist a daily rate snapshot from now on; until two exist she gives
    today's rates without claiming a move — §7.5).
  - **Sweep** — runs the real engine and names the top opportunities by client ("Your best
    one this morning is the Washingtons — an ARM about to reset…").
  - **Pull up a client** — "pull up the Chens" → opens/reads that client; answers questions
    about their loan from the record.
  - **Add a client** — captures the fields by voice and creates the record (read back for
    confirmation before saving).
  - **Log a contact** — "log that I called the Chens" → writes `last_contact` (the endpoint
    shipped with Sweeps Phase 1).
  - **Who should I call** — reads the check-ins due from the sweep.
  - **Calendar** — "what's on today?" reads the day; "book a follow-up with the Chens Friday
    at 10" creates the event.
  - **Draft outreach** — "draft the Chens their refi note" → composes a Gmail **draft**;
    Charli reads it back; sending requires an explicit, separate yes (voice + on-screen).
- **Proactive but bounded:** Charli offers and suggests (the morning menu, "want me to book
  that?", "want me to draft it?"), but every side-effecting action (create client, create
  event, send email) takes an explicit confirmation.

### 6.1 Experience-aware coaching (added 2026-10-22)

Bill's ask: a broker or LO could be a 20-year veteran or a week in, so Charli should tailor her
suggestions to their experience. **Charli knows each user's career stage and adapts how she
coaches, never what the numbers say.**

- **Stages:** New (under 1 year), Developing (1–3), Established (3–10), Veteran (10+).
- **Veteran:** numbers first, terse, ranked list, fastest path to action — no definitions.
- **New:** explains the why in plain words (what LTV and break-even mean), one concrete next
  step at a time, a short talk track on offer, reminders that outreach is approved before it
  sends. Developing and Established sit in between.
- **How she knows:** she asks once in the first session ("How long have you been
  originating?"), saves it only after the user confirms, and it's editable in the Charli panel;
  a broker can set it for their LOs. **Never inferred from behavior** — that would be guessing.
- **Never changes with stage:** the math, the tools, the retrieve-and-cite law, the confirm rule.
- Why it matters beyond the app: it's the concrete answer to "how do the next generation of
  brokers thrive" — the same co-pilot coaches a rookie up and gets out of a veteran's way.

## 7. Architecture (how — recommendation + decided pieces)

Built as an extension of the existing app: React/Vite client + Node/Express server, deployed
to Cloud Run, SQLite on the GCS volume. No rewrite.

### 7.1 Voice pipeline (decided — data stays on our infra)

**ElevenLabs for voice only (speech-to-text + Charli's TTS); Claude orchestrates
server-side.** Borrower data is reasoned over by Claude on our own server, and **no
third-party conversational-AI product sees the CRM.** Precisely what leaves our
infrastructure _(wording corrected 2026-10-25 after the final review)_: the broker's **audio**
and Charli's **reply text** go to ElevenLabs (speech only — it never receives tool results or
CRM lookups); the tool results Charli reasons over (client names, balances, rates — never
phone, email or notes, which are stripped before the model sees a record) go to the Anthropic
Messages API as part of the conversation. The data-retention terms of both vendors are Bill's
to confirm before launch (ElevenLabs' zero-retention option; Anthropic's API data policy). We
own the turn-taking loop in the browser (half-duplex in v1 — Charli's mic is off while she
speaks; barge-in is a later refinement).

_(Bill chose this over ElevenLabs' all-in-one Conversational AI, which would have routed
borrower NPI through their model and servers. The tradeoff is that we build the turn-taking
loop ourselves rather than getting it bundled — worth it to keep borrower data on our infra.)_

### 7.2 Tools (deterministic; the only way Charli gets facts)

Server endpoints the voice layer may call, each returning structured, citeable data:

- `getRates()` → today's rates + movement vs. the last persisted daily snapshot (existing
  `/api/rates`; snapshot store added, §7.5)
- `runSweep()` → opportunities + check-ins (existing `/api/sweeps`)
- `getClient(query)` / `listClients()` → CRM records (existing `/api/clients`)
- `addClient(fields)` → create (existing), **confirmed before save**
- `logContact(clientId)` → set `last_contact` (existing `/api/clients/:id/contact`); Charli
  reads back the client name for confirmation before writing, so a mis-heard name can't
  corrupt the check-in cadence _(builder call)_
- `getCalendar(range)` / `createEvent(details)` → Google Calendar (new, §7.3)
- `draftEmail(clientId, purpose)` → compose + stage a Gmail **draft** (new, §7.3);
  `sendEmail(draftId)` exists but is gated behind explicit approval and is the only path that
  sends — never called autonomously.

The orchestration LLM (Claude; `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` already in the app) maps
each utterance to a tool call, then narrates the structured result in Charli's voice. It is
instructed never to answer a factual/quantitative question except via a tool result.

### 7.3 Google integration

- **Per-user OAuth 2.0** (Gmail + Calendar scopes), Google first. Tokens stored server-side,
  encrypted; refresh handled server-side. New OAuth client id/secret live in env /
  Secret Manager, never in the repo. For the single v1 account, use Google OAuth
  **test-user** mode to skip restricted-scope app verification during the pilot. _(Builder
  call.)_
- **Provider abstraction:** calendar/email tools sit behind an interface so Microsoft 365 can
  be added later without touching the voice layer.
- **Email is draft-only by default.** `draftEmail` creates a Gmail draft. `sendEmail` runs
  only after an explicit per-send approval captured in the UI (and spoken). Nothing auto-sends.
- **Draft bodies are general for v1** — they invite the client to review their options and
  **never quote a specific rate or dollar figure**, which keeps us clear of mortgage-
  advertising / Loan-Estimate / state-licensing triggers. (Quoting engine figures is a later
  phase, with the disclosure handling it requires.)
- **v1 connects one account** (Bill / the demo broker). Multi-broker token management is a
  later concern but the schema is built per-broker from the start.

### 7.4 Grounding & transcript

Every turn shows in an on-screen transcript with the **source** behind each answer (which tool
/ record / rate produced it), so a spoken claim is always inspectable. When no tool can answer,
the transcript shows "Unable to verify" rather than a generated answer. _(Built as the
"unable to verify" chip on can't-verify and guideline hand-off replies.)_

### 7.5 Daily rate snapshot (new)

To ground "the day's movement" (§4/§5), persist **one rate snapshot per day**.
**Capture-on-fetch** — store the snapshot whenever rates are refreshed and the day has rolled
over — avoids needing an always-on cron on Cloud Run; a Cloud Scheduler ping is the fallback
if capture-on-fetch proves too sparse. "Movement" = today vs. the most recent prior snapshot.
Until two snapshots exist, Charli reports today's rates without claiming a move. (This is the
mortgage-rate series Charli quotes — not the 10-yr Treasury, which is a different instrument.)

## 8. Charli's persona & prompt (decided intent)

- **Voice/tone:** warm, familiar, competent, a step ahead — not a cold assistant.
- **System prompt encodes:** the morning greeting + proactive menu; the retrieve-and-cite law
  (answer only from tools; say "I can't verify that" otherwise); the confirmation rule for any
  side-effecting action; PII minimization (don't read back full SSNs/account numbers); and the
  hand-off language for anything in the deferred loan-guideline domain.

## 9. Where the Loan Decision & Guideline Expert fits

The "Loan Decision & Guideline Expert — Complete Build Package" (Bill's doc, 2026-10-21) is
**not v1**, and **not a separate assistant** to the user — it is a **knowledge module** that
plugs into Charli later and makes her a guideline expert too, using the *same* zero-guessing
discipline this design is built on.

It is deferred because its value is 90% in the **maintained corpus and governance**, not the
prompt: a current, dated, access-controlled library of UWM overlays + agency/investor/AUS
guidance, with a named owner and a refresh cadence; confirmed authorization to ingest internal
UWM content; and the compliance gating (Bill-only pilot, test gate T01–T20, blocking rule)
from that doc. When that library is ready, Charli routes loan-guideline questions to it and
answers with citations and standardized outcomes; until then she says she can't verify those.

See the source doc for the agent spec, evidence hierarchy, test suite, and rollout checklist.

## 10. Constraints

- **Node 20** locally (better-sqlite3 prebuilds; Node 24 won't compile it).
- **Cloud Run** deploy (`refi-radar`, project `refi-radar-496318`); SQLite on the GCS volume.
- **Browser voice:** mic permission required; runs in the desktop app's built-in browser /
  Chrome. First audio may need a user-gesture (autoplay policy).
- **Secrets by env var / Secret Manager only**, never in the repo: `ANTHROPIC_API_KEY`,
  `ELEVENLABS_API_KEY`, `FRED_API_KEY`, `JWT_SECRET`, Google OAuth client id/secret, plus the
  existing set. Reference by name.
- **No deploy without Bill's explicit go** (standing rule).
- **Email/comms are draft-and-approve only** (standing rule).
- **Determinism rule** holds throughout (§5).

## 11. What's left to the builder

- ~~Pull the exact voice id for Charli~~ — done: Bella `hpp4J3VqNfWAUOO0d1Us` (see §6).
- **First-greeting gesture** (§6): decide whether the login click or a one-tap "Start" serves
  as the autoplay gesture.
- **Voice panel UI**: transcript + source display, waveform/indicator, pause/mute placement.
- **Data model additions**: OAuth token table (encrypted), the daily rate-snapshot table
  (§7.5), and any interaction/notes table needed for richer logging beyond `last_contact`.
- **Turn-taking loop**: browser STT + VAD + barge-in details (we own this now, §7.1).
- **Orchestration config**: exact Claude tool-calling wiring (model already in the app).
- **Scope of "add/edit client by voice"**: which fields are voice-settable in v1.

## 12. Decisions resolved (builder check, 2026-10-21)

Brought to Bill; answered:

1. **Voice architecture — data stays on our infra.** ElevenLabs = voice only; Claude
   orchestrates server-side; borrower NPI never transits a third-party conversational model
   (§7.1).
2. **Email drafts — general only for v1.** No quoted rate/savings in client outreach (§7.3).
3. **Market movement — capture daily snapshots** from now on; grounded movement once history
   exists (§7.5).

Calls I made (sensible-builder defaults; say the word if you'd rule otherwise):

- Google OAuth **test-user** mode for the single v1 account (§7.3).
- The **server** `refi.js` engine is canonical for all math, with a parity test vs. the
  dashboard (§5).
- `logContact` **reads back the client name** before writing (§7.2).
- **Experience-aware coaching design** (§6.1, Bill said "you decide", 2026-10-22): four stages,
  asked once by voice and confirmed, editable in the panel, broker can set it for LOs, never
  inferred; stage changes coaching style only.
