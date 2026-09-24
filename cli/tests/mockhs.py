"""A tiny in-memory homeserver for the CLI tests (http.server in a thread).

Implements just what the CLI calls: whoami, directory lookup, room state
(full / single, GET and PUT), single event, and /messages. Every request is
recorded in `requests` so tests can assert that nothing was written.
"""
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER = "@alice:example.org"
ROOM = "!room:example.org"
ALIAS = "#team:example.org"


class MockHS:
    def __init__(self):
        self.state = {}   # (type, state_key) -> event
        self.events = {}  # event_id -> event
        self.requests = []
        self._n = 0
        hs = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _route(self, method):
                u = urllib.parse.urlsplit(self.path)
                path = urllib.parse.unquote(u.path)
                body = None
                if method == "PUT":
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n) or b"null")
                hs.requests.append((method, path, body))
                if self.headers.get("Authorization") != "Bearer tok":
                    return self._send(401, {"errcode": "M_UNKNOWN_TOKEN"})
                code, obj = hs.handle(method, path, body)
                self._send(code, obj)

            def do_GET(self):
                self._route("GET")

            def do_PUT(self):
                self._route("PUT")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def add_state(self, typ, key, content, sender=USER, ts=1_700_000_000_000):
        self._n += 1
        ev = {"type": typ, "state_key": key, "content": content, "sender": sender,
              "event_id": f"$e{self._n}", "origin_server_ts": ts, "room_id": ROOM}
        self.state[(typ, key)] = ev
        self.events[ev["event_id"]] = ev
        return ev

    def add_event(self, typ, content, sender=USER, ts=1_700_000_000_000):
        self._n += 1
        ev = {"type": typ, "content": content, "sender": sender, "event_id": f"$e{self._n}",
              "origin_server_ts": ts, "room_id": ROOM}
        self.events[ev["event_id"]] = ev
        return ev

    def writes(self):
        return [r for r in self.requests if r[0] == "PUT"]

    def handle(self, method, path, body):
        if path == "/_matrix/client/v3/account/whoami":
            return 200, {"user_id": USER}
        if path == f"/_matrix/client/v3/directory/room/{ALIAS}":
            return 200, {"room_id": ROOM}
        prefix = f"/_matrix/client/v3/rooms/{ROOM}/"
        if not path.startswith(prefix):
            return 404, {"errcode": "M_NOT_FOUND"}
        rest = path[len(prefix):]
        if rest == "state" and method == "GET":
            return 200, list(self.state.values())
        if rest.startswith("state/"):
            typ, _, key = rest[len("state/"):].partition("/")
            if method == "GET":
                ev = self.state.get((typ, key))
                return (200, ev["content"]) if ev else (404, {"errcode": "M_NOT_FOUND"})
            ev = self.add_state(typ, key, body)
            return 200, {"event_id": ev["event_id"]}
        if rest.startswith("event/"):
            ev = self.events.get(rest[len("event/"):])
            return (200, ev) if ev else (404, {"errcode": "M_NOT_FOUND"})
        if rest == "messages":
            return 200, {"chunk": sorted(self.events.values(), key=lambda e: -e["origin_server_ts"]), "end": None}
        return 404, {"errcode": "M_UNRECOGNIZED"}
