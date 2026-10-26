#!/bin/sh
# WebAssembly build of one PostgreSQL release from a PATCHED tree, run inside the wasm builder (Emscripten):
#   ./dc make wasm-src VERSION=18.6            # apply the common+wasm series into build/wasm/<v>/src
#   ./dcb wasm make wasm-build VERSION=18.6    # this script
#   ./dcb wasm make test-wasm-node VERSION=18.6
#
# What it produces (build/wasm/<v>/):
#   install/bin/postgres[.wasm]  the server, single-user and bootstrap mode, for node (NODERAWFS) - the engine of the browser
#                                 module is linked from the same objects by the web build (CDB-6), with other link settings
#   install/bin/initdb[.wasm]    initdb as a WebAssembly program for node (build-time only, never shipped)
#   install/share/               catalogs, timezones, extension and text-search files from THIS patched upstream
#   template-pgdata/             a cluster created by that wasm initdb running that wasm postgres: the bootstrap
#                                 asset a browser copy starts from (raw data directories are not portable between
#                                 native x86_64 and wasm32, so it must be made here, not by the native build)
#   obj/, build.log
#
# The same SQL profile as the native build: plpgsql and dict_snowball (English only) are linked into the server
# (patch common/0001, 0004; no dlopen in WebAssembly either), no ICU, readline, zlib, TLS, XML, LLVM.
#
# Environment (all optional): WASM_CFLAGS, WASM_LDFLAGS (complete replacements), RESUME=1 (keep a configured tree),
#   TEMPLATE_ARGS (extra initdb arguments).
set -eu
ver="${1:?usage: build-wasm.sh <version>}"
base="/w/build/wasm/$ver"
src="${SRC:-$base/src}"
obj="$base/obj"
inst="$base/install"
template="$base/template-pgdata"
log="$base/build.log"
prefix=/pgsql
jobs=$(nproc)
# WEB=1 builds the browser module instead (a second tree, same sources and configuration): an ES module and a
# .wasm that run in a Worker, with the data files and the template data directory of the node build packed into
# postgres.data. Run the node build first; it makes those files.
web="${WEB:-0}"; [ "$web" = 0 ] && unset WEB || true
if [ "$web" = 1 ]; then obj="$base/obj-web"; log="$base/build-web.log"; out="$base/web"; fi

# Exceptions: PostgreSQL's error handling is sigsetjmp/longjmp; with -fwasm-exceptions Emscripten implements it
# on WebAssembly exception handling instead of the slower, bigger JavaScript emulation.
cflags="${WASM_CFLAGS:--Os -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -fno-strict-aliasing}"
# Link settings for the node-hosted programs: the real file system of the build container (NODERAWFS), a growable
# heap, a stack deep enough for max_stack_depth, and a clean exit so atexit handlers run.
ldflags="${WASM_LDFLAGS:--fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sENVIRONMENT=node -sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=1}"

# Link settings of the browser module: an ES module for a Worker, JavaScript Promise Integration so that the
# backend can wait for the client's next protocol bytes (patch wasm/0007) without a second thread, the in-memory
# file system, and a heap that grows.
weblink="${WASM_WEB_LDFLAGS:--fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sENVIRONMENT=web,worker -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPostgres -sJSPI -sJSPI_EXPORTS=pg_wasm_main -sEXPORTED_FUNCTIONS=_pg_wasm_main,_malloc,_free -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=8388608 -Wl,--wrap=fsync -Wl,--wrap=fdatasync}"
# --wrap: fsync() and fdatasync() in the server become the storage barrier of the browser (wasm_embed.c, patch 0008)

[ -f "$src/configure" ] || { echo "build-wasm: $src has no configure; run ./dc make wasm-src VERSION=$ver" >&2; exit 2; }
[ -f "$src/src/backend/port/wasm_shm.c" ] || { echo "build-wasm: $src is not patched for wasm (no wasm_shm.c); run ./dc make wasm-src VERSION=$ver" >&2; exit 2; }

resume=0
if [ "${RESUME:-0}" = 1 ] && [ -f "$obj/GNUmakefile" ]; then resume=1; fi
mkdir -p "$base"
if [ "$resume" = 0 ]; then rm -rf "$obj"; : > "$log"; fi
if [ "$web" = 1 ]; then
    [ -d "$inst$prefix/share" ] && [ -d "$template" ] || { echo "build-wasm: WEB=1 needs the node build first (no $inst/share or $template)" >&2; exit 2; }
else
    rm -rf "$inst" "$template"
fi
mkdir -p "$obj" "$inst"; cd "$obj"
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

step() { echo "### $*" >> "$log"; "$@" >> "$log" 2>&1 || { echo "build-wasm: step failed: $*" >&2; tail -40 "$log" >&2; exit 1; }; }

export CC=emcc
# Overrides every make below needs: wasm-ld knows neither -rpath's --enable-new-dtags nor needs --export-dynamic.
mk() { make -j"$jobs" "$@" rpath= LDFLAGS_EX_BE=; }

if [ "$resume" = 0 ]; then
    echo "build-wasm: configure (emcc: $(emcc --version | head -1))"
    opts="--prefix=$prefix --without-readline --without-zlib --without-icu"
    help=$("$src/configure" --help)
    echo "$help" | grep -q -- '--disable-rpath' && opts="$opts --disable-rpath"
    # the release range's own configure options and compiler flags (data in ranges.json, written by make wasm-src)
    range_configure=$(tr '\n' ' ' < "$base/range-configure" 2>/dev/null || true)
    range_cflags=$(tr '\n' ' ' < "$base/range-cflags" 2>/dev/null || true)
    [ -z "$range_configure" ] || opts="$opts $range_configure"
    [ -z "$range_cflags" ] || cflags="$cflags $range_cflags"
    # Spinlocks: from 16 on, and in the later minors of 10 to 15, s_lock.h has a generic gcc/clang section (the __sync
    # builtins) that WebAssembly uses; the first minors of those majors have none, and there the semaphore-based spinlocks of
    # --disable-spinlocks are the way (one process, so no cost that matters).
    if ! grep -q 'defined(HAVE_GCC__SYNC_INT32_TAS)' "$src/src/include/storage/s_lock.h" && ! echo "$opts" | grep -q -- '--disable-spinlocks'; then
        echo "build-wasm: this s_lock.h has no generic gcc section: configure --disable-spinlocks"
        opts="$opts --disable-spinlocks"
    fi
    # The first minors of 14 include <sys/signalfd.h> for every epoll build without asking configure whether it exists
    # (Emscripten has epoll but no signalfd): where the include is not guarded and the header is missing, wait with poll().
    latch="$src/src/backend/storage/ipc/latch.c"
    extra_cpp=""
    if [ -f "$latch" ] && grep -q 'include <sys/signalfd.h>' "$latch" \
        && ! grep -B1 'include <sys/signalfd.h>' "$latch" | grep -q HAVE_SYS_SIGNALFD_H \
        && ! echo '#include <sys/signalfd.h>' | emcc -E -x c - >/dev/null 2>&1; then
        echo "build-wasm: latch.c includes signalfd.h unguarded and Emscripten has none: -DWAIT_USE_POLL"
        extra_cpp=" -DWAIT_USE_POLL"
    fi
    # emcc writes executable programs, so configure can run its tests under node: no cross-compile cache needed.
    # shellcheck disable=SC2086
    step "$src/configure" $opts CFLAGS="$cflags" LDFLAGS="$ldflags" CPPFLAGS="-DPG_STATIC_MODULES -DPG_NO_SHELL${WEB:+ -DPG_WASM_BROWSER}$extra_cpp"
fi
make_headers
fix_header_links

for d in src/port src/common src/timezone; do
    [ -d "$src/$d" ] || continue   # src/common arrived in 9.3
    echo "build-wasm: make $d"; step mk -C "$d"
done
# ---- static modules: plain objects with unique entry-point names (wasm objects cannot be renamed with objcopy,
# so the names are changed at compile time with -D); the backend link takes them through STATIC_MODULE_OBJS
cppbase=$(sed -n 's/^CPPFLAGS = //p' "$obj/src/Makefile.global")
compile_module() { # compile_module <dir> <prefix>: the module's objects, entry points renamed <prefix>_...
    d="$1"; p="$2"
    objs=$(make -s -C "$d" --eval='print-objs: ; @echo $(OBJS)' print-objs)
    # shellcheck disable=SC2086
    step make -j"$jobs" -C "$d" CPPFLAGS="$cppbase -DPg_magic_func=${p}_Pg_magic_func -D_PG_init=${p}_PG_init" $objs
}
list_objs() { # list_objs <dir>: absolute paths of the module's objects
    for o in $(make -s -C "$1" --eval='print-objs: ; @echo $(OBJS)' print-objs); do printf '%s/%s ' "$obj/$1" "$o"; done
}
echo "build-wasm: modules plpgsql, dict_snowball"
compile_module src/pl/plpgsql/src plpgsql
compile_module src/backend/snowball dict_snowball
mods="$(list_objs src/pl/plpgsql/src) $(list_objs src/backend/snowball)"

echo "build-wasm: link postgres"
rm -f src/backend/postgres src/backend/postgres.wasm src/backend/postgres.data
if [ "$web" = 1 ]; then
    # same objects, other link: the program path and the data directory are fixed by pg_wasm_main() (wasm_embed.c)
    step mk -C src/backend postgres STATIC_MODULE_OBJS="$mods" \
        LDFLAGS="$weblink --preload-file $template@/pgdata --preload-file $inst$prefix/share@$prefix/share"
    rm -rf "$out"; mkdir -p "$out"
    cp src/backend/postgres "$out/postgres.mjs"
    cp src/backend/postgres.wasm src/backend/postgres.data "$out/"
    # what the page-side storage checks before it opens a stored database (web/src/idb-store.js): an engine built
    # from another release or another feature profile must not read data written by this one
    profile=$(sha256sum /w/feature-profile.json | cut -c1-12)
    # the packaged files carry no empty directories (pg_notify, pg_twophase, ...): the Worker creates these
    empty=$(cd "$template" && find . -mindepth 1 -type d -empty | sed 's|^\.||' | sort | sed 's/.*/    "&"/' | paste -sd, -)
    printf '{\n  "pg": "%s",\n  "profile": "%s",\n  "storageFormat": 1,\n  "toolchain": "emscripten-%s",\n  "emptyDirs": [\n%s\n  ]\n}\n' \
        "$ver" "$profile" "$(emcc --version | head -1 | sed 's/.* \([0-9][0-9.]*\) (.*/\1/')" "$empty" > "$out/manifest.json"
    echo "build-wasm: done (web module in $out, $log)"
    ls -l "$out" | sed 's/^/  /'
    exit 0
fi
step mk -C src/backend postgres STATIC_MODULE_OBJS="$mods" LDFLAGS="$ldflags ${WASM_LINK_EXTRA:-}"   # WASM_LINK_EXTRA: debugging aid, for example --profiling-funcs (function names in traces)

# ---- initdb (a wasm program for node): needs libpgcommon/libpgport/libpgfeutils and the objects of libpq it uses
echo "build-wasm: initdb"
step mk -C src/interfaces/libpq libpq.a
[ ! -d "$src/src/fe_utils" ] || step mk -C src/fe_utils   # the front-end utilities library exists from 9.6 on
step mk -o submake-libpq -C src/bin/initdb initdb

# ---- install: server, tools, and the data files initdb needs, all from this tree
echo "build-wasm: install"
D="DESTDIR=$inst"
step make -C src/include install "$D"
step make -C src/backend install "$D" rpath= LDFLAGS_EX_BE=
step make -C src/timezone install "$D" rpath= LDFLAGS_EX_BE=
step make -C src/bin/initdb install "$D" rpath= LDFLAGS_EX_BE= -o submake-libpq
# extension scripts and control files exist from 9.1 on; 9.0 creates the language from initdb
grep -q "^install-data" "$src/src/pl/plpgsql/src/Makefile" && step make -C src/pl/plpgsql/src install-data "$D"
# the snowball Makefile installs the data files only after linking a shared library, which a static server has no use for:
# generate the SQL (a Makefile target in every release) and install it with the stop words of the one language kept
step make -C src/backend/snowball snowball_create.sql
mkdir -p "$inst$prefix/share/tsearch_data"
cp src/backend/snowball/snowball_create.sql "$inst$prefix/share/"
cp "$src/src/backend/snowball/stopwords/english.stop" "$inst$prefix/share/tsearch_data/"
# releases up to 11 have initdb read conversion_create.sql (encoding conversions from loadable modules; 12 and later have
# them built in): there are no loadable modules here, so an empty one (feature detection: only where initdb asks for it)
if grep -q conversion_create.sql "$src/src/bin/initdb/initdb.c"; then
    printf -- '-- no encoding conversions in this build (no loadable modules)
' > "$inst$prefix/share/conversion_create.sql"
fi
# a WebAssembly executable is the .js launcher plus a .wasm next to it; "install" copies only the first
bin="$inst$prefix/bin"
cp "$obj/src/backend/postgres.wasm" "$bin/"
cp "$obj/src/bin/initdb/initdb.wasm" "$bin/"
rm -f "$inst$prefix/share/errcodes.txt"      # build-time input only

# ---- the bootstrap data directory, made by the wasm initdb running the wasm postgres
echo "build-wasm: initdb (template data directory)"
# C.UTF-8 and the builtin provider, as in the native build, so both targets answer the same way; one-megabyte WAL
# segments keep the template (and what a browser has to persist) small.
locale_args="--locale=C.UTF-8"
# the builtin locale provider exists from PostgreSQL 17 on: use it where this initdb has it (feature detection)
if "$bin/initdb" --help | grep -q builtin; then locale_args="$locale_args --locale-provider=builtin --builtin-locale=C.UTF-8"; fi
# one-megabyte WAL segments (11 and later) keep the template small; 10 and earlier cannot set it and keep 16 MB
if "$bin/initdb" --help | grep -q wal-segsize; then locale_args="$locale_args --wal-segsize=1"; fi
# the option that skips fsync is --no-sync from 10 on, --nosync before
nosync_arg=--no-sync; "$bin/initdb" --help | grep -q -- --no-sync || { nosync_arg=--nosync; "$bin/initdb" --help | grep -q -- --nosync || nosync_arg=; }   # 9.2 never syncs and has no option
# shellcheck disable=SC2086
step timeout "${INITDB_TIMEOUT:-900}" "$bin/initdb" -D "$template" --username=postgres --auth=trust --encoding=UTF8 \
    $locale_args $nosync_arg ${TEMPLATE_ARGS:-}

echo "build-wasm: done ($log)"
ls -l "$bin" | sed 's/^/  /'
du -sk "$template" | sed 's/^/  template-pgdata KB: /'
