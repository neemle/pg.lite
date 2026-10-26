#!/bin/sh
# Do the files a patch series touches still compile? (check builder; called by scripts/check-releases.js)
#
#   syntax-check.sh <configured-tree> <patched-tree> <native|wasm> <file>...
#
# <configured-tree> is a pristine copy of the release that has been configured and has its generated headers (in-tree
# build); <patched-tree> is the release with the series applied. Each file (path relative to the tree) is compiled with
# -fsyntax-only against the patched headers first and the generated ones second, as the server (or, for src/bin, the
# frontend) would be: the wasm series is compiled with -D__EMSCRIPTEN__, so its guarded code is the code that is checked.
# Errors fail the check, and so does a call of a function the patches declare (wasm_*, ns_*, pg_noshell*) that is not
# declared. Files that include <emscripten.h> are skipped (the one new file per feature, the same in every release), and
# a missing generated header is reported as "unchecked", not as a failure.
# Exit: 0 all compile, 1 a file does not compile (the compiler's errors on stdout), 3 nothing could be checked.
cfg=$1; tree=$2; target=$3; shift 3
defs=""; [ "$target" = wasm ] && defs="-D__EMSCRIPTEN__"
bad=0; checked=0
for f in "$@"; do
    [ -f "$tree/$f" ] || continue
    grep -q 'emscripten\.h' "$tree/$f" && continue
    # which semaphore implementation is compiled depends on the configuration of the real wasm build, not on this one
    case "$target:$f" in wasm:*/posix_sema.c|wasm:*/sysv_sema.c|wasm:*/wasm_sema.c) continue ;; esac
    case "$f" in
        src/bin/*)            modes="-DFRONTEND" ;;
        src/port/*|src/common/*) modes="-UFRONTEND -DFRONTEND" ;;
        *)                    modes="-UFRONTEND" ;;
    esac
    for m in $modes; do
        out=$(gcc -fsyntax-only -std=gnu17 -w -D_GNU_SOURCE -DDLSUFFIX=\".so\" -DPGBINDIR=\"/b\" -DPGSHAREDIR=\"/s\" -DPGDATADIR=\"/s\" $defs $m \
            -Wimplicit-function-declaration \
            -I"$tree/$(dirname "$f")" -I"$tree/src/include" -I"$cfg/src/include" \
            -I"$tree/src/interfaces/libpq" -I"$cfg/src/interfaces/libpq" -I"$tree/src/port" -I"$cfg/src/port" \
            "$tree/$f" 2>&1)
        # -w hides warnings, so look for the implicit declarations of our own functions separately
        impl=$(gcc -fsyntax-only -std=gnu17 -D_GNU_SOURCE -DDLSUFFIX=\".so\" -DPGBINDIR=\"/b\" -DPGSHAREDIR=\"/s\" -DPGDATADIR=\"/s\" $defs $m -Wimplicit-function-declaration \
            -I"$tree/$(dirname "$f")" -I"$tree/src/include" -I"$cfg/src/include" \
            -I"$tree/src/interfaces/libpq" -I"$cfg/src/interfaces/libpq" -I"$tree/src/port" -I"$cfg/src/port" \
            "$tree/$f" 2>&1 | grep "implicit declaration of function '\(wasm_\|ns_\|pg_noshell\)" || true)
        if echo "$out" | grep -q 'fatal error: .*No such file'; then
            echo "unchecked $f ($m): $(echo "$out" | grep 'fatal error' | head -1)"
            continue
        fi
        checked=$((checked + 1))
        if echo "$out" | grep -q 'error:' || [ -n "$impl" ]; then
            bad=1
            echo "FAIL $f ($m)"
            echo "$out" | grep 'error:' | head -5
            [ -z "$impl" ] || echo "$impl" | head -3
        fi
    done
done
[ "$bad" = 1 ] && exit 1
[ "$checked" = 0 ] && [ "$#" -gt 0 ] && exit 3
exit 0
