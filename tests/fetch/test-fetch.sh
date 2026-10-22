#!/bin/sh
# Offline negative tests for scripts/fetch.sh. No network, no real download.
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
work="$root/cache/test-fetch"
rm -rf "$work"; mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
fail=0

expect() { # name expected_exit text -- command...
    name=$1; want=$2; text=$3; shift 4
    out=$("$@" 2>&1); code=$?
    if [ "$code" = "$want" ] && { [ -z "$text" ] || printf '%s' "$out" | grep -q "$text"; }; then
        echo "PASS $name"
    else
        echo "FAIL $name (exit $code, wanted $want, text '$text')"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1
    fi
}

# Version absent from the lock fails clearly (exit 3).
expect "version absent from lock fails" 3 "not in" -- \
    env FETCH_OFFLINE=1 CACHE_DIR="$work/c1" sh "$root/scripts/fetch.sh" 99.9

# Tampered archive: junk at the cached archive path is rejected with expected-vs-actual.
mkdir -p "$work/c2/downloads"
echo "this is not the postgresql archive" > "$work/c2/downloads/postgresql-18.6.tar.bz2"
expect "tampered archive is rejected" 1 "expected:" -- \
    env FETCH_OFFLINE=1 CACHE_DIR="$work/c2" sh "$root/scripts/fetch.sh"
if [ -d "$work/c2/src/18.6" ]; then echo "FAIL tampered archive was extracted"; fail=1; else echo "PASS tampered archive not extracted"; fi
if [ -f "$work/c2/downloads/postgresql-18.6.tar.bz2.rejected" ]; then echo "PASS rejected archive kept for inspection"; else echo "FAIL rejected archive not kept"; fail=1; fi

# Offline with nothing cached cannot proceed (exit 2).
expect "offline and not cached fails" 2 "not cached" -- \
    env FETCH_OFFLINE=1 CACHE_DIR="$work/c3" sh "$root/scripts/fetch.sh"

# Invalid lock (abbreviated commit) is refused before anything runs.
sed 's/"commit": "724edf9bde9d356724ad384a2e196edc3c9f80f7"/"commit": "724edf9"/' "$root/sources.lock.json" > "$work/bad.lock.json"
expect "invalid lock is refused" 1 "lock is invalid" -- \
    env FETCH_OFFLINE=1 CACHE_DIR="$work/c4" LOCK_FILE="$work/bad.lock.json" sh "$root/scripts/fetch.sh"

exit $fail
