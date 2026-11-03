#!/bin/sh
# Proves a builder image can do its one job. Runs inside the builder (tools/dcb <kind> make builder-check).
#   musl: a hello-world builds as a fully static, strippable ELF (readelf: no PT_INTERP, no DT_NEEDED)
#   wasm: a hello-world builds with emcc and runs under node
# Each check has a negative control, so a broken check cannot pass silently.
set -eu
kind="${COMPACTDB_BUILDER:-}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }

cat > "$tmp/hello.c" <<'EOF'
#include <stdio.h>
int main(void) { puts("hello from compactdb"); return 0; }
EOF

case "$kind" in
musl)
    gcc -dumpmachine | grep -q musl && pass "gcc targets musl ($(gcc -dumpmachine))" || bad "gcc target is not musl: $(gcc -dumpmachine)"

    gcc -O2 -static "$tmp/hello.c" -o "$tmp/hello_static"
    [ "$("$tmp/hello_static")" = "hello from compactdb" ] && pass "static binary runs" || bad "static binary output wrong"
    if readelf -lW "$tmp/hello_static" | grep -q INTERP; then bad "static binary has PT_INTERP"; else pass "static binary has no PT_INTERP"; fi
    if readelf -dW "$tmp/hello_static" 2>/dev/null | grep -q NEEDED; then bad "static binary has DT_NEEDED"; else pass "static binary has no DT_NEEDED"; fi

    cp "$tmp/hello_static" "$tmp/hello_stripped"
    strip --strip-all "$tmp/hello_stripped"
    if readelf -SW "$tmp/hello_stripped" | grep -qE '\.(symtab|debug_)'; then bad "strip left .symtab/.debug sections"; else pass "strip removes .symtab and .debug sections"; fi
    [ "$("$tmp/hello_stripped")" = "hello from compactdb" ] && pass "stripped binary still runs" || bad "stripped binary broke"

    # Negative control: a dynamic build must be detected by the very same readelf checks.
    gcc -O2 "$tmp/hello.c" -o "$tmp/hello_dyn"
    if readelf -lW "$tmp/hello_dyn" | grep -q INTERP && readelf -dW "$tmp/hello_dyn" | grep -q NEEDED; then
        pass "negative control: dynamic binary shows PT_INTERP and DT_NEEDED"
    else
        bad "negative control failed: dynamic binary not detected"
    fi
    ;;
ref)
    # The reference builder is the ordinary dynamic glibc toolchain: a hello-world must build,
    # run and be dynamically linked (this is the opposite of the musl static requirement).
    gcc -O2 "$tmp/hello.c" -o "$tmp/hello"
    [ "$("$tmp/hello")" = "hello from compactdb" ] && pass "reference toolchain builds and runs hello" || bad "hello output wrong"
    if readelf -lW "$tmp/hello" | grep -q INTERP && readelf -dW "$tmp/hello" | grep -q NEEDED; then
        pass "binary is dynamic, as the reference build must be"
    else
        bad "reference toolchain produced a static binary"
    fi
    ;;
wasm)
    emcc -O2 "$tmp/hello.c" -o "$tmp/hello.js"
    [ -f "$tmp/hello.wasm" ] && pass "emcc produced hello.wasm ($(wc -c < "$tmp/hello.wasm") bytes)" || bad "no hello.wasm produced"
    out=$(node "$tmp/hello.js" 2>&1 || true)
    [ "$out" = "hello from compactdb" ] && pass "wasm runs under node" || bad "wasm run output wrong: $out"

    # Negative control: a truncated module must make the same run fail.
    head -c 40 "$tmp/hello.wasm" > "$tmp/bad.wasm" && mv "$tmp/bad.wasm" "$tmp/hello.wasm"
    if node "$tmp/hello.js" >/dev/null 2>&1; then bad "negative control failed: corrupt wasm still ran"; else pass "negative control: corrupt wasm is rejected"; fi
    ;;
*)
    echo "check-builder: COMPACTDB_BUILDER is '$kind'; run this through tools/dcb musl|wasm" >&2
    exit 2
    ;;
esac

[ "$fail" = 0 ] && echo "builder-check ($kind): PASS" || echo "builder-check ($kind): FAIL"
exit "$fail"
