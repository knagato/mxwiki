"""mxsearch — search the history of the rooms this account is in, and answer with receipts.

Every hit comes with a matrix.to permalink, so an answer built from these
results points at the messages it came from instead of paraphrasing them from
memory (see docs/AGENTS.md).

Why not Synapse's /search: its Postgres full-text index tokenises on spaces, so
a Japanese (or Chinese, Thai, ...) sentence is one token and a keyword inside it
never matches. For small rooms (unencrypted, history visible to members) the
CLI keeps its own cache of every room's timeline and does plain substring
matching — deterministic, LLM-free, works for any language.

Credentials: same rules as mxwiki (--hs/--token, --env-file PATH,
$MATRIX_HOMESERVER / $MATRIX_ACCESS_TOKEN).

  mxsearch sync                       # pull new history into the cache (all joined rooms)
  mxsearch rooms                      # what is cached, per room
  mxsearch find <text> [<text> ...]   # substring search, AND across terms, newest first
      --room <id|alias>   only this room (repeatable)
      --since YYYY-MM-DD  --until YYYY-MM-DD
      --sender @user:hs   only this sender
      --limit N           default 20
      --context N         N messages before/after each hit (default 0)
      --no-sync           search the cache as is
      --json              one JSON object per hit
  mxsearch thread <event_id>          # the whole thread a message belongs to, oldest first

Cache: $MXSEARCH_CACHE or ~/.cache/mxsearch/<homeserver host>/<room_id>.jsonl.
Refresh walks /messages backwards until it meets an event it already has, so
a routine `find` costs one or two requests per room.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .client import Api as BaseApi
from .client import add_cred_args, load_creds

PAGE = 200
MAX_INITIAL_PAGES = 100   # 20 000 events per room on first sync; raise if a room is bigger


class Api(BaseApi):
    def room_name(self, room):
        url = self.hs + f"/_matrix/client/v3/rooms/{self.q(room)}/state/m.room.name/"
        r = urllib.request.Request(url, headers={"Authorization": "Bearer " + self.token})
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                return json.load(resp).get("name") or room
        except urllib.error.HTTPError:
            return room

    def messages(self, room, frm=None, limit=PAGE):
        return super().messages(room, frm, limit, {"types": ["m.room.message"], "lazy_load_members": True})

    def members(self, room):
        out = {}
        for ev in self.req("GET", f"/_matrix/client/v3/rooms/{self.q(room)}/members").get("chunk", []):
            c = ev.get("content") or {}
            if c.get("displayname"):
                out[ev["state_key"]] = c["displayname"]
        return out


# ---------------------------------------------------------------- cache ----

class Cache:
    """One JSONL per room: {event_id, ts, sender, body, thread, reply_to}. A
    sidecar <room>.meta.json holds the room name and member display names."""

    def __init__(self, hs):
        host = urllib.parse.urlparse(hs).netloc or hs
        self.dir = Path(os.environ.get("MXSEARCH_CACHE") or Path.home() / ".cache/mxsearch") / host
        self.dir.mkdir(parents=True, exist_ok=True)

    def path(self, room):
        return self.dir / (room.replace("/", "_") + ".jsonl")

    def meta_path(self, room):
        return self.dir / (room.replace("/", "_") + ".meta.json")

    def load(self, room):
        p = self.path(room)
        if not p.exists():
            return []
        return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]

    def save(self, room, events):
        events = sorted({e["event_id"]: e for e in events}.values(), key=lambda e: e["ts"])
        self.path(room).write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))
        return events

    def meta(self, room):
        p = self.meta_path(room)
        return json.loads(p.read_text()) if p.exists() else {}

    def save_meta(self, room, meta):
        self.meta_path(room).write_text(json.dumps(meta, ensure_ascii=False))

    def rooms(self):
        return [p.name[:-len(".jsonl")] for p in self.dir.glob("*.jsonl")]


def flatten(ev):
    c = ev.get("content") or {}
    body = c.get("body")
    if not isinstance(body, str) or not body:
        return None
    if c.get("m.new_content"):        # an edit: index the replacement text, drop the "* " prefix
        body = (c["m.new_content"].get("body") or body)
    rel = c.get("m.relates_to") or {}
    thread = rel.get("event_id") if rel.get("rel_type") == "m.thread" else None
    reply_to = ((rel.get("m.in_reply_to") or {}).get("event_id"))
    return {"event_id": ev["event_id"], "ts": ev.get("origin_server_ts", 0), "sender": ev.get("sender"),
            "body": body, "thread": thread, "reply_to": reply_to, "msgtype": c.get("msgtype")}


def sync_room(api, cache, room, quiet=False):
    known = cache.load(room)
    seen = {e["event_id"] for e in known}
    fresh, frm, pages = [], None, 0
    hit_known = False
    while True:
        page = api.messages(room, frm)
        for ev in page.get("chunk", []):
            if ev.get("event_id") in seen:
                hit_known = True
                break
            flat = flatten(ev)
            if flat:
                fresh.append(flat)
        pages += 1
        frm = page.get("end")
        if hit_known or not frm or not page.get("chunk") or pages >= MAX_INITIAL_PAGES:
            break
    events = cache.save(room, known + fresh) if fresh else known
    meta = cache.meta(room)
    if fresh or not meta:
        meta = {"name": api.room_name(room), "members": api.members(room),
                "synced_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        cache.save_meta(room, meta)
    if not quiet:
        print(f"{meta['name']:28} {room}  +{len(fresh):5}  total {len(events)}", file=sys.stderr)
    return events


def sync_all(api, cache, rooms=None, quiet=False):
    for room in rooms or api.joined_rooms():
        sync_room(api, cache, room, quiet=quiet)


# --------------------------------------------------------------- output ----

def fmt_ts(ts):
    return datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")


def permalink(hs, room, event_id):
    server = urllib.parse.urlparse(hs).netloc.split(":")[0]
    return f"https://matrix.to/#/{urllib.parse.quote(room, safe='')}/{urllib.parse.quote(event_id, safe='')}?via={server}"


def snippet(body, terms, width=160):
    text = " ".join(body.split())
    low = text.lower()
    pos = min((low.find(t.lower()) for t in terms if low.find(t.lower()) >= 0), default=0)
    start = max(0, pos - width // 3)
    s = text[start:start + width]
    return ("…" if start else "") + s + ("…" if start + width < len(text) else "")


def print_hit(hs, room, meta, e, terms, ctx_events=()):
    name = meta.get("members", {}).get(e["sender"], e["sender"])
    where = meta.get("name", room) + ("（スレッド内）" if e.get("thread") else "")
    print(f"- {fmt_ts(e['ts'])}  {where}  {name}")
    for c in ctx_events:
        who = meta.get("members", {}).get(c["sender"], c["sender"])
        print(f"    · {who}: {snippet(c['body'], terms, 120)}")
    print(f"  「{snippet(e['body'], terms)}」")
    print(f"  {permalink(hs, room, e['event_id'])}")


# ------------------------------------------------------------- commands ----

def cmd_sync(api, cache, args):
    rooms = [api.resolve(r) for r in args.room] if args.room else None
    sync_all(api, cache, rooms)


def cmd_rooms(api, cache, args):
    for room in sorted(cache.rooms()):
        meta = cache.meta(room)
        n = len(cache.load(room))
        print(f"{meta.get('name', room):28} {room}  {n:6} msgs  synced {meta.get('synced_at', '?')}")


def parse_day(s, end=False):
    d = datetime.datetime.strptime(s, "%Y-%m-%d").astimezone()
    if end:
        d += datetime.timedelta(days=1)
    return int(d.timestamp() * 1000)


def cmd_find(api, cache, args):
    rooms = [api.resolve(r) for r in args.room] if args.room else None
    if not args.no_sync:
        sync_all(api, cache, rooms, quiet=True)
    rooms = rooms or cache.rooms()
    terms = [t for t in args.text if t]
    since = parse_day(args.since) if args.since else None
    until = parse_day(args.until, end=True) if args.until else None
    hits = []
    for room in rooms:
        events = cache.load(room)
        meta = cache.meta(room)
        for i, e in enumerate(events):
            low = e["body"].lower()
            if not all(t.lower() in low for t in terms):
                continue
            if since and e["ts"] < since or until and e["ts"] >= until:
                continue
            if args.sender and e["sender"] != args.sender:
                continue
            ctx = events[max(0, i - args.context):i] if args.context else []
            hits.append((e["ts"], room, meta, e, ctx))
    hits.sort(key=lambda h: -h[0])
    hits = hits[:args.limit]
    if args.json:
        for ts, room, meta, e, ctx in hits:
            print(json.dumps({**e, "room_id": room, "room": meta.get("name", room),
                              "sender_name": meta.get("members", {}).get(e["sender"], e["sender"]),
                              "when": fmt_ts(ts), "url": permalink(api.hs, room, e["event_id"])}, ensure_ascii=False))
        return
    if not hits:
        print(f"no messages match {' + '.join(terms)}")
        return
    for ts, room, meta, e, ctx in hits:
        print_hit(api.hs, room, meta, e, terms, ctx)


def cmd_thread(api, cache, args):
    if not args.no_sync:
        sync_all(api, cache, quiet=True)
    for room in cache.rooms():
        events = cache.load(room)
        by_id = {e["event_id"]: e for e in events}
        if args.event_id not in by_id:
            continue
        root_id = by_id[args.event_id].get("thread") or args.event_id
        meta = cache.meta(room)
        chain = [e for e in events if e["event_id"] == root_id or e.get("thread") == root_id]
        print(f"# {meta.get('name', room)} — thread {permalink(api.hs, room, root_id)}")
        for e in chain:
            who = meta.get("members", {}).get(e["sender"], e["sender"])
            print(f"- {fmt_ts(e['ts'])} {who}: {' '.join(e['body'].split())}")
            print(f"  {permalink(api.hs, room, e['event_id'])}")
        return
    sys.exit(f"{args.event_id}: not in the cache (run `mxsearch sync`, or the room is not joined)")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mxsearch", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_cred_args(ap)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sync"); s.add_argument("--room", action="append", default=[]); s.set_defaults(fn=cmd_sync)
    s = sub.add_parser("rooms"); s.set_defaults(fn=cmd_rooms)
    s = sub.add_parser("find"); s.add_argument("text", nargs="+"); s.add_argument("--room", action="append", default=[])
    s.add_argument("--since"); s.add_argument("--until"); s.add_argument("--sender")
    s.add_argument("--limit", type=int, default=20); s.add_argument("--context", type=int, default=0)
    s.add_argument("--no-sync", action="store_true"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_find)
    s = sub.add_parser("thread"); s.add_argument("event_id"); s.add_argument("--no-sync", action="store_true"); s.set_defaults(fn=cmd_thread)
    args = ap.parse_args(argv)
    hs, token = load_creds(args)
    api = Api(hs, token)
    args.fn(api, Cache(hs), args)


if __name__ == "__main__":
    main()
