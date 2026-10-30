// The sidebar's items and the page the app opens on. Pure data: App.jsx draws it (Sidebar) and owns which view is showing.
//
// Charlie is the main page: "home" is Charlie's page (CharliView mode="home"), and every other page gets a corner Charlie button
// that opens the same conversation in a panel (CharliView mode="panel"). The old Dashboard is "overview".
// An item is { id, label, icon }; `icon` is a name App.jsx's Icon knows.

export const DEFAULT_VIEW = "home";

const MAIN = [
  { id: "home",     label: "Home",        icon: "mic" },
  { id: "sweeps",   label: "Sweeps",      icon: "search" },
  { id: "clients",  label: "All Clients", icon: "users" },
  { id: "rates",    label: "Rate Watch",  icon: "trending" },
  { id: "overview", label: "Overview",    icon: "dashboard" },
  { id: "add",      label: "Add Client",  icon: "plus" },
];

// Only a broker has a team and imports clients.
const BROKER = [
  { id: "team",   label: "My Team",        icon: "users" },
  { id: "import", label: "Import Clients", icon: "upload" },
];

const BOTTOM = [
  { id: "profile", label: "Profile", icon: "user" },
];

const fresh = (items) => items.map((item) => ({ ...item }));

// The items in the three runs the sidebar draws: the main ones, the broker's (below a rule), and the bottom one. -> { main, broker, bottom }
export function navGroups(role) {
  return { main: fresh(MAIN), broker: role === "broker" ? fresh(BROKER) : [], bottom: fresh(BOTTOM) };
}

// All of them in order, for a role ("broker" | "lo"; anything else is a loan officer's).
export function navItems(role) {
  const { main, broker, bottom } = navGroups(role);
  return [...main, ...broker, ...bottom];
}
