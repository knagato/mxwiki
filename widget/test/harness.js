// A stand-in for Element: hosts the widget in an iframe and answers its Widget
// API requests with a WidgetDriver built on the plain client API. Lets the
// widget-side code be exercised end to end without an Element session.
// Open via test/run.mjs (headless) or by hand:
//   http://localhost:5180/test/harness.html?hs=...&token=...&room=!id&user=@u:s
import { ClientWidgetApi, Widget, WidgetDriver } from "matrix-widget-api";
import { WIDGET_ID } from "../src/spec.js";

const p = new URLSearchParams(location.search);
const HS = p.get("hs").replace(/\/$/, ""), TOKEN = p.get("token"), ROOM = p.get("room"), USER = p.get("user");
const log = (...a) => { const el = document.getElementById("log"); if (el) el.textContent += a.join(" ") + "\n"; console.log("[harness]", ...a); };
const q = encodeURIComponent;
const call = async (m, path, body) => {
  const r = await fetch(HS + path, { method: m, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(m + " " + path + " -> " + r.status);
  return r.json();
};

// Mirrors Element Web's driver: readRoomState = current state, readRoomTimeline
// = what the client has loaded of the timeline (here: the last 100 events).
class Driver extends WidgetDriver {
  async validateCapabilities(requested) { log("capabilities:", [...requested].join(", ")); window.harness.capabilities = [...requested]; return requested; }
  async sendEvent(type, content, stateKey, roomId) {
    const rid = roomId || ROOM;
    if (stateKey !== null && stateKey !== undefined) {
      const r = await call("PUT", `/_matrix/client/v3/rooms/${q(rid)}/state/${q(type)}/${q(stateKey)}`, content);
      log("sent state", type, stateKey, r.event_id);
      return { roomId: rid, eventId: r.event_id };
    }
    const r = await call("PUT", `/_matrix/client/v3/rooms/${q(rid)}/send/${q(type)}/h${Date.now()}`, content);
    return { roomId: rid, eventId: r.event_id };
  }
  async readRoomState(roomId, type, stateKey) {
    const st = await call("GET", `/_matrix/client/v3/rooms/${q(roomId)}/state`);
    const out = st.filter((e) => e.type === type && (stateKey === undefined || e.state_key === stateKey));
    log("readRoomState", type, stateKey ?? "*", "->", out.length);
    return out;
  }
  async readRoomTimeline(roomId, type, msgtype, stateKey, limit) {
    const r = await call("GET", `/_matrix/client/v3/rooms/${q(roomId)}/messages?dir=b&limit=100`);
    const out = r.chunk.filter((e) => e.type === type && (stateKey === undefined || e.state_key === stateKey)).slice(0, limit || 100);
    log("readRoomTimeline", type, "->", out.length);
    return out;
  }
  getKnownRooms() { return [ROOM]; }
}

const iframe = document.getElementById("w");
const widget = new Widget({
  id: WIDGET_ID, creatorUserId: USER, type: "m.custom", name: "Wiki",
  url: `${location.origin}/?roomId=$matrix_room_id&widgetId=$matrix_widget_id&userId=$matrix_user_id`,
});
const api = new ClientWidgetApi(widget, iframe, new Driver());
api.setViewedRoomId(ROOM); // what Element does for a widget pinned in the open room
api.on("preparing", () => log("preparing"));
api.on("ready", () => log("ready"));
window.harness = { api, call, ROOM, USER, capabilities: null,
  // pretend a remote edit arrived (what Element does after /sync)
  feed: (ev) => api.feedEvent(ev, ROOM),
  feedState: (ev) => api.feedStateUpdate(ev),
};
iframe.src = widget.getCompleteUrl({ widgetRoomId: ROOM, currentUserId: USER, clientId: "harness", clientTheme: "light", clientLanguage: "ja" });
log("iframe:", iframe.src);
