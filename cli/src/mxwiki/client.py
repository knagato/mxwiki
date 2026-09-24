"""Client-server API v3 over urllib (standard library only) and the credential
rules shared by `mxwiki` and `mxsearch`.

Credentials, per value (homeserver and token), first match wins:
  --hs / --token              explicit
  --env-file PATH             dotenv file with MATRIX_HOMESERVER / MATRIX_ACCESS_TOKEN
                              (so a bot never has to `source` it in a shell)
  $MATRIX_HOMESERVER / $MATRIX_ACCESS_TOKEN
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ENV_HS = "MATRIX_HOMESERVER"
ENV_TOKEN = "MATRIX_ACCESS_TOKEN"


class Api:
    def __init__(self, hs, token):
        self.hs = hs.rstrip("/")
        self.token = token
        self._uid = None

    def req(self, method, path, body=None, params=None):
        url = self.hs + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            sys.exit(f"HTTP {e.code} {method} {path}: {e.read().decode(errors='replace')}")

    def try_get(self, path):
        """GET that returns None on 404 instead of exiting."""
        r = urllib.request.Request(self.hs + path, headers={"Authorization": "Bearer " + self.token})
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            sys.exit(f"HTTP {e.code} GET {path}: {e.read().decode(errors='replace')}")

    @staticmethod
    def q(s):
        return urllib.parse.quote(s, safe="")

    def whoami(self):
        if not self._uid:
            self._uid = self.req("GET", "/_matrix/client/v3/account/whoami")["user_id"]
        return self._uid

    def resolve(self, room):
        if room.startswith("!"):
            return room
        return self.req("GET", f"/_matrix/client/v3/directory/room/{self.q(room)}")["room_id"]

    def joined_rooms(self):
        return self.req("GET", "/_matrix/client/v3/joined_rooms")["joined_rooms"]

    def state(self, room):
        return self.req("GET", f"/_matrix/client/v3/rooms/{self.q(room)}/state")

    def get_state(self, room, typ, key):
        return self.req("GET", f"/_matrix/client/v3/rooms/{self.q(room)}/state/{self.q(typ)}/{self.q(key)}")

    def try_get_state(self, room, typ, key):
        """Like get_state, but None when the state event does not exist."""
        return self.try_get(f"/_matrix/client/v3/rooms/{self.q(room)}/state/{self.q(typ)}/{self.q(key)}")

    def put_state(self, room, typ, key, content):
        return self.req("PUT", f"/_matrix/client/v3/rooms/{self.q(room)}/state/{self.q(typ)}/{self.q(key)}", content)

    def event(self, room, event_id):
        return self.try_get(f"/_matrix/client/v3/rooms/{self.q(room)}/event/{self.q(event_id)}")

    def messages(self, room, frm=None, limit=200, filt=None):
        p = {"dir": "b", "limit": str(limit)}
        if frm:
            p["from"] = frm
        if filt:
            p["filter"] = json.dumps(filt)
        return self.req("GET", f"/_matrix/client/v3/rooms/{self.q(room)}/messages", params=p)


def read_env_file(path):
    """MATRIX_HOMESERVER / MATRIX_ACCESS_TOKEN from a dotenv file (KEY=value,
    optional quotes and `export `, # comments)."""
    p = Path(path).expanduser()
    if not p.exists():
        sys.exit(f"--env-file: no such file: {p}")
    vals = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        line = line.removeprefix("export ")
        k, v = line.split("=", 1)
        k = k.strip()
        if k in (ENV_HS, ENV_TOKEN):
            vals[k] = v.strip().strip('"').strip("'")
    return vals


def add_cred_args(ap):
    ap.add_argument("--hs", help=f"homeserver URL (else --env-file, else ${ENV_HS})")
    ap.add_argument("--token", help=f"access token (else --env-file, else ${ENV_TOKEN})")
    ap.add_argument("--env-file", metavar="PATH", help=f"dotenv file with {ENV_HS} and {ENV_TOKEN}")


def load_creds(args):
    file_vals = read_env_file(args.env_file) if args.env_file else {}
    hs = args.hs or file_vals.get(ENV_HS) or os.environ.get(ENV_HS)
    token = args.token or file_vals.get(ENV_TOKEN) or os.environ.get(ENV_TOKEN)
    if not hs or not token:
        missing = " and ".join(n for n, v in ((ENV_HS, hs), (ENV_TOKEN, token)) if not v)
        sys.exit(f"no credentials: {missing} not set — pass --hs/--token, --env-file PATH, or set the environment variables")
    return hs, token
