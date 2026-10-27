#!/bin/sh
# Host launcher for the native FROM scratch image (it only runs docker).
#   scripts/native-image.sh image [version]    assemble the context from build/native/<v> and build compactdb-native:<v>
#   scripts/native-image.sh up    [version]    start the server (cold init on an empty volume)
#   scripts/native-image.sh psql  [version] -- <psql args>   psql from the reference image over TCP
#   scripts/native-image.sh down  [version]    remove the server and its volume
#   scripts/native-image.sh test  [version]    SQL smoke, modules, auth, restart, non-empty PGDATA, static check
# Prerequisites (./builder.sh build <v> cli does all of it): tools/dc make native-src VERSION=<v>; tools/dcb musl make native-build VERSION=<v>;
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
client_img="${CLIENT_IMAGE:-compactdb-reference:$ver}"   # the stock psql of a first minor can crash on a current distribution: CLIENT_IMAGE=compactdb-reference:<later minor of the major>
net="compactdb-ref-net"
name="compactdb-native-$ver$vs"
vol="compactdb-native-data-$ver$vs"
builder="compactdb-builder-musl:local"
# Test credential for a throw-away server on a private docker network; not a secret.
pw="native-test-only"
export MSYS_NO_PATHCONV=1

client_one() { docker run --rm --network "$net" -e PGPASSWORD="${CLIENT_PASSWORD:-$pw}" --entrypoint psql "$client_img" -h "$name" -U postgres -v ON_ERROR_STOP=1 "$@"; }
# psql before 9.6 takes a single -c: run one psql per -c (commands are single-line), the other arguments are shared
client() {
    cmds=$(mktemp); common=""; ncmd=0
    while [ $# -gt 0 ]; do
        if [ "$1" = -c ]; then printf '%s
' "$2" >> "$cmds"; ncmd=$((ncmd + 1)); shift 2; else common="$common $1"; shift; fi
    done
    rc=0
    if [ "$ncmd" -le 1 ]; then
        # shellcheck disable=SC2086
        if [ "$ncmd" = 1 ]; then client_one $common -c "$(cat "$cmds")" || rc=$?; else client_one $common || rc=$?; fi
    else
        while IFS= read -r c; do
            # shellcheck disable=SC2086
            client_one $common -c "$c" || { rc=$?; break; }
        done < "$cmds"
    fi
    rm -f "$cmds"
    return $rc
}
wait_ready() {
    i=0
    until client -At -c "SELECT 1" >/dev/null 2>&1; do
        i=$((i + 1)); [ "$i" -gt 90 ] && { echo "native: server did not become ready" >&2; docker logs "$name" >&2; return 1; }
        sleep 1
    done
}

case "$cmd" in
image)
    docker image inspect "$builder" >/dev/null 2>&1 || { echo "native: build the musl builder first (tools/dcb musl make builder-check)" >&2; exit 1; }
    # The image holds ONE file: /usr/local/pgsql/bin/postgres, the server with initdb, the entrypoint and the share/ tree linked in (patch 0006,
    # build/native/<v>/image/postgres). Besides it there are only two empty directories (/tmp, and the data directory the volume mounts over).
    # WITH_TOOLS=1 only changes the tag (the compatibility test asks for the -tools image; the tools are part of the same file).
    tag="$img"; if [ "${WITH_TOOLS:-0}" = 1 ]; then tag="$img-tools"; fi
    docker run --rm --network none -e VDIR="$ver$bvs" -e PACK="$pack" -e XSFX="$xsfx_bin" -v compactdb-build:/b:ro -v "$root/docker/native:/n:ro" "$builder" sh -c '
         set -e
         bin=/b/native/$VDIR/image/postgres
         test -x $bin || { echo "no one-file build in build/native/$VDIR; run tools/dcb musl make native-build VERSION='"$ver"'" >&2; exit 1; }
         d=$(mktemp -d); r=$d/rootfs
         mkdir -p $r/tmp $r/usr/local/pgsql/bin $d/pgdata
         chmod 1777 $r/tmp
         cp $bin $r/usr/local/pgsql/bin/postgres
         if [ "$PACK" = xsfx ]; then   # pack the executable; keep the packed file only if it is smaller (the stub is 90 KB)
             cp $XSFX /tmp/xsfx; chmod +x /tmp/xsfx
             /tmp/xsfx $r/usr/local/pgsql/bin/postgres /tmp/packed >/dev/null; a=$(stat -c %s $r/usr/local/pgsql/bin/postgres); b=$(stat -c %s /tmp/packed)
             if [ $b -lt $a ]; then cat /tmp/packed > $r/usr/local/pgsql/bin/postgres; echo "native: packed postgres $a -> $b" >&2; else echo "native: kept postgres unpacked ($a; packed would be $b)" >&2; fi
         fi
         cp /n/Dockerfile $d/
         tar -C $d -cf - .' | docker build -q -t "$tag" -
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
    # docker adds mount points to every container export (.dockerenv, dev/console, etc/hosts, hostname, resolv.conf); they are not image content
    list="$root/reports/native-image-files$vs.txt"
    skip=' (\.dockerenv|dev/console|etc/(hostname|hosts|resolv\.conf))$'
    files=$(grep '^-' "$list" | grep -cvE "$skip" || true)
    bytes=$(grep '^-' "$list" | grep -vE "$skip" | awk '{s += $3} END {print s + 0}')
    echo "native: $files files, $bytes bytes (reports/native-image-files$vs.txt)"
    if grep -E ' (usr/)?(local/)?(bin|sbin)/(sh|bash|ash|busybox)$|ld-musl|ld-linux|\.so(\.[0-9]+)*$' "$root/reports/native-image-files$vs.txt"; then
        echo "FAIL: shell, dynamic loader or shared object found in the image"; exit 1
    fi
    [ "$files" = 1 ] && echo "PASS: the image holds exactly one file" || { echo "FAIL: expected one file in the image, found $files"; exit 1; }
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
    client -At -c "SELECT version()" -c "SHOW server_encoding" -c "SHOW timezone" -c "SELECT datcollate FROM pg_database WHERE datname='postgres'"
    # the locale provider column exists from 15 on
    client -At -c "SELECT datlocprovider::text FROM pg_database WHERE datname='postgres'" 2>/dev/null || echo "(this release has no locale provider column)"

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
