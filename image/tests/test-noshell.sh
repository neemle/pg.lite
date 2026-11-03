#!/bin/sh
# Builds src/common/noshell.c from the PATCHED tree and runs image/tests/noshell-test.c.
# Runs in the musl builder after the build has configured the tree:
#   [VARIANT=min3] tools/dcb musl make test-noshell VERSION=18.6
set -eu
ver="${1:?usage: test-noshell.sh <version>}"
src="/w/build/native/$ver/src"
obj="/w/build/native/$ver${VARIANT:+-$VARIANT}/obj"   # the build tree of the variant that was built (VARIANT=min3)
ns="$src/src/common/noshell.c"; [ -f "$ns" ] || ns="$src/src/port/noshell.c"   # 9.2 has no src/common
[ -f "$ns" ] || { echo "test-noshell: patched tree missing; run tools/dc make native-src VERSION=$ver" >&2; exit 2; }
[ -f "$obj/src/include/pg_config.h" ] || { echo "test-noshell: tree not configured; run tools/dcb musl make native-build VERSION=$ver" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
range_cflags=$(tr '
' ' ' < "/w/build/native/$ver/range-cflags" 2>/dev/null || true)   # for example -std=gnu17 for releases written for older C
# shellcheck disable=SC2086
gcc -O2 -Wall $range_cflags -DFRONTEND -DPG_NO_SHELL -I"$obj/src/include" -I"$src/src/include" -c -o "$tmp/noshell.o" "$ns"
gcc -O2 -Wall -c -o "$tmp/test.o" /w/image/tests/noshell-test.c
gcc -static -o "$tmp/test" "$tmp/test.o" "$tmp/noshell.o"
"$tmp/test"
