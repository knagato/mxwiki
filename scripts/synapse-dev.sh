#!/bin/sh
# Throwaway Synapse for tests: open registration, relaxed rate limits, SQLite.
#   scripts/synapse-dev.sh up     # -> http://localhost:${MXWIKI_SYNAPSE_PORT:-18914}
#   scripts/synapse-dev.sh down   # stop and delete the container and its data
# Used by CI (.github/workflows/ci.yml) and for running the E2E test locally.
set -eu
PORT="${MXWIKI_SYNAPSE_PORT:-18914}"
NAME="${MXWIKI_SYNAPSE_NAME:-mxwiki-synapse}"
IMAGE="${MXWIKI_SYNAPSE_IMAGE:-matrixdotorg/synapse:latest}"
VOL="$NAME-data"

case "${1:-}" in
up)
  docker volume create "$VOL" >/dev/null
  docker run --rm -v "$VOL:/data" -e SYNAPSE_SERVER_NAME=localhost -e SYNAPSE_REPORT_STATS=no "$IMAGE" generate >/dev/null
  # Append inside the container: the generated files belong to the synapse user.
  docker run --rm -v "$VOL:/data" --entrypoint sh "$IMAGE" -c 'printf "\n" >> /data/homeserver.yaml && cat >> /data/homeserver.yaml <<EOF
enable_registration: true
enable_registration_without_verification: true
rc_message: {per_second: 1000, burst_count: 1000}
rc_registration: {per_second: 1000, burst_count: 1000}
rc_login:
  address: {per_second: 1000, burst_count: 1000}
  account: {per_second: 1000, burst_count: 1000}
  failed_attempts: {per_second: 1000, burst_count: 1000}
EOF'
  docker run -d --name "$NAME" -v "$VOL:/data" -p "127.0.0.1:$PORT:8008" "$IMAGE" >/dev/null
  i=0
  until curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { docker logs "$NAME"; exit 1; }
    sleep 1
  done
  echo "synapse up: http://localhost:$PORT"
  ;;
down)
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  ;;
*)
  echo "usage: $0 up|down" >&2; exit 2
  ;;
esac
