# Using mxwiki from bots and AI agents

Chat is where things flow; the wiki is where they stay. A bot that writes reports,
minutes or research notes can put them in the room's wiki with the CLI, using **its own
Matrix account**: it then has exactly the permissions of a room member at its power level,
and every page it writes is attributed to it.

## Setup

- Give the bot an account, invite it to the rooms, and make sure its power level can edit
  pages (`mxwiki grant-edit --level 0` lets every member edit).
- Put its credentials in a dotenv file readable only by the bot:

  ```
  MATRIX_HOMESERVER=https://matrix.example.org
  MATRIX_ACCESS_TOKEN=...
  ```

- Install the CLI where the bot runs: `pipx install mxwiki` (or `uv tool install mxwiki`).

## Command shape

Agent frameworks often vet shell commands before running them, and anything they cannot
read statically (variables, `source`, loops, pipes, heredocs) tends to be held for approval
or rejected. So:

- **One call = one complete command**, starting with the full path of the executable.
- **Pass credentials with `--env-file PATH`.** The CLI reads the file itself; never
  `source` it or export variables in the shell.
- **Always pass `--room`.** Each room has its own wiki; there is no default.
- **Write bodies to a file first**, then `put … -f FILE --rm`. `--rm` deletes the draft
  after a successful put, so a later run never trips over a stale file.

```sh
/usr/local/bin/mxwiki --env-file /etc/bot/matrix.env --room '#research:example.org' list
/usr/local/bin/mxwiki --env-file /etc/bot/matrix.env --room '#research:example.org' get daily/2026-09-14
/usr/local/bin/mxwiki --env-file /etc/bot/matrix.env --room '#research:example.org' search 'keyword'
/usr/local/bin/mxwiki --env-file /etc/bot/matrix.env --room '#research:example.org' put daily/2026-09-14 --title 'Daily 2026-09-14' -f /tmp/daily-2026-09-14.md --rm
/usr/local/bin/mxwiki --env-file /etc/bot/matrix.env --room '#research:example.org' index-add daily/2026-09-14 --title 'Daily 2026-09-14' --note 'one line'
/usr/local/bin/mxsearch --env-file /etc/bot/matrix.env find 'keyword' --room '#research:example.org'
```

Read several pages with several `get` calls, one per call.

## Conventions

- **Post the slug, not the body.** After writing a page, reply in chat with the page name
  and one line of summary. Do not paste the body into the chat.
- **`home` is the index.** After creating a page, add it with `index-add` (one line under a
  heading; it creates the heading if missing and does nothing if the page is already
  listed). Rewrite `home` itself only to restructure it.
- **Slugs** are lowercase ASCII paths (`daily/2026-09-14`, `topic/<name>`,
  `minutes/YYYY-MM-DD`); human-readable titles, in any language, go in `--title`.
- **Whole-page writes.** There is no partial update: `get`, edit, `put` the whole page.
- **48 KiB per page.** Split long pages (`topic/x/part-2`).
- **Read freely, write when asked.** Reading another room's wiki is fine where the bot is a
  member; writing there should be on request.

## Answering with receipts

For "did we discuss X?" questions, search before answering, and cite:

```sh
/usr/local/bin/mxsearch --env-file /etc/bot/matrix.env find 'X' --limit 10
/usr/local/bin/mxwiki --env-file /etc/bot/matrix.env --room '#team:example.org' search 'X'
```

Every `mxsearch` hit carries a matrix.to permalink; an answer should link to the messages it
is based on rather than paraphrase from memory. `mxsearch thread <event_id>` shows the whole
thread around a hit.

## Errors

- `403`: the bot is not in the room, or its power level cannot edit pages.
- `M_NOT_FOUND` / `no such page`: wrong slug; `list` shows what exists.
- `which room?`: `--room` is missing.
