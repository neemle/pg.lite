#!/bin/sh
# Quick, repeatable server benchmark of one image (host launcher: it only runs docker).
#   scripts/bench.sh <image> <data-mount> <label>
#     e.g. scripts/bench.sh compactdb-native:18.6 /var/lib/postgresql/data plain
#          scripts/bench.sh postgres:18-alpine    /var/lib/postgresql      official-alpine
#
# Fresh volume and container; the client is pgbench from the reference image over TCP on a private
# network, so every server is measured the same way. Measures: time to the first successful SQL
# (cold init + start), pgbench -i at scale 5 (500,000 rows), then 3 runs each of select-only and
# TPC-B-like (4 clients, 10 s). One JSON line is appended to reports/bench.jsonl. This is an
# indicative comparison on one machine, not the final performance report (CDB-10).
set -eu
image="${1:?usage: bench.sh <image> <data-mount> <label>}"
mount="${2:?data mount point}"
label="${3:?label}"
root=$(cd "$(dirname "$0")/.." && pwd)
client_img="compactdb-reference:18.6"
net="compactdb-ref-net"
name="compactdb-bench"
vol="compactdb-bench-data"
pw="bench-test-only"
export MSYS_NO_PATHCONV=1

docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$vol" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker volume create "$vol" >/dev/null

now() { date +%s%N; }
pg() { prog="$1"; shift; docker run --rm --network "$net" -e PGPASSWORD="$pw" --entrypoint "$prog" "$client_img" "$@"; }

t0=$(now)
docker run -d --name "$name" --network "$net" -e POSTGRES_PASSWORD="$pw" -v "$vol:$mount" "$image" >/dev/null
i=0
until pg psql -h "$name" -U postgres -At -c "SELECT 1" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 180 ] && { echo "bench: $label did not start" >&2; docker logs "$name" >&2; exit 1; }
    sleep 0.2
done
start_ms=$(( ($(now) - t0) / 1000000 ))

t1=$(now)
pg pgbench -h "$name" -U postgres -i -s 5 -q postgres >/dev/null 2>&1
init_ms=$(( ($(now) - t1) / 1000000 ))

tps() { # tps <extra pgbench args...>  -> prints the tps number
    pg pgbench -h "$name" -U postgres -c 4 -j 2 -T 10 "$@" postgres 2>&1 | sed -n 's/^tps = \([0-9.]*\) .*/\1/p'
}
sel=""; tpcb=""
for n in 1 2 3; do sel="$sel $(tps -S)"; done
for n in 1 2 3; do tpcb="$tpcb $(tps)"; done
median() { echo "$@" | tr ' ' '\n' | grep -v '^$' | sort -n | sed -n '2p'; }
msel=$(median $sel); mtpcb=$(median $tpcb)

mkdir -p "$root/reports"
printf '{"label":"%s","image":"%s","startMs":%s,"initScale5Ms":%s,"selectOnlyTps":[%s],"tpcbTps":[%s],"medianSelectTps":%s,"medianTpcbTps":%s}\n' \
    "$label" "$image" "$start_ms" "$init_ms" "$(echo $sel | tr ' ' ',')" "$(echo $tpcb | tr ' ' ',')" "$msel" "$mtpcb" | tee -a "$root/reports/bench.jsonl"
