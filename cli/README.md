# mxwiki (CLI)

Command-line tools for [mxwiki](https://github.com/knagato/mxwiki): a Matrix room as a
page-oriented wiki, one page per state event (`com.knatrix.mxwiki.page`). Standard
library only; talks to the client-server API v3 directly.

```sh
pipx install mxwiki            # or: uv tool install mxwiki
export MATRIX_HOMESERVER=https://matrix.example.org MATRIX_ACCESS_TOKEN=syt_...
mxwiki --room '#team:example.org' pin --url https://wiki.example.org/
mxwiki --room '#team:example.org' put home -f home.md
mxwiki --room '#team:example.org' list
mxsearch find "keyword"        # search room history, answers with matrix.to links
```

Commands: `list get put index-add rm mv history search mirror pin unpin layout migrate grant-edit`
(`mxwiki --help`). Credentials: `--hs/--token` > `--env-file PATH` > environment.
Wire format: [docs/SPEC.md](https://github.com/knagato/mxwiki/blob/main/docs/SPEC.md).
License: Apache-2.0.
