#!/bin/sh
# Usage: run-node.sh <script.js> [args...]
# Runs a repo Node script with the local node if present, otherwise inside a Node container
# (default image node:24-bookworm-slim, override with NODE_IMAGE). The repo root is mounted
# read-only; network is disabled because the repo scripts that use this never need it.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
if command -v node >/dev/null 2>&1; then
    exec node "$@"
fi
image="${NODE_IMAGE:-node:24-bookworm-slim}"
script="$1"; shift
# Extra mounts for fixture files outside the repo are not supported: keep inputs in the repo.
MSYS_NO_PATHCONV=1 exec docker run --rm --network none -v "$root:/w:ro" -w /w "$image" node "$script" "$@"
