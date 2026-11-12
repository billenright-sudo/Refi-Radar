import { navItems } from "./nav.mjs";

const SAME = new Set(["home", "sweeps", "clients", "rates", "team", "profile", "billing"]);

// What the app has open now, as Charlie's session reports it. -> { page, clientId? } | null
// (final review M4, R15) one loan officer's portal is no page she knows (null), so "take me to My Team" from it opens the team list.
export function onScreenOf({ view, selectedId, importHasFile } = {}) {
  if (view === "client-detail") return Number.isInteger(selectedId) && selectedId > 0 ? { page: "client", clientId: selectedId } : null;
  if (view === "add" || view === "edit") return { page: "form" };
  if (view === "import") return { page: importHasFile ? "form" : "import" };
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

// The App preparing the screen a turn of Charlie's asked to open (App.jsx prepareScreen hands it its state and setters):
//   app: { screenNow, clients, reloadClients, role, billingOn, isPhone, setSelected, setView, setPanelOpen, scrollTo }
//   -> { ok: true, go } | { ok: false, reason: "form" | "missing" | "not-allowed" }
// A form open keeps the page (A2), checked first and again last (final review I4): a form the broker opened by hand while the client
// list was re-read is caught, and nothing waits between that check and the return. A client not in the list is looked for once more
// (one reload; a failed one is "missing"); a page must be in the user's sidebar. go() shows the page, sets her panel, and scrolls the
// window to the top (final review I3, R12: the page asked for is what they see; hand navigation is unchanged).
export async function prepareScreenFor(screen, app) {
  if (!screen) return { ok: false, reason: "missing" };
  const formOpen = () => app.screenNow()?.page === "form";
  if (formOpen()) return { ok: false, reason: "form" };
  let client = null;
  if (screen.page === "client") {
    const find = (list) => (list || []).find(x => x.id === screen.clientId) || null;
    client = find(app.clients);
    if (!client) {
      let fresh = null;
      try { fresh = await app.reloadClients(); } catch { fresh = null; }
      client = find(fresh);
    }
    if (!client) return { ok: false, reason: "missing" };
  } else if (!pageAllowed(screen.page, app.role, app.billingOn)) {
    return { ok: false, reason: "not-allowed" };
  }
  if (formOpen()) return { ok: false, reason: "form" };
  const target = viewForScreen(screen);
  const go = () => {
    if (client) app.setSelected(client);
    app.setView(target);
    app.setPanelOpen(panelAfter({ target, isPhone: app.isPhone() }) === "open");
    app.scrollTo(0, 0);
  };
  return { ok: true, go };
}
