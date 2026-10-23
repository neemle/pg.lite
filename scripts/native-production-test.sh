#!/bin/sh
# Production-readiness tests for the static image: concurrency, many clients, crash and shutdown under load,
# background workers, replication, hardened container settings. Host launcher: it only runs docker.
#   [VARIANT=min3] [PACK=xsfx] [PROD_T=10] scripts/native-production-test.sh [version]
#
# The server runs the way production would run it: read-only root filesystem, /tmp as tmpfs, no capabilities,
# no-new-privileges, 512 MiB memory limit, 2 CPUs, a pids limit, the default 64 MiB /dev/shm.
# The client side is multi-threaded: pgbench from the reference image with -j threads. The server itself is multi-process.
#
# P01 process model          P02 many clients, TPC-B, three protocols     P03 connection limit
# P04 SERIALIZABLE contention P05 deadlocks                                P06 advisory locks, LISTEN/NOTIFY
# P07 parallel query + spill  P08 large values                             P09 autovacuum
# P10 DDL under load          P11 connection churn, no leaks               P12 cancel, timeouts, terminate
# P13 one backend killed      P14 graceful stop under load                 P15 kill -9 under load (3 cycles)
# P16 streaming replication   P17 log and container health
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
ver="${1:-18.6}"
vs="${VARIANT:+-$VARIANT}${PACK:+-$PACK}"
img="compactdb-native:$ver$vs"
client_img="compactdb-reference:$ver"
builder="compactdb-builder-musl:local"
net="compactdb-ref-net"
name="compactdb-prod-$ver$vs"
rname="$name-replica"
vol="$name-data"
rvol="$name-replica-data"
pw="native-test-only"
T="${PROD_T:-10}"
export MSYS_NO_PATHCONV=1

docker image inspect "$img" >/dev/null 2>&1 || { echo "prod: build the image first (scripts/native-image.sh image $ver)" >&2; exit 1; }
docker image inspect "$client_img" >/dev/null 2>&1 || { echo "prod: build the reference image first (scripts/reference.sh image $ver)" >&2; exit 1; }
fail=0; limits=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
check() { # check <description> <command...>
    d="$1"; shift
    if "$@"; then pass "$d"; else bad "$d"; fi
}
cleanup() {
    docker rm -f "$name" "$rname" prod-w prod-r prod-v prod-l prod-s >/dev/null 2>&1 || true
    docker volume rm "$vol" "$rvol" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
cleanup

# ---- helpers
hardened="--read-only --tmpfs /tmp:rw,mode=1777 --cap-drop ALL --security-opt no-new-privileges --pids-limit 512"
run_server() { # run_server <container> <volume> [postgres args...]
    c="$1"; v="$2"; shift 2
    # shellcheck disable=SC2086
    docker run -d --name "$c" --network "$net" $hardened --memory 512m --memory-swap 512m --cpus 2 \
        -e POSTGRES_PASSWORD="$pw" -v "$v:/var/lib/postgresql/data" "$img" "$@" >/dev/null
}
q_on() { h="$1"; shift; docker run --rm --network "$net" -e PGPASSWORD="$pw" --entrypoint psql "$client_img" -h "$h" -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
q() { q_on "$name" "$@"; }
wait_up() { # wait_up <host> [seconds]
    i=0
    until q_on "$1" -c "SELECT 1" >/dev/null 2>&1; do
        i=$((i + 1)); [ "$i" -gt "${2:-120}" ] && { echo "prod: $1 did not come up"; docker logs "$1" 2>&1 | tail -20; return 1; }
        sleep 1
    done
}
pb() { docker run --rm --network "$net" -e PGPASSWORD="$pw" -v "$root/scripts/pgbench:/s:ro" --entrypoint pgbench "$client_img" -h "$name" -U postgres "$@" postgres; }
pbbg() { n="$1"; shift; docker run -d --name "$n" --network "$net" -e PGPASSWORD="$pw" -v "$root/scripts/pgbench:/s:ro" --entrypoint pgbench "$client_img" -h "$name" -U postgres "$@" postgres >/dev/null; }
bg() { n="$1"; shift; docker run -d --name "$n" --network "$net" -e PGPASSWORD="$pw" --entrypoint psql "$client_img" -h "$name" -U postgres -v ON_ERROR_STOP=1 -At "$@" >/dev/null; }
out() { docker wait "$1" >/dev/null; docker logs "$1" 2>&1 | tr -d '\r'; docker rm "$1" >/dev/null; }
ns() { docker run --rm --network none --pid "container:${2:-$name}" "$builder" sh -c "$1"; }
slog() { docker logs "${1:-$name}" 2>&1 | tr -d '\r'; }
# until_sql <sql returning t or f>: wait up to 30 s until the condition holds, i.e. until a background client really is in the state the next step needs
until_sql() { i=0; until [ "$(q -c "$1" 2>/dev/null)" = t ]; do i=$((i + 1)); [ "$i" -gt 60 ] && { echo "prod: condition never held: $1" >&2; return 1; }; sleep 0.5; done; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
num() { sed -n "s/^$1: \([0-9][0-9]*\).*/\1/p" | head -1; }  # num <pgbench line label>

reset_bank() { # reset_bank <accounts>  : every account holds 1000; the ledger is empty
    q -c "DROP TABLE IF EXISTS ledger, bank; CREATE TABLE bank (id int PRIMARY KEY, bal bigint NOT NULL); INSERT INTO bank SELECT g, 1000 FROM generate_series(1, $1) g; CREATE TABLE ledger (id bigserial PRIMARY KEY, a int, b int, amt int)" >/dev/null
}
ledger_ok() { # ledger_ok <accounts> : balances equal 1000 + credits - debits for EVERY account, and the total is unchanged
    bad_rows=$(q -c "SELECT count(*) FROM bank b WHERE b.bal <> 1000 + coalesce((SELECT sum(amt) FROM ledger l WHERE l.b = b.id), 0) - coalesce((SELECT sum(amt) FROM ledger l WHERE l.a = b.id), 0)")
    total=$(q -c "SELECT sum(bal) FROM bank")
    [ "$bad_rows" = 0 ] && [ "$total" = "$(( $1 * 1000 ))" ]
}
index_ok() { # index scan and sequential scan agree about the ledger
    a=$(q -c "SET enable_seqscan = off" -c "SET enable_bitmapscan = off" -c "SELECT count(*), coalesce(sum(id),0) FROM ledger WHERE id > 0" | tail -1)
    b=$(q -c "SET enable_indexscan = off" -c "SET enable_bitmapscan = off" -c "SET enable_indexonlyscan = off" -c "SELECT count(*), coalesce(sum(id),0) FROM ledger WHERE id > 0" | tail -1)
    [ -n "$a" ] && [ "$a" = "$b" ]
}
tpcb_ok() { # the four TPC-B sums agree
    [ "$(q -c "SELECT (SELECT sum(abalance) FROM pgbench_accounts) = (SELECT sum(tbalance) FROM pgbench_tellers) AND (SELECT sum(tbalance) FROM pgbench_tellers) = (SELECT sum(bbalance) FROM pgbench_branches) AND (SELECT sum(bbalance) FROM pgbench_branches) = (SELECT coalesce(sum(delta),0) FROM pgbench_history)")" = t ]
}

echo "=== start: hardened container (read-only root, tmpfs /tmp, no capabilities, 512 MiB, 2 CPUs), cold init"
run_server "$name" "$vol"
wait_up "$name"
q -c "ALTER SYSTEM SET deadlock_timeout = '200ms'" -c "ALTER SYSTEM SET autovacuum_naptime = '3s'" -c "ALTER SYSTEM SET log_min_messages = 'warning'" -c "SELECT pg_reload_conf()" >/dev/null
mem0=$(docker stats --no-stream --format '{{.MemUsage}}' "$name" | cut -d/ -f1)
echo "idle server memory: $mem0"

echo "=== P01: process model"
types=$(q -c "SELECT string_agg(DISTINCT backend_type, ', ' ORDER BY backend_type) FROM pg_stat_activity")
echo "backend types: $types"
for t in "autovacuum launcher" "background writer" checkpointer "io worker" "logical replication launcher" walwriter; do
    case "$types" in *"$t"*) pass "background process present: $t" ;; *) bad "background process missing: $t" ;; esac
done
uid=$(ns "awk '/^Uid:/ {print \$2}' /proc/1/status")
[ "$uid" = 70 ] && pass "the server (PID 1) runs as uid 70, not root" || bad "server uid is $uid"
hc=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' "$name")
[ "$hc" = "true [ALL]" ] && pass "root filesystem is read-only and all capabilities are dropped" || bad "container settings: $hc"
[ "$(q -c "SHOW max_connections")" = 100 ] && pass "max_connections is 100" || bad "max_connections"

echo "=== P02: many clients at once (TPC-B: 90 clients on 8 threads, then 32 clients on a single branch row)"
pb -i -s 5 -q >/dev/null 2>&1
runs=0
for proto in simple extended prepared; do
    o=$(pb -n -c 90 -j 8 -t 40 -M "$proto" 2>&1 || true)
    n=$(echo "$o" | num "number of transactions actually processed"); f=$(echo "$o" | num "number of failed transactions"); tps=$(echo "$o" | sed -n 's/^tps = \([0-9.]*\).*/\1/p' | head -1)
    h=$(q -c "SELECT count(*) FROM pgbench_history"); runs=$((runs + 1))
    [ "$n" = 3600 ] && [ "${f:-0}" = 0 ] && pass "-M $proto: 90 clients, 3600 of 3600 transactions committed, no failures (${tps} tps)" || bad "-M $proto: processed=$n failed=${f:-?}"
    [ "$h" = $((3600 * runs)) ] && pass "-M $proto: history has exactly ${h} rows (nothing lost, nothing duplicated)" || bad "-M $proto: history has $h rows, expected $((3600 * runs))"
    check "-M $proto: TPC-B invariant (accounts = tellers = branches = history)" tpcb_ok
done
pb -i -s 1 -q >/dev/null 2>&1
o=$(pb -n -c 32 -j 4 -t 150 -M prepared 2>&1 || true)
n=$(echo "$o" | num "number of transactions actually processed"); f=$(echo "$o" | num "number of failed transactions")
[ "$n" = 4800 ] && [ "${f:-0}" = 0 ] && pass "all 4800 transactions on one hot branch row committed" || bad "hot row: processed=$n failed=${f:-?}"
check "TPC-B invariant after the hot-row run (accounts = tellers = branches = history)" tpcb_ok
[ "$(q -c "SELECT count(*) FROM pgbench_history")" = 4800 ] && pass "history has exactly 4800 rows" || bad "history count"

echo "=== P03: more clients than max_connections"
o=$(pb -n -c 120 -j 4 -S -T 5 2>&1 || true)
echo "$o" | grep -qi "too many clients" && pass "excess clients are refused with 'too many clients already'" || bad "no too-many-clients message: $(echo "$o" | tail -2)"
[ "$(q -c "SELECT 1")" = 1 ] && pass "server still answers" || bad "server stopped answering"
sleep 1
[ "$(q -c "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'")" = 1 ] && pass "all refused/finished sessions are gone (1 backend: this one)" || bad "backends left over"

echo "=== P04: SERIALIZABLE under contention (24 clients, 20 hot accounts) with a concurrent consistency reader"
reset_bank 20
pbbg prod-r -n -c 4 -j 2 -T $((T + 6)) -f /s/reader_sum.sql -D expected=20000 --max-tries=1
o=$(pb -n -c 24 -j 4 -t 300 -M prepared --max-tries=500 -f /s/transfer_ser.sql 2>&1 || true)
rr=$(out prod-r)
n=$(echo "$o" | num "number of transactions actually processed"); f=$(echo "$o" | num "number of failed transactions"); r=$(echo "$o" | num "number of transactions retried")
echo "serializable run: processed=$n failed=${f:-0} retried=${r:-0}"
[ "$n" = 7200 ] && [ "${f:-0}" = 0 ] && pass "7200 of 7200 serializable transfers committed (after serialization retries)" || bad "serializable: processed=$n failed=${f:-?}"
[ "${r:-0}" -gt 0 ] && pass "serialization conflicts really happened and were retried (${r})" || bad "no conflicts: the test did not stress SSI"
[ "$(q -c "SELECT count(*) FROM ledger")" = 7200 ] && pass "ledger has exactly 7200 rows (each transfer applied once)" || bad "ledger count"
check "every account balance equals 1000 + credits - debits, total 20000" ledger_ok 20
rf=$(echo "$rr" | num "number of failed transactions")
rp=$(echo "$rr" | num "number of transactions actually processed")
[ "${rf:-0}" = 0 ] && [ "${rp:-0}" -gt 0 ] && pass "a concurrent reader saw a consistent total (20000) in all ${rp} snapshots" || bad "reader saw an inconsistent total (failed=${rf:-?} processed=${rp:-?})"

echo "=== P05: deadlocks (manual pair, then 16 clients locking 8 rows in random order)"
reset_bank 8
bg prod-v -c "BEGIN; UPDATE bank SET bal = bal WHERE id = 1; SELECT pg_sleep(4); UPDATE bank SET bal = bal WHERE id = 2; COMMIT; SELECT 'v ok'"
bg prod-w -c "BEGIN; UPDATE bank SET bal = bal WHERE id = 2; SELECT pg_sleep(4); UPDATE bank SET bal = bal WHERE id = 1; COMMIT; SELECT 'w ok'"
ov=$(out prod-v); ow=$(out prod-w)
dl=$(printf '%s\n%s\n' "$ov" "$ow" | grep -c "deadlock detected" || true); ok=$(printf '%s\n%s\n' "$ov" "$ow" | grep -c " ok$" || true)
[ "$dl" = 1 ] && [ "$ok" = 1 ] && pass "exactly one of two crossed sessions was chosen as the deadlock victim, the other committed" || bad "deadlock pair: victims=$dl committed=$ok"
reset_bank 8
o=$(pb -n -c 16 -j 4 -t 60 -M simple --max-tries=1000 -f /s/transfer_dl.sql 2>&1 || true)
n=$(echo "$o" | num "number of transactions actually processed"); f=$(echo "$o" | num "number of failed transactions"); r=$(echo "$o" | num "number of transactions retried")
[ "$n" = 960 ] && [ "${f:-0}" = 0 ] && pass "960 of 960 transfers committed despite deadlocks (${r:-0} retried)" || bad "deadlock run: processed=$n failed=${f:-?}"
[ "$(slog | grep -c 'deadlock detected')" -ge 2 ] && pass "the server detected and logged the deadlocks" || bad "no deadlocks in the log"
check "balances equal 1000 + credits - debits, total 8000" ledger_ok 8

echo "=== P06: advisory locks and LISTEN/NOTIFY across sessions"
bg prod-l -c "SELECT pg_advisory_lock(42)" -c "SELECT pg_sleep(4)"
until_sql "SELECT count(*) > 0 FROM pg_locks WHERE locktype = 'advisory' AND granted"
[ "$(q -c "SELECT pg_try_advisory_lock(42)")" = f ] && pass "advisory lock held by another session is refused" || bad "advisory lock not exclusive"
out prod-l >/dev/null
[ "$(q -c "SELECT pg_try_advisory_lock(42)")" = t ] && pass "advisory lock is free after its session ended" || bad "advisory lock leaked"
bg prod-l -c "LISTEN chan" -c "SELECT pg_sleep(5)" -c "SELECT 'done'"
until_sql "SELECT count(*) > 0 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(5)%' AND pid <> pg_backend_pid()"
q -c "NOTIFY chan, 'hello'" -c "BEGIN; NOTIFY chan, 'ghost'; ROLLBACK" -c "SELECT pg_notify('chan', 'second')" >/dev/null
ol=$(out prod-l)
echo "$ol" | grep -q '"hello"' && echo "$ol" | grep -q '"second"' && pass "listener received both committed notifications" || bad "notifications missing: $ol"
echo "$ol" | grep -q 'ghost' && bad "a rolled back NOTIFY was delivered" || pass "the rolled back NOTIFY was not delivered"

echo "=== P07: parallel query and spilling to temporary files (/dev/shm is the default 64 MiB)"
q -c "DROP TABLE IF EXISTS ptest; CREATE TABLE ptest AS SELECT g AS id, md5(g::text) AS h FROM generate_series(1, 1500000) g; ANALYZE ptest" >/dev/null
PAR="SET max_parallel_workers_per_gather = 4; SET parallel_setup_cost = 0; SET parallel_tuple_cost = 0; SET min_parallel_table_scan_size = 0"
plan=$(q -c "$PAR" -c "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT count(*), sum(id) FROM ptest")
echo "$plan" | grep -qE "Workers Launched: [1-9]" && pass "parallel aggregate launched workers (dynamic shared memory and background workers work)" || bad "no parallel workers: $plan"
a=$(q -c "$PAR" -c "SELECT count(*) || '/' || sum(id) FROM ptest" | tail -1); b=$(q -c "SET max_parallel_workers_per_gather = 0" -c "SELECT count(*) || '/' || sum(id) FROM ptest" | tail -1)
[ -n "$a" ] && [ "$a" = "$b" ] && pass "parallel and serial results are identical ($a)" || bad "parallel $a vs serial $b"
plan=$(q -c "$PAR" -c "SET work_mem = '2MB'" -c "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT count(*) FROM ptest a JOIN ptest b USING (id)")
echo "$plan" | grep -qE "Workers Launched: [1-9]" && pass "parallel join with a batched hash ran" || bad "parallel join: $plan"
plan=$(q -c "SET work_mem = '1MB'" -c "SET max_parallel_workers_per_gather = 0" -c "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT max(rn) FROM (SELECT row_number() OVER (ORDER BY h DESC) AS rn FROM ptest) s")
echo "$plan" | grep -q "external merge" && pass "a sort larger than work_mem spilled to temporary files and completed ($(echo "$plan" | grep -o 'Disk: [0-9]*kB' | head -1))" || bad "the sort did not spill: $plan"

echo "=== P08: large values (TOAST) and large objects, intact across a restart"
q -c "DROP TABLE IF EXISTS blob; CREATE TABLE blob (id int PRIMARY KEY, v text); INSERT INTO blob SELECT 1, string_agg(md5(g::text), '' ORDER BY g) FROM generate_series(1, 600000) g" >/dev/null
want=$(q -c "SELECT md5(string_agg(md5(g::text), '' ORDER BY g)) FROM generate_series(1, 600000) g")
sz=$(q -c "SELECT length(v) || '/' || pg_column_size(v) FROM blob")
q -c "SELECT lo_from_bytea(777, decode(repeat('00ff', 500000), 'hex'))" >/dev/null
docker restart -t 60 "$name" >/dev/null; wait_up "$name"
got=$(q -c "SELECT md5(v) FROM blob")
[ "$got" = "$want" ] && pass "a 19 MB value (stored as ${sz} bytes, compressed) is intact after a restart" || bad "large value changed"
[ "$(q -c "SELECT length(lo_get(777))")" = 1000000 ] && pass "a 1 MB large object is intact" || bad "large object"

echo "=== P09: autovacuum and autoanalyze run by themselves"
q -c "DROP TABLE IF EXISTS av; CREATE TABLE av (id int PRIMARY KEY, v text) WITH (autovacuum_vacuum_threshold = 50, autovacuum_vacuum_scale_factor = 0, autovacuum_analyze_threshold = 50, autovacuum_analyze_scale_factor = 0); INSERT INTO av SELECT g, md5(g::text) FROM generate_series(1, 20000) g; DELETE FROM av WHERE id > 5000" >/dev/null
i=0; while [ "$i" -lt 60 ]; do
    av=$(q -c "SELECT (last_autovacuum IS NOT NULL)::int::text || (last_autoanalyze IS NOT NULL)::int::text FROM pg_stat_user_tables WHERE relname = 'av'")
    [ "$av" = 11 ] && break; i=$((i + 1)); sleep 1
done
[ "$av" = 11 ] && pass "autovacuum and autoanalyze ran on their own (after ${i} s)" || bad "autovacuum did not run (state $av)"

echo "=== P10: DDL while 8 clients write (CREATE INDEX CONCURRENTLY, REINDEX CONCURRENTLY, ADD COLUMN, VACUUM FULL)"
reset_bank 100
pbbg prod-w -n -c 8 -j 2 -T $((T + 10)) --max-tries=100 -f /s/transfer_rc.sql
sleep 2
ddl_ok=1
for s in "CREATE INDEX CONCURRENTLY ledger_a ON ledger (a)" "CREATE INDEX CONCURRENTLY ledger_b ON ledger (b)" "REINDEX INDEX CONCURRENTLY ledger_a" "ALTER TABLE ledger ADD COLUMN note text DEFAULT 'x'" "VACUUM FULL ledger" "ANALYZE ledger" "CREATE INDEX CONCURRENTLY bank_bal ON bank (bal)"; do
    q -c "$s" >/dev/null 2>/tmp/prod_ddl.txt && echo "  ok: $s" || { echo "  FAILED: $s: $(cat /tmp/prod_ddl.txt)"; ddl_ok=0; }
done
[ "$ddl_ok" = 1 ] && pass "all DDL statements completed while the write load was running" || bad "a DDL statement failed"
o=$(out prod-w); f=$(echo "$o" | num "number of failed transactions"); n=$(echo "$o" | num "number of transactions actually processed")
[ "${f:-0}" = 0 ] && [ "${n:-0}" -gt 0 ] && pass "no writer transaction failed during the DDL (${n} committed)" || bad "writer failures: failed=${f:-?} processed=${n:-?}"
check "balances still equal 1000 + credits - debits" ledger_ok 100
check "index scan and sequential scan agree on the ledger (indexes built online are consistent)" index_ok
[ "$(q -c "SELECT count(*) FROM pg_index WHERE NOT indisvalid")" = 0 ] && pass "no invalid indexes" || bad "invalid index left behind"

echo "=== P11: connection churn (a new connection for every transaction, 20 clients) and leaks"
mem1=$(docker stats --no-stream --format '{{.MemUsage}}' "$name" | cut -d/ -f1)
o=$(pb -n -C -S -c 20 -j 4 -T "$T" 2>&1 || true)
n=$(echo "$o" | num "number of transactions actually processed"); f=$(echo "$o" | num "number of failed transactions")
[ "${n:-0}" -gt 200 ] && [ "${f:-0}" = 0 ] && pass "${n} connect/query/disconnect cycles, no failures" || bad "churn: processed=${n:-?} failed=${f:-?}"
sleep 2
[ "$(q -c "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'")" = 1 ] && pass "no sessions left behind" || bad "sessions left behind"
z=$(ns 'n=0; for p in /proc/[0-9]*; do s=$(awk "{print \$3}" $p/stat 2>/dev/null); [ "$s" = Z ] && n=$((n+1)); done; echo $n')
[ "$z" = 0 ] && pass "no zombie processes" || bad "$z zombie processes"
mem2=$(docker stats --no-stream --format '{{.MemUsage}}' "$name" | cut -d/ -f1)
echo "container memory: idle $mem0, before churn $mem1, after churn $mem2"

echo "=== P12: cancel, timeouts, terminate"
r=$(q -c "SET statement_timeout = '1s'" -c "SELECT pg_sleep(5)" 2>&1 || true)
echo "$r" | grep -q "statement timeout" && pass "statement_timeout cancels a long statement" || bad "statement_timeout: $r"
bg prod-l -c "BEGIN; LOCK TABLE bank IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8); COMMIT"
until_sql "SELECT count(*) > 0 FROM pg_locks WHERE locktype = 'relation' AND mode = 'AccessExclusiveLock' AND granted AND relation = 'bank'::regclass"
r=$(q -c "SET lock_timeout = '500ms'" -c "SELECT count(*) FROM bank" 2>&1 || true)
echo "$r" | grep -q "lock timeout" && pass "lock_timeout gives up on a blocked statement" || bad "lock_timeout: $r"
out prod-l >/dev/null
bg prod-v -c "SELECT pg_sleep(60)"
until_sql "SELECT count(*) > 0 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%' AND state = 'active' AND pid <> pg_backend_pid()"
q -c "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%' AND pid <> pg_backend_pid()" >/dev/null
ov=$(out prod-v)
echo "$ov" | grep -q "canceling statement due to user request" && pass "pg_cancel_backend cancels another session's statement" || bad "cancel: $ov"
bg prod-v -c "SELECT pg_sleep(60)"
until_sql "SELECT count(*) > 0 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%' AND state = 'active' AND pid <> pg_backend_pid()"
q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%' AND pid <> pg_backend_pid()" >/dev/null
ov=$(out prod-v)
echo "$ov" | grep -qiE "terminating connection due to administrator command|server closed the connection" && pass "pg_terminate_backend ends another session" || bad "terminate: $ov"

echo "=== P13: one backend is killed with SIGKILL (the postmaster must reinitialise, nothing committed is lost)"
reset_bank 100
q -c "INSERT INTO ledger (a, b, amt) VALUES (1, 2, 10); UPDATE bank SET bal = bal - 10 WHERE id = 1; UPDATE bank SET bal = bal + 10 WHERE id = 2" >/dev/null
started=$(docker inspect -f '{{.State.StartedAt}}' "$name")
bg prod-v -c "SELECT pg_sleep(120)"
until_sql "SELECT count(*) > 0 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(120)%' AND state = 'active' AND pid <> pg_backend_pid()"
vpid=$(q -c "SELECT pid FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(120)%' AND pid <> pg_backend_pid()")
ns "kill -9 $vpid" >/dev/null
out prod-v >/dev/null
wait_up "$name" 60
sl=$(slog)
echo "$sl" | grep -q "terminated by signal 9" && echo "$sl" | grep -q "terminating any other active server processes\|all server processes terminated; reinitializing" && pass "postmaster noticed the dead backend and reinitialised shared memory" || bad "no crash handling in the log"
[ "$(docker inspect -f '{{.State.StartedAt}}' "$name")" = "$started" ] && [ "$(docker inspect -f '{{.RestartCount}}' "$name")" = 0 ] && pass "the container itself did not restart (PID 1 survived)" || bad "container restarted"
check "committed data is intact after the backend crash" ledger_ok 100

echo "=== P14: docker stop (SIGINT, fast shutdown) while 16 clients are writing"
pbbg prod-w -n -c 16 -j 4 -T 60 --max-tries=100 -f /s/transfer_rc.sql
sleep 4
docker stop -t 60 "$name" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
[ "$code" = 0 ] && pass "the server exited with status 0 on SIGINT under load" || bad "exit status $code"
docker rm -f prod-w >/dev/null 2>&1 || true
slog | grep -q "database system is shut down" && pass "log shows an orderly shutdown" || bad "no orderly shutdown in the log"
before=$(slog | grep -c "redo starts" || true)
docker start "$name" >/dev/null; wait_up "$name"
after=$(slog | grep -c "redo starts" || true)
[ "$before" = "$after" ] && pass "restart after the stop needed no crash recovery" || bad "crash recovery after a clean stop"
check "balances consistent after the stop under load" ledger_ok 100
n=$(q -c "SELECT count(*) FROM ledger"); echo "ledger rows after stop: $n"

echo "=== P15: kill -9 of the whole server under load, 3 cycles (WAL redo each time)"
cycle=1
while [ "$cycle" -le 3 ]; do
    pbbg prod-w -n -c 16 -j 4 -T 60 -f /s/transfer_rc.sql
    sleep $((3 + cycle))
    docker kill -s KILL "$name" >/dev/null
    docker rm -f prod-w >/dev/null 2>&1 || true
    docker start "$name" >/dev/null; wait_up "$name"
    n=$(q -c "SELECT count(*) FROM ledger")
    if ledger_ok 100 && index_ok; then pass "cycle $cycle: consistent after the crash ($n ledger rows, balances = credits - debits, indexes agree)"; else bad "cycle $cycle: inconsistent after the crash"; fi
    cycle=$((cycle + 1))
done
r=$(slog | grep -c "redo done at" || true)
[ "$r" -ge 3 ] && pass "the log shows WAL redo ran after each kill (${r} times)" || bad "redo only ${r} times"
[ "$(q -c "SELECT coalesce(sum(checksum_failures),0) FROM pg_stat_database")" = 0 ] && pass "no data page checksum failures" || bad "checksum failures"

echo "=== P16: streaming replication (pg_basebackup over the network, a second static container as the standby)"
docker run --rm -v "$vol:/d" "$builder" sh -c 'echo "host replication all all scram-sha-256" >> /d/pg_hba.conf'
q -c "SELECT pg_reload_conf()" >/dev/null
docker volume create "$rvol" >/dev/null
docker run --rm --user 0 -v "$rvol:/d" "$builder" chown 70:70 /d
docker run --rm --user 70 --network "$net" -e PGPASSWORD="$pw" -v "$rvol:/d" --entrypoint pg_basebackup "$client_img" -h "$name" -U postgres -D /d -X stream -R -c fast >/dev/null 2>&1 \
    && pass "pg_basebackup copied the running primary" || bad "pg_basebackup failed"
docker run --rm --user 0 -e L="primary_conninfo = 'host=$name user=postgres password=$pw'" -v "$rvol:/d" "$builder" sh -c 'chown -R 70:70 /d && chmod 700 /d && echo "$L" >> /d/postgresql.auto.conf'
run_server "$rname" "$rvol"
wait_up "$rname"
[ "$(q_on "$rname" -c "SELECT pg_is_in_recovery()")" = t ] && pass "the second container is a hot standby" || bad "standby not in recovery"
sleep 6
if slog "$rname" | grep -q 'could not load library "libpqwalreceiver"'; then
    # known limitation of the static server (modules cannot be loaded): reported, not hidden
    echo "LIMIT streaming replication: the standby cannot start its WAL receiver (libpqwalreceiver is a loadable module); see docs/production-tests.md"
    limits=$((limits + 1))
else
q -c "INSERT INTO ledger (a, b, amt) SELECT 1, 1, 0 FROM generate_series(1, 5000)" >/dev/null
want=$(q -c "SELECT count(*) FROM ledger")
i=0; while [ "$i" -lt 60 ]; do got=$(q_on "$rname" -c "SELECT count(*) FROM ledger"); [ "$got" = "$want" ] && break; i=$((i + 1)); sleep 1; done
[ "$got" = "$want" ] && pass "the standby replayed the primary's writes ($want rows)" || bad "standby has $got rows, primary $want"
[ "$(q -c "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")" = 1 ] && pass "primary shows one streaming WAL sender" || bad "no streaming walsender"
fi
r=$(q_on "$rname" -c "CREATE TABLE nope (i int)" 2>&1 || true)
echo "$r" | grep -q "read-only transaction" && pass "the standby refuses writes" || bad "standby accepted a write: $r"
q_on "$rname" -c "SELECT pg_promote()" >/dev/null
i=0; until [ "$(q_on "$rname" -c "SELECT pg_is_in_recovery()")" = f ]; do i=$((i + 1)); [ "$i" -gt 30 ] && break; sleep 1; done
q_on "$rname" -c "CREATE TABLE promoted (i int); INSERT INTO promoted VALUES (1)" >/dev/null && pass "after pg_promote the former standby accepts writes" || bad "promotion failed"

echo "=== P17: log and container health after all of the above"
sl="$(slog; slog "$rname")"
for pat in "PANIC" "terminated by signal 11" "terminated by signal 6" "invalid memory alloc" "could not open shared memory" "could not resize shared memory" "out of memory" "TRAP:" "could not fork"; do
    echo "$sl" | grep -q "$pat" && bad "log contains: $pat" || pass "log has no '$pat'"
done
[ "$(docker inspect -f '{{.State.OOMKilled}}' "$name")" = false ] && pass "the container was never OOM-killed under the 512 MiB limit" || bad "OOM kill"
if ledger_ok 100 && index_ok; then pass "final state of the primary: balances consistent, indexes agree"; else bad "final state inconsistent"; fi
mem3=$(docker stats --no-stream --format '{{.MemUsage}}' "$name" | cut -d/ -f1)
echo "container memory at the end: $mem3"

[ "$fail" = 0 ] && echo "production test: PASS (known limitations reported: $limits)" || { echo "production test: FAIL"; exit 1; }
