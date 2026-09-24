// Prepares a local Synapse (scripts/synapse-dev.sh up) for the E2E run:
// registers a user, creates a room, lets PL 0 edit pages, and prints
//   MXWIKI_TEST_HS=... MXWIKI_TEST_TOKEN=... MXWIKI_TEST_ROOM=...
// (also appended to $GITHUB_ENV when set). Needs enable_registration and
// enable_registration_without_verification, which synapse-dev.sh turns on.
import { appendFileSync } from "node:fs";
import { PAGE_TYPE } from "../src/spec.js";

const HS = (process.env.MXWIKI_TEST_HS || "http://localhost:18914").replace(/\/$/, "");
const q = encodeURIComponent;
const call = async (m, path, body, token) => {
  const r = await fetch(HS + path, { method: m, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

for (let i = 0; ; i++) {
  try { if ((await fetch(HS + "/health")).ok) break; } catch {}
  if (i > 60) throw new Error(`${HS} did not come up`);
  await new Promise((r) => setTimeout(r, 1000));
}

// User-interactive auth: the first call returns a session, the second completes m.login.dummy.
const reg = { username: `wiki${Date.now()}`, password: `pw-${Math.random().toString(36).slice(2)}`, inhibit_login: false };
let r = await call("POST", "/_matrix/client/v3/register", reg);
if (r.status === 401) r = await call("POST", "/_matrix/client/v3/register", { ...reg, auth: { type: "m.login.dummy", session: r.json.session } });
if (r.status !== 200) throw new Error("register: " + JSON.stringify(r.json));
const token = r.json.access_token;

r = await call("POST", "/_matrix/client/v3/createRoom", { name: "Wiki E2E", preset: "private_chat", room_alias_name: `wiki-e2e-${Date.now()}` }, token);
if (r.status !== 200) throw new Error("createRoom: " + JSON.stringify(r.json));
const room = r.json.room_id;

// What `mxwiki grant-edit --level 0` does: page edits at PL 0.
const plPath = `/_matrix/client/v3/rooms/${q(room)}/state/m.room.power_levels/`;
const pl = (await call("GET", plPath, null, token)).json;
pl.events = { ...(pl.events || {}), [PAGE_TYPE]: 0 };
r = await call("PUT", plPath, pl, token);
if (r.status !== 200) throw new Error("power_levels: " + JSON.stringify(r.json));

const out = `MXWIKI_TEST_HS=${HS}\nMXWIKI_TEST_TOKEN=${token}\nMXWIKI_TEST_ROOM=${room}\n`;
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, out);
process.stdout.write(out);
