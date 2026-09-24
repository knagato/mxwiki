# mxwiki wire format

This document is normative. The widget (`widget/`) and the CLI (`cli/`) implement it, and
both are tested against the same vectors (`spec/vectors.json`). The key words MUST, SHOULD
and MAY are used as in RFC 2119.

Namespace: `com.knatrix` (reverse DNS of knatrix.com, owned by the author). **The event
type names below are stable API; changing any of them is a major version.**

## 1. Model

- **One room = one wiki.** The room's membership decides who can read it; its power levels
  decide who can edit it. There is no server-side component.
- **One page = one slug.** A slug identifies a page within its room.
- mxwiki defines two storage profiles for where the page body lives (§3, §4). v0.1 clients
  implement **Profile S**. **Profile T** is specified for timeline-body and end-to-end
  encrypted wikis and is experimental.

## 2. Slugs

A slug is the `state_key` of the page's state event and MUST match

```
^(?=.{1,128}$)[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$
```

i.e. 1–128 characters, segments of lowercase ASCII letters, digits, `.`, `_`, `-`, each
segment starting with a letter or digit, joined by `/`. Clients SHOULD present the segments
before the last `/` as folders (`minutes/2026-09-14` is page `2026-09-14` in folder
`minutes`). A folder exists only while a page is under it. Human-readable names, in any
script, go in the page title.

The page with slug `home` is the wiki's entry page by convention; clients SHOULD open it
first when present.

## 3. Profile S — body in state (v0.1)

| Item | Value |
|---|---|
| Event type | `com.knatrix.mxwiki.page` (state event) |
| `state_key` | the slug (§2) |
| `content` | `{ "title": string, "body": string, "updated_by": string, "updated_at": string }` |
| `body` | Markdown (CommonMark + GFM), UTF-8, **at most 48 KiB (49 152 bytes)** |
| Delete | send the state event with empty content `{}` |

- `title`: display title. Writers SHOULD fall back to the first `# heading` of the body, then
  to the slug, when none is given.
- `updated_by`: the Matrix user ID of the writer; `updated_at`: ISO 8601 UTC timestamp with
  second precision (`2026-09-14T12:34:56Z`). Both are informational; the event's `sender`
  and `origin_server_ts` are authoritative.
- The 48 KiB body limit leaves room for the rest of the event under Matrix's 64 KiB event
  size limit. Writers MUST refuse larger bodies rather than truncating them.
- A page whose content has neither `title` nor `body` is deleted. Readers MUST NOT list it.
  Deletion keeps the page's history (the earlier versions stay in the room's timeline).
- History is the chain of state events for `(type, slug)` in the timeline
  (`replaces_state`). Renaming a page is copy + delete; the history stays on the old slug.
- Concurrent edits are last-write-wins. Interactive writers SHOULD detect that the page
  changed since editing began (compare the `event_id` they started from) and ask.

## 4. Profile T — body in the timeline (experimental)

This is the MyWiki model (see `docs/MYWIKI-DESIGN.md`) made precise. It keeps state small,
keeps bodies out of unencrypted state (so it works unchanged in end-to-end encrypted rooms)
and has no 48 KiB limit on the page as a whole beyond the per-event limit.

| Item | Value |
|---|---|
| Body event type | `com.knatrix.mxwiki.body` (timeline event; encrypted in E2EE rooms) |
| Body content | `{ "slug": string, "title": string, "body": string }` |
| First version | a body event without relation; it is the page's **root** |
| Later versions | body events with `"m.relates_to": { "rel_type": "m.reference", "event_id": <root event ID> }` |
| Pointer type | `com.knatrix.mxwiki.page_ref` (state event, `state_key` = slug) |
| Pointer content | `{ "title", "root_event_id", "latest_event_id", "body_sha256", "updated_by", "updated_at" }` |

- There is no separate anchor event: the first version is the root.
- `body_sha256` is the lowercase hex SHA-256 of the UTF-8 bytes of the latest `body`.
- **Reading.** Take the pointer from state, then fetch the relations of `root_event_id`
  (`/relations/{root}/m.reference`, paginated backwards) plus the root itself. **Use only the
  version whose event ID equals `latest_event_id` and whose body hashes to `body_sha256`.**
  Anyone who can send messages can send a body event that references a root, so the newest
  relation MUST NOT be trusted; the power-level-protected pointer is the authority.
- **History** is the list of relations of the root, plus the root.
- **Writing.** Send the body event, then update the pointer. Deleting is `{}` on the pointer.
- In encrypted rooms the body events are `m.room.encrypted`; `m.relates_to` stays in the
  clear (as for all relations), so the same algorithm applies after decryption.
- A widget can read relations through `WidgetApi.readEventRelations` (MSC3869). Element Web's
  driver implements it with `client.relations`; this has been confirmed in the source but not
  yet against a running Element. **Status in v0.1:** specified only. The widget does not
  implement Profile T; the reference implementation is the PoC under `legacy/`. Before a
  client enables it, the E2E harness's `WidgetDriver` gets `readEventRelations`, and the
  latest version and history are verified on a local Synapse in (1) an unencrypted and
  (2) an encrypted room. `mxwiki migrate` already reads Profile T pointers (§9).

## 5. Links between pages

`[[slug]]` and `[[slug|label]]` in a body link to the page with that slug in the same room.
Clients MUST render links to pages that do not exist (or are deleted) distinguishably (the
widget draws them dashed) and SHOULD offer to create the page when one is followed.

## 6. Widget pin

A room gets its wiki UI by pinning the widget:

| Item | Value |
|---|---|
| Event type | `im.vector.modular.widgets` |
| `state_key` | `com.knatrix.mxwiki` |
| `content` | `{ "type": "m.custom", "name": "Wiki", "url": "<widget origin>/?roomId=$matrix_room_id&widgetId=$matrix_widget_id&userId=$matrix_user_id", "creatorUserId": <mxid>, "id": "com.knatrix.mxwiki", "data": {} }` |
| Unpin | empty content `{}` |

The widget reads `widgetId`, `roomId`, `userId` and the client-supplied `parentUrl` from its
URL. Optional, Element-specific: the layout state event `io.element.widgets.layout`
(`state_key` `""`) with `widgets["com.knatrix.mxwiki"] = { "container": "top" | "right",
"index": 0, "width": 100, "height": <percent> }` opens the widget for every member; without
an entry it lives in the room's Extensions panel (`mxwiki layout top|right|none`).

## 7. Widget capabilities

The widget requests exactly these capabilities, and no others:

- `org.matrix.msc2762.receive.state_event:com.knatrix.mxwiki.page`
- `org.matrix.msc2762.send.state_event:com.knatrix.mxwiki.page`
- `org.matrix.msc2762.receive.event:com.knatrix.mxwiki.page` (the recent-history view)

It never passes `room_id` to Widget API calls: the client scopes them to the room the widget
is pinned in. Naming a room would require the `org.matrix.msc2762.timeline:<room>`
capability.

## 8. Power levels

| Action | Needs |
|---|---|
| Pin / unpin / layout | the level for `im.vector.modular.widgets` (Element's default: 50) and `io.element.widgets.layout` |
| Edit pages | the level for `com.knatrix.mxwiki.page` in `m.room.power_levels` → `events`; without an entry, `state_default` (default 50) |
| Grant page editing | the level for `m.room.power_levels` (default 100) |

To let every member edit, add `"com.knatrix.mxwiki.page": 0` to `events`
(`mxwiki grant-edit --level 0`). For Profile T the pointer type `com.knatrix.mxwiki.page_ref`
is the one to grant; sending body events needs only the level for messages.

## 9. Element module configuration

The optional header-button module reads this key from Element Web's `config.json`:

```json
"com.knatrix.mxwiki": { "host": "<widget host>", "path": "/" }
```

A pinned widget whose URL host equals `host` and whose path starts with `path` (or whose
name is `Wiki`) gets a button in the room header.

## 10. Versioning and migration

The type names in this document are fixed for the 0.x and 1.x series. Should Matrix gain a
standard event type for wiki pages through an MSC, mxwiki will move to it in a major version;
the migration path is `mxwiki migrate --from <old type>`, which copies every page of the old
type to the new one under the same slug and leaves the old events in place (`--dry-run`
lists what would be copied). The same command migrates rooms written with pre-release type
names and Profile T / MyWiki pointer types (it follows `latest_event_id`, checks
`body_sha256` when present, and skips encrypted bodies).
