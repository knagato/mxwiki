# mxwiki

**A Matrix room as a page-oriented wiki.** One page = one state event. No server of its own:
the room's members can read the wiki, and its power levels decide who edits it.

- **widget/**: a room widget for Element (and other clients that support widgets): page
  tree with folders, Markdown with `[[slug]]` links, editing, a history view, and live
  updates when someone else saves. Built on `matrix-widget-api`, `marked` and `DOMPurify`.
  Outside Element it has a dev mode that connects with an access token.
- **cli/**: `mxwiki` (list / get / put / rm / mv / history / search / mirror / pin / unpin /
  layout / migrate / grant-edit) and `mxsearch` (full-text search over room history, with
  matrix.to permalinks). Python standard library only.
- **element-module/**: an optional Element Web module that adds a "Wiki" button to the room
  header.

![mxwiki in Element's right panel: the page tree with folders, and the Home page with [[links]], one of them dashed because the page does not exist yet](docs/images/screenshot.png)

## Try it in 5 minutes

You need a Matrix account that can pin widgets in a room (power level 50) and a place to
serve static files over HTTPS.

```sh
# 1. Build the widget and serve it (any static host; see docs/DEPLOY.md for headers)
cd widget && pnpm install && pnpm build        # -> widget/dist
#    or: docker run -p 8080:80 -e MXWIKI_FRAME_ANCESTORS=https://element.example.org ghcr.io/knagato/mxwiki

# 2. Install the CLI
pipx install mxwiki                            # or: uv tool install mxwiki

# 3. Pin it in a room and write the first page
export MATRIX_HOMESERVER=https://matrix.example.org MATRIX_ACCESS_TOKEN=...
mxwiki --room '#team:example.org' pin --url https://wiki.example.org/
echo '# Home

Start here. See [[minutes/2026-09-14]].' | mxwiki --room '#team:example.org' put home
```

Open the room in Element → room info → Extensions → **Wiki**, approve the capabilities once,
and the wiki opens in the right panel. (Your access token is in Element under Settings →
Help & About → Advanced; a bot account with its own token is better for scripts.)

## Permissions

| Who | Can |
|---|---|
| Room members | read the wiki (it is room state) |
| Members with the power level for `com.knatrix.mxwiki.page` | edit pages. Without an entry in `m.room.power_levels` → `events`, that is `state_default` (50). `mxwiki grant-edit --level 0` lets everyone edit. |
| PL 50 (Element default for widgets) | pin / unpin the widget, set the shared layout |
| PL 100 (room admin) | `grant-edit` |

Pages are stored in **unencrypted** room state even in encrypted rooms; don't keep secrets
in a Profile S wiki. See [SECURITY.md](SECURITY.md).

## Element button (optional)

`element-module/widget-button.js` adds a "Wiki" button next to the room-info button in rooms
that have the widget pinned. It is an **optional add-on**: Element has no extension point for
the room header, so the module inserts the button by cloning an existing header button. If an
Element update changes that markup, the button just disappears — the wiki itself still opens
from the Extensions panel. Setup: [docs/DEPLOY.md §4](docs/DEPLOY.md).

Checked with Element Web 1.12.29 (header button, widget in the right panel, capability approval, editing).

## Documentation

- [docs/SPEC.md](docs/SPEC.md): the wire format (event types, slugs, limits, capabilities,
  power levels). The source of truth; the widget and CLI are tested against it.
- [docs/DESIGN.md](docs/DESIGN.md): why there is no server, what the Widget API actually
  does, and the alternatives that were considered.
- [docs/DEPLOY.md](docs/DEPLOY.md): static hosting, CSP and caching, Docker, Element config.
- [docs/AGENTS.md](docs/AGENTS.md): driving the CLI from bots and AI agents.
- [docs/MYWIKI-DESIGN.md](docs/MYWIKI-DESIGN.md): the original MyWiki design notes (Japanese).

## Repository layout

```
widget/            room widget (vite). src/: spec, slug, strings, render, backend, main
widget/test/       unit tests + end-to-end harness (a stand-in for Element, run against Synapse)
cli/               Python package `mxwiki` (commands: mxwiki, mxsearch)
element-module/    optional Element Web module (header button)
spec/vectors.json  test vectors shared by the widget and CLI tests
examples/          Caddyfile and docker-compose.yml for serving the widget
legacy/            MyWiki PoCs: the reference implementation of Profile T (not built, not in CI)
```

`legacy/tier1-poc/` (`plan-a.html` is the main line; `index.html`, `plan-b.html` are demos)
and `legacy/tier2/` (end-to-end encrypted, matrix-js-sdk) are the MyWiki proofs of concept
that store bodies in the timeline. They are kept as the reference implementation of
**Profile T** (SPEC §4) and are not maintained.

## 日本語

mxwiki は Matrix のルーム 1 つをページ指向の Wiki にするツールです。1 ページ = 1 つの
state event（`com.knatrix.mxwiki.page`、state_key = slug）で、ルームのメンバーシップと
power level がそのまま Wiki の閲覧・編集権限になります。サーバー側のコードはありません。

- **widget/**: Element のルームウィジェット。フォルダ付きページ一覧、Markdown、`[[slug]]`
  リンク、編集、履歴、他人の保存の即時反映。UI 文言は現在日本語（`widget/src/strings.js`
  に集約。英語などを足せます）。
- **cli/**: `mxwiki`（ページ操作・ウィジェットの pin・`migrate`・`grant-edit`）と
  `mxsearch`（ルーム履歴の部分一致検索。Synapse の `/search` は日本語の文中語に当たらない
  ため独自キャッシュで検索し、matrix.to リンクを返す）。
- **element-module/**: ルームヘッダーに「Wiki」ボタンを足す任意のアドオン。Element の DOM
  変更で壊れてもボタンが消えるだけで、Wiki 自体は拡張機能パネルから開けます。

試し方は上の「Try it in 5 minutes」、仕様は [docs/SPEC.md](docs/SPEC.md)、設計の経緯
（本文を timeline から state に移した理由）は [docs/DESIGN.md](docs/DESIGN.md) と
[docs/MYWIKI-DESIGN.md](docs/MYWIKI-DESIGN.md) を参照してください。

## License

[Apache-2.0](LICENSE). Copyright 2026 knagato.
