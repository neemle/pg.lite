#!/bin/sh
# Host launcher for the native FROM scratch image (it only runs docker).
#   scripts/native-image.sh image [version]    assemble the context from build/native/<v> and build compactdb-native:<v>
#   scripts/native-image.sh up    [version]    start the server (cold init on an empty volume)
#   scripts/native-image.sh psql  [version] -- <psql args>   psql from the reference image over TCP
#   scripts/native-image.sh down  [version]    remove the server and its volume
#   scripts/native-image.sh test  [version]    SQL smoke, modules, auth, restart, non-empty PGDATA, static check
# Prerequisites: ./dc make native-src VERSION=<v>; ./dcb musl make native-build VERSION=<v>;
#                scripts/reference.sh image <v>  (its psql is the external client).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cmd="${1:?usage: native-image.sh image|up|psql|down|test [version]}"; shift
ver="${1:-18.6}"; [ $# -gt 0 ] && shift || true
bvs="${VARIANT:+-$VARIANT}"   # size/compiler variant (build/native/<ver>-<variant>), see build-native.sh
# PACK=xsfx compresses every executable with xsfx (LZMA2) when the image is assembled; it gets its own image tag
pack="${PACK:-}"; case "$pack" in ""|xsfx) ;; *) echo "native: PACK must be empty or xsfx" >&2; exit 2 ;; esac
vs="$bvs${pack:+-$pack}"
xsfx_bin=/b/xsfx/v0.2.0/x/xsfx-x86_64-unknown-linux-musl
img="compactdb-native:$ver$vs"
client_img="compactdb-reference:$ver"
net="compactdb-ref-net"
name="compactdb-native-$ver$vs"
vol="compactdb-native-data-$ver$vs"
builder="compactdb-builder-musl:local"
# Test credential for a throw-away server on a private docker network; not a secret.
pw="native-test-only"
export MSYS_NO_PATHCONV=1

client() { docker run --rm --network "$net" -e PGPASSWORD="${CLIENT_PASSWORD:-$pw}" --entrypoint psql "$client_img" -h "$name" -U postgres -v ON_ERROR_STOP=1 "$@"; }
wait_ready() {
    i=0
    until client -At -c "SELECT 1" >/dev/null 2>&1; do
        i=$((i + 1)); [ "$i" -gt 90 ] && { echo "native: server did not become ready" >&2; docker logs "$name" >&2; return 1; }
        sleep 1
    done
}

case "$cmd" in
image)
    docker image inspect "$builder" >/dev/null 2>&1 || { echo "native: build the musl builder first (./dcb musl make builder-check)" >&2; exit 1; }
    # Runtime needs three programs: postgres, initdb (first start only) and the launcher.
    # WITH_TOOLS=1 adds pg_resetwal and pg_controldata (recovery/diagnostics) and tags <image>-tools.
    tools="postgres initdb"; tag="$img"
    if [ "${WITH_TOOLS:-0}" = 1 ]; then tools="postgres initdb pg_resetwal pg_controldata"; tag="$img-tools"; fi
    docker run --rm --network none -v compactdb-build:/b:ro -v "$root/docker/native:/n:ro" "$builder" sh -c \
        "set -e
         inst=/b/native/$ver$bvs/install-strip/usr/local/pgsql
         test -x \$inst/bin/postgres || { echo 'no static build in build/native/$ver; run ./dcb musl make native-build VERSION=$ver' >&2; exit 1; }
         d=\$(mktemp -d); r=\$d/rootfs
         mkdir -p \$r/usr/local/pgsql/bin \$r/usr/local/pgsql/lib \$r/etc \$r/tmp \$d/pgdata
         chmod 1777 \$r/tmp
         : > \$r/usr/local/pgsql/lib/.keep   # the server requires this directory; an empty one does not survive COPY
         for b in $tools; do cp \$inst/bin/\$b \$r/usr/local/pgsql/bin/; done
         cp -a \$inst/share \$r/usr/local/pgsql/share
         rm -f \$r/usr/local/pgsql/share/errcodes.txt   # build-time input only; nothing reads it at run time
         # the launcher runs initdb on the first start: use the builtin locale provider only if this initdb has one
         lopt=''; if ! \$inst/bin/initdb --help | grep -q builtin; then lopt=-DNO_BUILTIN_LOCALE; fi
         gcc -O2 -static \$lopt -o \$r/usr/local/pgsql/bin/pg-launcher /n/launcher.c
         strip --strip-all \$r/usr/local/pgsql/bin/pg-launcher
         if [ '$pack' = xsfx ]; then   # pack every executable; keep a packed file only if it is smaller (the stub is 90 KB)
             cp $xsfx_bin /tmp/xsfx; chmod +x /tmp/xsfx
             for f in \$r/usr/local/pgsql/bin/*; do
                 /tmp/xsfx \$f /tmp/packed >/dev/null; a=\$(stat -c %s \$f); b=\$(stat -c %s /tmp/packed)
                 if [ \$b -lt \$a ]; then cat /tmp/packed > \$f; echo \"native: packed \$(basename \$f) \$a -> \$b\" >&2; else echo \"native: kept \$(basename \$f) unpacked (\$a; packed would be \$b)\" >&2; fi
             done
         fi
         printf 'postgres:x:70:70:postgres:/var/lib/postgresql:/sbin/nologin\n' > \$r/etc/passwd
         printf 'postgres:x:70:\n' > \$r/etc/group
         cp /n/Dockerfile \$d/
         tar -C \$d -cf - ." | docker build -q -t "$tag" -
    echo "native: built $tag"
    ;;
up)
    docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume create "$vol" >/dev/null
    docker run -d --name "$name" --network "$net" -e POSTGRES_PASSWORD="$pw" -v "$vol:/var/lib/postgresql/data" "$img" >/dev/null
    wait_ready
    echo "native: $name is ready (network $net)"
    ;;
psql)
    [ "${1:-}" = "--" ] && shift
    client "$@"
    ;;
manifest)
    # Every file in the image with its size, and proof there is no shell, loader or shared object.
    cid=$(docker create "$img" /nonexistent)
    docker export "$cid" | docker run -i --rm --network none --entrypoint tar "$builder" -tvf - > "$root/reports/native-image-files$vs.txt"
    docker rm "$cid" >/dev/null
    files=$(grep -c '^-' "$root/reports/native-image-files$vs.txt" || true)
    bytes=$(awk '/^-/ {s += $3} END {print s + 0}' "$root/reports/native-image-files$vs.txt")
    echo "native: $files files, $bytes bytes (reports/native-image-files$vs.txt)"
    if grep -E ' (usr/)?(local/)?(bin|sbin)/(sh|bash|ash|busybox)$|ld-musl|ld-linux|\.so(\.[0-9]+)*$' "$root/reports/native-image-files$vs.txt"; then
        echo "FAIL: shell, dynamic loader or shared object found in the image"; exit 1
    fi
    echo "PASS: no shell, no dynamic loader, no shared object in the image"
    ;;
down)
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$vol" >/dev/null 2>&1 || true
    echo "native: removed $name and $vol"
    ;;
test)
    docker image inspect "$client_img" >/dev/null 2>&1 || { echo "native: build the reference image first (scripts/reference.sh image $ver)" >&2; exit 1; }
    trap 'sh "$0" down "$ver" >/dev/null 2>&1 || true; docker volume rm "$vol-bad" >/dev/null 2>&1 || true' EXIT
    fail=0
    pass() { echo "PASS $*"; }
    bad() { echo "FAIL $*"; fail=1; }
    sh "$0" down "$ver" >/dev/null 2>&1 || true

    echo "--- cold init in the scratch image on an empty volume, as uid 70 (no shell, no .so)"
    sh "$0" up "$ver"
    [ "$(client -At -c 'SELECT 1')" = "1" ] && pass "SELECT 1 from an external client over TCP" || bad "SELECT 1"
    client -At -c "SELECT version()" -c "SHOW server_encoding" -c "SHOW timezone" -c "SELECT datlocprovider::text || ' ' || datcollate FROM pg_database WHERE datname='postgres'"

    echo "--- built-in modules (no dlopen)"
    out=$(client -At -c "CREATE FUNCTION f(x int) RETURNS int LANGUAGE plpgsql AS \$\$ BEGIN RETURN x + 1; END \$\$" -c "SELECT f(41)" 2>&1) && [ "$(echo "$out" | tail -1)" = "42" ] && pass "plpgsql function runs" || { bad "plpgsql: $out"; }
    out=$(client -At -c "SELECT to_tsvector('english', 'The quick brown foxes jumped')" 2>&1) && echo "$out" | grep -q "fox" && pass "snowball text search stems (foxes -> fox)" || bad "snowball: $out"

    cfgs=$(client -At -c "SELECT string_agg(cfgname, ',' ORDER BY cfgname) FROM pg_ts_config" 2>&1)
    case ",$cfgs," in *,english,*) pass "text search configurations: $(echo "$cfgs" | tr ',' '\n' | wc -l) ($cfgs)" ;; *) bad "english text search configuration missing: $cfgs" ;; esac

    echo "--- missing module gives a clear error and the server survives"
    out=$(client -At -c "LOAD 'does_not_exist'" 2>&1 || true)
    echo "$out" | grep -q "statically linked" && pass "LOAD of an unknown library: clear error ($out)" || bad "unexpected LOAD result: $out"
    [ "$(client -At -c 'SELECT 1')" = "1" ] && pass "server still answers after the failed LOAD" || bad "server died"

    echo "--- authentication"
    if CLIENT_PASSWORD=wrong client -At -c "SELECT 1" >/dev/null 2>&1; then bad "wrong password accepted"; else pass "wrong SCRAM password rejected"; fi

    echo "--- restart keeps data (same volume, no re-init)"
    client -At -c "CREATE TABLE t(x int)" -c "INSERT INTO t VALUES (42)" >/dev/null
    docker restart "$name" >/dev/null
    wait_ready
    [ "$(client -At -c 'SELECT x FROM t')" = "42" ] && pass "data survived restart" || bad "data lost on restart"
    docker logs "$name" 2>&1 | grep -c "database system is ready to accept connections" | grep -q . && pass "server logged readiness"

    echo "--- non-empty, non-cluster PGDATA is refused and left alone"
    docker volume create "$vol-bad" >/dev/null
    docker run --rm -v "$vol-bad:/d" --user 0 --entrypoint "" "$builder" sh -c 'echo precious > /d/keep.txt; chown -R 70:70 /d' >/dev/null
    set +e
    docker run --rm --name "$name-bad" -e POSTGRES_PASSWORD="$pw" -v "$vol-bad:/var/lib/postgresql/data" "$img" 2>"$name.err" >/dev/null
    rc=$?
    set -e
    still=$(docker run --rm -v "$vol-bad:/d" --entrypoint "" "$builder" sh -c 'cat /d/keep.txt; ls /d | wc -l' | tr '\n' ' ')
    { [ "$rc" = 1 ] && [ "$still" = "precious 1 " ]; } && pass "refused (exit 1), file kept, nothing created" || bad "bad PGDATA handling: rc=$rc contents=$still"
    rm -f "$name.err"

    [ "$fail" = 0 ] && echo "native image test: PASS" || { echo "native image test: FAIL"; exit 1; }
    ;;
*)
    echo "native: unknown command $cmd" >&2; exit 2 ;;
esac
