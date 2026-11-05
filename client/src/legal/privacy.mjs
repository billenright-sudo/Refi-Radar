// Broker Radar Privacy Policy: a first draft for the owner's lawyer (spec §6.6). Plain English on purpose.
// Bracketed items are blanks for the owner or the lawyer. VERSION must equal PRIVACY_VERSION in server/lib/terms.js
// (server/test/terms-version.test.js checks it); a new VERSION makes everyone accept the policy again on next sign-in.

export const VERSION = "2026-11-05";

export const SECTIONS = [
  {
    heading: "About this policy",
    paragraphs: [
      "Draft for legal review — not yet in effect.",
      "This policy explains what [Company legal name] (\"we\", \"us\"), doing business as Broker Radar, a product of Ignite Business Solutions, collects when mortgage brokerages and their users use Broker Radar: what we collect, why, who it goes to, and how long we keep it.",
      "Brokerages put information about their own borrowers into Broker Radar. For that information, the brokerage is in charge and we act on its behalf as its service provider. If you are a borrower, please contact your broker about your information. [lawyer: confirm our role under GLBA and state privacy laws, for example \"service provider\" or \"processor\".]",
    ],
  },
  {
    heading: "What we collect",
    paragraphs: [
      "Account details: each user's name, email address and role, and the NMLS ID and career stage if they add them. Passwords are stored only in a scrambled (hashed) form, never as typed.",
      "Your brokerage's client data: the borrowers you add or import, such as names, contact details, loan balances, rates, credit scores and property values, plus your notes and follow-ups. The import reads only the fields Broker Radar uses and ignores the rest, such as Social Security numbers, dates of birth, income and account numbers.",
      "Conversations with Charlie: what you say or type to Charlie, and its answers. When you speak, your recording is sent to be turned into text. We don't keep the recording.",
      "Google Calendar, only if a user connects it: that user's Google email address and permission to see and manage their calendar events. A user can disconnect at any time.",
      "Billing details: the broker enters card details on Stripe's own page, and card numbers never reach our servers. We keep only what Stripe tells us about the subscription, such as its status, its dates and whether a card is on file.",
      "Terms acceptances: which version of the Terms of Service and this policy each user accepted, when, and from which IP address.",
      "Feedback you send us, with the page you sent it from.",
      "Technical information: basic server records, such as IP addresses, times and errors, to keep the service running and secure.",
    ],
  },
  {
    heading: "Why we use it",
    paragraphs: [
      "To run Broker Radar: show your clients, estimate refinance opportunities, power Charlie, and work with a connected calendar.",
      "To bill the brokerage, through Stripe.",
      "To send the app's emails, such as invitations, sign-up and email-change confirmations, password resets, refinance alerts and the billing confirmation.",
      "To keep accounts and data secure, prevent abuse and fix problems.",
      "To improve Broker Radar using the feedback you send.",
      "To meet our legal duties.",
      "We don't sell personal information and we don't use it for advertising. We use borrowers' information only to provide Broker Radar to their brokerage. [lawyer: confirm this wording works under state privacy laws.]",
    ],
  },
  {
    heading: "Who it goes to",
    paragraphs: [
      "We share information only with the service providers that help us run Broker Radar, and only what each one needs:",
      "Anthropic provides the AI behind Charlie. It receives what you say or type to Charlie and the client details Charlie needs to answer.",
      "ElevenLabs provides Charlie's voice. It receives Charlie's replies to turn into speech, and your recordings to turn into text.",
      "Google receives requests about a user's calendar only when that user has connected Google Calendar, and only to see or change their events as they ask. Broker Radar's use of information received from Google APIs follows the Google API Services User Data Policy, including its Limited Use requirements. [lawyer: confirm this statement.]",
      "Stripe handles payments. It receives the broker's name, email address and card details (entered on Stripe's own page), and the number of users on the subscription.",
      "Google Cloud hosts Broker Radar and stores its data.",
      "Gmail (Google) sends the app's emails. It receives each email and the address it goes to.",
      "Each provider handles information under its own terms. [lawyer: confirm we have data processing terms with each provider, and whether any of them stores data outside the United States.]",
      "We may also share information when the law requires it, to protect our rights or someone's safety, or as part of a sale or merger of the business, under this policy. [lawyer: confirm.]",
    ],
  },
  {
    heading: "Cookies",
    paragraphs: [
      "We use one cookie to keep you signed in. The app can't work without it.",
      "When a user connects Google Calendar, a second, short-lived cookie protects that step. It lasts at most ten minutes and is cleared when the step finishes.",
      "We don't use tracking cookies or analytics cookies, and we don't show advertising.",
    ],
  },
  {
    heading: "How long we keep it",
    paragraphs: [
      "While a brokerage's subscription is active, we keep its data so Broker Radar can work.",
      "If the account pauses, for example after a failed payment, we keep its data. Pausing never deletes anything.",
      "After a brokerage cancels, we keep its data for [N] days, then delete it. [owner: choose N, and say whether accounts paused for a failed payment follow the same rule.]",
      "When the broker removes a loan officer, we keep that user's record so the brokerage's history stays whole, but they can no longer sign in.",
      "We keep billing records and terms acceptances for as long as we need them for legal and tax reasons. [lawyer: confirm how long.]",
      "Backups and server records are kept for [backup and log period], then deleted. [owner: confirm.]",
    ],
  },
  {
    heading: "Security",
    paragraphs: [
      "We protect information with care. Connections use HTTPS. Passwords are stored only in hashed form. Card numbers never reach our servers. Access is limited by role, and loan officers never see the brokerage's billing.",
      "No system is perfectly secure. If we learn of a breach that affects your information, we'll tell the affected brokerage without undue delay, as the law requires. [lawyer: breach notice duties.]",
    ],
  },
  {
    heading: "Your rights and choices",
    paragraphs: [
      "Each user can see and update their own profile in Broker Radar. The broker can download the brokerage's clients as a CSV file at any time, including while the account is paused.",
      "A user can disconnect Google Calendar at any time.",
      "You can ask to see, correct or delete your personal information by emailing [support email]. We'll answer within [response period]. Depending on where you live, state law may give you more rights. [lawyer: list the state rights that apply, such as California's, and how we check who is asking.]",
      "Borrowers: please ask your broker first. We'll help the brokerage respond.",
      "Broker Radar is for business use and is not meant for anyone under 18.",
    ],
  },
  {
    heading: "Changes to this policy",
    paragraphs: [
      "When we change this policy, we update its version date and ask everyone to accept the new version the next time they sign in.",
    ],
  },
  {
    heading: "Contact",
    paragraphs: [
      "Questions about privacy: [support email].",
      "[Company legal name], doing business as Broker Radar, a product of Ignite Business Solutions. [mailing address]",
    ],
  },
];
