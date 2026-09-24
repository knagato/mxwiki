# Changelog

## 0.1.0 (unreleased)

First release as a standalone project. History starts with the MyWiki proofs of concept
(2026-08); the room-widget implementation was ported back from a downstream deployment
(2026-09).

### Wire format

- `docs/SPEC.md`: page state event `com.knatrix.mxwiki.page` (Profile S, body in state,
  48 KiB), widget pin under state key `com.knatrix.mxwiki`, exactly three widget
  capabilities, power levels, the Element module config key `com.knatrix.mxwiki`.
- Profile T (body in the timeline, `com.knatrix.mxwiki.body` + `com.knatrix.mxwiki.page_ref`
  with `body_sha256`) specified as experimental.
- `spec/vectors.json`: slug and size vectors shared by the widget and CLI tests.

### Widget

- Room widget with folder tree, Markdown and `[[slug]]` links, editing with conflict check,
  recent-history view with restore, live updates from `update_state` pushes (with a
  `read_events` fallback for older clients), dev mode with an access token
  (`?hs=&room=` pre-fill).
- UI strings collected in `widget/src/strings.js`.
- End-to-end harness runs against a local Synapse (`scripts/synapse-dev.sh`).

### CLI (`pip install mxwiki`)

- `mxwiki`: list, get, put, index-add, rm, mv, history, search, mirror, pin, unpin, layout.
- New: `migrate --from TYPE [--dry-run] [--force]`, `grant-edit [--level N]`,
  `--env-file PATH` for credentials (`--hs/--token` > `--env-file` > environment).
- `pin` requires `--url` (or `MXWIKI_WIDGET_URL`) and appends the widget query template.
- `mxsearch`: sync, rooms, find, thread over a local cache of room history.

### Element module

- Optional header button; config key `com.knatrix.mxwiki` with `host` and `path`.
