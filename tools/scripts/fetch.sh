#!/bin/sh
# Usage: fetch.sh [version]        (env: LOCK_FILE, CACHE_DIR, FETCH_OFFLINE=1)
# Runs INSIDE the tools container (tools/dc make fetch). Fetches ONLY the release pinned in
# sources.lock.json into an ignored cache directory and verifies it. Never writes a
# PostgreSQL tree into a tracked path.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
lock="${LOCK_FILE:-$root/sources.lock.json}"
cache="${CACHE_DIR:-$root/cache}"
offline="${FETCH_OFFLINE:-0}"

# 1. Refuse an invalid lock before trusting any value from it.
node "$root/scripts/validate-locks.js" --sources "$lock" --toolchain /nonexistent --features /nonexistent >/dev/null \
    || { echo "fetch: sources lock is invalid; run 'make validate-locks'" >&2; exit 1; }

# 2. Read the release (exit 3 if the version is not in the lock).
vars=$(node "$root/scripts/lock-get.js" "$lock" "${1:-}") || exit $?
eval "$vars"
export VERSION TAG COMMIT GIT_URL ARCHIVE_URL SHA256
mkdir -p "$cache"
export CACHE="$cache" OFFLINE="$offline"

# 3. Download, verify and extract.
echo "fetch: version $VERSION"
exec sh "$root/scripts/fetch-inner.sh"
