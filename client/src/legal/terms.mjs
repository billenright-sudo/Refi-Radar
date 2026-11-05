// Broker Radar Terms of Service: a first draft for the owner's lawyer (spec §6.6). Plain English on purpose.
// Bracketed items are blanks for the owner or the lawyer. VERSION must equal TERMS_VERSION in server/lib/terms.js
// (server/test/terms-version.test.js checks it); a new VERSION makes everyone accept the terms again on next sign-in.

export const VERSION = "2026-11-05";

export const SECTIONS = [
  {
    heading: "About these terms",
    paragraphs: [
      "Draft for legal review — not yet in effect.",
      "These terms are an agreement between [Company legal name] (\"we\", \"us\"), doing business as Broker Radar, a product of Ignite Business Solutions, and the mortgage brokerage that signs up (\"you\"). [lawyer: confirm the contracting entity and how Ignite Business Solutions should be described.]",
      "You agree to these terms by ticking \"I agree to the Terms of Service and Privacy Policy\" when you create an account. The person who signs up confirms they have authority to agree for the brokerage. Each loan officer agrees to the same terms when accepting an invitation. [lawyer: confirm this is enough to bind the brokerage.]",
      "Our Privacy Policy explains how we handle personal information. It is part of these terms.",
    ],
  },
  {
    heading: "The service",
    paragraphs: [
      "Broker Radar is online software for mortgage brokerages. It keeps your book of clients in one place, estimates when a refinance may make sense for them, and helps you plan follow-ups.",
      "It includes Charlie, an AI voice co-pilot. You can talk to Charlie or type to it. If a user connects their own Google Calendar, Charlie can see and manage that user's calendar events when asked.",
      "Charlie uses artificial intelligence and can make mistakes. Check anything important before you rely on it.",
      "Broker Radar is a tool for professionals. We are not a lender, we don't make loans, and we don't give financial, legal or tax advice.",
    ],
  },
  {
    heading: "Accounts and users",
    paragraphs: [
      "The person who signs up is the broker. The broker runs the brokerage's account and is the only person who sees prices and billing.",
      "The broker can invite loan officers. A loan officer who accepts an invitation becomes a user. A pending invitation is not a user.",
      "The broker can remove a loan officer at any time. A removed loan officer can no longer sign in, and their clients move to the broker.",
      "Each person needs their own sign-in. Don't share passwords or accounts. You are responsible for what happens under your brokerage's accounts. Tell us at [support email] straight away if you think someone has used an account without permission.",
      "You must be at least 18, give accurate details when you sign up, and use Broker Radar for your business.",
    ],
  },
  {
    heading: "Price",
    paragraphs: [
      "Broker Radar costs $99 a month for your brokerage, which includes the broker, plus $49 for each additional user.",
      "A user is anyone in your brokerage who can sign in: the broker, plus each loan officer who has accepted an invitation. For example, 1 user is $99 a month, 3 users are $197 a month, and 10 users are $540 a month.",
      "Prices are in US dollars. [owner: say whether sales tax will be added.]",
      "We may change the price. If we do, we'll tell the broker at least [notice period] before the new price applies, and you can cancel before then. [lawyer: confirm the notice period.]",
    ],
  },
  {
    heading: "Free trial and free test month",
    paragraphs: [
      "New brokerages get a 14-day free trial. The broker enters a card when signing up, on a page run by Stripe, our payment company. We charge nothing during the trial.",
      "On day 15 we start charging $99 a month, plus $49 for each additional user, until you cancel. If you cancel before day 15, you are not charged, and you can keep using Broker Radar until the trial ends.",
      "Invited testers who sign up with a tester code get a free 30-day test month instead. No card is needed. Before the month ends, we ask the broker to add a card. With a card, the first charge is on day 31. Without one, your account pauses when the month ends.",
      "Each brokerage gets one free trial or test month. If you come back after cancelling, there is no second free trial: the monthly charge starts the day you restart.",
      "We may stop offering tester codes, or end a tester code, at any time. This doesn't shorten a test month that has already started.",
    ],
  },
  {
    heading: "Automatic monthly billing",
    paragraphs: [
      "Your subscription renews automatically. We charge the broker's card each month, for the month ahead, until you cancel.",
      "When a loan officer accepts an invitation, or the broker removes one, your monthly charge changes. The change is prorated: for the rest of that month you pay, or are credited, only for the days left. The adjustment shows on your next bill.",
      "The broker can see invoices and update the card in Billing → Manage billing.",
      "Apart from those prorated adjustments, we don't refund or credit partial months, including when you cancel. [lawyer: confirm the no-refund wording.]",
      "[lawyer: check the automatic-renewal laws that apply (for example, California's) for the wording, sign-up disclosures and reminders they require.]",
    ],
  },
  {
    heading: "Cancelling",
    paragraphs: [
      "The broker can cancel at any time in Billing → Manage billing. You don't need to contact us.",
      "After you cancel, Broker Radar keeps working until the end of the month you have paid for, or until your trial or test month ends. We don't charge you again after that.",
      "Cancelling doesn't delete your data straight away. See \"When your subscription ends\" below.",
    ],
  },
  {
    heading: "Failed payments and pausing",
    paragraphs: [
      "If a payment fails, we try the card again for up to 14 days. Broker Radar keeps working during that time, and the broker sees a notice asking them to update the card.",
      "If the payment still hasn't gone through after 14 days, the subscription ends and your account pauses.",
      "While your account is paused, loan officers can't use Broker Radar. The broker can still sign in, add a card or restart the subscription, and download your clients as a CSV file.",
      "Pausing never deletes your data. We keep it while your account is paused.",
    ],
  },
  {
    heading: "Your data",
    paragraphs: [
      "Your brokerage owns the data it puts into Broker Radar, including its client list. In these terms we call it \"your data\".",
      "You let us store, copy and process your data only as needed to run Broker Radar for you, keep it secure and give you support. We don't sell your data and we don't use it for advertising. [lawyer: confirm this wording works under state privacy laws.]",
      "The broker can download your clients as a CSV file at any time, including while your account is paused.",
      "We use a few service providers to run Broker Radar. They process your data for us: Anthropic (the AI behind Charlie), ElevenLabs (Charlie's voice), Google (only when a user connects their Google Calendar), Stripe (payments) and Google Cloud (hosting). The app's emails are sent through Gmail. Our Privacy Policy says what each one receives.",
    ],
  },
  {
    heading: "Borrower information: your responsibilities",
    paragraphs: [
      "Your data will include information about your borrowers, such as names, contact details, loan balances, rates, credit scores and property values.",
      "You are responsible for having the right to upload this information, and to use it the way you do in Broker Radar, including to contact borrowers.",
      "You are responsible for complying with the laws that protect it, including the Gramm-Leach-Bliley Act (GLBA) and its privacy and safeguards rules, state privacy laws, and the rules on contacting consumers by phone, text and email. [lawyer: list the laws that apply, and confirm our role as the brokerage's service provider under GLBA and state law.]",
      "We handle borrower information on your behalf, only to provide Broker Radar to you. [lawyer: say whether a separate data processing agreement or GLBA service-provider terms are needed.]",
      "Only upload what Broker Radar needs. The import reads only the fields it uses and ignores the rest, such as Social Security numbers, dates of birth, income and account numbers.",
      "If we learn of a security breach that affects your data, we'll tell the broker without undue delay. If you learn that borrower information in Broker Radar was misused, tell us at [support email]. [lawyer: breach notice timing and each side's duties.]",
    ],
  },
  {
    heading: "When your subscription ends",
    paragraphs: [
      "Your subscription ends when you cancel and the paid month, trial or test month runs out; when a failed payment isn't fixed within 14 days; or when a test month ends without a card. Your account then pauses.",
      "After you cancel, we keep your brokerage's data for [N] days, then delete it. Until then, the broker can sign in, download your clients as a CSV file, or restart the subscription.",
      "[owner: say whether an account paused for a failed payment, or for a test month that ended without a card, is also deleted after [N] days, or kept until you decide.]",
      "[lawyer: confirm the notice we give before deleting, and any records we must keep longer by law.]",
    ],
  },
  {
    heading: "Acceptable use",
    paragraphs: [
      "Use Broker Radar only for your brokerage's lawful business.",
      "Don't use it to break the law, including lending, fair-lending, privacy and consumer-contact laws. Don't upload data you have no right to use. Don't try to get into other accounts, our systems or our providers' systems. Don't copy, resell or rebuild Broker Radar, overload it, or scrape it with automated tools. Don't use Charlie to create anything harmful, misleading or unlawful.",
      "We may suspend a user or an account that breaks these rules or puts other customers or our systems at risk. Where we reasonably can, we'll tell the broker first. [lawyer: confirm suspension and termination rights.]",
    ],
  },
  {
    heading: "Feedback",
    paragraphs: [
      "Anyone signed in can send us feedback from inside Broker Radar. We read it.",
      "We may use your feedback to improve Broker Radar, without paying you or owing you anything for it.",
      "Please don't put borrowers' personal information in feedback.",
    ],
  },
  {
    heading: "Availability and changes to the service",
    paragraphs: [
      "We work to keep Broker Radar running, but we can't promise it will always be available or free of errors. It may be down for maintenance, for updates, or because of problems outside our control, including problems at our service providers.",
      "We may change, add or remove features. If we remove something important that you rely on, we'll tell the broker first.",
    ],
  },
  {
    heading: "Rate estimates and other disclaimers",
    paragraphs: [
      "Rates, payments and savings shown in Broker Radar are estimates. They are not loan offers, rate quotes or commitments to lend, and they are not financial advice.",
      "Charlie's answers and suggestions come from AI and can be wrong. Check them before you rely on them.",
      "Your brokerage makes its own lending decisions and is responsible for its own compliance, including licensing, disclosures, fair lending and the rules on contacting consumers.",
      "Broker Radar is provided \"as is\" and \"as available\". [lawyer: warranty disclaimer wording.]",
    ],
  },
  {
    heading: "Limitation of liability",
    paragraphs: [
      "[lawyer: limitation of liability. For example: no liability for indirect or lost-profit damages, or for decisions made on estimates or Charlie's suggestions, and a cap on total liability at the fees paid in the [12] months before the claim.]",
      "[lawyer: indemnity. For example: the brokerage covers our costs if a claim arises from borrower data it had no right to upload, or from its breaking the law.]",
    ],
  },
  {
    heading: "Governing law",
    paragraphs: [
      "These terms are governed by the laws of the State of [State], without regard to its conflict-of-laws rules. [lawyer: choose courts or arbitration, the venue, and whether to include a class-action waiver.]",
    ],
  },
  {
    heading: "Changes to these terms",
    paragraphs: [
      "We may update these terms. When we do, we change the version date and ask everyone to accept the new version the next time they sign in. You can't keep using Broker Radar until you accept. If you don't agree, the broker can cancel.",
      "A price rise always comes with notice first, as the Price section says.",
      "[lawyer: confirm that accepting on next sign-in is enough for changes to take effect.]",
    ],
  },
  {
    heading: "Contact",
    paragraphs: [
      "Questions about these terms: [support email].",
      "[Company legal name], doing business as Broker Radar, a product of Ignite Business Solutions. [mailing address]",
    ],
  },
];
