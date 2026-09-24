"""mxwiki — page-oriented CLI for a Matrix room used as a wiki (docs/SPEC.md, Profile S).

One page = one state event of type com.knatrix.mxwiki.page, state_key = slug,
content = {title, body (Markdown), updated_by, updated_at}. The body lives in
the state event itself, so the page list is the room state and the history is
the replaces_state chain.

Credentials (per value, first match wins):
  --hs / --token              explicit
  --env-file PATH             dotenv file with MATRIX_HOMESERVER / MATRIX_ACCESS_TOKEN
                              (so a bot never has to `source` the file in a shell)
  $MATRIX_HOMESERVER / $MATRIX_ACCESS_TOKEN

Room: --room <id|alias> or $WIKI_ROOM (required — every room has its own wiki, there is no default one).

  mxwiki list
  mxwiki get <slug>                    # body to stdout; --json for the whole content
  mxwiki put <slug> [--title T] [-f file [--rm] | body on stdin]   # --rm deletes the file once the page landed
  mxwiki index-add <slug> --title T [--note N] [--page home] [--section H]
                                       # add `- [[slug|T]] — N` under a heading of the index page (no temp file)
  mxwiki rm <slug>                     # empties the state event (content {}), keeps history
  mxwiki mv <old> <new>                # copy to the new slug, empty the old (history stays on the old slug)
  mxwiki history <slug> [--limit N]    # walks /messages backwards for state events of the slug
  mxwiki search <text>                 # client-side over title + body
  mxwiki mirror <dir>                  # write every page as <dir>/<slug>.md (room -> Markdown)
  mxwiki pin --url U [--layout top|right]   # add the Wiki widget (Extensions panel; --layout opens it for everyone)
  mxwiki unpin                              # remove the widget and its layout entry
  mxwiki layout top|right|none              # set/clear the shared layout entry only
  mxwiki migrate --from TYPE [--dry-run]    # copy every page of an older state type to this one
  mxwiki grant-edit [--level N]             # let members at PL N edit pages (default 0 = everyone)

Every room can carry its own wiki: `pin` is per room (one widget state event),
pages are that room's com.knatrix.mxwiki.page state. `pin` needs the PL for
im.vector.modular.widgets (50 by default); `grant-edit` needs the PL for
m.room.power_levels (100 by default).
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from .client import Api, add_cred_args, load_creds

PAGE_TYPE = "com.knatrix.mxwiki.page"
WIDGET_TYPE = "im.vector.modular.widgets"
LAYOUT_TYPE = "io.element.widgets.layout"
WIDGET_ID = "com.knatrix.mxwiki"
WIDGET_QUERY = "roomId=$matrix_room_id&widgetId=$matrix_widget_id&userId=$matrix_user_id"
MAX_BODY = 48 * 1024  # bytes; the whole event is capped at 64 KiB


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ts_iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def pages(api, room):
    out = []
    for ev in api.state(room):
        if ev.get("type") == PAGE_TYPE and ev.get("state_key") and ev.get("content"):
            c = ev["content"]
            out.append({"slug": ev["state_key"], "title": c.get("title") or ev["state_key"],
                        "body": c.get("body", ""), "updated_by": c.get("updated_by", ev.get("sender")),
                        "updated_at": c.get("updated_at"), "event_id": ev.get("event_id")})
    return sorted(out, key=lambda p: p["slug"])


# Slugs may be paths (`minutes/2026-08-14`); the widget shows the path as folders.
SLUG_RE = re.compile(r"^(?=.{1,128}$)[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$")


def valid_slug(slug):
    return bool(SLUG_RE.match(slug))


def check_slug(slug):
    if not valid_slug(slug):
        sys.exit(f"bad slug {slug!r}: segments of lowercase letters, digits, '.', '_', '-' joined by '/' (max 128)")


def check_body(body, what="body"):
    n = len(body.encode())
    if n > MAX_BODY:
        sys.exit(f"{what} is {n} bytes; limit {MAX_BODY} (split the page)")


def cmd_list(api, room, args):
    for p in pages(api, room):
        if args.json:
            print(json.dumps({k: v for k, v in p.items() if k != "body"}, ensure_ascii=False))
        else:
            print(f"{p['slug']:32} {p['title']:40} {p['updated_at'] or '':20} {p['updated_by'] or ''}")


def cmd_get(api, room, args):
    check_slug(args.slug)
    c = api.try_get_state(room, PAGE_TYPE, args.slug)
    if not c:
        sys.exit(f"{args.slug}: no such page (or deleted)")
    if args.json:
        print(json.dumps(c, ensure_ascii=False, indent=2))
    else:
        sys.stdout.write(c.get("body", ""))
        if not c.get("body", "").endswith("\n"):
            sys.stdout.write("\n")


def cmd_put(api, room, args):
    check_slug(args.slug)
    if args.file:
        body = Path(args.file).read_text()
    else:
        body = sys.stdin.read()
    check_body(body)
    title = args.title
    if not title:
        m = re.match(r"^#\s+(.+)$", body.lstrip(), re.MULTILINE)
        title = m.group(1).strip() if m else args.slug
    content = {"title": title, "body": body, "updated_by": api.whoami(), "updated_at": now_iso()}
    r = api.put_state(room, PAGE_TYPE, args.slug, content)
    print(f"put {args.slug} ({len(body.encode())} bytes) -> {r['event_id']}")
    if args.file and args.rm:
        # For callers that draft pages in a temp file (bots): consuming the
        # draft here means the next run never finds a stale file at that path.
        Path(args.file).unlink(missing_ok=True)


def insert_index_line(body, heading, line, slug):
    """Return body with `line` inserted under the heading whose text is `heading`.

    A line already mentioning [[slug is left alone (None is returned). The
    heading is matched by text at any level; a missing heading is created: a
    YYYY-MM heading goes above the first existing YYYY-MM heading (newest
    first), anything else is appended at the end.
    """
    if re.search(r"\[\[" + re.escape(slug) + r"(\||\]\])", body):
        return None
    lines = body.rstrip("\n").split("\n")
    head_re = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
    idx = None
    for i, l in enumerate(lines):
        m = head_re.match(l)
        if m and m.group(2).strip() == heading:
            idx = i
            break
    if idx is None:
        month_re = re.compile(r"^#{1,6}\s+\d{4}-\d{2}\s*$")
        months = [i for i, l in enumerate(lines) if month_re.match(l)]
        if re.fullmatch(r"\d{4}-\d{2}", heading) and months:
            level = lines[months[0]].split()[0]
            lines[months[0]:months[0]] = [f"{level} {heading}", "", line, ""]
        else:
            # Match the level the page already uses for its sections (the H1 is the title).
            subs = [head_re.match(l).group(1) for l in lines if head_re.match(l) and len(head_re.match(l).group(1)) >= 2]
            level = subs[-1] if subs else "##"
            lines += ["", f"{level} {heading}", "", line]
        return "\n".join(lines) + "\n"
    # Insert as the first entry under the heading, keeping the page's own spacing style.
    j = idx + 1
    while j < len(lines) and lines[j].strip() == "":
        j += 1
    lines[j:j] = [line]
    return "\n".join(lines) + "\n"


def cmd_index_add(api, room, args):
    check_slug(args.slug); check_slug(args.page)
    c = api.try_get_state(room, PAGE_TYPE, args.page)
    if not c:
        sys.exit(f"{args.page}: no such page (or deleted) — create the index first")
    line = f"- [[{args.slug}|{args.title}]]"
    if args.note:
        line += f" — {args.note}"
    heading = args.section or datetime.datetime.now().astimezone().strftime("%Y-%m")
    body = insert_index_line(c.get("body", ""), heading, line, args.slug)
    if body is None:
        print(f"{args.page}: [[{args.slug}]] already listed, nothing to do")
        return
    check_body(body, args.page)
    content = {"title": c.get("title") or args.page, "body": body, "updated_by": api.whoami(), "updated_at": now_iso()}
    r = api.put_state(room, PAGE_TYPE, args.page, content)
    print(f"index-add {args.page}: + [[{args.slug}]] under '{heading}' -> {r['event_id']}")


def cmd_rm(api, room, args):
    check_slug(args.slug)
    r = api.put_state(room, PAGE_TYPE, args.slug, {})
    print(f"emptied {args.slug} -> {r['event_id']}")


def cmd_mv(api, room, args):
    check_slug(args.old); check_slug(args.new)
    c = api.try_get_state(room, PAGE_TYPE, args.old)
    if not c:
        sys.exit(f"{args.old}: no such page (or empty)")
    if api.try_get_state(room, PAGE_TYPE, args.new) and not args.force:
        sys.exit(f"{args.new} already exists (use --force to overwrite)")
    c = dict(c, updated_by=api.whoami(), updated_at=now_iso())
    r = api.put_state(room, PAGE_TYPE, args.new, c)
    api.put_state(room, PAGE_TYPE, args.old, {})
    print(f"moved {args.old} -> {args.new} ({r['event_id']}); links [[{args.old}]] elsewhere need updating")


def cmd_history(api, room, args):
    check_slug(args.slug)
    filt = {"types": [PAGE_TYPE], "lazy_load_members": True}
    frm, n = None, 0
    while n < args.limit:
        r = api.messages(room, frm, 200, filt)
        for ev in r.get("chunk", []):
            if ev.get("type") == PAGE_TYPE and ev.get("state_key") == args.slug:
                c = ev.get("content") or {}
                ts = datetime.datetime.fromtimestamp(ev["origin_server_ts"] / 1000, datetime.timezone.utc).isoformat()
                size = len((c.get("body") or "").encode())
                print(f"{ev['event_id']}  {ts}  {ev['sender']}  {c.get('title','(deleted)') if c else '(deleted)'}  {size}B")
                if args.show:
                    print(c.get("body", ""))
                    print("-" * 60)
                n += 1
                if n >= args.limit:
                    break
        frm = r.get("end")
        if not frm or not r.get("chunk"):
            break


def cmd_search(api, room, args):
    needle = args.text.lower()
    for p in pages(api, room):
        hay = (p["title"] + "\n" + p["body"]).lower()
        if needle in hay:
            line = next((l for l in p["body"].splitlines() if needle in l.lower()), "")
            print(f"{p['slug']:32} {p['title'][:40]:40} {line.strip()[:80]}")


def cmd_mirror(api, room, args):
    d = Path(args.dir)
    d.mkdir(parents=True, exist_ok=True)
    seen = set()
    for p in pages(api, room):
        f = d / f"{p['slug']}.md"
        f.parent.mkdir(parents=True, exist_ok=True)
        fm = f"---\ntitle: {json.dumps(p['title'], ensure_ascii=False)}\nslug: {p['slug']}\nupdated_by: {p['updated_by']}\nupdated_at: {p['updated_at']}\n---\n"
        f.write_text(fm + p["body"])
        seen.add(f)
    if args.prune:
        for f in d.rglob("*.md"):
            if f not in seen:
                f.unlink()
    print(f"mirrored {len(seen)} pages -> {d}")


def set_layout(api, room, container, height=50):
    """Shared layout (Element, io.element.widgets.layout): where the widget is
    open for every member. None = no entry: the widget only lives in the
    Extensions panel and each member opens it when they want it."""
    layout = api.try_get_state(room, LAYOUT_TYPE, "") or {}
    widgets = layout.setdefault("widgets", {})
    if container:
        widgets[WIDGET_ID] = {"container": container, "index": 0, "width": 100, "height": height}
    elif WIDGET_ID in widgets:
        del widgets[WIDGET_ID]
    else:
        return
    r = api.put_state(room, LAYOUT_TYPE, "", layout)
    print(f"layout -> {r['event_id']} ({container or 'no entry'})")


def widget_url(url):
    """The widget origin as given, plus the query Element fills in, unless the
    caller already wrote its own template."""
    if "$matrix_widget_id" in url:
        return url
    return url + ("&" if "?" in url else "?") + WIDGET_QUERY


def cmd_pin(api, room, args):
    url = args.url or os.environ.get("MXWIKI_WIDGET_URL")
    if not url:
        sys.exit("pin: where is the widget served? pass --url https://wiki.example.org/ (or set MXWIKI_WIDGET_URL)")
    widget = {"type": "m.custom", "name": "Wiki", "url": widget_url(url), "data": {},
              "creatorUserId": api.whoami(), "id": WIDGET_ID}
    r = api.put_state(room, WIDGET_TYPE, WIDGET_ID, widget)
    print(f"widget -> {r['event_id']}")
    if args.layout:
        set_layout(api, room, args.layout, args.height)


def cmd_layout(api, room, args):
    set_layout(api, room, None if args.container == "none" else args.container, args.height)


def cmd_unpin(api, room, args):
    r = api.put_state(room, WIDGET_TYPE, WIDGET_ID, {})
    print(f"widget removed -> {r['event_id']}")
    set_layout(api, room, None)


def body_from_pointer(api, room, slug, c):
    """Body of a timeline-body page (Profile T `page_ref`, or the MyWiki PoC's
    `{title, latest_event_id}` pointer). Returns (body, None) or (None, reason)."""
    eid = c.get("latest_event_id")
    ev = api.event(room, eid)
    if not ev:
        return None, f"body event {eid} not readable"
    if ev.get("type") == "m.room.encrypted":
        return None, "body event is encrypted (migrate from a client that can decrypt it)"
    bc = ev.get("content") or {}
    nc = bc.get("m.new_content") or {}
    body = nc.get("wiki.raw") or bc.get("wiki.raw")
    if body is None and "slug" in bc and "body" in bc:  # Profile T com.knatrix.mxwiki.body
        body = bc["body"]
    if body is None:  # PoC messages carry `[wiki:<slug>] <title>\n\n<body>` in `body`
        body = re.sub(r"^\[wiki:[^\]]*\][^\n]*\n\n", "", nc.get("body") or bc.get("body") or "", count=1)
    want = c.get("body_sha256")
    if want and hashlib.sha256(body.encode()).hexdigest() != want:
        return None, "body does not match the pointer's body_sha256"
    return body, None


def cmd_migrate(api, room, args):
    """Copy every page of an older state type (a pre-release type name, or a
    timeline-body pointer type) to PAGE_TYPE under the same slug. The old
    events are left in place, so the migration can be repeated or undone."""
    if args.from_type == PAGE_TYPE:
        sys.exit(f"--from is the current type {PAGE_TYPE}; nothing to migrate")
    state = api.state(room)
    have = {ev["state_key"] for ev in state if ev.get("type") == PAGE_TYPE and ev.get("content")}
    todo = skipped = 0
    for ev in sorted((e for e in state if e.get("type") == args.from_type), key=lambda e: e.get("state_key", "")):
        slug, c = ev.get("state_key", ""), ev.get("content") or {}
        if not c:
            continue  # deleted page
        if not valid_slug(slug):
            print(f"skip {slug!r}: not a valid slug"); skipped += 1; continue
        if slug in have and not args.force:
            print(f"skip {slug}: already a {PAGE_TYPE} page (--force to overwrite)"); skipped += 1; continue
        if "body" in c:
            body = c.get("body") or ""
        elif c.get("latest_event_id"):
            body, why = body_from_pointer(api, room, slug, c)
            if body is None:
                print(f"skip {slug}: {why}"); skipped += 1; continue
        else:
            print(f"skip {slug}: content has neither body nor latest_event_id"); skipped += 1; continue
        n = len(body.encode())
        if n > MAX_BODY:
            print(f"skip {slug}: body is {n} bytes; limit {MAX_BODY}"); skipped += 1; continue
        content = {"title": c.get("title") or slug, "body": body,
                   "updated_by": c.get("updated_by") or ev.get("sender"),
                   "updated_at": c.get("updated_at") or ts_iso(ev.get("origin_server_ts", 0))}
        todo += 1
        if args.dry_run:
            print(f"would put {slug} ({n} bytes) from {ev.get('event_id')}")
        else:
            r = api.put_state(room, PAGE_TYPE, slug, content)
            print(f"put {slug} ({n} bytes) -> {r['event_id']}")
    verb = "would migrate" if args.dry_run else "migrated"
    print(f"{verb} {todo} page(s) from {args.from_type}; skipped {skipped}")


def cmd_grant_edit(api, room, args):
    """Add PAGE_TYPE to m.room.power_levels `events`, so members at --level
    can edit pages without the general state_default."""
    pl = api.get_state(room, "m.room.power_levels", "")
    me = api.whoami()
    mine = pl.get("users", {}).get(me, pl.get("users_default", 0))
    events = pl.setdefault("events", {})
    need = events.get("m.room.power_levels", pl.get("state_default", 50))
    old = events.get(PAGE_TYPE, pl.get("state_default", 50))
    if mine < need:
        sys.exit(f"grant-edit: changing m.room.power_levels needs power level {need} (usually 100, a room admin); "
                 f"{me} has {mine}. Ask a room admin to run this.")
    if max(args.level, old) > mine:
        sys.exit(f"grant-edit: {me} (PL {mine}) cannot set or change a level above its own "
                 f"(current {old}, requested {args.level})")
    if events.get(PAGE_TYPE) == args.level:
        print(f"{PAGE_TYPE} is already editable at PL {args.level}")
        return
    events[PAGE_TYPE] = args.level
    r = api.put_state(room, "m.room.power_levels", "", pl)
    print(f"power_levels: {PAGE_TYPE} = {args.level} -> {r['event_id']}")


def build_parser():
    ap = argparse.ArgumentParser(prog="mxwiki", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_cred_args(ap)
    ap.add_argument("--room", default=os.environ.get("WIKI_ROOM"), help="room ID or alias (else $WIKI_ROOM)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("list"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("get"); s.add_argument("slug"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_get)
    s = sub.add_parser("put"); s.add_argument("slug"); s.add_argument("--title"); s.add_argument("-f", "--file"); s.add_argument("--rm", action="store_true", help="delete --file after a successful put"); s.set_defaults(fn=cmd_put)
    s = sub.add_parser("index-add", help="add one `- [[slug|title]] — note` line to an index page"); s.add_argument("slug"); s.add_argument("--title", required=True); s.add_argument("--note"); s.add_argument("--page", default="home"); s.add_argument("--section", help="heading text to file it under (default: this month, YYYY-MM)"); s.set_defaults(fn=cmd_index_add)
    s = sub.add_parser("rm"); s.add_argument("slug"); s.set_defaults(fn=cmd_rm)
    s = sub.add_parser("mv"); s.add_argument("old"); s.add_argument("new"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_mv)
    s = sub.add_parser("history"); s.add_argument("slug"); s.add_argument("--limit", type=int, default=20); s.add_argument("--show", action="store_true"); s.set_defaults(fn=cmd_history)
    s = sub.add_parser("search"); s.add_argument("text"); s.set_defaults(fn=cmd_search)
    s = sub.add_parser("mirror"); s.add_argument("dir"); s.add_argument("--prune", action="store_true"); s.set_defaults(fn=cmd_mirror)
    s = sub.add_parser("pin"); s.add_argument("--url", help="where the widget is served (else $MXWIKI_WIDGET_URL); the Element query template is appended"); s.add_argument("--layout", choices=["top", "right"], help="also open it for everyone (default: Extensions panel only)"); s.add_argument("--height", type=int, default=50, help="percent of the room view for --layout top"); s.set_defaults(fn=cmd_pin)
    s = sub.add_parser("layout"); s.add_argument("container", choices=["top", "right", "none"]); s.add_argument("--height", type=int, default=50); s.set_defaults(fn=cmd_layout)
    s = sub.add_parser("unpin"); s.set_defaults(fn=cmd_unpin)
    s = sub.add_parser("migrate", help=f"copy pages of an older state type to {PAGE_TYPE}"); s.add_argument("--from", dest="from_type", required=True, metavar="TYPE"); s.add_argument("--dry-run", action="store_true"); s.add_argument("--force", action="store_true", help="overwrite slugs that already have a page"); s.set_defaults(fn=cmd_migrate)
    s = sub.add_parser("grant-edit", help="let members at --level edit pages (m.room.power_levels events)"); s.add_argument("--level", type=int, default=0); s.set_defaults(fn=cmd_grant_edit)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    hs, token = load_creds(args)
    api = Api(hs, token)
    room = args.room
    if not room:
        sys.exit("which room? pass --room '#team:example.org' (or set WIKI_ROOM); every room has its own wiki")
    room = api.resolve(room)
    args.fn(api, room, args)


if __name__ == "__main__":
    main()
