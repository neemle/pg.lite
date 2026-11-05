#!/bin/sh
# Exit status 0 when the release gets an arm64 image next to the amd64 one, 1 when it does not.
#   sh scripts/has-arm64.sh <version>
# The rule: arm64 where upstream PostgreSQL supports aarch64 natively. The aarch64 spinlocks (s_lock.h) came with 9.2.5, so the
# first release with an arm64 image is 9.2.5; every later release has one. The earlier ones are built for amd64 only.
set -eu
[ $# -eq 1 ] || { echo "usage: has-arm64.sh <version>" >&2; exit 2; }
first=9.2.5
[ "$(printf '%s\n%s\n' "$first" "$1" | sort -V | head -n 1)" = "$first" ]
