#!/bin/sh
# Experiment: does an UNPATCHED release configure and compile with the modern musl builder, and
# with which C standard flag? Runs inside the musl builder (./dcb musl sh scripts/try-build.sh 9.6.24).
# It never changes the fetched tree: it builds in a copy on the build volume.
#
#   try-build.sh <version> [std ...]     default std list: "" gnu89 gnu99 gnu11
#
# Result: one JSON line appended to /w/reports/build-experiments.jsonl and the logs kept in
# build/try/<version>/. Option support is detected from configure --help, not from the version.
set -eu
ver="${1:?usage: try-build.sh <version> [std ...]}"; shift
stds="${*:-\"\" gnu89 gnu99 gnu11}"
src="/w/cache/src/$ver"
work="/w/build/try/$ver"
[ -f "$src/configure" ] || { echo "try-build: $src missing; run ./dc make fetch VERSION=$ver" >&2; exit 2; }

rows=""
winner_json=null
for std in $stds; do
    std=$(printf '%s' "$std" | tr -d '"')
    rm -rf "$work"; mkdir -p "$work"
    cp -a "$src/." "$work/"
    cd "$work"
    cc="gcc"; [ -z "$std" ] || cc="gcc -std=$std"
    opts="--prefix=/usr/local/pgsql"
    ./configure --help | grep -q -- '--without-readline' && opts="$opts --without-readline"
    ./configure --help | grep -q -- '--with-icu' && opts="$opts --without-icu"
    cfg_rc=0; mk_rc=-1
    # shellcheck disable=SC2086
    ./configure $opts CC="$cc" > configure.log 2>&1 || cfg_rc=$?
    err=""
    if [ "$cfg_rc" = 0 ]; then
        mk_rc=0
        make -j"$(nproc)" > make.log 2>&1 || mk_rc=$?
        [ "$mk_rc" = 0 ] || err=$(grep -m3 -E 'error:|Error [0-9]' make.log | cut -c1-160 | tr '\n' '|' | sed 's/"/\\"/g')
    else
        err=$(grep -m2 -E 'error' configure.log | cut -c1-160 | tr '\n' '|' | sed 's/"/\\"/g')
    fi
    status=fail; [ "$cfg_rc" = 0 ] && [ "$mk_rc" = 0 ] && status=ok
    echo "try-build $ver std='${std:-default}': configure rc=$cfg_rc make rc=$mk_rc -> $status ${err:+($err)}"
    rows="${rows}${rows:+,}{\"std\":\"$std\",\"configureRc\":$cfg_rc,\"makeRc\":$mk_rc,\"status\":\"$status\",\"error\":\"$err\"}"
    mkdir -p "/w/build/try/logs/$ver"; cp configure.log "/w/build/try/logs/$ver/configure-${std:-default}.log"; [ ! -f make.log ] || cp make.log "/w/build/try/logs/$ver/make-${std:-default}.log"
    cd /w
    if [ "$status" = ok ]; then winner_json="\"$std\""; break; fi
done
rm -rf "$work"
printf '{"version":"%s","gcc":"%s","winner":%s,"attempts":[%s]}
' "$ver" "$(gcc -dumpfullversion)" "$winner_json" "$rows" >> /w/reports/build-experiments.jsonl
echo "try-build: $ver done (appended to reports/build-experiments.jsonl)"
