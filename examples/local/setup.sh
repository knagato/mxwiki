#!/bin/sh
# Seeds the local stack (docker-compose.yml): registers a user, creates a room
# with a few pages, lets everyone edit, and pins the widget in the right panel.
# Re-running is safe: the user is reused and a new room is created each time.
#   ./setup.sh            # user alice / password mxwiki-local
set -eu
HS=http://localhost:18914
WIDGET=http://localhost:18916/
USER_NAME="${MXWIKI_LOCAL_USER:-alice}"
PASSWORD="${MXWIKI_LOCAL_PASSWORD:-mxwiki-local}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

i=0
until curl -fsS "$HS/health" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "Synapse is not up at $HS (docker compose up -d?)" >&2; exit 1; }
  sleep 1
done

# Register (two-step user-interactive auth with m.login.dummy), or log in if the user exists.
REG="{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}"
SESSION=$(curl -s -X POST "$HS/_matrix/client/v3/register" -d "$REG" | json '.get("session","")')
RESP=$(curl -s -X POST "$HS/_matrix/client/v3/register" \
  -d "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\",\"auth\":{\"type\":\"m.login.dummy\",\"session\":\"$SESSION\"}}")
TOKEN=$(printf '%s' "$RESP" | json '.get("access_token","")')
if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -s -X POST "$HS/_matrix/client/v3/login" \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$USER_NAME\"},\"password\":\"$PASSWORD\"}" | json '["access_token"]')
fi

ALIAS="wiki-$(date +%H%M%S)"
ROOM=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" "$HS/_matrix/client/v3/createRoom" \
  -d "{\"name\":\"Wiki demo\",\"preset\":\"private_chat\",\"room_alias_name\":\"$ALIAS\"}" | json '["room_id"]')

mxwiki() { PYTHONPATH="$ROOT/cli/src" MATRIX_HOMESERVER="$HS" MATRIX_ACCESS_TOKEN="$TOKEN" python3 -m mxwiki --room "$ROOM" "$@"; }

mxwiki grant-edit --level 0
mxwiki pin --url "$WIDGET" --layout right
mxwiki put home <<'EOF'
# Home

Welcome to the local mxwiki demo.

- [[guide/editing|How to edit]]
- [[minutes/2026-09-24]]
- [[ideas]] (does not exist yet: dashed link, click to create it)
EOF
mxwiki put guide/editing <<'EOF'
# How to edit

Press **編集**, change the Markdown, press **保存**. Link to other pages with `[[slug]]`.
Back to [[home]].
EOF
mxwiki put minutes/2026-09-24 <<'EOF'
# Minutes 2026-09-24

| Item | Owner |
|---|---|
| Try mxwiki locally | alice |
EOF

echo
echo "Element: http://localhost:18915   user: $USER_NAME   password: $PASSWORD"
echo "Room:    #$ALIAS:localhost ($ROOM) — the Wiki opens in the right panel"
