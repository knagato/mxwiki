// MyWiki Tier2 — E2EE 暗号化 Wiki (matrix-js-sdk + rust crypto)
//
// 設計（DESIGN.md 準拠）:
//  - 本文 = 暗号化 timeline イベント（SDK が megolm で暗復号）
//  - state = ポインタ {title, latest_event_id}（state は暗号化されないので機密はここに置かない）
//  - 画像 = 暗号化 media。encryptAttachment で暗号化してアップロードし、
//           復号鍵(EncryptedFile)は本文イベント content の "wiki.images" に格納 → mxc 漏洩でも復号不可
//  - 新ブラウザ初回のみ 回復キー/セキュリティフレーズ で鍵バックアップを解錠（以降 IndexedDB 永続）

import * as sdk from "matrix-js-sdk";
import { decodeRecoveryKey, deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/index.js";
import { encryptAttachment, decryptAttachment } from "matrix-encrypt-attachment";

const PAGE_TYPE = "com.example.wiki.page_e";
const DEFAULT_ROOM = "!secretwiki:example.org";
const LS = "mywiki.tier2.session";
const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $("status").textContent = m || ""; };

// 回復キー入力を getSecretStorageKey コールバックへ渡すための一時保管
let ssKey = null; // { keyId, privateKey: Uint8Array }
let loginPassword = null; // クロスサイニング鍵アップロードの UIA 用（メモリのみ）

let client = null, roomId = null, pages = [], current = null, editing = false;

// ---- Matrix クライアント構築 ----
function buildClient({ baseUrl, accessToken, userId, deviceId }) {
  return sdk.createClient({
    baseUrl, accessToken, userId, deviceId,
    // 4S(Secure Storage)の鍵を要求されたら、ユーザーが入力した回復キーを返す
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        if (!ssKey) return null;
        if (keys[ssKey.keyId]) return [ssKey.keyId, ssKey.privateKey];
        // default キーが要求された場合のフォールバック
        const only = Object.keys(keys)[0];
        return only ? [only, ssKey.privateKey] : null;
      },
    },
  });
}

async function startClientWithCrypto(c) {
  // crypto ストアをデバイス別に分離（再ログインで新デバイスになっても旧ストアと衝突しない）
  const prefix = ("mywiki_" + c.getUserId() + "_" + c.getDeviceId()).replace(/[^A-Za-z0-9_]/g, "_");
  await c.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: prefix });
  // knagato は多数ルームに参加しているため、Wiki ルームだけに絞って sync を高速化する。
  // to_device / device_lists（E2EE 用）は room フィルタの対象外なので暗号化は問題なく動く。
  const filter = new sdk.Filter(c.getUserId());
  filter.setDefinition({
    room: {
      rooms: [roomId],                      // このルームだけ同期
      timeline: { limit: 30 },
      state: { lazy_load_members: true },
      ephemeral: { types: [] },             // タイピング/既読は不要
    },
    presence: { types: [] },                // 他ユーザーのプレゼンスも不要
  });
  await c.startClient({ filter, initialSyncLimit: 20 });
  await new Promise((res) => {
    const onSync = (state) => { if (state === "PREPARED") { c.off("sync", onSync); res(); } };
    c.on("sync", onSync);
  });
}

// ---- 鍵バックアップ解錠 ----
async function needsUnlock(c) {
  try {
    const crypto = c.getCrypto();
    const info = await crypto.getKeyBackupInfo();
    if (!info) return false;                       // バックアップ未設定 → 解錠不要
    const active = await crypto.getActiveSessionBackupVersion();
    if (!active) return true;                       // バックアップ未有効 → 解錠が要る
    // 自デバイスがクロスサイニング検証済みでなければ、解錠して自己署名する
    const vs = await crypto.getDeviceVerificationStatus(c.getUserId(), c.getDeviceId());
    const verified = vs && (vs.crossSigningVerified || vs.signedByOwner);
    return !verified;
  } catch { return false; }
}

async function doUnlock(recoveryInput) {
  const crypto = client.getCrypto();
  const keyId = await client.secretStorage.getDefaultKeyId();
  if (!keyId) throw new Error("このアカウントに Secure Storage が未設定です（Element で回復方法を作成してください）");
  const tuple = await client.secretStorage.getKey(keyId);
  const desc = tuple ? tuple[1] : null;
  // 入力が回復キーかパスフレーズかを判定
  let priv;
  const looksLikeKey = /^[A-Za-z0-9\s]{40,}$/.test(recoveryInput) && recoveryInput.replace(/\s/g, "").length >= 40;
  try {
    priv = decodeRecoveryKey(recoveryInput.replace(/\s/g, ""));
  } catch {
    priv = null;
  }
  if (!priv) {
    if (!desc || !desc.passphrase) throw new Error("回復キーの形式が不正、かつパスフレーズ設定もありません");
    const p = desc.passphrase;
    priv = await deriveRecoveryKeyFromPassphrase(recoveryInput, p.salt, p.iterations);
  }
  ssKey = { keyId, privateKey: priv };
  // 4S からバックアップ復号鍵を取り込み、鍵をインポート
  await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
  await crypto.restoreKeyBackup();
  await crypto.checkKeyBackupAndEnable();
  // このデバイスを自分のクロスサイニング鍵で署名 → 「検証済み」にする
  const uid = client.getUserId();
  const authCb = async (makeRequest) => {
    if (!loginPassword) throw new Error("自己署名に再認証が必要ですが、パスワードが保持されていません（一度ログアウトし、パスワードでログインし直してから解錠してください）");
    return await makeRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: uid },
      password: loginPassword,
    });
  };
  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: authCb });
  // 自デバイスを署名（サーバーに署名が上がる。ローカルの検証状態表示は遅延するが実害なし）
  try { await crypto.crossSignDevice(client.getDeviceId()); } catch (e) { console.warn("crossSignDevice:", e); }
  console.log("self cross-sign done; verification status may lag locally until next key refresh.");
}

// ---- ページ読み書き ----
function getRoom() { return client.getRoom(roomId); }

// 部屋のタイムラインを遡って全イベントを読み込む（PoC: ページ数が少ない前提）
async function backfill() {
  const room = getRoom();
  if (!room) throw new Error("ルームが見つかりません（参加していますか？）");
  let tl = room.getLiveTimeline();
  let guard = 0;
  while (client.getRoom(roomId) && room.oldState && guard < 30) {
    const more = await client.paginateEventTimeline(tl, { backwards: true, limit: 100 });
    guard++;
    if (!more) break;
  }
}

function listPointers() {
  const room = getRoom();
  const s = room.currentState.getStateEvents(PAGE_TYPE);
  return s.map((e) => {
    const c = e.getContent();
    return { slug: e.getStateKey(), title: c.title || e.getStateKey(), eid: c.latest_event_id };
  }).filter((p) => p.slug).sort((a, b) => a.title.localeCompare(b.title, "ja"));
}

async function findEvent(eid) {
  const room = getRoom();
  let ev = room.findEventById(eid);
  if (!ev) { await backfill(); ev = room.findEventById(eid); }
  if (!ev) return null;
  if (ev.isEncrypted() && ev.getContent()?.msgtype === undefined) {
    await client.decryptEventIfNeeded(ev);
  }
  return ev;
}

// mxc の暗号化 media をダウンロード → 復号 → object URL
async function decryptImage(encFile) {
  const mxc = encFile.url;
  const m = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/); if (!m) return "";
  const httpUrl = `${client.baseUrl}/_matrix/client/v1/media/download/${m[1]}/${m[2]}`;
  const r = await fetch(httpUrl, { headers: { Authorization: "Bearer " + client.getAccessToken() } });
  if (!r.ok) return "";
  const cipher = await r.arrayBuffer();
  const plain = await decryptAttachment(cipher, encFile);
  const blob = new Blob([plain], { type: (encFile.mimetype) || "image/*" });
  return URL.createObjectURL(blob);
}

async function ensureJoined() {
  try { await client.joinRoom(roomId); } catch (e) { console.warn("ensureJoined:", e?.message || e); }
  for (let i = 0; i < 20; i++) {
    const r = client.getRoom(roomId);
    if (r && r.getMyMembership() === "join") return;
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function savePage(slug, title, rawBody, images) {
  await ensureJoined();
  // 本文イベント（暗号化ルームなので SDK が自動で megolm 暗号化）
  const content = {
    msgtype: "m.text",
    body: `[wiki:${slug}] ${title}`,
    "wiki.slug": slug,
    "wiki.raw": rawBody,
    "wiki.images": images || {},
  };
  let res;
  try {
    res = await client.sendEvent(roomId, "m.room.message", content);
  } catch (e) {
    // まだ membership が反映されていない場合の 403 を join リトライで回収
    if (e && (e.errcode === "M_FORBIDDEN" || String(e).includes("not in room"))) {
      await client.joinRoom(roomId);
      await new Promise((r) => setTimeout(r, 500));
      res = await client.sendEvent(roomId, "m.room.message", content);
    } else { throw e; }
  }
  // state ポインタ更新（平文・非機密のみ）
  await client.sendStateEvent(roomId, PAGE_TYPE, { title, latest_event_id: res.event_id }, slug);
  return res.event_id;
}

// 画像をクライアント暗号化してアップロード → EncryptedFile を返す
async function uploadEncryptedImage(file) {
  const buf = await file.arrayBuffer();
  const enc = await encryptAttachment(buf);            // { data, info }
  const up = await client.uploadContent(new Blob([enc.data]), { type: "application/octet-stream", includeFilename: false });
  const mxc = up.content_uri;
  const encFile = { ...enc.info, url: mxc, mimetype: file.type || "image/png", v: "v2" };
  return encFile;
}

// ---- Markdown（画像は enc:ID プレースホルダ） ----
function md(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(src).split("\n"); let out = [], inList = false, inCode = false;
  const img = (alt, url) => url.startsWith("enc:")
    ? `<img alt="${alt}" data-enc="${url.slice(4)}" style="max-width:100%;border-radius:8px">`
    : `<img alt="${alt}" src="${url}" style="max-width:100%;border-radius:8px">`;
  const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => img(a, u))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (let l of lines) {
    if (l.trim().startsWith("```")) { out.push(inCode ? "</pre>" : "<pre>"); inCode = !inCode; continue; }
    if (inCode) { out.push(l); continue; }
    let m;
    if (m = l.match(/^(#{1,3})\s+(.*)/)) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (m = l.match(/^[-*]\s+(.*)/)) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (inList) { out.push("</ul>"); inList = false; }
    out.push(l.trim() === "" ? "<br>" : `<p>${inline(l)}</p>`);
  }
  if (inList) out.push("</ul>"); if (inCode) out.push("</pre>");
  return out.join("\n");
}

// ---- UI ----
async function boot() {
  $("login").style.display = "none"; $("unlock").style.display = "none"; $("app").style.display = "grid";
  $("whoami").textContent = client.getUserId();
  await refresh();
}
async function refresh(skipOpen = false) {
  setStatus("同期中…");
  pages = listPointers();
  // 保存直後は sendStateEvent がまだ sync に反映されていないことがあるため、現在ページを即マージ
  if (current && !pages.some((p) => p.slug === current.slug)) {
    pages = [...pages, { slug: current.slug, title: current.title, eid: current.eid }]
      .sort((a, b) => a.title.localeCompare(b.title, "ja"));
  }
  const ul = $("pages"); ul.innerHTML = "";
  pages.forEach((p) => {
    const li = document.createElement("li"); li.textContent = p.title; li.dataset.slug = p.slug;
    if (current && current.slug === p.slug) li.className = "active";
    li.onclick = () => open(p.slug); ul.appendChild(li);
  });
  setStatus("");
  if (skipOpen) return;                 // 保存直後など、呼び出し側が描画を担当する場合
  if (!current && pages.length) open(pages[0].slug);
  else if (current) open(current.slug);
  else showEmpty();
}
function showEmpty() { $("curTitle").textContent = ""; $("meta").textContent = ""; $("view").innerHTML = '<p class="muted">ページがありません。＋ で作成してください。</p>'; }
async function open(slug) {
  current = pages.find((p) => p.slug === slug); if (!current) return;
  editing = false; setMode();
  $("curTitle").textContent = current.title;
  [...$("pages").children].forEach((li) => li.className = li.dataset.slug === slug ? "active" : "");
  $("meta").textContent = "🔒 暗号化 event: " + (current.eid || "(なし)");
  $("view").innerHTML = '<p class="muted">復号中…</p>';
  const ev = await findEvent(current.eid);
  if (!ev) { $("view").innerHTML = '<p class="muted">本文イベントが見つかりません</p>'; return; }
  const c = ev.getContent();
  if (ev.isDecryptionFailure && ev.isDecryptionFailure()) {
    $("view").innerHTML = '<p class="muted">⚠️ 復号できませんでした（鍵バックアップの解錠が必要かもしれません）</p>'; return;
  }
  current.raw = c["wiki.raw"] || ""; current.images = c["wiki.images"] || {};
  $("view").innerHTML = md(current.raw);
  await resolveEncImages($("view"), current.images);
}
async function resolveEncImages(root, images) {
  for (const el of root.querySelectorAll("img[data-enc]")) {
    const encFile = images[el.dataset.enc];
    if (!encFile) { el.alt = "(画像情報なし)"; continue; }
    const url = await decryptImage(encFile);
    if (url) el.src = url; else el.alt = "(画像復号失敗) " + el.alt;
  }
}
function setMode() {
  $("view").style.display = editing ? "none" : "block"; $("editor").style.display = editing ? "flex" : "none";
  $("editBtn").style.display = editing ? "none" : "inline-block"; $("saveBtn").style.display = editing ? "inline-block" : "none"; $("cancelBtn").style.display = editing ? "inline-block" : "none";
}
let draftImages = {};
function startEdit() { editing = true; setMode(); $("saveErr").textContent = ""; $("imgStatus").textContent = ""; $("edTitle").value = current ? current.title : ""; $("edBody").value = current ? (current.raw || "") : ""; draftImages = current ? { ...(current.images || {}) } : {}; }
async function save() {
  const title = $("edTitle").value.trim() || "無題"; const body = $("edBody").value;
  const slug = current ? current.slug : slugify(title);
  $("saveBtn").disabled = true; setStatus("暗号化して保存中…");
  try {
    const eid = await savePage(slug, title, body, draftImages);
    current = { slug, title, raw: body, images: draftImages, eid }; editing = false;
    setMode();
    // 一覧だけ更新し、本文・画像はメモリの下書きから直接描画（再取得しないので即時反映）
    await refresh(true);
    $("curTitle").textContent = title;
    $("meta").textContent = "🔒 暗号化 event: " + eid;
    $("view").innerHTML = md(body);
    await resolveEncImages($("view"), draftImages);
  } catch (e) { $("saveErr").textContent = e.message || String(e); }
  finally { $("saveBtn").disabled = false; setStatus(""); }
}
function slugify(t) { const b = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); return b || ("page-e-" + Math.floor(performance.now())); }
function newPage() { current = null; startEdit(); $("curTitle").textContent = "新規ページ"; $("meta").textContent = ""; }

// ---- ログインフロー ----
async function login() {
  $("loginErr").textContent = "";
  const baseUrl = $("hs").value.trim() || window.location.origin; // 空欄なら同一オリジン(=Vite が /_matrix を Synapse へプロキシ)
  const user = $("user").value.trim();
  const pw = $("pw").value;
  loginPassword = pw; // UIA 用に一時保持
  roomId = $("room").value.trim() || DEFAULT_ROOM;
  try {
    setStatus("ログイン中…");
    const tmp = sdk.createClient({ baseUrl });
    // ログインごとに新デバイス（＝新 crypto ストア）。device_id を使い回すと
    // 永続ストアが鍵アップロード済みと誤認し、新デバイスに鍵が上がらない不具合になる。
    const res = await tmp.login("m.login.password", {
      identifier: { type: "m.id.user", user }, password: pw,
      initial_device_display_name: "MyWiki Tier2 SPA",
    });
    // ルーム ID がドメイン部を欠いていたら補完（例 !abc → !abc:server）
    const domain = (res.user_id || "").split(":")[1];
    if (roomId && (roomId[0] === "!" || roomId[0] === "#") && !roomId.includes(":") && domain) {
      roomId = roomId + ":" + domain;
    }
    const sess = { baseUrl, accessToken: res.access_token, userId: res.user_id, deviceId: res.device_id, roomId };
    localStorage.setItem(LS, JSON.stringify(sess));
    await afterAuth(sess);
  } catch (e) { $("login").style.display = "block"; $("loginErr").textContent = e.message || String(e); setStatus(""); }
}

async function afterAuth(sess) {
  $("login").style.display = "none";
  setStatus("🔒 接続中…（対象ルームのみ同期）");
  roomId = sess.roomId || DEFAULT_ROOM;
  // 古いセッションでドメイン欠落 ID が保存されている場合の補完
  const domain = (sess.userId || "").split(":")[1];
  if (roomId && (roomId[0] === "!" || roomId[0] === "#") && !roomId.includes(":") && domain) {
    roomId = roomId + ":" + domain;
    sess.roomId = roomId; localStorage.setItem(LS, JSON.stringify(sess));
  }
  client = buildClient(sess);
  setStatus("暗号化を初期化中…");
  await startClientWithCrypto(client);
  // 参加を確実化（joinRoom は idempotent。同期前に getRoom が null でも確実に join 済みにする）
  try { await client.joinRoom(roomId); } catch (e) { console.warn("joinRoom:", e?.message || e); }
  // 参加が sync に反映されるまで待つ（未反映だと送信が 403 not-in-room になる）
  for (let i = 0; i < 20; i++) {
    const r = client.getRoom(roomId);
    if (r && r.getMyMembership() === "join") break;
    await new Promise((res) => setTimeout(res, 250));
  }
  if (await needsUnlock(client)) {
    $("login").style.display = "none"; $("unlock").style.display = "block"; setStatus("");
    return;
  }
  // ページ用 state event が sync で届いたら一覧を更新
  client.on("RoomState.events", (ev) => {
    if (ev.getRoomId() === roomId && ev.getType() === PAGE_TYPE && $("app").style.display !== "none") {
      const openSlug = current ? current.slug : null;
      pages = listPointers();
      const ul = $("pages"); ul.innerHTML = "";
      pages.forEach((p) => {
        const li = document.createElement("li"); li.textContent = p.title; li.dataset.slug = p.slug;
        if (openSlug === p.slug) li.className = "active";
        li.onclick = () => open(p.slug); ul.appendChild(li);
      });
    }
  });
  await boot();
}

async function unlock() {
  $("unlockErr").textContent = "";
  const v = $("recovery").value.trim();
  if (!v) { $("unlockErr").textContent = "回復キーまたはパスフレーズを入力してください"; return; }
  try { setStatus("鍵を復元中…"); await doUnlock(v); setStatus(""); await boot(); }
  catch (e) { $("unlockErr").textContent = e.message || String(e); setStatus(""); }
}

// ---- events ----
$("loginBtn").onclick = login;
$("unlockBtn").onclick = unlock;
$("skipUnlockBtn").onclick = () => boot();
$("logoutBtn").onclick = () => {
  // まずローカルセッションを確実に消す（この後で必ず reload する）
  try { localStorage.removeItem(LS); } catch {}
  // サーバー側デバイスも無効化（失敗しても無視、ブロックしない）
  try { if (client) { client.logout(true).catch(() => {}); client.stopClient(); } } catch (e) { console.warn("logout:", e); }
  location.reload();
};
$("editBtn").onclick = startEdit;
$("cancelBtn").onclick = () => { editing = false; if (current) open(current.slug); else showEmpty(); };
$("saveBtn").onclick = save;
$("newBtn").onclick = newPage;
$("imgBtn").onclick = () => $("imgFile").click();
$("imgFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  $("imgStatus").textContent = "暗号化してアップロード中…";
  try {
    const encFile = await uploadEncryptedImage(f);
    const id = "img" + Math.floor(performance.now());
    draftImages[id] = encFile;
    const ta = $("edBody"); const pos = (ta.selectionStart != null) ? ta.selectionStart : ta.value.length;
    const snip = `\n![${f.name}](enc:${id})\n`;
    ta.value = ta.value.slice(0, pos) + snip + ta.value.slice(pos);
    $("imgStatus").textContent = "挿入しました（暗号化 media）";
  } catch (err) { $("imgStatus").textContent = err.message || String(err); }
  finally { e.target.value = ""; }
};

// 自動復帰
(async () => {
  const s = localStorage.getItem(LS);
  if (!s) return;
  try { await afterAuth(JSON.parse(s)); }
  catch (e) { console.error(e); localStorage.removeItem(LS); $("login").style.display = "block"; setStatus(""); }
})();
