/**
 * RefiRadar — Demo Data Seeder
 * Usage: node scripts/seed-demo.js [APP_URL]
 *
 * Creates a demo broker account and loads 12 realistic clients.
 * Safe to re-run — skips registration if account already exists.
 *
 * Demo credentials:
 *   Email:    demo@refiradar.com
 *   Password: DemoPass123!
 *   Brokerage: Premier Mortgage Group
 */

const APP_URL = process.argv[2] || "https://refi-radar-194747178897.us-central1.run.app";

const BROKER = {
  firstName: "Bill",
  lastName:  "Enright",
  email:     "demo@refiradar.com",
  password:  "DemoPass123!",
  orgName:   "Premier Mortgage Group",
};

// 12 clients — mix of high priority, medium, and monitoring
// Rates reflect a market where 30yr is ~6.75%
const CLIENTS = [
  // ── HIGH PRIORITY (rate delta ≥ 1.0%, break-even ≤ 24 months) ──────────
  {
    name:          "Robert & Linda Chen",
    email:         "rchen@email.com",
    phone:         "(555) 010-1234",
    loanType:      "30yr_fixed",
    currentRate:   7.85,
    loanBalance:   485000,
    propertyValue: 650000,
    closeDate:     "2022-08-15",
    creditScore:   760,
    notes:         "Referred by James at Title Co. ARM adjusting in 3 months — very motivated.",
  },
  {
    name:          "Jennifer & Carlos Lopez",
    email:         "jlopez@email.com",
    phone:         "(555) 010-4567",
    loanType:      "5_1_arm",
    currentRate:   8.25,
    loanBalance:   560000,
    propertyValue: 720000,
    closeDate:     "2022-11-30",
    creditScore:   720,
    notes:         "ARM adjusting next quarter. High urgency — call this week.",
  },
  {
    name:          "Michael Thompson",
    email:         "mthompson@email.com",
    phone:         "(555) 010-6789",
    loanType:      "30yr_fixed",
    currentRate:   8.10,
    loanBalance:   425000,
    propertyValue: 580000,
    closeDate:     "2022-06-18",
    creditScore:   755,
    notes:         "Phone contact only — do not email. Best time to call: mornings.",
  },
  {
    name:          "Carlos & Maria Reyes",
    email:         "creyes@email.com",
    phone:         "(555) 010-8901",
    loanType:      "30yr_fixed",
    currentRate:   7.65,
    loanBalance:   390000,
    propertyValue: 510000,
    closeDate:     "2022-09-22",
    creditScore:   748,
    notes:         "Interested in cash-out refi to fund home renovation. Equity strong.",
  },

  // ── MEDIUM PRIORITY (rate delta 0.5–0.99%) ──────────────────────────────
  {
    name:          "Marcus Williams",
    email:         "mwilliams@email.com",
    phone:         "(555) 010-2345",
    loanType:      "30yr_fixed",
    currentRate:   7.25,
    loanBalance:   320000,
    propertyValue: 420000,
    closeDate:     "2023-02-20",
    creditScore:   740,
    notes:         "",
  },
  {
    name:          "Aisha Johnson",
    email:         "ajohnson@email.com",
    phone:         "(555) 010-7890",
    loanType:      "15yr_fixed",
    currentRate:   7.40,
    loanBalance:   178000,
    propertyValue: 310000,
    closeDate:     "2023-01-12",
    creditScore:   810,
    notes:         "Excellent credit. Has asked about 15→30 yr refi to lower monthly payment.",
  },
  {
    name:          "Patricia & James Moore",
    email:         "pmoore@email.com",
    phone:         "(555) 010-3344",
    loanType:      "30yr_fixed",
    currentRate:   7.35,
    loanBalance:   295000,
    propertyValue: 440000,
    closeDate:     "2023-03-08",
    creditScore:   775,
    notes:         "Recently promoted — income increased. Good candidate for accelerated payoff.",
  },
  {
    name:          "David & Amy Kowalski",
    email:         "dkowalski@email.com",
    phone:         "(555) 010-5678",
    loanType:      "30yr_fixed",
    currentRate:   7.15,
    loanBalance:   185000,
    propertyValue: 290000,
    closeDate:     "2023-09-05",
    creditScore:   785,
    notes:         "",
  },

  // ── MONITORING (rate delta < 0.5% or break-even > 36 months) ───────────
  {
    name:          "Sarah & Tom Patel",
    email:         "spatel@email.com",
    phone:         "(555) 010-3456",
    loanType:      "15yr_fixed",
    currentRate:   6.90,
    loanBalance:   215000,
    propertyValue: 380000,
    closeDate:     "2023-06-10",
    creditScore:   800,
    notes:         "Self-employed — will need 2 years tax returns. Watch rates through Q3.",
  },
  {
    name:          "Kevin Nguyen",
    email:         "knguyen@email.com",
    phone:         "(555) 010-9012",
    loanType:      "30yr_fixed",
    currentRate:   6.50,
    loanBalance:   142000,
    propertyValue: 195000,
    closeDate:     "2024-01-20",
    creditScore:   790,
    notes:         "Recent purchase. Too early for refi — revisit in 18 months.",
  },
  {
    name:          "Deborah & Frank Sullivan",
    email:         "dsullivan@email.com",
    phone:         "(555) 010-5566",
    loanType:      "30yr_fixed",
    currentRate:   6.75,
    loanBalance:   312000,
    propertyValue: 490000,
    closeDate:     "2023-11-15",
    creditScore:   762,
    notes:         "Happy with current payment. Would refi if rates drop below 6%.",
  },
  {
    name:          "Anthony & Brenda Washington",
    email:         "awashington@email.com",
    phone:         "(555) 010-7711",
    loanType:      "5_1_arm",
    currentRate:   6.85,
    loanBalance:   198000,
    propertyValue: 275000,
    closeDate:     "2024-03-01",
    creditScore:   733,
    notes:         "ARM still in fixed period. Set reminder to contact 6 months before adjustment.",
  },
];

// ── helpers ────────────────────────────────────────────────────────────────

let cookie = "";

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res  = await fetch(`${APP_URL}${path}`, opts);

  // Capture Set-Cookie header on login/register
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function pad(s, n) { return String(s).padEnd(n); }
function green(s)  { return `\x1b[32m${s}\x1b[0m`; }
function amber(s)  { return `\x1b[33m${s}\x1b[0m`; }
function red(s)    { return `\x1b[31m${s}\x1b[0m`; }
function bold(s)   { return `\x1b[1m${s}\x1b[0m`; }

// ── main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(bold("\n🏠 RefiRadar — Demo Seeder"));
  console.log(`   Target: ${APP_URL}\n`);

  // 1. Register demo broker (or log in if already exists)
  process.stdout.write("  Creating broker account… ");
  const reg = await api("POST", "/api/auth/register", BROKER);

  if (reg.status === 201) {
    console.log(green("✓ Registered"));
  } else if (reg.status === 409) {
    process.stdout.write(amber("already exists, logging in… "));
    const login = await api("POST", "/api/auth/login", { email: BROKER.email, password: BROKER.password });
    if (login.status !== 200) {
      console.log(red(`✗ Login failed: ${login.data?.error}`));
      process.exit(1);
    }
    console.log(green("✓ Logged in"));
  } else {
    console.log(red(`✗ Failed (${reg.status}): ${reg.data?.error}`));
    process.exit(1);
  }

  // 2. Load clients
  console.log(`\n  Loading ${CLIENTS.length} clients:\n`);
  let ok = 0, skip = 0;

  for (const c of CLIENTS) {
    process.stdout.write(`    ${pad(c.name, 32)}`);
    const r = await api("POST", "/api/clients", c);
    if (r.status === 201) {
      console.log(green("✓"));
      ok++;
    } else {
      console.log(amber(`skipped (${r.data?.error || r.status})`));
      skip++;
    }
  }

  // 3. Summary
  console.log(`
  ─────────────────────────────────────────
  ${green(`✓ ${ok} clients imported`)}${skip ? `  ${amber(`${skip} skipped`)}` : ""}

  ${bold("Demo login credentials:")}
    URL:      ${APP_URL}
    Email:    ${BROKER.email}
    Password: ${BROKER.password}

  ${bold("Client mix:")}
    🔥 High Priority   — 4 clients (rate delta ≥ 1.0%)
    ⚡ Refi Ready      — 4 clients (rate delta 0.5–0.99%)
    👁  Monitoring      — 4 clients (watching)
  ─────────────────────────────────────────
`);
})();
