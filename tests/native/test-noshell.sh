#!/bin/sh
# Builds src/common/noshell.c from the PATCHED tree and runs tests/native/noshell-test.c.
# Runs in the musl builder after the build has configured the tree:
#   ./dcb musl make test-noshell VERSION=18.6
set -eu
ver="${1:?usage: test-noshell.sh <version>}"
src="/w/build/native/$ver/src"
obj="/w/build/native/$ver/obj"
[ -f "$src/src/common/noshell.c" ] || { echo "test-noshell: patched tree missing; run ./dc make native-src VERSION=$ver" >&2; exit 2; }
[ -f "$obj/src/include/pg_config.h" ] || { echo "test-noshell: tree not configured; run ./dcb musl make native-build VERSION=$ver" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
gcc -O2 -Wall -DFRONTEND -DPG_NO_SHELL -I"$obj/src/include" -I"$src/src/include" -c -o "$tmp/noshell.o" "$src/src/common/noshell.c"
gcc -O2 -Wall -c -o "$tmp/test.o" /w/tests/native/noshell-test.c
gcc -static -o "$tmp/test" "$tmp/test.o" "$tmp/noshell.o"
"$tmp/test"
