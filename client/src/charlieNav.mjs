import { navItems } from "./nav.mjs";

const SAME = new Set(["home", "sweeps", "clients", "rates", "team", "profile", "billing"]);

// What the app has open now, as Charlie's session reports it. -> { page, clientId? } | null
export function onScreenOf({ view, selectedId, importHasFile } = {}) {
  if (view === "client-detail") return Number.isInteger(selectedId) && selectedId > 0 ? { page: "client", clientId: selectedId } : null;
  if (view === "add" || view === "edit") return { page: "form" };
  if (view === "import") return { page: importHasFile ? "form" : "import" };
  if (view === "lo-portal") return { page: "team" };
  if (SAME.has(view)) return { page: view };
  return null;
}

// Is this page in the sidebar for this role (billing only while it is on)?
export function pageAllowed(page, role, billingOn) {
  return navItems(role, { billing: Boolean(billingOn) }).some(i => i.id === page);
}

// After she opens a screen: her corner panel stays open, or closes (Home shows her dock; a phone's panel fills the screen).
export function panelAfter({ target, isPhone }) {
  if (target === "home" || isPhone) return "close";
  return "open";
}

// The app's view name for a screen.
export function viewForScreen(screen) {
  return screen && screen.page === "client" ? "client-detail" : screen.page;
}
