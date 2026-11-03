#!/bin/sh
# The patches to PostgreSQL, applied with GNU patch.
#
#   patches.sh verify                                  every patch has a complete header and the numbers are unique
#   patches.sh apply <src dir> <out dir> <native|wasm>  copy the fetched source to <out dir> and apply the common and target patches
#
# All patches of the tree under patches/ belong to the release this branch builds. They are applied in the order of their
# numbers (NNNN-name.patch, the number is the order); the header line "Targets: common|native|wasm" says where a patch goes.
# The fetched source is never patched in place, and no fuzz is accepted: a patch applies exactly or the build stops.
set -eu
patches="${PATCHES:-patches}"
third_party="${THIRD_PARTY:-THIRD_PARTY.md}"

# the patch files, ordered by their file names (the four digits first), one path a line
list() { find "$patches" -name '*.patch' | awk -F/ '{ print $NF " " $0 }' | sort | cut -d' ' -f2-; }

# a header field of a patch: the header ends at the first blank line
field() { sed -n "/^\$/q; s/^$2: *//p" "$1" | head -n 1; }

verify() {
    bad=0
    for p in $(list); do
        for f in Subject Purpose Components Checks Origin Targets; do
            [ -n "$(field "$p" "$f")" ] || { echo "$p: header field \"$f\" missing or empty"; bad=1; }
        done
        for t in $(field "$p" Targets | tr ',' ' '); do
            case "$t" in common|native|wasm) ;; *) echo "$p: Targets has unknown value \"$t\""; bad=1 ;; esac
        done
        case "$(field "$p" Origin)" in
            own) ;;
            borrowed)
                for f in Source-URL Source-Commit Source-License Adaptation; do
                    [ -n "$(field "$p" "$f")" ] || { echo "$p: borrowed patch needs \"$f\""; bad=1; }
                done
                commit=$(field "$p" Source-Commit)
                echo "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "$p: Source-Commit must be a full 40-hex SHA"; bad=1; }
                grep -q "$commit" "$third_party" 2>/dev/null || { echo "$p: Source-Commit $commit is not recorded in $third_party"; bad=1; }
                field "$p" Source-URL | grep -q '^https://' || { echo "$p: Source-URL must be https"; bad=1; }
                ;;
            *) echo "$p: Origin must be \"own\" or \"borrowed\""; bad=1 ;;
        esac
        echo "$(basename "$p")" | grep -Eq '^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*\.patch$' || { echo "$p: a patch is named NNNN-name.patch"; bad=1; }
    done
    dup=$(list | xargs -n1 basename | cut -c1-4 | sort | uniq -d | tr '\n' ' ')
    [ -z "$dup" ] || { echo "patch numbers used twice: $dup"; bad=1; }
    [ "$bad" = 0 ] || exit 1
    echo "patches verify: PASS ($(list | wc -l | tr -d ' ') patch(es))"
}

apply() {
    src="$1"; out="$2"; target="$3"
    case "$target" in native|wasm) ;; *) echo "apply: the target is native or wasm" >&2; exit 2 ;; esac
    [ -d "$src" ] || { echo "apply: source $src does not exist" >&2; exit 1; }
    [ "$(cd "$out/.." 2>/dev/null && pwd)/$(basename "$out")" != "$(cd "$src" && pwd)" ] || { echo "apply: the output must differ from the source" >&2; exit 1; }
    verify >/dev/null
    rm -rf "$out"; mkdir -p "$(dirname "$out")"
    cp -a "$src" "$out"
    rm -f "$out/.compactdb-verified"
    here=$(pwd)
    n=0
    for p in $(list); do
        case ",$(field "$p" Targets | tr -d ' ')," in *,common,*|*",$target,"*) ;; *) continue ;; esac
        if ! (cd "$out" && patch -p1 -N -F0 --no-backup-if-mismatch -r - -i "$here/$p") >"$out/.patch.log" 2>&1; then
            echo "apply: FAIL at $p"; cat "$out/.patch.log"; rm -rf "$out"; exit 1
        fi
        n=$((n + 1))
        echo "applied $(basename "$p"): $(field "$p" Subject)"
    done
    rm -f "$out/.patch.log"
    echo "apply: $n patch(es) for $target in $out"
}

case "${1:-}" in
    verify) verify ;;
    apply) [ $# -eq 4 ] || { echo "usage: patches.sh apply <src> <out> <native|wasm>" >&2; exit 2; }; apply "$2" "$3" "$4" ;;
    *) echo "usage: patches.sh verify | apply <src> <out> <native|wasm>" >&2; exit 2 ;;
esac
