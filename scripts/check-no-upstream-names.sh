#!/bin/sh
# Fails if names from the deployment this code was ported back from leak into
# the tree (organisation, hosts, rooms, agent products). The patterns live here,
# not in the workflow, so the workflow file does not match itself; this file is
# the only one excluded.
#   scripts/check-no-upstream-names.sh        # from the repository root
set -u
cd "$(dirname "$0")/.."
PATTERN='fism|prtcl|hermes|fanimubi|influence-protocol|matrix-commander|musubi'
if grep -rniE "$PATTERN" . \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.venv \
    --exclude-dir=__pycache__ --exclude-dir=.ruff_cache \
    --exclude=check-no-upstream-names.sh; then
  echo "error: upstream-specific names found (see above)" >&2
  exit 1
fi
echo "ok: no upstream-specific names"
