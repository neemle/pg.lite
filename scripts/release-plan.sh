#!/bin/sh
# Release plan for a git tag. The tag IS the PostgreSQL version: v18.6 builds PostgreSQL 18.6 and nothing else.
#
#   release-plan.sh <tag>            prints KEY=value lines: tag, version, major, newestInMajor, newestOverall
#   release-plan.sh --github <tag>   the same (the lines go to $GITHUB_OUTPUT)
#
# Exit 0 ok, 2 usage, 3 the tag is not a release of tools/releases.txt.
# The image and the archive released from tag vX.Y.Z contain exactly upstream PostgreSQL X.Y.Z (checksum-pinned in
# tools/releases.txt) plus this repository's patches; the image tags are the version (18.6) and, when it is the newest
# release of its major, the major (18). Runs in the tools container.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
list="${RELEASES_FILE:-$root/releases.txt}"
[ "${1:-}" = "--github" ] && shift
tag="${1:-}"
[ -n "$tag" ] || { echo "usage: release-plan.sh [--github] <tag>" >&2; exit 2; }

version=$(echo "$tag" | sed -n 's/^v\([0-9][0-9]*\(\.[0-9][0-9]*\)\{1,2\}\)$/\1/p')
[ -n "$version" ] || { echo "release-plan: tag \"$tag\" is not v<postgresql version> (for example v18.6)" >&2; exit 3; }
major=$(awk -v v="$version" '!/^#/ && NF && $1 "" == v "" { print $2 }' "$list")
[ -n "$major" ] || { echo "release-plan: PostgreSQL $version is not in tools/releases.txt; the tag must name an upstream release" >&2; exit 3; }

# the newest release: the highest version, compared number by number
newest() { awk -v m="$1" '!/^#/ && NF && (m == "" || $2 "" == m "") { print $1 }' "$list" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1; }
echo "tag=$tag"
echo "version=$version"
echo "major=$major"
echo "newestInMajor=$([ "$(newest "$major")" = "$version" ] && echo true || echo false)"
echo "newestOverall=$([ "$(newest "")" = "$version" ] && echo true || echo false)"
