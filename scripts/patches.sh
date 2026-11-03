#!/bin/sh
# The patches to PostgreSQL, applied with GNU patch.
#
#   patches.sh verify                                          every patch has a complete header, and no two patches of a release share a number
#   patches.sh apply <src dir> <out dir> <native|wasm> <version>  copy the fetched source to <out dir> and apply the patches of that release
#
# The patches are applied in the order of their numbers (NNNN-name.patch, the number is the order). The header says where and for
# which releases a patch goes: "Targets: common|native|wasm" and "Releases: <from>-<to>", the releases it applies to, both ends
# included, the end may be left open ("9.0.0-" is every release from 9.0.0 on). Two patches may have the same number when their
# releases do not overlap: they are the same change for releases whose source differs. A patch that does not apply to a release it
# claims is a bug of its range: it is split or ended, never fuzzed.
# The fetched source is never patched in place, and no fuzz is accepted: a patch applies exactly or the build stops.
set -eu
patches="${PATCHES:-patches}"
third_party="${THIRD_PARTY:-THIRD_PARTY.md}"

# the patch files, ordered by their file names (the four digits first), one path a line
list() { find "$patches" -name '*.patch' | awk -F/ '{ print $NF " " $0 }' | sort | cut -d' ' -f2-; }

# a header field of a patch: the header ends at the first blank line
field() { sed -n "/^\$/q; s/^$2: *//p" "$1" | head -n 1; }

# a release as one number to compare: 9.0.5 -> 9000005, 10.2 -> 10002000
vnum() { echo "$1" | awk -F. '{ printf "%d", $1 * 1000000 + $2 * 1000 + $3 }'; }

# the range of a patch: "<from>-<to>" -> from, to (to is empty when the end is open)
range_from() { field "$1" Releases | tr -d ' ' | sed 's/-.*//'; }
range_to() { field "$1" Releases | tr -d ' ' | sed 's/^[^-]*-//'; }

# does the patch apply to the release? ($1 patch, $2 version)
in_range() {
    [ "$(vnum "$2")" -ge "$(vnum "$(range_from "$1")")" ] || return 1
    to=$(range_to "$1")
    [ -z "$to" ] || [ "$(vnum "$2")" -le "$(vnum "$to")" ]
}

verify() {
    bad=0
    for p in $(list); do
        for f in Subject Purpose Components Checks Origin Targets Releases; do
            [ -n "$(field "$p" "$f")" ] || { echo "$p: header field \"$f\" missing or empty"; bad=1; }
        done
        for t in $(field "$p" Targets | tr ',' ' '); do
            case "$t" in common|native|wasm) ;; *) echo "$p: Targets has unknown value \"$t\""; bad=1 ;; esac
        done
        field "$p" Releases | tr -d ' ' | grep -Eq '^[0-9]+(\.[0-9]+){1,2}-([0-9]+(\.[0-9]+){1,2})?$' \
            || { echo "$p: Releases is <from>-<to> with versions like 9.0.0-9.0.4, or 9.0.0- for an open end"; bad=1; }
        if [ -n "$(range_to "$p")" ] && [ "$(vnum "$(range_to "$p")")" -lt "$(vnum "$(range_from "$p")")" ]; then
            echo "$p: Releases ends before it starts"; bad=1
        fi
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
    # one number may be used twice only when the releases of the two patches do not overlap
    overlap=$(for p in $(list); do
        to=$(range_to "$p"); to=${to:-999999.999.999}
        echo "$(basename "$p" | cut -c1-4) $(vnum "$(range_from "$p")") $(vnum "$to") $(basename "$p")"
    done | awk '{ num[NR]=$1; from[NR]=$2; to[NR]=$3; name[NR]=$4
        for (i = 1; i < NR; i++) if (num[i] == num[NR] && from[i] <= to[NR] && from[NR] <= to[i]) print name[NR] " and " name[i] }')
    [ -z "$overlap" ] || { echo "patches of the same number apply to the same release: $overlap"; bad=1; }
    [ "$bad" = 0 ] || exit 1
    echo "patches verify: PASS ($(list | wc -l | tr -d ' ') patch(es))"
}

apply() {
    src="$1"; out="$2"; target="$3"; version="$4"
    case "$target" in native|wasm) ;; *) echo "apply: the target is native or wasm" >&2; exit 2 ;; esac
    echo "$version" | grep -Eq '^[0-9]+(\.[0-9]+){1,2}$' || { echo "apply: the version must look like 9.0.5 or 17.2" >&2; exit 2; }
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
        in_range "$p" "$version" || continue
        if ! (cd "$out" && patch -p1 -N -F0 --no-backup-if-mismatch -r - -i "$here/$p") >"$out/.patch.log" 2>&1; then
            echo "apply: FAIL at $p"; cat "$out/.patch.log"; rm -rf "$out"; exit 1
        fi
        n=$((n + 1))
        echo "applied $(basename "$p"): $(field "$p" Subject)"
    done
    rm -f "$out/.patch.log"
    echo "apply: $n patch(es) for $target, release $version, in $out"
}

case "${1:-}" in
    verify) verify ;;
    apply) [ $# -eq 5 ] || { echo "usage: patches.sh apply <src> <out> <native|wasm> <version>" >&2; exit 2; }; apply "$2" "$3" "$4" "$5" ;;
    *) echo "usage: patches.sh verify | apply <src> <out> <native|wasm> <version>" >&2; exit 2 ;;
esac
