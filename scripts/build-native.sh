#!/bin/sh
# Static musl build of one PostgreSQL release from a PATCHED tree, run inside the musl builder:
#   ./dc make native-src VERSION=18.6            # apply the common+native series into build/native/<v>/src
#   ./dcb musl make native-build VERSION=18.6    # this script
#
# What is built (the runtime needs nothing else): postgres, initdb, pg_resetwal, pg_controldata.
# The libpq-based clients (psql, pg_dump, pg_ctl) are not linked statically: libpq.a is not
# self-contained and its common-library flavours clash, and they are admin tools outside the runtime.
#
# Static modules: plpgsql, dict_snowball and libpqwalreceiver (with the libpq objects it needs) are normal module builds whose objects are combined
# with "ld -r", get unique Pg_magic_func/_PG_init names (objcopy), and are linked into postgres
# through STATIC_MODULE_OBJS (patch 0001).  Shell-free spawning needs PG_NO_SHELL (patch 0002).
#
# Size/compiler variants (docs/size-experiments.md) are chosen with environment variables; with none
# set the build is the plain -O2 one.
#   VARIANT        name; output goes to build/native/<version>-<VARIANT> (the patched source is shared)
#   NATIVE_CFLAGS  complete CFLAGS for configure (e.g. "-Os -fno-pie -ffunction-sections ...")
#   NATIVE_LDEX    executable link flags instead of plain "-static" (e.g. "-static -no-pie -Wl,--gc-sections")
#   NATIVE_LDFLAGS LDFLAGS for every link and for configure (a -fno-pie build needs -no-pie here: gcc links PIE by default)
#   NATIVE_BE_LD   if SET (even empty): replaces LDFLAGS_EX_BE, i.e. drops -Wl,--export-dynamic
#   NATIVE_LTO=1   link-time optimization: gcc-ar/gcc-ranlib, modules compiled without LTO
#   RESUME=1       keep an existing configured tree (make is incremental)
#
# Output: build/native/<version>[-<VARIANT>]/{obj,staticmods,install,install-strip,build.log}
set -eu
ver="${1:?usage: build-native.sh <version>}"
variant="${VARIANT:-}"
base="/w/build/native/$ver"
src="${SRC:-$base/src}"
out="$base${variant:+-$variant}"
prefix=/usr/local/pgsql
cflags="${NATIVE_CFLAGS:-}"
ldex="${NATIVE_LDEX:--static}"
ldflags="${NATIVE_LDFLAGS:-}"
lto="${NATIVE_LTO:-0}"
extra_opts="${NATIVE_CONFIGURE:-}"
be_arg=""
if [ "${NATIVE_BE_LD+set}" = set ]; then be_arg="LDFLAGS_EX_BE=${NATIVE_BE_LD}"; fi

# Named presets (measured in docs/size-experiments.md), used when no NATIVE_* option is given:
#   gc     -O2, per-function/data sections, no unwind tables, --gc-sections, non-PIE, no --export-dynamic
#   os     the same with -Os                         <- smallest build that stays simple and fast to build
#   oslto  the same with -Os and link-time optimization
case "$variant" in
    gc|os|oslto|ospie|min1|min2|min3)
        if [ -z "$cflags" ] && [ -z "$ldflags" ] && [ "$ldex" = -static ] && [ -z "$be_arg" ] && [ "$lto" != 1 ]; then
            common="-ffunction-sections -fdata-sections -fno-asynchronous-unwind-tables -fno-unwind-tables"
            ldex="-static -no-pie -Wl,--gc-sections"; be_arg="LDFLAGS_EX_BE="
            case "$variant" in
                gc) cflags="-O2 $common" ;;
                os) cflags="-Os $common" ;;
                oslto) cflags="-Os -flto=auto $common"; ldex="$ldex -flto=auto"; lto=1 ;;
                # as os, but still position-independent (static-pie): keeps address-space randomization
                ospie) cflags="-Os $common"; ldex="-static -Wl,--gc-sections" ;;
                # min1..min3 = ospie on the tree with patch 0004 (English-only snowball), then cumulatively:
                #   min2 adds -ffile-prefix-map (shorter __FILE__ strings, build paths normalized)
                #   min3 adds --without-zlib (the server needs zlib only for gzip base backups; pg_dump is not in the image)
                min1) cflags="-Os $common"; ldex="-static -Wl,--gc-sections" ;;
                min2) cflags="-Os $common -ffile-prefix-map=$src/= -ffile-prefix-map=$out/obj/="; ldex="-static -Wl,--gc-sections" ;;
                min3) cflags="-Os $common -ffile-prefix-map=$src/= -ffile-prefix-map=$out/obj/="; ldex="-static -Wl,--gc-sections"; extra_opts="--without-zlib" ;;
            esac
        fi ;;
esac
[ -f "$src/configure" ] || { echo "build-native: $src has no configure; run ./dc make native-src VERSION=$ver" >&2; exit 2; }
[ -f "$src/src/backend/utils/fmgr/staticmods.c" ] || { echo "build-native: $src is not patched (no staticmods.c); run ./dc make native-src VERSION=$ver" >&2; exit 2; }

# A size/compiler variant must have its own name, or it would overwrite the plain build tree.
if [ -z "$variant" ] && { [ -n "$cflags" ] || [ -n "$ldflags" ] || [ "$ldex" != -static ] || [ -n "$be_arg" ] || [ "$lto" = 1 ]; }; then
    echo "build-native: NATIVE_* options need VARIANT=<name>" >&2; exit 2
fi

resume=0
if [ "${RESUME:-0}" = 1 ] && [ -f "$out/obj/GNUmakefile" ]; then resume=1; fi
if [ "$resume" = 0 ]; then rm -rf "$out/obj"; fi
rm -rf "$out/staticmods" "$out/install" "$out/install-strip"
mkdir -p "$out/obj" "$out/staticmods"; cd "$out/obj"
log="$out/build.log"; [ "$resume" = 1 ] || : > "$log"
# A release tarball carries some generated headers in the source tree (errcodes.h in 16.x). An out-of-tree build then
# links src/include/utils/errcodes.h to where it would have generated the file, which does not exist: point such
# links at the copy in the source tree.
fix_header_links() {
    for l in $(find src/include -type l); do
        [ -e "$l" ] && continue
        t=$(readlink "$l"); alt="$src/${t#"$PWD"/}"
        [ -e "$alt" ] && ln -sf "$alt" "$l"
    done
    return 0
}

# Generate the headers the parallel build races on. 9.6 and later have a target for it; earlier releases generate the same
# headers through the targets their recursive build depends on.
make_headers() {
    if grep -q '^generated-headers' "$src/src/backend/Makefile"; then
        step make -C src/backend generated-headers
    else
        step make -C src/backend ../../src/include/parser/gram.h ../../src/include/catalog/schemapg.h             ../../src/include/utils/fmgroids.h ../../src/include/utils/errcodes.h ../../src/include/utils/probes.h
    fi
}

step() { echo "### $*" >> "$log"; "$@" >> "$log" 2>&1 || { echo "build-native: step failed: $*" >&2; tail -40 "$log" >&2; exit 1; }; }

# Options that exist in this release's configure (feature detection, not version checks).
opts="--prefix=$prefix"
help=$("$src/configure" --help)
echo "$help" | grep -q -- '--without-readline' && opts="$opts --without-readline"
echo "$help" | grep -qE -- '--(with|without)-icu' && opts="$opts --without-icu"
echo "$help" | grep -q -- '--disable-rpath' && opts="$opts --disable-rpath"
if [ -n "$extra_opts" ]; then opts="$opts $extra_opts"; fi
# the release range's own configure options and compiler flags (data in ranges.json, written by make native-src)
range_configure=$(tr '\n' ' ' < "$base/range-configure" 2>/dev/null || true)
range_cflags=$(tr '\n' ' ' < "$base/range-cflags" 2>/dev/null || true)
[ -z "$range_configure" ] || opts="$opts $range_configure"
[ -z "$range_cflags" ] || cflags="${cflags:--O2} $range_cflags"

# Static frontends need the two encoding functions the shared libpq would export (see the shim).
step gcc -O2 -c -o "$out/shim.o" /w/docker/native/libpq_static_shim.c
fe_ldx="$ldex $out/shim.o"

if [ "$resume" = 0 ]; then
    echo "build-native: configure $opts (variant '${variant:-plain}': CFLAGS='${cflags:-default}' LDFLAGS_EX='$ldex' LTO=$lto)"
    # shellcheck disable=SC2086
    set -- $opts CPPFLAGS="-DPG_STATIC_MODULES -DPG_NO_SHELL" LDFLAGS_EX="$ldex"
    [ -z "$cflags" ] || set -- "$@" CFLAGS="$cflags"
    [ -z "$ldflags" ] || set -- "$@" LDFLAGS="$ldflags"
    [ "$lto" != 1 ] || set -- "$@" AR=gcc-ar RANLIB=gcc-ranlib NM=gcc-nm
    step "$src/configure" "$@"
    # Parallel out-of-tree builds race on generated headers, so make those first.
fi
make_headers
fix_header_links

# The server has its own encoding functions; only the frontends get the shim.
for d in src/port src/common src/timezone; do
    [ -d "$src/$d" ] || continue   # src/common arrived in 9.3
    echo "build-native: make $d"; step make -j"$(nproc)" -C "$d"
done
echo "build-native: make src/backend"; step make -j"$(nproc)" -C src/backend $be_arg
for d in src/pl/plpgsql/src src/backend/snowball src/backend/replication/libpqwalreceiver; do
    echo "build-native: make $d (module objects, linked into postgres below)"
    if [ "$lto" = 1 ]; then
        # (LDFLAGS= : the module .so files are never used, only their objects; -no-pie breaks their shared link)
        # ld -r + objcopy cannot rename symbols inside LTO bytecode, so the modules stay ordinary objects
        step make -j"$(nproc)" -C "$d" LDFLAGS= CFLAGS_SL_MODULE="-fvisibility=hidden -fno-lto"
    else
        step make -j"$(nproc)" -C "$d" LDFLAGS=
    fi
done
# pg_resetwal was called pg_resetxlog before 10
resetwal=pg_resetwal; [ -d "$src/src/bin/pg_resetwal" ] || resetwal=pg_resetxlog
for d in src/bin/initdb src/bin/$resetwal src/bin/pg_controldata; do
    echo "build-native: make $d (frontend, with the libpq static shim)"
    step make -j"$(nproc)" -C "$d" LDFLAGS_EX="$fe_ldx"
done

# ---- static modules: one relocatable object per module with unique entry-point names
sm="$out/staticmods"
cd "$out/obj/src/pl/plpgsql/src"
step ld -r -o "$sm/plpgsql.o" pl_comp.o pl_exec.o pl_funcs.o pl_gram.o pl_handler.o pl_scanner.o
step objcopy --redefine-sym Pg_magic_func=plpgsql_Pg_magic_func --redefine-sym _PG_init=plpgsql_PG_init "$sm/plpgsql.o"
cd "$out/obj/src/backend/snowball"
# shellcheck disable=SC2046
step ld -r -o "$sm/dict_snowball.o" $(ls ./*.o | sort)
step objcopy --redefine-sym Pg_magic_func=dict_snowball_Pg_magic_func --redefine-sym _PG_init=dict_snowball_PG_init "$sm/dict_snowball.o"
# libpqwalreceiver: the module object combined with the libpq objects it calls and the FRONTEND flavour of src/common and
# src/port that libpq is built against (libpq frees what its common functions allocate with free(), so it must not get the
# server's palloc-based copies). "ld -r" takes only the members that are needed; objcopy then makes every symbol defined in
# the blob local except the two entry points, so nothing in it can clash with the server's functions of the same names.
# What the blob leaves undefined (libc, and the server functions libpqwalreceiver itself uses) is resolved by the final link.
lw="$out/obj/src/backend/replication/libpqwalreceiver"
# libpq is built against the "_shlib" variants of libpgcommon and libpgport where the release has them (feature detection)
shl=_shlib; [ -f "$out/obj/src/common/libpgcommon_shlib.a" ] || shl=
step ld -r -o "$sm/libpqwalreceiver.o" "$lw/libpqwalreceiver.o" --start-group "$out/obj/src/interfaces/libpq/libpq.a" $([ -f "$out/obj/src/common/libpgcommon$shl.a" ] && echo "$out/obj/src/common/libpgcommon$shl.a") "$out/obj/src/port/libpgport$shl.a" --end-group
step objcopy --redefine-sym Pg_magic_func=libpqwalreceiver_Pg_magic_func --redefine-sym _PG_init=libpqwalreceiver_PG_init "$sm/libpqwalreceiver.o"
step objcopy --keep-global-symbol=libpqwalreceiver_Pg_magic_func --keep-global-symbol=libpqwalreceiver_PG_init "$sm/libpqwalreceiver.o"

# ---- relink postgres with the modules inside
cd "$out/obj"
mods="$sm/plpgsql.o $sm/dict_snowball.o $sm/libpqwalreceiver.o"
rm -f src/backend/postgres
echo "build-native: relink postgres with static modules"
step make -C src/backend STATIC_MODULE_OBJS="$mods" $be_arg
for sym in plpgsql_call_handler dsnowball_init plpgsql_Pg_magic_func dict_snowball_Pg_magic_func libpqwalreceiver_PG_init; do
    nm src/backend/postgres | grep -q " [TtWw] $sym\$" || { echo "build-native: symbol $sym missing from postgres" >&2; exit 1; }
done

# ---- install (full and stripped)
for kind in install install-strip; do
    # src/include installs postgres.bki and system_constraints.sql (the headers it also installs stay out of the image)
    for d in src/include src/backend src/timezone src/pl/plpgsql/src src/backend/snowball src/bin/initdb src/bin/$resetwal src/bin/pg_controldata; do
        step make -C "$d" "$kind" DESTDIR="$out/$kind" STATIC_MODULE_OBJS="$mods" $be_arg
    done
done
# Releases up to 11 have initdb read conversion_create.sql, which creates the encoding conversions from loadable modules
# (12 and later have them built in). A static server has no loadable modules and the profile has no conversions, so the
# file is an empty one (feature detection: only where initdb asks for it).
if grep -q conversion_create.sql "$src/src/bin/initdb/initdb.c"; then
    for kind in install install-strip; do
        printf -- '-- no encoding conversions in this build (no loadable modules)
' > "$out/$kind$prefix/share/conversion_create.sql"
    done
fi
echo "build-native: done ($log)"
ls -l "$out/install-strip$prefix/bin"
