#!/bin/sh
# Usage: run-node.sh <script.js> [args...]
# Runs a repo Node script inside a Node container (default image node:24-bookworm-slim,
# override with NODE_IMAGE). Nothing runs on the host except docker itself: there is
# deliberately no fallback to a locally installed node. The repo root is mounted read-only
# and the network is disabled because the scripts that use this never need it.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
image="${NODE_IMAGE:-node:24-bookworm-slim}"
script="$1"; shift
# Inputs must live inside the repo (the only thing mounted).
MSYS_NO_PATHCONV=1 exec docker run --rm --network none -v "$root:/w:ro" -w /w "$image" node "$script" "$@"
