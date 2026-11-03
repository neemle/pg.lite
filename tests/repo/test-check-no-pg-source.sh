#!/bin/sh
# Positive and negative test for scripts/check-no-pg-source.sh.
set -u
here=$(cd "$(dirname "$0")" && pwd)
guard="$here/../../scripts/check-no-pg-source.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

git -C "$tmp" init -q
mkdir -p "$tmp/scripts" "$tmp/patches/common"
echo "ok" > "$tmp/scripts/build.sh"
echo "ok" > "$tmp/patches/common/0001-example.patch"

# Positive: a clean repo passes.
if sh "$guard" "$tmp" >/dev/null 2>&1; then echo "PASS clean repo accepted"; else echo "FAIL clean repo rejected"; fail=1; fi

# Negative: a PostgreSQL source path (untracked, not ignored) is rejected.
mkdir -p "$tmp/src/backend/postmaster"
echo "x" > "$tmp/src/backend/postmaster/postmaster.c"
if sh "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL source tree accepted"; fail=1; else echo "PASS source tree rejected"; fi

# Negative: a tracked PostgreSQL marker file is rejected too.
rm -rf "$tmp/src"
echo "x" > "$tmp/configure.ac"
git -C "$tmp" add configure.ac
if sh "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL tracked configure.ac accepted"; fail=1; else echo "PASS tracked configure.ac rejected"; fi

# Positive: the same paths inside an ignored cache directory are not reported.
git -C "$tmp" rm -q --cached configure.ac; rm -f "$tmp/configure.ac"
printf 'cache/\n' > "$tmp/.gitignore"
mkdir -p "$tmp/cache/pg/src/backend"
echo "x" > "$tmp/cache/pg/src/backend/main.c"
if sh "$guard" "$tmp" >/dev/null 2>&1; then echo "PASS ignored cache tree accepted"; else echo "FAIL ignored cache tree rejected"; fail=1; fi

exit $fail
