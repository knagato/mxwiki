# Design

mxwiki started as **MyWiki** (2026-08), a pair of proofs of concept for a "stock, not
flow" wiki on Matrix: pages you can find again, next to the chat that produced them. Its
design notes (in Japanese, trimmed of environment-specific details) are in
[`MYWIKI-DESIGN.md`](MYWIKI-DESIGN.md); the PoCs are under `legacy/`. In 2026-09 a
downstream deployment turned the Tier 1 PoC into an Element room widget with a CLI; that
implementation was ported back here as v0.1. This page records what was kept, what
changed, and why.

## Why serverless

Everything a wiki needs is already in a Matrix room:

- **Access control** — room membership is read access, power levels are write access.
  Nothing to configure twice, no second user database.
- **Storage and history** — state events are keyed (`type`, `state_key`), so "the current
  version of page X" is a state lookup and "all pages" is the room state; every edit stays
  in the timeline.
- **Sync and notifications** — clients already receive state changes; the widget gets
  them pushed.
- **Federation** — a wiki room on one server can be joined from another.

So mxwiki is a static web page (the widget), a CLI, and a documented event format. Hosting
the widget means serving static files; there is no process to run or back up.

## Kept from MyWiki

- One room = one wiki; page identity = `state_key` = slug; `[[slug]]` links (a MyWiki TODO,
  now implemented, with missing pages drawn dashed).
- Page list = room state filtered by type; history = past events.
- A SPA that delegates authentication and data to Matrix.
- The Obsidian read-only mirror idea: `mxwiki mirror <dir>` writes `<slug>.md` with
  frontmatter, file name = slug so `[[slug]]` resolves unchanged in Obsidian.
- Size limits from Matrix (64 KiB per event), and splitting long pages.
- Tier 2 (end-to-end encryption) as a goal; it maps to Profile T (below).

## Changed: where the body lives

MyWiki put the body in the **timeline** (`m.room.message`, raw text in `wiki.raw`, edits as
`m.replace`) and kept only a pointer `{title, latest_event_id}` in state. Its reasons were
sound: small state (the body stays out of Synapse's state-resolution memory), no plaintext
in state (state is never encrypted, so the same structure works for E2EE), and
Matrix-native history.

The downstream port moved the body **into the state event** (48 KiB cap), because of what
a *room widget* can read through the Widget API:

- A widget can only read the events the client has loaded into its timeline; there is no
  "fetch event by ID" action. A page last edited months ago is simply not reachable.
- Reading `m.room.message` bodies requires the capability to receive *all* messages in the
  room, which is far broader than a wiki should ask for.
- With the body in state, one capability (`receive.state_event:<page type>`) delivers every
  current page, pushed by the client, however old.

Both models are now specified (`SPEC.md`): **Profile S** (state body, what v0.1 implements)
and **Profile T** (timeline body, the MyWiki model, made tamper-resistant with a
`body_sha256` in the pointer and a `m.reference` chain to a root event). Profile T becomes
reachable from a widget through `readEventRelations` (MSC3869), which asks the server rather
than the client's timeline; it stays experimental until verified end to end (SPEC §4).

## Widget API behaviour (verified; the code relies on it)

- With `matrix-widget-api` ≥ 1.11 and a client that supports it (current Element Web), the
  client **pushes the current state** with an `update_state` action right after the
  capabilities are approved, and again on every change. In that setting `read_events`
  (`readStateEvents`) does *not* return current state: it returns the **history the client
  has in its timeline** (newest first).
- Older clients never push, and `read_events` returns the current state.
- The widget waits 1.5 s for the first push and then falls back to `readStateEvents`. Its
  page table keeps only the newest version per slug (by `origin_server_ts`), so it is
  correct whichever of the two it receives, even when fed several versions of a page.
- **Listeners must be registered before `api.start()`**: the first push can arrive
  immediately after start. `pushBuffer` in `widget/src/backend.js` buffers pushes until the
  app is ready for them.
- `new WidgetApi(widgetId, clientOrigin)` takes the client origin from the `parentUrl`
  query parameter the client adds.
- Element shows one approval dialog for the three capabilities (SPEC §7) the first time the
  widget is opened.
- No call passes `room_id`: doing so needs the `timeline:<room>` capability.

## The CLI

Standard library only, so it runs wherever Python does (servers, bots, CI) without a
virtualenv. It talks to the client-server API directly, and so is not limited like the
widget: `history` pages through `/messages`, `migrate` fetches events by ID. Bots use it
with their own token (`--env-file`), which keeps the bot's permissions those of an ordinary
room member. `mxsearch` is the companion for *chat* history: Synapse's full-text search
tokenises on whitespace, so a keyword inside a Japanese sentence never matches; `mxsearch`
keeps a local cache per room and does substring matching, answering with matrix.to links.

## The Element header button

An optional Element Web module adds a "Wiki" button to the room header. The module API
(`config.json` `modules`, `static moduleApiVersion`, `api.config.get`) is a stable contract;
the button placement is not: Element has no header extension point, so the module finds
`.mx_RoomHeader` with a MutationObserver and clones an existing Compound icon button. If the
markup changes, the button disappears and nothing else breaks; the wiki is still in the
room's Extensions panel.

## Alternatives considered

| Approach | Why not (for v0.1) |
|---|---|
| Body in timeline, read by the widget from the client's timeline (MyWiki Tier 1) | Old pages unreachable; needs the capability to read every message (above). |
| Body in the media repository, state holds the `mxc://` (MyWiki `plan-b.html`) | Media is readable by any account on the server that knows the URI, not just room members; authenticated media makes browser fetching awkward; no per-room access control. |
| A separate wiki server with Matrix login (OIDC / OpenID token) | A second service to run, back up and permission; the room's access control has to be mirrored. |
| One state event per wiki holding all pages | Hits the 64 KiB limit at once; every edit conflicts with every other edit. |

## Known limits

- 48 KiB per page body (Profile S). Split long pages (`topic/part-2`).
- Every edit stores the whole body again; very frequent edits of large pages grow the room.
- State is not encrypted. Profile S wikis in encrypted rooms still store pages in plaintext
  state; use Profile T for confidential content once it is enabled.
- Thousands of pages in one room make state resolution heavier; split wikis by room.
- The widget's history view shows only what the client has loaded; `mxwiki history` shows
  everything.
