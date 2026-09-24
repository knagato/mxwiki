# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a vulnerability"**
(Security → Advisories) on this repository rather than in a public issue. You should get a
first answer within a week.

## Security model

- **Access control is the room's.** Anyone who can read the room's state can read every
  page; anyone with the power level for `com.knatrix.mxwiki.page` can change or delete any
  page. Deleted pages remain in the room's history.
- **Profile S pages are not encrypted.** State events are never end-to-end encrypted, even in
  encrypted rooms, so page bodies are readable by the homeservers of the room's members. Do
  not put secrets in a wiki. Profile T (SPEC §4) is designed for encrypted wikis and is
  experimental.
- **Rendering.** Page bodies are Markdown from any editor of the room. The widget renders them
  with `marked` and sanitises the HTML with `DOMPurify` before inserting it; external links
  open in a new tab with `rel=noopener`.
- **Widget capabilities.** The widget asks only for reading and sending its own page state
  type and reading its events (SPEC §7). It gets no access token from the client.
- **Framing.** Serve the widget with `Content-Security-Policy: frame-ancestors` limited to
  your Element origin(s) (docs/DEPLOY.md).
- **Dev mode** (outside Element) takes an access token in a form field and keeps it in
  memory only; it is never stored. Use it for development, not as a way to share the wiki.
- **The CLI** reads tokens from arguments, an env file, or the environment, and sends them
  only to the configured homeserver. Keep env files readable by their owner only.
