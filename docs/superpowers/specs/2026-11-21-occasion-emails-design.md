# Occasion emails for Charlie: design

**Approved by Bill 2026-11-21** ("emails ok"), from the description in chat. Build on the side copy
`C:\Users\bille\dev\refi-radar-emails`, branch `feature/occasion-emails`. Merge, push and deploy each wait for his go.

## Why

Charlie can set up two client emails today, a check-in and a refinance review (`server/lib/assistant/outreach.js`,
`draftEmailTool` in `server/lib/assistant/tools.js`). Birthdays and anniversaries are on file and shown under Dates Coming
Up, but there is no email for them, and nothing records that a note went out.

## What stays exactly as it is

- Charlie never writes an email and never sends one. The wording is fixed by the app. The email opens ready to send in the
  broker's own Gmail, Outlook or mail app (`composeLinks`).
- Every client email is signed with the sender's NMLS ID (and the company's when it has one). No NMLS ID saved: no email.
- A client marked "do not email" never gets one set up, on any path.
- The recipient is the address on the client's record. No rate, no dollar figure, no age and no count of years in any email.
- The two existing emails keep their wording.

## The four new emails

Purposes added to `PURPOSES`: `birthday`, `family_birthday`, `wedding_anniversary`, `home_anniversary`.

| Purpose | For these occasion kinds (`lib/occasions.js`) | Subject |
|---|---|---|
| `birthday` | `birthday` | `Happy birthday!` |
| `family_birthday` | `spouse_birthday`, `child_birthday` | `Happy birthday to {who}!` |
| `wedding_anniversary` | `wedding` | `Happy anniversary!` |
| `home_anniversary` | `loan`, `home` | `Happy home anniversary!` |

Bodies, in the existing template form (`Hi {clientName},` first, `Best,\n{SIGNATURE}` last):

- `birthday`: `Happy birthday! I hope you have a great day and a wonderful year ahead.`
- `family_birthday`: `I wanted to wish {who} a very happy birthday. I hope you all have a great day celebrating.`
- `wedding_anniversary`: `Happy anniversary! Wishing you both a wonderful day and many more years together.`
- `home_anniversary`: `Happy home anniversary! I hope the home is treating you well. It was a pleasure helping you with
  it, and I'm always here if you ever need anything.`

`{who}` is a family member's name **from the client's record**, never from the model or the browser:

- For a child it is that child's stored name. For a spouse it is the stored spouse name; with no spouse name on file the
  text says `your spouse` (subject: `Happy birthday to your spouse!`).
- A caller names the family member with `who`. It must equal the stored spouse name or a stored child's name (compared
  trimmed and case-insensitively; the stored spelling is what prints). With `who` left out: if the client has exactly one
  family member with a birthday on file, that one; otherwise the email is refused with code `who_needed`.
- `PURPOSE_WORDS` gains the four: `birthday`, `family birthday`, `wedding anniversary`, `home anniversary`.

The home anniversary note must not read as an offer: no review, no rates, no "options".

## One way to set an email up

A shared function (in `outreach.js` or a small new module beside it) does what `draftEmailTool` does today and both
callers use it, so the rules cannot drift:

`setUpEmail(db, user, clientRow, { purpose, who }) -> { ok: true, email: { to, subject, body, links }, who } | { ok: false, code, client? }`

Codes: `do_not_email`, `nmls_missing`, `no_email`, `who_needed`, `invalid` (unknown purpose, or a `who` that is not on the
record), `unavailable`. `draftEmailTool` keeps its current results for the old cases (same `data`, `source` and `compose`
shapes, same order of refusals) and maps the new codes in the same style.

## Three ways to reach it

1. **Ask Charlie.** `draftEmailTool` accepts the four new purposes and an optional `who` (a string). Its description says
   what each is for, that `who` must be a family member named on the client's record, and that nothing is sent.
2. **She offers it when she reads the dates.** One line in the system prompt (`prompt.js`, by the dates guidance): after
   reading dates she may offer to set up the matching email, one client at a time, and never for an occasion already
   marked emailed. `upcomingDatesTool` rows gain `emailed: true` when that occasion's email was marked sent (see below).
3. **A button on each row of Dates Coming Up** (Home, `client/src/App.jsx`). The row keeps opening the client page as
   today; an `Email` button sits at the row's right end and does not trigger the row. Pressing it asks the server for the
   email and shows it under the row: To, Subject, Message, the three open-in links (the same three as Charlie's compose
   card: Gmail, Outlook, other email app) and a `Mark sent` button. A refusal shows one plain line instead:
   - `do_not_email`: `This client is marked do not email.`
   - `no_email`: `No email address on file. Add one on the client's Edit page.`
   - `nmls_missing`: `Save your NMLS ID in Profile first. Every client email carries it.`
   - anything else: `Couldn't set up the email. Try again.`
   The pure pieces (the purpose for an occasion kind, the refusal line for a code, whether a row is emailed) live in a
   `.mjs` module with tests, as the other screens do. No restyling of the card: the additions use its existing styles.

New route: `POST /api/clients/:id/email` with `{ purpose, who? }`, scoped like the other client routes (a broker: the
org's clients; a loan officer: their own). It answers `{ success: true, email: { to, subject, body, links } }` or
`{ success: false, code }` with a 4xx status. It sends nothing and saves nothing.

## Mark sent

A tap that says "I sent it". New route: `POST /api/clients/:id/email-sent` with `{ purpose, who?, date? }`.

- It sets the client's `last_contact` to now (that is what resets the check-in clock), through the same code the
  existing contact route uses for that. It writes **nothing** to `contact_log` (that table is calls only: its `outcome`
  allows `reached` and `not_reached`, and widening it would mean rebuilding a table on the live database), so the client's
  call history is unchanged. It does **not** close open call follow-ups and does **not** count as "reached" for the call
  list. (Decided 2026-11-21 when the builder found the constraint.)
- For an occasion purpose with a `date` (the occasion's date, `YYYY-MM-DD`), it also records the occasion as emailed in a
  new table, `occasion_emails (id, client_id, user_id, kind, who, occasion_date, created_at)`, unique on
  `(client_id, kind, who, occasion_date)`; a second tap changes nothing. `kind` is the occasion kind
  (`birthday`, `spouse_birthday`, `child_birthday`, `wedding`, `loan`, `home`); `who` is `''` when there is none. Created in
  `server/db.js` the way the other tables are (idempotent).
- What reads it:
  - each client the API returns carries `occasionEmails: [{ kind, who, date }]` for occasion dates from 30 days ago
    onward, so a Dates Coming Up row shows `Emailed` (with a check) in place of the `Email` button;
  - `upcomingDatesTool` marks the row `emailed: true`;
  - the morning briefing leaves an emailed occasion out of the dates it reads.
- Charlie's compose card (`ComposeCard` in `client/src/charli/CharliView.jsx`) gets the same `Mark sent` button, for
  every purpose. For that, the tool's `compose` result also carries `clientId`, `purpose`, and, for an occasion purpose
  when that client has a matching occasion coming up within 60 days, `occasion: { kind, who, date }`.
- After a successful `Mark sent` the button reads `Marked sent` and is disabled.

## Out of scope (later, on Bill's word)

Charlie sending by herself; text messages; holidays, closing-day thank-you and after-call notes; rotating wordings;
several clients at once; a lawyer's review of the wording (Bill's step, before this is offered to brokers).

## Tests

Server (`node --test`, `npm test` in `server`): the four templates (exact text, signature lines, `who` rules, no digits
in any body or subject); `setUpEmail` for every code; the tool with the new purposes and `who`; both routes (scoping, each
refusal, nothing saved by the first, what the second writes, a second tap); the table; `occasionEmails` on the client
payload; `emailed` on `upcomingDatesTool`; the briefing leaving an emailed occasion out; the two existing emails
unchanged. Client (`npm test` and `npm run build` in `client`): the pure helpers. Every existing test keeps passing.
