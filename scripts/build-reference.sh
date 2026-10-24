#!/bin/sh
# Builds UNMODIFIED upstream PostgreSQL with its default configuration (only --prefix is set).
# Runs inside the ref builder:  ./dcb ref make reference VERSION=18.6
#
# - The build is out-of-tree (VPATH) so cache/src/<version> is never written to; the script
#   proves it by looking for files newer than the extraction marker.
# - No patch is applied here by construction; the script refuses to run if the source tree is
#   not the one fetch.sh verified.
# - Outputs in build/ref/<version>/: install/ (make install), install-strip/ (make install-strip),
#   build.log; and reports/reference-size[-<version>].json (no suffix for the baseline release) with the byte totals and the method.
set -eu
ver="${1:?usage: build-reference.sh <version>}"
baseline=$(sed -n 's/.*"baseline": "\([^"]*\)".*/\1/p' /w/sources.lock.json | head -1)
report=/w/reports/reference-size-$ver.json; [ "$ver" = "$baseline" ] && report=/w/reports/reference-size.json
src="/w/cache/src/$ver"
marker="$src/.compactdb-verified"
out="/w/build/ref/$ver"
prefix=/usr/local/pgsql

[ -f "$marker" ] || { echo "build-reference: $src is not a verified fetch; run ./dc make fetch VERSION=$ver" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/obj"
log="$out/build.log"
cd "$out/obj"

step() { echo "### $*" >> "$log"; "$@" >> "$log" 2>&1 || { echo "build-reference: step failed: $*" >&2; tail -40 "$log" >&2; exit 1; }; }
: > "$log"
echo "build-reference: configure (default options, prefix $prefix), then make, install, install-strip"
step "$src/configure" --prefix="$prefix"
# Out-of-tree parallel builds race on generated headers (utils/errcodes.h): generate them first.
step make -C src/backend generated-headers
step make -j"$(nproc)"
step make install DESTDIR="$out/install"
step make install-strip DESTDIR="$out/install-strip"
echo "build-reference: build and install finished ($log)"

# The source tree must be exactly as fetched: nothing newer than the extraction marker.
changed=$(find "$src" -type f -newer "$marker" | wc -l)
if [ "$changed" != 0 ]; then
    echo "build-reference: FAIL - $changed file(s) in $src changed after fetch" >&2
    exit 1
fi
echo "build-reference: source tree untouched (0 files newer than the fetch marker)"

# ---- sizes: sum of regular file sizes (find -printf %s), bytes on disk apparent size ----
bytes() { find "$1" -type f -printf '%s\n' | awk '{s+=$1} END{print s+0}'; }
count() { find "$1" -type f | wc -l; }
sub() { # variant dir -> JSON object of per-directory bytes
    d="$1$prefix"
    printf '{"bin":%s,"lib":%s,"share":%s,"include":%s,"total":%s,"files":%s,"postgresBinary":%s,"libpq":%s}' \
        "$(bytes "$d/bin")" "$(bytes "$d/lib")" "$(bytes "$d/share")" "$(bytes "$d/include")" \
        "$(bytes "$d")" "$(count "$d")" "$(stat -c %s "$d/bin/postgres")" "$(stat -c %s "$(readlink -f "$d/lib/libpq.so.5")")"
}
needs=$(ldd "$out/install-strip$prefix/bin/postgres" | awk '{print $1}' | grep -v '^linux-vdso' | sort | tr '\n' ' ' | sed 's/ $//')
pkgs=$(dpkg-query -W -f='${Package}=${Version};' gcc libicu-dev libreadline-dev zlib1g-dev bison flex perl | sed 's/;$//')
mkdir -p /w/reports
printf '{\n  "version": "%s",\n  "kind": "unmodified upstream, default configure, glibc dynamic",\n  "configure": "--prefix=%s",\n  "method": "sum of regular-file apparent sizes in bytes (find -type f -printf %%s), install tree under the prefix; unstripped = make install, stripped = make install-strip; shared libraries the executables need from the OS are listed but not counted",\n  "unstripped": %s,\n  "stripped": %s,\n  "postgresNeededLibraries": "%s",\n  "buildPackages": "%s",\n  "gcc": "%s"\n}\n' \
    "$ver" "$prefix" "$(sub "$out/install")" "$(sub "$out/install-strip")" "$needs" "$pkgs" "$(gcc -dumpfullversion)" \
    > "$report"
echo "build-reference: wrote $report"
cat "$report"
