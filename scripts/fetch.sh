#!/bin/sh
# Usage: fetch.sh [version]        (env: LOCK_FILE, CACHE_DIR, FETCH_OFFLINE=1, FETCH_IMAGE)
# Fetches ONLY the release pinned in sources.lock.json into an ignored cache directory and
# verifies it. Never writes a PostgreSQL tree into a tracked path.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
lock="${LOCK_FILE:-$root/sources.lock.json}"
cache="${CACHE_DIR:-$root/cache}"
offline="${FETCH_OFFLINE:-0}"
# Interim tool image (curl, git, tar, bzip2). CDB-17 replaces it with a digest-pinned image.
image="${FETCH_IMAGE:-rust:1-bookworm}"

# 1. Refuse an invalid lock before trusting any value from it.
case "$lock" in "$root"/*) lockrel="${lock#"$root"/}" ;; *) lockrel="" ;; esac
if [ -z "$lockrel" ]; then
    echo "fetch: LOCK_FILE must live inside the repo (mounted read-only into the container)" >&2
    exit 2
fi
sh "$root/scripts/run-node.sh" scripts/validate-locks.js --sources "$lockrel" --toolchain /nonexistent --features /nonexistent >/dev/null \
    || { echo "fetch: sources lock is invalid; run 'make validate-locks'" >&2; exit 1; }

# 2. Read the release (exit 3 if the version is not in the lock).
vars=$(sh "$root/scripts/run-node.sh" scripts/lock-get.js "$lockrel" "${1:-}") || exit $?
eval "$vars"
export VERSION TAG COMMIT GIT_URL ARCHIVE_URL SHA256
mkdir -p "$cache"
cache_abs=$(cd "$cache" && pwd)

# 3. Download, verify and extract inside a container.
net=""
[ "$offline" = "1" ] && net="--network none"
user=""
[ "$(uname -s)" = "Linux" ] && user="--user $(id -u):$(id -g)"
echo "fetch: version $VERSION via image $image"
# shellcheck disable=SC2086
MSYS_NO_PATHCONV=1 docker run --rm $net $user \
    -e VERSION -e TAG -e COMMIT -e GIT_URL -e ARCHIVE_URL -e SHA256 \
    -e OFFLINE="$offline" -e CACHE=/cache \
    -v "$cache_abs:/cache" \
    -v "$root/scripts/fetch-inner.sh:/fetch-inner.sh:ro" \
    "$image" sh /fetch-inner.sh
