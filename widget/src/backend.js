// Backends: the same calls, via the Widget API or via the client API.
//
// No room_id is passed on any call: the client scopes the widget to the room it
// is pinned in (the "viewed room"). Naming the room explicitly would require the
// org.matrix.msc2762.timeline:<room> capability, which Element prompts for.
//
// State semantics (MSC2762 update_state, matrix-widget-api >= 1.11 / current
// Element Web): the CURRENT state arrives by push — a full `update_state` right
// after capabilities are approved, then one per change — while `read_events`
// for a state type returns the events the client has in its TIMELINE (i.e.
// history, newest first). Older clients never push and answer `read_events`
// with current state instead; `initialState` handles both. See docs/DESIGN.md.
import { WidgetApi, WidgetApiToWidgetAction } from "matrix-widget-api";
import { PAGE_TYPE } from "./spec.js";

export function widgetBackend(api, roomId, userId, pushed) {
  return {
    userId, roomId, mode: "widget",
    async initialState() {
      const first = await pushed.first(1500);
      if (first) return first;
      console.info("no update_state push; falling back to read_events");
      return api.readStateEvents(PAGE_TYPE, 5000);
    },
    async refreshState() { return null; }, // pushes keep the local copy current
    async put(slug, content) {
      const r = await api.sendStateEvent(PAGE_TYPE, slug, content);
      return r.event_id;
    },
    // Recent history only: what the client has in the live timeline.
    async recentHistory() {
      try { return await api.readRoomEvents(PAGE_TYPE, 500); }
      catch (e) { console.warn("readRoomEvents", e); return []; }
    },
    onUpdate(fn) { pushed.listen(fn); },
  };
}

// Listeners must exist before api.start(): the initial update_state can arrive
// before the app has booted. Buffers pushes until someone listens.
export function pushBuffer(api) {
  let buf = [], fn = null, firstResolve = null;
  const deliver = (evs) => {
    if (!evs.length) return;
    if (firstResolve) { firstResolve(evs); firstResolve = null; return; }
    if (fn) fn(evs); else buf.push(...evs);
  };
  api.on(`action:${WidgetApiToWidgetAction.SendEvent}`, (ev) => {
    ev.preventDefault();
    api.transport.reply(ev.detail, {});
    const e = ev.detail.data;
    if (e?.type === PAGE_TYPE && e.state_key !== undefined) deliver([e]);
  });
  api.on(`action:${WidgetApiToWidgetAction.UpdateState}`, (ev) => {
    ev.preventDefault();
    api.transport.reply(ev.detail, {});
    deliver((ev.detail.data?.state || []).filter((e) => e.type === PAGE_TYPE));
  });
  return {
    first(timeoutMs) {
      if (buf.length) { const b = buf; buf = []; return Promise.resolve(b); }
      return new Promise((res) => { firstResolve = res; setTimeout(() => { if (firstResolve) { firstResolve = null; res(null); } }, timeoutMs); });
    },
    listen(f) { fn = f; if (buf.length) { const b = buf; buf = []; fn(b); } },
  };
}

// Creates the WidgetApi, registers the push listeners and requests exactly the
// three capabilities of docs/SPEC.md. The caller awaits `ready` after start().
export function createWidgetApi(widgetId, parentUrl) {
  let clientOrigin = null;
  try { clientOrigin = parentUrl ? new URL(parentUrl).origin : null; } catch {}
  const api = new WidgetApi(widgetId, clientOrigin);
  const pushed = pushBuffer(api);
  api.requestCapabilityToReceiveState(PAGE_TYPE);
  api.requestCapabilityToSendState(PAGE_TYPE);
  api.requestCapabilityToReceiveEvent(PAGE_TYPE); // readRoomEvents for the recent-history view
  const ready = new Promise((res) => api.once("ready", res));
  return { api, pushed, ready };
}

export const canReadPages = (api) => api.hasCapability(`org.matrix.msc2762.receive.state_event:${PAGE_TYPE}`);

export function clientBackend(hs, token, roomId, userId) {
  const q = encodeURIComponent;
  const h = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const call = async (method, path, body) => {
    const r = await fetch(hs + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).error || ""}`);
    return r.json();
  };
  return {
    userId, roomId, mode: "dev",
    async initialState() {
      return (await call("GET", `/_matrix/client/v3/rooms/${q(roomId)}/state`)).filter((e) => e.type === PAGE_TYPE);
    },
    async refreshState() { return this.initialState(); },
    async put(slug, content) {
      return (await call("PUT", `/_matrix/client/v3/rooms/${q(roomId)}/state/${q(PAGE_TYPE)}/${q(slug)}`, content)).event_id;
    },
    async recentHistory() {
      const f = encodeURIComponent(JSON.stringify({ types: [PAGE_TYPE] }));
      return (await call("GET", `/_matrix/client/v3/rooms/${q(roomId)}/messages?dir=b&limit=500&filter=${f}`)).chunk;
    },
    onUpdate() {},
    call,
  };
}
