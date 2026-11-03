#!/bin/sh
# Usage: fetch.sh [version]        (env: RELEASES_FILE, CACHE_DIR, FETCH_OFFLINE=1)
# Runs INSIDE the tools container (tools/dc make fetch). Fetches ONLY the release listed in tools/releases.txt
# (default: its first line) into an ignored cache directory and verifies it. Never writes a PostgreSQL tree into a tracked path.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
list="${RELEASES_FILE:-$root/releases.txt}"
cache="${CACHE_DIR:-$root/cache}"
offline="${FETCH_OFFLINE:-0}"

# 1. The release (exit 3 if the version is not in the list).
version="${1:-$(awk '!/^#/ && NF { print $1; exit }' "$list")}"
row=$(awk -v v="$version" '!/^#/ && NF && $1 "" == v "" { print; exit }' "$list")
[ -n "$row" ] || { echo "fetch: version $version is not in $list; known: $(awk '!/^#/ && NF { printf "%s ", $1 }' "$list")" >&2; exit 3; }
# shellcheck disable=SC2086
set -- $row
VERSION=$1; TAG=$3; COMMIT=$4; SHA256=$5; ARCHIVE_URL=$6; GIT_URL=$7

# 2. Refuse a malformed line before trusting any value from it.
bad=""
echo "$VERSION" | grep -Eq '^[0-9]+(\.[0-9]+){1,2}$' || bad="$bad version"
echo "$TAG" | grep -Eq '^[A-Za-z0-9_.-]+$' || bad="$bad tag"
echo "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || bad="$bad commit(40 hex)"
echo "$SHA256" | grep -Eq '^[0-9a-f]{64}$' || bad="$bad sha256(64 hex)"
echo "$ARCHIVE_URL" | grep -Eq '^https://[A-Za-z0-9._/+-]+$' || bad="$bad archive-url(https)"
echo "$GIT_URL" | grep -Eq '^https://[A-Za-z0-9._/+-]+$' || bad="$bad git-url(https)"
[ -z "$bad" ] || { echo "fetch: the line of $VERSION in $list is invalid:$bad" >&2; exit 1; }

export VERSION TAG COMMIT GIT_URL ARCHIVE_URL SHA256
mkdir -p "$cache"
export CACHE="$cache" OFFLINE="$offline"

# 3. Download, verify and extract.
echo "fetch: version $VERSION"
exec sh "$root/scripts/fetch-inner.sh"
