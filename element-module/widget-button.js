/*
 * mxwiki — optional Element Web runtime module (config.json "modules"). Adds a
 * "Wiki" button to the room header, next to video call / threads / room info,
 * whenever the current room has the mxwiki widget pinned. Clicking toggles the
 * widget in the right panel, exactly like the Extensions card does.
 *
 * Configuration (config.json):
 *   "modules": ["/modules/widget-button.js"],
 *   "com.knatrix.mxwiki": { "host": "wiki.example.org", "path": "/" }
 *
 * Detection: a room widget (im.vector.modular.widgets) whose URL host equals
 * the configured host and whose path starts with the configured path, or whose
 * name is "Wiki". No button is added in rooms without the widget, so loading
 * this module on a server without a wiki is harmless.
 *
 * Element has no room-header extension point, so the button is inserted into
 * the header DOM with a MutationObserver: it is a clone of an existing Compound
 * icon button (class `_icon-button_…`), which keeps it styled across class-hash
 * changes. If Element's header markup changes and no header or template button
 * is found, the module does nothing — the wiki itself stays reachable from the
 * room's Extensions panel. See README for the Element versions it was checked on.
 */

const CONFIG_KEY = "com.knatrix.mxwiki";
const MARK = "mxwiki-button";
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M6 3h11a3 3 0 0 1 3 3v12.5a.5.5 0 0 1-.5.5H7a1 1 0 0 0 0 2h12a1 1 0 1 1 0 2H6.5A2.5 2.5 0 0 1 4 20.5V5a2 2 0 0 1 2-2m1 2v12h10V6a1 1 0 0 0-1-1zm2 3h6a1 1 0 1 1 0 2H9a1 1 0 0 1 0-2m0 4h6a1 1 0 1 1 0 2H9a1 1 0 0 1 0-2"/>' +
  "</svg>";

export default class MxwikiButtonModule {
  static moduleApiVersion = "^1.0.0";

  constructor(api) {
    this.api = api;
    this.host = null;
    this.path = "/";
    this.observer = null;
    this.scheduled = false;
  }

  async load() {
    try {
      const cfg = this.api.config.get(CONFIG_KEY);
      this.host = (cfg && cfg.host) || null;
      this.path = (cfg && cfg.path) || "/";
    } catch (_) {
      this.host = null;
    }
    const start = () => {
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(document.body, { childList: true, subtree: true });
      this.schedule();
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  // Coalesce bursts of DOM mutations into one pass per frame.
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      try {
        this.sync();
      } catch (e) {
        console.warn("[mxwiki-button]", e);
      }
    });
  }

  ctx() {
    return window.mxSdkContext || null;
  }

  currentRoom() {
    const ctx = this.ctx();
    const client = ctx && ctx.client;
    const roomId = ctx && ctx.roomViewStore && ctx.roomViewStore.getRoomId();
    return client && roomId ? client.getRoom(roomId) : null;
  }

  wikiWidget(room) {
    const ctx = this.ctx();
    if (!ctx || !room) return null;
    const apps = ctx.widgetStore.getApps(room.roomId) || [];
    return (
      apps.find((app) => {
        try {
          const u = new URL(app.url);
          return !!this.host && u.host === this.host && u.pathname.startsWith(this.path);
        } catch (_) {
          return false;
        }
      }) ||
      apps.find((app) => (app.name || "").trim().toLowerCase() === "wiki") ||
      null
    );
  }

  isActive(room, app) {
    const ctx = this.ctx();
    if (!ctx || !ctx.rightPanelStore.isOpenForRoom(room.roomId)) return false;
    const card = ctx.rightPanelStore.currentCardForRoom(room.roomId);
    return !!card && card.phase === "Widget" && !!card.state && card.state.widgetId === app.id;
  }

  sync() {
    const header = document.querySelector(".mx_RoomHeader");
    const existing = header && header.querySelector("." + MARK);
    if (!header) return;

    const room = this.currentRoom();
    const app = this.wikiWidget(room);
    if (!app) {
      if (existing) existing.remove();
      return;
    }

    // Template: the last Compound icon button that is a direct child of the
    // header (room info). Falls back to any icon button.
    const iconButtons = Array.from(header.children).filter(
      (el) => el.tagName === "BUTTON" && /_icon-button_/.test(el.className)
    );
    const template = iconButtons.filter((b) => !b.classList.contains(MARK)).pop();
    if (!template) return;

    let btn = existing;
    if (!btn) {
      btn = template.cloneNode(true);
      btn.classList.add(MARK);
      btn.removeAttribute("aria-labelledby");
      btn.removeAttribute("aria-describedby");
      btn.removeAttribute("data-indicator");
      btn.removeAttribute("id");
      const inner = btn.firstElementChild;
      if (inner) {
        inner.removeAttribute("data-indicator");
        inner.innerHTML = ICON;
      } else {
        btn.innerHTML = ICON;
      }
      btn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.toggle();
      });
    }
    const label = (app.name && app.name.trim()) || "Wiki";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.dataset.roomId = room.roomId;
    btn.dataset.active = this.isActive(room, app) ? "true" : "false";

    // Keep it immediately before the room-info button.
    if (btn.nextElementSibling !== template) {
      header.insertBefore(btn, template);
    }
  }

  toggle() {
    const ctx = this.ctx();
    const room = this.currentRoom();
    const app = this.wikiWidget(room);
    if (!ctx || !room || !app) return;
    if (this.isActive(room, app)) {
      ctx.rightPanelStore.togglePanel(room.roomId);
    } else {
      if (!ctx.widgetLayoutStore.isInContainer(room, app, "right")) {
        ctx.widgetLayoutStore.moveToContainer(room, app, "right");
      }
      ctx.rightPanelStore.setCard({ phase: "Widget", state: { widgetId: app.id } }, true, room.roomId);
      if (!ctx.rightPanelStore.isOpenForRoom(room.roomId)) ctx.rightPanelStore.show(room.roomId);
    }
    this.schedule();
  }
}
