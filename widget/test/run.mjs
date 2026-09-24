// Headless end-to-end check of the widget through the Widget API:
//   MXWIKI_TEST_HS=http://localhost:18914 MXWIKI_TEST_TOKEN=... MXWIKI_TEST_ROOM='!id:localhost' node test/run.mjs
// (`node test/setup-synapse.mjs` prints those three for a local Synapse.)
// Needs Chrome: CHROME_PATH, or Google Chrome in its default macOS location.
// Spawns `vite` for the duration of the run, then kills it. A room without a
// `home` page is seeded with one (and removed again afterwards).
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { PAGE_TYPE, MAX_BODY } from "../src/spec.js";

const env = (k) => { const v = process.env[k]; if (!v) { console.error(`set ${k}`); process.exit(2); } return v; };
const HS = env("MXWIKI_TEST_HS").replace(/\/$/, ""), TOKEN = env("MXWIKI_TEST_TOKEN");
let ROOM = env("MXWIKI_TEST_ROOM");
const PORT = Number(process.env.MXWIKI_TEST_PORT || 5180);
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const q = encodeURIComponent;
const api = async (m, path, body) => {
  const r = await fetch(HS + path, { method: m, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${m} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const pagePath = (slug) => `/_matrix/client/v3/rooms/${q(ROOM)}/state/${q(PAGE_TYPE)}/${q(slug)}`;
const getPage = async (slug) => { try { return await api("GET", pagePath(slug)); } catch { return null; } };
let fails = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) fails++; };

const USER = (await api("GET", "/_matrix/client/v3/account/whoami")).user_id;
if (!ROOM.startsWith("!")) ROOM = (await api("GET", `/_matrix/client/v3/directory/room/${q(ROOM)}`)).room_id;

// Seed a home page with two resolvable [[links]] when the room has none.
const existingHome = await getPage("home");
const seeded = !existingHome || !existingHome.body;
if (seeded) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await api("PUT", pagePath("harness/linked"), { title: "Linked", body: "# Linked\n\nback to [[home]]\n", updated_by: USER, updated_at: stamp });
  await api("PUT", pagePath("home"), { title: "Home", body: "# Home\n\n- [[harness/linked]]\n- [[home|this page]]\n", updated_by: USER, updated_at: stamp });
  console.log("seeded home + harness/linked");
}

// Poll the port rather than parse vite's banner: with CI set it is coloured, and
// "Local:" never appears as one string.
const vite = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "inherit", "inherit"] });
let viteExited = false;
vite.on("exit", () => { viteExited = true; });
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch {}
  if (viteExited || i > 60) { vite.kill(); throw new Error(`vite did not come up on port ${PORT}`); }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") console.log("  [console." + m.type() + "]", m.text()); });
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); console.log("  [dialog]", d.message()); await d.accept(); });
  const url = `http://localhost:${PORT}/test/harness.html?hs=${q(HS)}&token=${q(TOKEN)}&room=${q(ROOM)}&user=${q(USER)}`;
  await page.goto(url);
  const frameEl = await page.waitForSelector("iframe#w");
  const frame = await frameEl.contentFrame();

  // 1. the widget negotiates capabilities and lists pages from state
  await frame.waitForSelector("#app:not([hidden])", { timeout: 20000 });
  await frame.waitForFunction(() => document.querySelectorAll("#pages li").length > 0, { timeout: 20000 });
  const caps = (await page.evaluate(() => window.harness.capabilities)) || [];
  const want = [`org.matrix.msc2762.receive.state_event:${PAGE_TYPE}`, `org.matrix.msc2762.send.state_event:${PAGE_TYPE}`, `org.matrix.msc2762.receive.event:${PAGE_TYPE}`];
  check(caps.length === want.length && want.every((c) => caps.includes(c)), `requests exactly the SPEC capabilities: ${JSON.stringify(caps)}`);
  const listed = await frame.$$eval("#pages li:not(.folder)", (els) => els.map((e) => e.dataset.slug));
  const state = (await api("GET", `/_matrix/client/v3/rooms/${q(ROOM)}/state`)).filter((e) => e.type === PAGE_TYPE && e.content.title);
  check(listed.length === state.length, `page list has ${listed.length} entries (state has ${state.length})`);
  check(await frame.$eval("#mode", (e) => e.textContent) === "widget", "running in widget mode");
  check((await frame.$eval("#whoami", (e) => e.textContent)) === USER, "user id came from the widget URL");

  // 2. home opens by default and [[links]] render
  const title = await frame.$eval("#curTitle", (e) => e.textContent);
  const openSlug = decodeURIComponent((await frame.evaluate(() => location.hash)).slice(1));
  check(openSlug === "home", `home page opened first (slug "${openSlug}", title "${title}")`);
  const links = await frame.$$eval("#view a.wikilink", (as) => as.map((a) => [a.dataset.slug, a.classList.contains("missing")]));
  check(links.length >= 2 && links.every(([, missing]) => !missing), `wikilinks rendered and resolved: ${JSON.stringify(links)}`);

  // 3. edit + save goes through sendStateEvent and lands in room state
  const stamp = `harness ${new Date().toISOString()}`;
  await frame.click("#editBtn");
  await frame.waitForSelector("#editor:not([hidden])");
  await frame.$eval("#edBody", (el, s) => { el.value = el.value.replace(/\n<!-- harness:.*-->\n?/s, "") + `\n<!-- harness: ${s} -->\n`; el.dispatchEvent(new Event("input")); }, stamp);
  await frame.click("#saveBtn");
  try { await frame.waitForSelector("#view:not([hidden])", { timeout: 20000 }); }
  catch (e) { console.log("  saveErr:", await frame.$eval("#saveErr", (el) => el.textContent)); throw e; }
  const saved = await api("GET", pagePath("home"));
  check(saved.body.includes(stamp), "saved body is in room state");
  check(saved.updated_by === USER, `updated_by = ${saved.updated_by}`);

  check(!dialogs.length, `no spurious conflict dialog (${dialogs.length})`);

  // 4. a remote edit pushed by the client (feedStateUpdate) refreshes the view
  const remoteTitle = `harness remote ${Date.now()}`;
  const remoteBody = "# harness\n\nremote edit via harness\n\n- [[home]]\n";
  const put = await api("PUT", pagePath("harness/remote"), { title: remoteTitle, body: remoteBody, updated_by: USER, updated_at: new Date().toISOString() });
  await page.evaluate((ev) => window.harness.feedState(ev), { type: PAGE_TYPE, state_key: "harness/remote", room_id: ROOM, sender: USER, event_id: put.event_id, origin_server_ts: Date.now(), content: { title: remoteTitle, body: remoteBody, updated_by: USER } });
  await frame.waitForFunction((t) => [...document.querySelectorAll("#pages li")].some((li) => li.textContent.includes(t)), { timeout: 10000 }, remoteTitle);
  check(true, "pushed state update re-rendered the page list");
  const folders = await frame.$$eval("#pages li.folder .name", (els) => els.map((e) => e.textContent));
  check(folders.includes("harness/"), `folder rows rendered for path slugs: ${JSON.stringify(folders)}`);

  // 5. history view lists versions of the current page
  await frame.click("#histBtn");
  await frame.waitForSelector("#history table", { timeout: 20000 });
  const rows = await frame.$$eval("#history table tr", (tr) => tr.length - 1);
  check(rows >= 2, `history shows ${rows} versions of home`);

  // 6. oversize body is rejected client-side
  await frame.click("#editBtn");
  await frame.waitForSelector("#editor:not([hidden])");
  await frame.$eval("#edBody", (el, n) => { el.value = "x".repeat(n); el.dispatchEvent(new Event("input")); }, MAX_BODY + 1);
  await frame.click("#saveBtn");
  const err = await frame.$eval("#saveErr", (e) => e.textContent);
  check(err.includes(String(MAX_BODY)), `oversize rejected: "${err}"`);
} finally {
  await browser.close();
  vite.kill();
}
// clean up: drop the harness pages, strip the marker from home (or drop a seeded home)
await api("PUT", pagePath("harness/remote"), {});
if (seeded) {
  await api("PUT", pagePath("harness/linked"), {});
  await api("PUT", pagePath("home"), {});
} else {
  const home = await api("GET", pagePath("home"));
  await api("PUT", pagePath("home"), { ...home, body: home.body.replace(/\n<!-- harness:.*-->\n?/s, "\n").replace(/\n+$/, "\n") });
}
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
