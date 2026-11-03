#!/bin/sh
# Host launcher for the unmodified reference server (it only runs docker).
#   scripts/reference.sh image [version]   build compactdb-reference:<version> from build/ref/<version>/install
#   scripts/reference.sh up    [version]   start the server on a private docker network (no host port)
#   scripts/reference.sh psql  [version] -- <psql args>   run psql from a second container over TCP
#   scripts/reference.sh down  [version]   stop and remove the server and its data volume
#   scripts/reference.sh test  [version]   up, SELECT 1 from an external client, wrong password, down
# Prerequisite: tools/dc make fetch VERSION=<v> and tools/dcb ref make reference VERSION=<v>.
set -eu
root=$(cd "$(dirname "$0")/../tools" && pwd)
cmd="${1:?usage: reference.sh image|up|psql|down|test [version]}"; shift
ver="${1:-18.6}"; [ $# -gt 0 ] && shift || true
img="compactdb-reference:$ver"
net="compactdb-ref-net"
name="compactdb-ref-$ver"
vol="compactdb-ref-data-$ver"
# Test credential for a private, throw-away server on an internal docker network; not a secret.
pw="reference-test-only"
export MSYS_NO_PATHCONV=1

builder="compactdb-builder-ref:local"

client() { docker run --rm --network "$net" -e PGPASSWORD="${CLIENT_PASSWORD:-$pw}" --entrypoint psql "$img" -h "$name" -U postgres -v ON_ERROR_STOP=1 "$@"; }

case "$cmd" in
image)
    docker image inspect "$builder" >/dev/null 2>&1 || { echo "reference: build the ref builder first (tools/dcb ref make builder-check)" >&2; exit 1; }
    # Stream a build context (Dockerfile + entrypoint + install tree) out of the build volume.
    docker run --rm --network none -v compactdb-build:/b:ro -v "$root/docker/reference:/ref:ro" "$builder" sh -c \
        "set -e; test -d /b/ref/$ver/install || { echo 'no build/ref/$ver/install; run tools/dcb ref make reference VERSION=$ver' >&2; exit 1; }
         d=\$(mktemp -d); cp /ref/Dockerfile /ref/entrypoint.sh \$d/
         tar -C /b/ref/$ver/install -cf \$d/install.tar .
         tar -C \$d -cf - ." | docker build -q -t "$img" -
    echo "reference: built $img"
    ;;
up)
    docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume create "$vol" >/dev/null
    docker run -d --name "$name" --network "$net" -e POSTGRES_PASSWORD="$pw" -v "$vol:/var/lib/postgresql/data" "$img" >/dev/null
    i=0
    until docker exec "$name" pg_isready -q -U postgres 2>/dev/null; do
        i=$((i + 1)); [ "$i" -gt 60 ] && { echo "reference: server did not become ready" >&2; docker logs "$name" >&2; exit 1; }
        sleep 1
    done
    echo "reference: $name is ready (network $net)"
    ;;
psql)
    [ "${1:-}" = "--" ] && shift
    client "$@"
    ;;
down)
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$vol" >/dev/null 2>&1 || true
    echo "reference: removed $name and $vol"
    ;;
test)
    trap 'sh "$0" down "$ver" >/dev/null 2>&1 || true' EXIT
    sh "$0" up "$ver"
    echo "--- SELECT 1 from an external client container over TCP:"
    client -At -c "SELECT 1"
    echo "--- server and profile:"
    client -At -c "SELECT version()" -c "SHOW server_encoding" -c "SHOW timezone" -c "SELECT datlocprovider::text || ' ' || datcollate FROM pg_database WHERE datname='postgres'"
    echo "--- wrong password must be rejected:"
    if CLIENT_PASSWORD=wrong client -At -c "SELECT 1" >/dev/null 2>&1; then echo "FAIL wrong password was accepted"; exit 1; else echo "PASS wrong password rejected"; fi
    echo "--- restart keeps data:"
    client -At -c "CREATE TABLE t(x int); INSERT INTO t VALUES (42)"
    docker restart "$name" >/dev/null
    i=0; until docker exec "$name" pg_isready -q -U postgres 2>/dev/null; do i=$((i+1)); [ "$i" -gt 60 ] && exit 1; sleep 1; done
    [ "$(client -At -c 'SELECT x FROM t')" = "42" ] && echo "PASS data survived restart" || { echo "FAIL data lost"; exit 1; }
    echo "reference test: PASS"
    ;;
*)
    echo "reference: unknown command $cmd" >&2; exit 2 ;;
esac
