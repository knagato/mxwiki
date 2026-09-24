# Contributing

Issues and pull requests are welcome. Please keep changes small and focused, and describe
how you tested them.

## Ground rules

- **The wire format is `docs/SPEC.md`.** A change to event types, content fields, slugs,
  limits or capabilities starts as a change to SPEC.md and `spec/vectors.json`, and must be
  made in the widget and the CLI together. Renaming an event type is a major version.
- The widget requests exactly the capabilities in SPEC §7. Adding one needs a reason in the
  PR: every capability is a prompt users have to approve.
- The CLI stays standard-library only.
- `scripts/check-no-upstream-names.sh` must pass (CI runs it).
- Package operations use **pnpm**.

## Development

```sh
# widget
cd widget
pnpm install
pnpm dev            # http://localhost:5180 — dev mode (?hs=https://…&room=%23room:server pre-fills the form)
pnpm test           # unit tests (spec vectors)
pnpm build          # -> widget/dist

# CLI
cd cli
python -m unittest discover -s tests
uvx ruff check .
uv tool install --editable .     # mxwiki / mxsearch on PATH
```

### Try it in Element (local Docker)

`examples/local/` runs Synapse, Element Web (with the header-button module) and the widget
built from this checkout, all bound to 127.0.0.1:

```sh
cd examples/local
docker compose up -d --build
./setup.sh               # user alice / mxwiki-local, a room with pages, widget pinned
# open http://localhost:18915, sign in, open the room, click the book icon in the header
docker compose down -v   # remove everything
```

Ports 18914 (Synapse), 18915 (Element), 18916 (widget). `scripts/synapse-dev.sh` also uses
18914, so stop one before starting the other. After changing the widget, rebuild with
`docker compose up -d --build wiki`.

### End-to-end test

The harness (`widget/test/harness.html`) stands in for Element: it hosts the widget in an
iframe and answers its Widget API requests with a `WidgetDriver` built on the client API.
`widget/test/run.mjs` drives it with puppeteer-core and headless Chrome against a real
homeserver.

```sh
scripts/synapse-dev.sh up                  # throwaway Synapse on http://localhost:18914 (Docker)
cd widget
node test/setup-synapse.mjs > /tmp/e2e.env # registers a user, creates a room, grants page edits
set -a; . /tmp/e2e.env; set +a
node test/run.mjs                          # CHROME_PATH=... if Chrome is not in the default macOS location
cd .. && scripts/synapse-dev.sh down
```

Ports: `MXWIKI_SYNAPSE_PORT` (default 18914) and `MXWIKI_TEST_PORT` for vite (default 5180).
`run.mjs` also works against any homeserver and room given in `MXWIKI_TEST_HS`,
`MXWIKI_TEST_TOKEN` and `MXWIKI_TEST_ROOM`; it seeds a `home` page if there is none and
removes what it created afterwards.

## Releasing

1. Set the version in `cli/src/mxwiki/__init__.py` and `widget/package.json`, and move the
   `CHANGELOG.md` entry out of "unreleased".
2. Tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` checks the versions, then
   attaches `mxwiki-widget-vX.Y.Z.tar.gz` to the GitHub Release, pushes
   `ghcr.io/knagato/mxwiki:X.Y.Z` (and `X.Y`, `latest`), and publishes the CLI to PyPI.

One-time setup for PyPI Trusted Publishing: on pypi.org, add a pending publisher for project
`mxwiki` with owner `knagato`, repository `mxwiki`, workflow `release.yml`, environment
`pypi`; in the GitHub repository settings, create the environment `pypi` (optionally with
required reviewers). No API token is stored.
