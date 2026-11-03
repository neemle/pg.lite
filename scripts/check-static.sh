#!/bin/sh
# Static-ELF check for built runtime files (the evidence for N01-N03). Runs inside the musl
# (or ref) builder because it needs readelf:   tools/dcb musl make check-static DIR=<path>
#
#   check-static.sh [--json FILE] [--allow-unstripped] PATH...
#
# For every ELF under the given files/directories:
#   - no PT_INTERP (no dynamic loader requested)
#   - no DT_NEEDED (no shared library dependency)
#   - not a shared object file (*.so*) - the runtime must not ship any
#   - stripped: no .symtab and no .debug_* sections (unless --allow-unstripped)
# Non-ELF files are skipped and counted. Exit 0 only if every ELF passes; 1 if one fails;
# 2 on usage error or when no ELF was found (an empty check proves nothing).
set -eu
json=""
strip_required=1
paths=""
while [ $# -gt 0 ]; do
    case "$1" in
        --json) json="${2:?--json needs a file}"; shift 2 ;;
        --allow-unstripped) strip_required=0; shift ;;
        -*) echo "check-static: unknown option $1" >&2; exit 2 ;;
        *) paths="$paths
$1"; shift ;;
    esac
done
[ -n "$paths" ] || { echo "usage: check-static.sh [--json FILE] [--allow-unstripped] PATH..." >&2; exit 2; }
command -v readelf >/dev/null || { echo "check-static: readelf not found; run inside tools/dcb musl" >&2; exit 2; }

elf=0; skipped=0; failed=0
rows=""
check_file() {
    f="$1"
    # ELF magic: 7f 45 4c 46
    [ "$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ] || { skipped=$((skipped + 1)); return; }
    elf=$((elf + 1))
    reasons=""
    interp=false; needed=""; stripped=true; sofile=false
    readelf -lW "$f" 2>/dev/null | grep -q 'INTERP' && { interp=true; reasons="$reasons PT_INTERP"; }
    needed=$(readelf -dW "$f" 2>/dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | tr '\n' ',' | sed 's/,$//')
    [ -z "$needed" ] || reasons="$reasons DT_NEEDED($needed)"
    case "$f" in *.so|*.so.*) sofile=true; reasons="$reasons shared-object-file" ;; esac
    if readelf -SW "$f" 2>/dev/null | grep -qE '\.symtab|\.debug_'; then
        stripped=false
        [ "$strip_required" = 1 ] && reasons="$reasons not-stripped"
    fi
    if [ -n "$reasons" ]; then
        failed=$((failed + 1)); echo "FAIL $f:$reasons"
    else
        echo "PASS $f (static, no PT_INTERP, no DT_NEEDED$([ "$stripped" = true ] && echo ', stripped'))"
    fi
    rows="${rows}${rows:+,}{\"path\":\"$f\",\"ok\":$([ -z "$reasons" ] && echo true || echo false),\"interp\":$interp,\"needed\":\"$needed\",\"stripped\":$stripped,\"sharedObject\":$sofile}"
}

# Word-split on newlines only so paths with spaces survive.
IFS='
'
for p in $paths; do
    [ -e "$p" ] || { echo "check-static: $p does not exist" >&2; exit 2; }
    if [ -d "$p" ]; then
        for f in $(find "$p" -type f | sort); do check_file "$f"; done
    else
        check_file "$p"
    fi
done
unset IFS

echo "check-static: $elf ELF file(s) checked, $failed failed, $skipped non-ELF skipped"
[ -z "$json" ] || printf '{"checked":%s,"failed":%s,"skippedNonElf":%s,"ok":%s,"files":[%s]}\n' "$elf" "$failed" "$skipped" "$([ "$failed" = 0 ] && [ "$elf" -gt 0 ] && echo true || echo false)" "$rows" > "$json"
[ "$elf" -gt 0 ] || { echo "check-static: no ELF files found - nothing was proven" >&2; exit 2; }
[ "$failed" = 0 ]
