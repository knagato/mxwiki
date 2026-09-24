# Deploying

mxwiki has nothing to run except a static file server for the widget. The CLI runs wherever
you are; the Element button is optional.

## 1. Build and serve the widget

```sh
cd widget && pnpm install && pnpm build     # -> widget/dist (index.html + assets/)
```

Serve `widget/dist` over **HTTPS** from its own origin, e.g. `https://wiki.example.org/`.
Any static host works. Requirements:

- **`Content-Security-Policy: frame-ancestors https://<Element host>`** (plus `'self'` if you
  like). Element embeds the widget in an iframe; without its origin here the browser refuses
  to render it, and without the header anyone can frame it.
- **Caching:** files under `assets/` have content hashes in their names and never change:
  `Cache-Control: public, max-age=31536000, immutable`. `index.html` must be revalidated:
  `Cache-Control: no-cache`, so a new release reaches users on their next widget load.
- The widget talks only to the Matrix client through `postMessage`, so it needs no CORS or
  API access of its own. (Dev mode, used outside Element, calls the homeserver from the
  browser; Synapse sends CORS headers for the client API.)

`examples/Caddyfile` implements all of this; `examples/docker-compose.yml` runs it with
automatic HTTPS.

## 2. Docker image

```sh
docker run -d --restart unless-stopped -p 8080:80 \
  -e MXWIKI_FRAME_ANCESTORS=https://element.example.org \
  ghcr.io/knagato/mxwiki:latest
```

| Variable | Meaning | Default |
|---|---|---|
| `MXWIKI_SITE` | Caddy site address: a hostname (automatic HTTPS; publish 80 and 443 and mount `/data`) or `:80` behind your reverse proxy | `:80` |
| `MXWIKI_FRAME_ANCESTORS` | origins allowed to frame the widget, space-separated | empty (`'self'` only) |

Or build it yourself: `docker build -t mxwiki .`

## 3. Pin the widget in a room

```sh
pipx install mxwiki                        # or: uv tool install mxwiki
export MATRIX_HOMESERVER=https://matrix.example.org MATRIX_ACCESS_TOKEN=...
mxwiki --room '#team:example.org' pin --url https://wiki.example.org/
mxwiki --room '#team:example.org' grant-edit --level 0   # optional: every member can edit
mxwiki --room '#team:example.org' layout right           # optional: open it for everyone
```

`pin` needs power level 50 (Element's default for widgets); `grant-edit` needs 100. Every
room that should have a wiki gets its own pin. The first time a member opens the widget,
Element asks them to approve its three capabilities.

## 4. Element header button (optional)

1. Serve `element-module/widget-button.js` from your Element Web deployment (same origin is
   simplest), e.g. as `/modules/widget-button.js`.
2. In Element's `config.json`:

   ```json
   {
     "modules": ["/modules/widget-button.js"],
     "com.knatrix.mxwiki": { "host": "wiki.example.org", "path": "/" }
   }
   ```

With the official Element Web Docker image, mount the file as a directory module instead:
`widget-button.js` → `/modules/mxwiki/index.js`. The image serves `/modules` and adds every
`/modules/<name>/index.js` to `modules` in `config.json` by itself, so leave `modules` out of
your config (listing it too would load the module twice). `examples/local/` does this.

Rooms with the widget pinned get a "Wiki" button in the header that toggles the widget in the
right panel. The button depends on Element's header markup (see README, "Element button");
if it stops appearing after an Element upgrade, the wiki itself is unaffected.

## 5. Upgrading

Deploy the new `widget/dist` (or image). Because `index.html` is `no-cache`, clients pick up
the new bundle on the next widget load. Event types are stable within a major version; a
major version comes with a `mxwiki migrate` path (SPEC §10).
