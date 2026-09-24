// mxwiki widget. One page = one state event `com.knatrix.mxwiki.page`
// (state_key = slug) whose content carries the Markdown body (docs/SPEC.md,
// Profile S). Inside Element this runs as a room widget and talks to the room
// through the Widget API (no login of its own). Outside Element (vite dev, or
// the URL opened directly) it falls back to a dev mode that talks to the client
// API with a pasted access token.
import "./style.css";
import { PAGE_TYPE, MAX_BODY } from "./spec.js";
import { isValidSlug, folderOf, byteLength } from "./slug.js";
import { render, sanitize, fmtTs, short } from "./render.js";
import { widgetBackend, clientBackend, createWidgetApi, canReadPages } from "./backend.js";
import { t, fmtDate, applyStrings } from "./strings.js";

const collapsed = new Set(JSON.parse(localStorage.getItem("mxwiki.collapsed") || "[]"));
function toggleFolder(path) {
  collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path);
  localStorage.setItem("mxwiki.collapsed", JSON.stringify([...collapsed]));
  renderList();
}

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let be;                 // backend
let pages = new Map();  // slug -> {slug,title,body,updated_by,updated_at,event_id,deleted}
let current = null;     // slug
let view = "read";      // read | edit | history
let isNew = false;
let editBase = null;    // event_id of the version the editor was opened on

// Keeps the newest version per slug, so it is safe to feed it timeline
// history (several versions of one page, any order) as well as state.
function ingest(events) {
  for (const e of events) {
    if (e.state_key === undefined || e.state_key === null) continue;
    const prev = pages.get(e.state_key);
    if (prev && e.origin_server_ts && prev.ts && e.origin_server_ts < prev.ts) continue;
    const c = e.content || {};
    pages.set(e.state_key, {
      ts: e.origin_server_ts || Date.now(),
      slug: e.state_key, title: c.title || e.state_key, body: c.body || "",
      updated_by: c.updated_by || e.sender, updated_at: c.updated_at, event_id: e.event_id,
      deleted: !c.title && !c.body,
    });
  }
}

function livePages() {
  return [...pages.values()].filter((p) => !p.deleted).sort((a, b) => a.slug.localeCompare(b.slug));
}

function renderList() {
  const ul = $("pages"); ul.innerHTML = "";
  const f = $("filter").value.trim().toLowerCase();
  const shown = livePages().filter((p) => !f || (p.slug + " " + p.title).toLowerCase().includes(f));
  // Build a tree: folders first (alphabetical), then pages.
  const root = { folders: new Map(), pages: [] };
  for (const p of shown) {
    let node = root;
    const segs = p.slug.split("/");
    for (const seg of segs.slice(0, -1)) {
      if (!node.folders.has(seg)) node.folders.set(seg, { folders: new Map(), pages: [] });
      node = node.folders.get(seg);
    }
    node.pages.push(p);
  }
  const curFolder = current ? folderOf(current) : "";
  const emit = (node, path, depth) => {
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const full = path ? `${path}/${name}` : name;
      // Never hide the folder chain of the open page or of a filter match.
      const open = f || !collapsed.has(full) || curFolder === full || curFolder.startsWith(full + "/");
      const li = document.createElement("li");
      li.className = "folder" + (open ? " open" : "");
      li.style.paddingLeft = `${9 + depth * 12}px`;
      li.innerHTML = `<span class="tri"></span><span class="name"></span><small class="count"></small>`;
      li.querySelector(".name").textContent = name + "/";
      li.querySelector(".count").textContent = countPages(child);
      li.onclick = () => toggleFolder(full);
      ul.appendChild(li);
      if (open) emit(child, full, depth + 1);
    }
    for (const p of node.pages.sort((a, b) => a.slug.localeCompare(b.slug))) {
      const li = document.createElement("li");
      li.dataset.slug = p.slug;
      li.style.paddingLeft = `${9 + depth * 12}px`;
      li.innerHTML = `<span></span><small></small>`;
      li.firstChild.textContent = p.title;
      li.lastChild.textContent = p.slug.split("/").pop();
      if (p.slug === current) li.className = "active";
      li.onclick = () => { openPage(p.slug); $("app").classList.remove("menu-open"); };
      ul.appendChild(li);
    }
  };
  emit(root, "", 0);
}
function countPages(node) {
  let n = node.pages.length;
  for (const c of node.folders.values()) n += countPages(c);
  return n;
}

function setView(v) {
  view = v;
  $("view").hidden = v !== "read";
  $("editor").hidden = v !== "edit";
  $("history").hidden = v !== "history";
  $("editBtn").hidden = v === "edit";
  $("histBtn").hidden = v === "edit";
  $("saveBtn").hidden = v !== "edit";
  $("cancelBtn").hidden = v !== "edit";
}

function openPage(slug) {
  const p = pages.get(slug);
  current = slug; isNew = false;
  location.hash = encodeURIComponent(slug);
  renderList();
  setView("read");
  if (!p || p.deleted) {
    $("curTitle").textContent = slug;
    $("meta").textContent = t("page.missing");
    $("view").innerHTML = `<p class="muted">${t("page.createHint", { slug: sanitize(slug) })}</p>`;
    return;
  }
  $("curTitle").textContent = p.title;
  $("meta").textContent = `${short(p.updated_by)} · ${fmtTs(p.updated_at)} · ${byteLength(p.body)} B`;
  $("view").innerHTML = render(p.body, new Set(livePages().map((x) => x.slug)));
  $("view").querySelectorAll("a.wikilink").forEach((a) => {
    a.onclick = (ev) => { ev.preventDefault(); openPage(a.dataset.slug); };
  });
  $("view").querySelectorAll("a:not(.wikilink)").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
}

function showEmpty() {
  current = null;
  $("curTitle").textContent = "";
  $("meta").textContent = "";
  $("view").innerHTML = `<p class="muted">${t("page.empty")}</p>`;
  setView("read");
}

function startEdit(newPage = false) {
  isNew = newPage;
  const p = newPage ? null : pages.get(current);
  editBase = p && !p.deleted ? p.event_id : null;
  $("edSlug").value = newPage ? (current && folderOf(current) ? folderOf(current) + "/" : "") : current;
  $("edSlug").readOnly = !newPage;
  $("edTitle").value = p && !p.deleted ? p.title : "";
  $("edBody").value = p && !p.deleted ? p.body : "";
  $("saveErr").textContent = "";
  $("curTitle").textContent = newPage ? t("editor.newPage") : (p?.title || current);
  updateSize();
  setView("edit");
  (newPage ? $("edSlug") : $("edBody")).focus();
}

function updateSize() {
  const n = byteLength($("edBody").value);
  $("size").textContent = `${n.toLocaleString()} / ${MAX_BODY.toLocaleString()} B`;
  $("size").style.color = n > MAX_BODY ? "#c92a2a" : "";
}

async function save() {
  const slug = $("edSlug").value.trim();
  const body = $("edBody").value;
  let title = $("edTitle").value.trim();
  if (!isValidSlug(slug)) { $("saveErr").textContent = t("save.badSlug"); return; }
  if (isNew && pages.get(slug) && !pages.get(slug).deleted) { $("saveErr").textContent = t("save.exists"); return; }
  const bytes = byteLength(body);
  if (bytes > MAX_BODY) { $("saveErr").textContent = t("save.tooLarge", { bytes, max: MAX_BODY }); return; }
  if (!title) { const m = body.match(/^#\s+(.+)$/m); title = m ? m[1].trim() : slug; }
  // Conflict check (last-write-wins otherwise): has the page moved on since
  // the editor was opened? In widget mode the pushes keep `pages` current; in
  // dev mode re-read the state first.
  const content = { title, body, updated_by: be.userId, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  $("saveBtn").disabled = true;
  try {
    const fresh = await be.refreshState();
    if (fresh) ingest(fresh);
    const now = pages.get(slug);
    if (editBase && now && !now.deleted && now.event_id !== editBase
        && !confirm(t("save.conflict", { who: short(now.updated_by), when: fmtTs(now.updated_at) }))) return;
    const eid = await be.put(slug, content);
    ingest([{ type: PAGE_TYPE, state_key: slug, content, event_id: eid, sender: be.userId, origin_server_ts: Date.now() }]);
    current = slug;
    openPage(slug);
  } catch (e) {
    $("saveErr").textContent = String(e.message || e);
  } finally {
    $("saveBtn").disabled = false;
  }
}

async function showHistory() {
  if (!current) return;
  setView("history");
  $("history").innerHTML = `<p class="muted">${t("history.loading")}</p>`;
  const evs = (await be.recentHistory()).filter((e) => e.state_key === current)
    .sort((a, b) => b.origin_server_ts - a.origin_server_ts);
  const note = be.mode === "widget" ? t("history.noteWidget") : t("history.noteDev");
  let html = `<p class="muted">${note}</p>`;
  if (!evs.length) html += `<p class="muted">${t("history.none")}</p>`;
  else {
    html += `<table><tr><th>${t("history.when")}</th><th>${t("history.who")}</th><th>${t("history.title")}</th><th>${t("history.size")}</th><th></th></tr>`;
    evs.forEach((e, i) => {
      const c = e.content || {};
      const size = byteLength(c.body || "");
      html += `<tr><td class="mono">${fmtDate(e.origin_server_ts)}</td><td>${sanitize(short(e.sender))}</td><td>${sanitize(c.title || t("history.deleted"))}</td><td>${size} B</td><td>${i === 0 ? t("history.current") : `<button data-i="${i}">${t("history.restore")}</button>`}</td></tr>`;
    });
    html += "</table>";
  }
  $("history").innerHTML = html;
  $("history").querySelectorAll("button[data-i]").forEach((b) => {
    b.onclick = () => {
      const c = evs[+b.dataset.i].content || {};
      startEdit(false);
      $("edTitle").value = c.title || "";
      $("edBody").value = c.body || "";
      updateSize();
    };
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot(backend) {
  be = backend;
  $("gate").hidden = true;
  $("app").hidden = false;
  $("whoami").textContent = be.userId;
  $("mode").textContent = be.mode === "widget" ? t("mode.widget") : t("mode.dev");
  ingest(await be.initialState());
  be.onUpdate((evs) => {
    const cur = current ? pages.get(current)?.event_id : null;
    ingest(evs);
    renderList();
    if (current && view === "read" && pages.get(current)?.event_id !== cur) openPage(current);
  });
  renderList();
  const want = decodeURIComponent(location.hash.slice(1));
  if (want && pages.has(want)) openPage(want);
  else if (pages.has("home") && !pages.get("home").deleted) openPage("home");
  else if (livePages().length) openPage(livePages()[0].slug);
  else showEmpty();
}

applyStrings();
$("editBtn").onclick = () => current ? startEdit(false) : startEdit(true);
$("newBtn").onclick = () => { startEdit(true); $("app").classList.remove("menu-open"); };
$("cancelBtn").onclick = () => (current ? openPage(current) : showEmpty());
$("saveBtn").onclick = save;
$("histBtn").onclick = showHistory;
$("menuBtn").onclick = () => $("app").classList.toggle("menu-open");
$("filter").oninput = renderList;
$("edBody").oninput = updateSize;
window.addEventListener("hashchange", () => {
  const s = decodeURIComponent(location.hash.slice(1));
  if (s && s !== current && view === "read") openPage(s);
});

async function startWidget() {
  const { api, pushed, ready } = createWidgetApi(params.get("widgetId"), params.get("parentUrl"));
  api.start();
  api.sendContentLoaded().catch(() => {});
  const timer = setTimeout(() => { $("gateMsg").textContent = t("gate.waiting"); }, 4000);
  await ready;
  clearTimeout(timer);
  if (!canReadPages(api)) {
    $("gateMsg").textContent = t("gate.noReadCapability");
    return;
  }
  await boot(widgetBackend(api, params.get("roomId"), params.get("userId"), pushed));
}

$("devBtn").onclick = async () => {
  $("gateErr").textContent = "";
  try {
    const hs = $("devHs").value.trim().replace(/\/$/, "");
    const token = $("devToken").value.trim();
    let room = $("devRoom").value.trim();
    const tmp = clientBackend(hs, token, room, null);
    const who = (await tmp.call("GET", "/_matrix/client/v3/account/whoami")).user_id;
    if (!room.startsWith("!")) room = (await tmp.call("GET", `/_matrix/client/v3/directory/room/${encodeURIComponent(room)}`)).room_id;
    await boot(clientBackend(hs, token, room, who));
  } catch (e) { $("gateErr").textContent = String(e.message || e); }
};

if (params.get("widgetId") && window.parent !== window) {
  $("devLogin").hidden = true;
  startWidget().catch((e) => { $("gateMsg").textContent = t("gate.error", { msg: e.message || e }); });
} else {
  // Dev mode: ?hs=https://matrix.example.org&room=%23team:example.org pre-fills the form.
  $("devHs").value = params.get("hs") || "";
  $("devRoom").value = params.get("room") || "";
  $("gateMsg").textContent = t("gate.openAsWidget");
  $("devLogin").open = true;
}
