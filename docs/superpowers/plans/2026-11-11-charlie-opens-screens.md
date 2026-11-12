# Charlie Opens Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Pull up Helen Brandt" / "take me to Rate Watch" opens that client's page or that app page, with Charlie still in view and her code-written line heard in full.

**Architecture:** A new code-only tool, `showScreenTool`, returns a `screen` beside the reply the way `draftEmailTool` returns `compose`; the orchestrator ends the turn with a code-written line, only on a turn its own navigation recognizer marks. The browser sends what is open (`onScreen`) on every turn; the session asks the App to *prepare* the screen (checks that can fail), then shows and speaks the line, then tells the App to *go*; the Charlie view that unmounts lets that one line finish (`audio.retire()`).

**Tech Stack:** Node 20 (`C:/Users/bille/dev/node20` first on PATH; the system node is 24), Express, better-sqlite3, `node --test`; React 18 / Vite with inline styles; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-charlie-opens-screens-design.md` (read it first; it is the authority).

## Global Constraints

- Worktree `C:\Users\bille\dev\refi-radar-charlie-screens`, branch `feature/charlie-screens`. Nothing is merged, pushed or deployed (each needs Bill's go).
- No database change, no new route, no new dependency. `/api/assistant/turn` gains only the optional body field `onScreen` and the optional answer field `screen`.
- No paid API calls anywhere: tests use the scripted fake Anthropic client and fake fetch/audio; do not run `server/scripts/charlie-eval.js`.
- Every line about a screen is code-written, exactly (copy is fixed; `{name}` is the stored client name, whitespace-collapsed):
  - client: `Here's {name}.` · already there: `You're already on {name}'s page.`
  - pages: home `Here's Home.` · sweeps `Here's Sweeps.` · clients `Here's your client list.` · rates `Here's Rate Watch.` · add `Here's the Add Client form.` · team `Here's your team.` · import `Here's Import Clients.` · profile `Here's your profile.` · billing `Here's Billing.`
  - a page already open: the page's line with `Here's ` replaced by `You're already on ` (`You're already on Rate Watch.`).
  - `You've got a form open. Save or cancel it first, then ask me again.` · `That page is for your broker's account.` · `Billing isn't turned on for your account yet.` · `I couldn't open that page.`
- Page ids are `nav.mjs`'s: `home, sweeps, clients, rates, add, team, import, profile, billing`; broker-only: `team, import, billing` (billing also only while billing is on).
- `onScreen.page` is one of `home, sweeps, clients, rates, team, import, profile, billing, client, form`; `clientId` only a positive integer, only with `client`. Anything else is ignored (treated as unknown).
- The approved layouts stay as they are (Home, the dock, the panel, the client page). Nothing new is drawn.
- Charlie is she/her in all copy and comments.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test commands: server `cd server && npm test`; client `cd client && npm test && npm run build`.

## Review Focus

1. The broker closes Charlie's view (or she is otherwise gone) while she is still working on "pull up Helen": nothing opens, nothing is said, and the transcript says `I couldn't open that page.` (Task 5).
2. The broker clicks into Add Client by hand while she is working: nothing opens and the transcript says the form line (Task 5, Task 7).
3. On a phone with her panel already open (it fills the screen), "pull up Helen": the panel closes so Helen's page is what they see (Task 7).
4. Voice off, or her line can't be fetched (a TTS 429/503): the page change leaves no live mic and no audio left running (Task 6).
5. "Open the email" / "open it in Gmail" after a compose card, and "pull up my top opportunities": not a page request in the first case, an answer in words in the second; nothing is replaced by `I couldn't open that page.` (Task 1, Task 3).

## Rulings in this plan (my calls, beyond the spec's)

- **"Look up <client>" opens the page** when the rest of the sentence is only the client's name (Bill's own words on 2026-11-11 were "look up a client or bring up a client"). "Look up Helen's balance" stays a question.
- **Strong verbs always mark a page request:** pull up, bring up, open, go to / go back to / go home, take me to / take me home, jump to, switch to, navigate to, head to. **"Show (me)" and "look up"** mark one only when what follows is a page name or a client name. "Open" never marks one when its object is an email, a draft, Gmail, Outlook, mail or a link.
- **A clarifier is one hop:** the answer to Charlie's single question right after a page request continues it.
- **A page claim the app didn't make is replaced:** on a page-request turn with no screen handed up, model text that says she pulled up / brought up / opened a page, took them somewhere, or put it on the screen becomes `I couldn't open that page.`
- **The browser re-checks at arrival:** a form open by then gives the form line; Charlie's view gone by then gives `I couldn't open that page.`
- **On a phone, a Charlie page change closes her panel** if it was open, so the page asked for is what they see.
- **Billing on/off on the server** uses the rule of `routes/billing.js` (`billingConfig.enabled` and a gateway), exported once as `billingIsOn(app)`.

---

### Task 1: The navigation module (server, pure)

**Files:**
- Create: `server/lib/assistant/navigation.js`
- Test: `server/test/assistant-navigation.test.js`

**Interfaces:**
- Produces:
  - `SCREEN_PAGES`: frozen `["home","sweeps","clients","rates","add","team","import","profile","billing"]`; `BROKER_PAGES`: frozen Set `team, import, billing`.
  - `FORM_OPEN`, `BROKER_ONLY`, `BILLING_OFF`, `COULDNT_OPEN`: the exact lines in Global Constraints.
  - `cleanOnScreen(raw) -> { page, clientId? } | null`
  - `screenLine(screen, name?) -> string`; `alreadyLine(screen, name?) -> string`; `isAlreadyOn(screen, onScreen) -> boolean` (`screen` is `{ page }` or `{ page: "client", clientId }`).
  - `isNavigationRequest(text: string, namesClient?: (s: string) => boolean) -> boolean`
  - `claimsScreenOpened(text: string) -> boolean`

- [ ] **Step 1: Write the failing tests.** Table tests:

```js
// isNavigationRequest(text, namesClient) — namesClient = (s) => /helen|brandt/i.test(s)
const YES = ["pull up Helen Brandt", "Charlie, bring up the Brandts", "open Helen Brandt", "go to Helen's page",
  "take me to Rate Watch", "open Sweeps", "go home", "show me my clients", "go to my team", "can you pull up Helen",
  "please open rate watch", "look up Helen Brandt", "show me Helen Brandt", "take me home", "switch to sweeps"];
const NO = ["show me who's at their target", "show me today's rates", "what's Helen's target?", "log a call with Helen",
  "open the email", "open it in Gmail", "look up the Cowboys score", "look up Helen's balance", "who should I call?",
  "what are rates today"];
// cleanOnScreen
assert.deepStrictEqual(cleanOnScreen({ page: "client", clientId: 7 }), { page: "client", clientId: 7 });
assert.deepStrictEqual(cleanOnScreen({ page: "rates", clientId: 7 }), { page: "rates" });
for (const bad of [null, "rates", { page: "admin" }, { page: "client" }, { page: "client", clientId: 0 }, { page: "client", clientId: "7" }, { page: "add" }])
  assert.strictEqual(cleanOnScreen(bad), null);
// lines
assert.strictEqual(screenLine({ page: "client", clientId: 7 }, "Helen  Brandt"), "Here's Helen Brandt.");
assert.strictEqual(screenLine({ page: "clients" }), "Here's your client list.");
assert.strictEqual(alreadyLine({ page: "rates" }), "You're already on Rate Watch.");
assert.strictEqual(alreadyLine({ page: "client", clientId: 7 }, "Helen Brandt"), "You're already on Helen Brandt's page.");
assert.strictEqual(isAlreadyOn({ page: "client", clientId: 7 }, { page: "client", clientId: 7 }), true);
assert.strictEqual(isAlreadyOn({ page: "client", clientId: 7 }, { page: "client", clientId: 8 }), false);
assert.strictEqual(isAlreadyOn({ page: "rates" }, null), false);
// claimsScreenOpened
for (const t of ["Pulling up Helen now.", "I've opened her page.", "Taking you to Rate Watch.", "It's on your screen.", "There you go."]) assert.ok(claimsScreenOpened(t));
for (const t of ["Which Chen — Robert and Linda, or Chen Wei?", "I don't see a Zed in your book.", "Here are your top opportunities."]) assert.ok(!claimsScreenOpened(t));
```

Also one test per page id that `screenLine({ page })` is its Global Constraints line.

- [ ] **Step 2: Run** `cd server && node --test test/assistant-navigation.test.js` — FAIL (module missing).
- [ ] **Step 3: Implement `navigation.js`.** Leading filler allowed before the verb: a vocative "Charlie,"/"Charli,", "hey", "please", "can/could/would/will you", "let's", "I want to". Page names accepted after "show (me)": home, the home page, the dashboard, sweeps, (all|my) clients, the client list, rate watch, (the) rates page, add (a) client, my team, import (clients), (my) profile, billing — an optional trailing "page"/"please"/"for me". A client name after "show (me)"/"look up" is `namesClient(rest)` on the whole remainder (a trailing "'s page", "page", "file", "please", "for me" stripped first), and the remainder must not open with a question word. No figures, no state, no I/O.
- [ ] **Step 4: Run** the test file — PASS; then `npm test` in `server` — all green.
- [ ] **Step 5: Commit** `feat(charlie): navigation recognizer, screen lines and onScreen cleaning`.

### Task 2: `showScreenTool` and the billing rule

**Files:**
- Modify: `server/lib/assistant/tools.js` (new tool, registry, `TOOL_SCHEMA`, exports)
- Modify: `server/routes/billing.js` (export `billingIsOn(app)`, used by `billingOf`)
- Test: `server/test/assistant-tools.test.js`, `server/test/billing-api.test.js` (one case)

**Interfaces:**
- Consumes: `SCREEN_PAGES`, `BROKER_PAGES` (Task 1); `scopedClients(ctx)`.
- Produces: `showScreenTool(args, ctx)`; `ctx.billingOn` (boolean, set by Task 4) is read here. Results:
  - client: `{ data: { page: "client", clientId, name }, source: "client record", screen: { page: "client", clientId } }`
  - page: `{ data: { page }, source: "(screen)", screen: { page } }`
  - bad input: `fail("(invalid input)", …)`; not in the caller's scope: `fail("(not found)", "no such client in your book")`
  - a loan officer and a broker-only page: `{ data: { error: "that page is only on a broker's account", code: "broker_only" }, source: "(not available)" }`
  - a broker, `billing`, `ctx.billingOn !== true`: `{ data: { error: "billing is not turned on", code: "billing_off" }, source: "(not available)" }`
- `billingIsOn(app) -> boolean`: `Boolean(config && config.enabled && gateway)` with `app.get("billingConfig")`, `app.get("billingGateway")`.

- [ ] **Step 1: Write the failing tests** in `assistant-tools.test.js`: a broker opens a company client's page (the result above, `name` the stored name); a loan officer gets `(not found)` for a teammate's client and the client result for their own; `clientId` `"7"`, `0`, missing → `(invalid input)`; `{ page: "admin" }` → `(invalid input)`; LO + `team`/`import`/`billing` → `code: "broker_only"`; broker + `billing` with `billingOn` false/absent → `billing_off`, true → `{ page: "billing" }` screen; every `SCREEN_PAGES` id for a broker with billing on gives `screen: { page }`; the tool writes nothing (client count and row unchanged); `TOOL_SCHEMA` has a `showScreenTool` entry whose `page` enum is `[...SCREEN_PAGES, "client"]`. In `billing-api.test.js`: `billingIsOn` is false with no config, false with `enabled` and no gateway, true with both.
- [ ] **Step 2: Run** `cd server && node --test test/assistant-tools.test.js test/billing-api.test.js` — FAIL.
- [ ] **Step 3: Implement.** Schema description, exactly:

```text
Open a page of the app on the user's screen: a client's page (page "client" with the clientId from findClient; never guess it), or one of the app's pages: home (Home), sweeps (Sweeps), clients (All Clients), rates (Rate Watch), add (Add Client), team (My Team), import (Import Clients), profile (Profile), billing (Billing). Use it only when the user asks to see, open, pull up, bring up or go to that client or page, never on your own. It changes nothing but what is on the screen. The app says what opened: say nothing about it yourself. If findClient returns more than one match, ask which one first. A list or figures ("show me who's at their target", "show me today's rates") is answered in words, not with this.
```

`clientId` accepts what `idOf` accepts elsewhere in tools.js (a digit string is the model's usual slip). Update the file's header comment: `showScreenTool` returns `screen` at the top level, as `draftEmailTool` returns `compose`, and writes nothing.
- [ ] **Step 4: Run** both files, then `npm test` in `server` — green.
- [ ] **Step 5: Commit** `feat(charlie): showScreenTool (opens nothing itself; returns the screen) + billingIsOn`.

### Task 3: The orchestrator and the prompt

**Files:**
- Modify: `server/lib/assistant/orchestrator.js` (`runTool`, `LAST_CALL_TOOLS`, `finish`, `runTurn`, `codeAuthoredLine`, header comment)
- Modify: `server/lib/assistant/prompt.js` (one rule in `CHARLI_SYSTEM`)
- Test: `server/test/assistant-orchestrator.test.js`

**Interfaces:**
- Consumes: Task 1's exports; Task 2's result shape; `namesClient(text, ctx)` from tools.js; `ctx.onScreen` (`cleanOnScreen` output or absent).
- Produces: `runTurn(...)` result gains `screen?: { page } | { page: "client", clientId }`; new export `isNavigationTurn(messages, ctx) -> boolean`.

- [ ] **Step 1: Write the failing tests** (scripted fake client: `fakeClient`, `useTool`, `say`, `userSays`; a broker org with Helen Brandt, Robert & Linda Chen, Chen Wei; an LO with their own client and a teammate's):
  - "pull up Helen Brandt": `findClient` → `showScreenTool {page:"client", clientId}` → `reply === "Here's Helen Brandt."`, `screen` deep-equals `{ page: "client", clientId }`, `sources` `["client record"]`, and the fake was called exactly twice.
  - "take me to Rate Watch" → `showScreenTool {page:"rates"}` → `"Here's Rate Watch."`, `screen {page:"rates"}`.
  - A1: "what's in Helen's notes?" with the model calling `showScreenTool {page:"rates"}` → `NOTHING_CHANGED`, no `screen`.
  - `ctx.onScreen {page:"form"}` + a page request → `FORM_OPEN`, no `screen`.
  - Already: `ctx.onScreen {page:"client", clientId: helen}` → `"You're already on Helen Brandt's page."`; `{page:"rates"}` + rates → `"You're already on Rate Watch."`; neither has `screen`.
  - LO "take me to My Team" → `BROKER_ONLY`; broker billing with `ctx.billingOn` false → `BILLING_OFF`, true → `"Here's Billing."` + screen.
  - LO "pull up <teammate's client>": `findClient` returns no match → the model's not-found sentence is the reply, unchanged, no `screen`.
  - Two `showScreenTool` calls in one response, and `showScreenTool` beside `logContactTool` → `ONE_AT_A_TIME`.
  - Clarifier: history `["pull up Chen", "Which Chen — Robert and Linda, or Chen Wei?", "Robert and Linda"]` → `findClient` → `showScreenTool` → `"Here's Robert & Linda Chen."` (their stored name) + screen; `isNavigationTurn` is true for it and false for `["log a call with Chen", "Which Chen…?", "Robert and Linda"]`.
  - Page claim: "pull up Helen Brandt" where the model only says "Pulling up Helen now." → `COULDNT_OPEN`.
  - Review Focus 5: "pull up my top opportunities" answered by `runSweepTool` then a figure-free sentence → that sentence, unchanged; "open the email" after a compose turn keeps today's behaviour (no `screen`; reply as before).
  - `CHARLI_SYSTEM` includes `showScreenTool` and the sentence about `Here's` lines below.
- [ ] **Step 2: Run** `cd server && node --test test/assistant-orchestrator.test.js` — the new cases FAIL.
- [ ] **Step 3: Implement.**
  - `runTool` carries `result.screen` (an object) like `compose`; `"showScreenTool"` joins `LAST_CALL_TOOLS`; `finish` takes `screen` as a 6th argument and sets `out.screen`.
  - `isNavigationTurn(messages, ctx)`: `isNavigationRequest(latest user text, (s) => namesClient(s, ctx))`, or one hop: latest user message `isAnswerShaped`, the message before it an assistant message ending in `?`, the user message before that `isNavigationRequest`. Computed once per turn as `navTurn`, beside `actionTurn`; the change-request recognizer is not touched.
  - After the tools of a response run, before `codeAuthoredLine`: a `showScreenTool` block on a turn that is not `navTurn` → `finish(NOTHING_CHANGED)`; on `navTurn` with `ctx.onScreen.page === "form"` → `finish(FORM_OPEN)`.
  - `codeAuthoredLine`: `broker_only` → `BROKER_ONLY`, `billing_off` → `BILLING_OFF`.
  - `changes` counts `o.screen` too. A screen change: `isAlreadyOn` → `finish(alreadyLine(...))`; else `finish(screenLine(...), cited, undefined, undefined, undefined, change.screen)`. The name comes from `change.data.name` through `cleanName`.
  - On `navTurn` with no screen handed up, a model reply for which `claimsScreenOpened` is true → `finish(COULDNT_OPEN)`, ahead of the other text screens; every other screen still runs as today.
  - `prompt.js`, one rule in `CHARLI_SYSTEM` beside the "Done —" rule, exactly: `Screens: when the user asks to pull up, bring up, open, show or go to a client or one of the app's pages, call showScreenTool (after findClient for a client) and say nothing about it yourself. A line in your earlier messages that starts with "Here's" or "You're already on" right after such a request was written by the app when it opened that page; it is true.`
- [ ] **Step 4: Run** the file, then `npm test` in `server` — green (no existing test changes; if one must, say why in the report).
- [ ] **Step 5: Commit** `feat(charlie): page requests end in a code-written line and a screen`.

### Task 4: The turn route

**Files:**
- Modify: `server/routes/assistant.js` (`/turn`: `ctx.onScreen`, `ctx.billingOn`, `payload.screen`; the route's contract comment)
- Test: `server/test/assistant-api.test.js`

**Interfaces:**
- Consumes: `cleanOnScreen` (Task 1), `billingIsOn` (Task 2), `out.screen` (Task 3).
- Produces: `POST /api/assistant/turn` body `{ …, onScreen? }` → `{ reply, sources, turnId, screen? }`.

- [ ] **Step 1: Write the failing tests** (`setClient(fakeClient(...))`, `asUser`): a screen turn answers `screen` and the line; `onScreen: { page: "form" }` answers `FORM_OPEN` and no `screen`; `onScreen` of `"rates"`, `{ page: "admin" }`, `{ page: "client", clientId: -1 }` is ignored (the turn answers as with no `onScreen`); with `billingConfig {enabled:true}` and a `billingGateway` set on the app, a broker's billing request gets `"Here's Billing."`, without them `BILLING_OFF`; a greeting with `onScreen` is unchanged.
- [ ] **Step 2: Run** `cd server && node --test test/assistant-api.test.js` — FAIL.
- [ ] **Step 3: Implement.** `ctx.onScreen` is set only when `cleanOnScreen` returns an object; `ctx.billingOn = billingIsOn(req.app)`. `payload.screen = out.screen` when present (no confirm id: nothing to confirm).
- [ ] **Step 4: Run** the file, then `npm test` in `server` — green.
- [ ] **Step 5: Commit** `feat(charlie): /turn carries onScreen in and screen out`.

### Task 5: The browser session

**Files:**
- Modify: `client/src/charli/session.mjs` (options, `runTurn`, a screen-turn path, `speak`, constants, header comment)
- Test: `client/src/charli/session.test.mjs`

**Interfaces:**
- Consumes: `/turn`'s `screen` (Task 4).
- Produces:
  - `createSession({ …, screenNow, onShowScreen })`: `screenNow() -> { page, clientId? } | null` is sent as `body.onScreen` on every turn (omitted when null or throwing); `onShowScreen(screen) -> Promise<{ ok: true, go: () => void } | { ok: false, reason?: "form" | "missing" | "not-allowed" }>`.
  - Exports `COULDNT_OPEN`, `FORM_OPEN` (keep in sync with `server/lib/assistant/navigation.js`).
  - `onSpeak` receives `{ text, turnId, handoff: true }` for the line of a screen that is opening.

- [ ] **Step 1: Write the failing tests** (`setup`, `fakeServer`, `turnReply`, `lastTurn`, `messagesOf`):
  - A reply with `screen {page:"client", clientId: 7}`: `onShowScreen` is called once with that object; the turn `"Here's Helen Brandt."` is in the transcript; `onSpeak` got `{ text: "Here's Helen Brandt.", handoff: true }` **before** `go` ran (record the order); `go` ran once.
  - `onShowScreen` → `{ ok: false }`: the transcript and the next turn's `messages` hold `"I couldn't open that page."`, never `"Here's …"`; `go` never called.
  - `{ ok: false, reason: "form" }` → `FORM_OPEN` the same way.
  - `screen {page:"admin"}`, `screen "rates"`, and no `onShowScreen` option → `COULDNT_OPEN`, `onShowScreen` not called.
  - Review Focus 1: `leave()` while `onShowScreen` is pending → after it resolves `{ ok: true, go }`, `go` is not called, nothing is spoken, the transcript shows `COULDNT_OPEN`.
  - `onShowScreen` that rejects → `COULDNT_OPEN`.
  - `screenNow` returning `{ page: "client", clientId: 7 }` → that `body.onScreen`; returning null or throwing → no `onScreen` key; the greeting body never has it.
  - A second `submit` while the screen turn awaits `onShowScreen` → `{ ok: false, reason: "busy" }`.
  - A reply with both `screen` and `sideEffect` sets no `pending` (a screen turn proposes nothing).
- [ ] **Step 2: Run** `cd client && node --test src/charli/session.test.mjs` — FAIL.
- [ ] **Step 3: Implement.** In `runTurn`, a non-error reply with a non-empty `reply` and a `screen` key goes to the screen path; everything else to `showTurnResult` as today. Screen path: clean the screen (`{ page }` of the nine ids or `{ page: "client", clientId: positive integer }`); if clean, not away, and `onShowScreen` exists, await it (a throw is `{ ok: false }`); if the session went away or was disposed meanwhile, treat it as not opened. Then add one assistant turn (the reply with its sources and turnId when opened, else the replacement line with no sources), speak it (with `handoff: true` only when opened), and only then call `go()`. `speak(text, turnId, extra)` passes `extra` into the `onSpeak` object.
- [ ] **Step 4: Run** the file, then `npm test` in `client` — green.
- [ ] **Step 5: Commit** `feat(charlie): the session opens a screen before her line and replaces the line when it can't`.

### Task 6: Her line survives the page change

**Files:**
- Modify: `client/src/charli/audio.js` (`retire()`)
- Modify: `client/src/charli/CharliView.jsx` (props `onShowScreen`, `screenNow`; the handoff flag; cleanup)
- Test: `client/src/charli/audio.test.mjs`

**Interfaces:**
- Consumes: Task 5's `createSession` options and the `handoff` mark on spoken lines.
- Produces: `audio.retire()`: the mic and capture stop at once; no new `speak` is accepted; what is playing or queued plays to the end, then the instance disposes itself; with nothing playing or queued (or only clips blocked by autoplay) it disposes at once. `CharliView` props `onShowScreen`, `screenNow` (App passes both; they must be stable functions, because the kept session is built by the first view and holds that view's refs, as `onClientsChanged` does today).

- [ ] **Step 1: Write the failing tests** in `audio.test.mjs` (its `FakeAudio` / fake fetch): `retire()` mid-clip lets the clip end and plays the queued one, then a later `speak` is ignored; `retire()` with the mic live stops it at once (`onMicChange("off")`); Review Focus 4: `retire()` with nothing queued, and after a TTS 429, leaves nothing playing and no live mic, and `dispose()` after `retire()` is harmless.
- [ ] **Step 2: Run** `cd client && node --test src/charli/audio.test.mjs` — FAIL.
- [ ] **Step 3: Implement.** `retire()` in `audio.js`. In `CharliView`: pass `screenNow` and `onShowScreen` into `createSession` through refs (the `onClientsChanged` pattern); `voice.speak` sets a `handoffRef` when the line has `handoff: true`, and `onSpeakingChange(false)` clears it; the unmount cleanup calls `audio.retire()` when `handoffRef.current`, else `audio.dispose()` as today (everything else in the cleanup unchanged).
- [ ] **Step 4: Run** the file, then `npm test` and `npm run build` in `client` — green.
- [ ] **Step 5: Commit** `feat(charlie): the view she leaves for a page lets her line finish`.

### Task 7: The App opens the screen

**Files:**
- Create: `client/src/charlieNav.mjs`; Test: `client/src/charlieNav.test.mjs` (add it to `client/package.json`'s `test` script list)
- Modify: `client/src/App.jsx` (refs, `screenNow`, `prepareScreen`, `reloadClients` returns the list, props on both `CharliView`s)
- Modify: `client/src/import/ImportView.jsx` (prop `onFileState(hasFile: boolean)`)

**Interfaces:**
- Consumes: `navItems(role, { billing })` from `nav.mjs`; Task 5's `onShowScreen` / `screenNow` contract; Task 6's props.
- Produces (pure, `charlieNav.mjs`):
  - `onScreenOf({ view, selectedId, importHasFile }) -> { page, clientId? } | null`: `client-detail` with an id → `{ page: "client", clientId }`; `add`, `edit` → `form`; `import` → `form` when `importHasFile`, else `import`; `lo-portal` → `team`; `home, sweeps, clients, rates, team, profile, billing` → themselves; anything else → null.
  - `pageAllowed(page, role, billingOn) -> boolean` (from `navItems`).
  - `panelAfter({ target, isPhone }) -> "open" | "close"`: `home` → `close` (her dock shows); a phone → `close`; else `open`.
  - `viewForScreen(screen) -> string`: `client-detail` for a client, else the page id.

- [ ] **Step 1: Write the failing tests** for the four functions: every row of the mapping above; `pageAllowed("team", "lo", false) === false`, `pageAllowed("billing", "broker", false) === false`, `pageAllowed("billing", "broker", true) === true`, `pageAllowed("rates", "lo", false) === true`, `pageAllowed("client", "broker", true) === false`; Review Focus 3: `panelAfter({ target: "client-detail", isPhone: true }) === "close"`, `({ target: "rates", isPhone: false }) === "open"`, `({ target: "home", isPhone: false }) === "close"`.
- [ ] **Step 2: Run** `cd client && node --test src/charlieNav.test.mjs` — FAIL.
- [ ] **Step 3: Implement `charlieNav.mjs`, then wire `App.jsx`.**
  - Refs kept current on each render: clients, user, `billingOn`, view, selected id (exists), `isPhone`, and `importHasFile` (set by `ImportView`'s `onFileState`).
  - `screenNow` = `onScreenOf` over the refs. `prepareScreen(screen)` (both `useCallback(..., [])`):
    - Review Focus 2: a form open now (`onScreenOf(...).page === "form"`) → `{ ok: false, reason: "form" }`.
    - A page `pageAllowed` refuses → `{ ok: false, reason: "not-allowed" }`.
    - A client not in the list → `await reloadClients()` once (it now resolves to the fresh list, or null), then look again; still missing → `{ ok: false, reason: "missing" }`.
    - Otherwise `{ ok: true, go }`: `go` sets `selected` (for a client) and the view (`viewForScreen`), then the panel per `panelAfter` (`open` → `setPanelOpen(true)`, `close` → `setPanelOpen(false)`).
  - Pass `onShowScreen={prepareScreen}` and `screenNow={screenNow}` to the dock and the panel `CharliView`.
  - `ImportView` calls `onFileState(true)` while its step is `review` or `importing`, `onFileState(false)` on `upload` and `result` and when it unmounts.
- [ ] **Step 4: Run** `npm test` and `npm run build` in `client`, and `npm test` in `server` — green.
- [ ] **Step 5: Commit** `feat(charlie): the App opens the page she was asked for, Charlie still in view`.

### Task 8: Browser check (controller, no paid calls)

**Files:** none in the repo (scratchpad only).

- [ ] **Step 1:** Run the worktree's server on a throwaway DB with sample clients (no Anthropic, FRED or ElevenLabs keys), and its client with Vite, via `.claude/launch.json` entries like the target-rate ones.
- [ ] **Step 2:** In the page, stub only `fetch("/api/assistant/turn")` to answer `{ reply: "Here's Helen Brandt.", sources: ["client record"], turnId: "t1", screen: { page: "client", clientId: <Helen's id> } }`, then type "pull up Helen Brandt" in the dock.
- [ ] **Step 3:** Check with `read_page`: Helen's client page is showing, the panel is open with the same conversation, the last line is `Here's Helen Brandt.`; then the same at phone width (375×812): Helen's page showing, panel closed, her corner button there. Stub a `screen` for a deleted client id: the line is `I couldn't open that page.` and the page did not change. With Add Client open: the form line, the form untouched.
- [ ] **Step 4:** Screenshots of the laptop and phone results, sent to Bill. Reset the viewport to desktop.

---

## Self-review notes

- Spec coverage: G1 Tasks 2, 3, 7 · G2 Tasks 2, 3, 7 · G3 Tasks 6, 7 · G4 Tasks 3, 5 · A1 Task 3 · A2 Tasks 3, 5, 7 · A3 Task 2 · A4 Tasks 3, 5 · 4.4 Tasks 1, 4, 7 · 4.5 Task 2 · §8 cases 1–10 across Tasks 3, 5, 6, 7, 8.
- Not in this plan: Charlie knowing what is on screen; filling forms; several pages at once; Charlie eval cases (a paid run is Bill's call).
