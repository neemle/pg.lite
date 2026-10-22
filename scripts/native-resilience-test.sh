#!/bin/sh
# N07 (concurrent sessions) and N08 (crash after a confirmed commit) against the static image.
# Host launcher: it only runs docker. Usage: [VARIANT=os] scripts/native-resilience-test.sh [version]
#
# N07  two independent sessions: no dirty reads; a row lock blocks the second writer and is released by
#      COMMIT and by ROLLBACK; the "debit 80 from 100" race has exactly one winner; sum is conserved.
# N08  SIGKILL right after a confirmed commit (no shutdown checkpoint): the committed rows are there after
#      restart, a transaction that was still open at the kill is not visible, the log shows crash recovery.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
ver="${1:-18.6}"
vs="${VARIANT:+-$VARIANT}${PACK:+-$PACK}"
img="compactdb-native:$ver$vs"
client_img="compactdb-reference:$ver"
net="compactdb-ref-net"
name="compactdb-native-$ver$vs"
vol="compactdb-native-data-$ver$vs"
pw="native-test-only"
export MSYS_NO_PATHCONV=1

docker image inspect "$img" >/dev/null 2>&1 || { echo "resilience: build the image first (scripts/native-image.sh image $ver)" >&2; exit 1; }
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
trap 'sh "$root/scripts/native-image.sh" down "$ver" >/dev/null 2>&1 || true; docker rm -f compat-s1 compat-s2 compat-s3 >/dev/null 2>&1 || true' EXIT

q() { docker run --rm --network "$net" -e PGPASSWORD="$pw" --entrypoint psql "$client_img" -h "$name" -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
bg() { # bg <container> <sql>  : run a session in the background; its output is read with docker logs
    n="$1"; shift
    docker run -d --name "$n" --network "$net" -e PGPASSWORD="$pw" --entrypoint psql "$client_img" -h "$name" -U postgres -v ON_ERROR_STOP=1 -At "$@" >/dev/null
}
out() { docker wait "$1" >/dev/null; docker logs "$1" 2>&1 | tr -d '\r'; docker rm "$1" >/dev/null; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

sh "$root/scripts/native-image.sh" down "$ver" >/dev/null 2>&1 || true
sh "$root/scripts/native-image.sh" up "$ver"
q -c "CREATE TABLE acct (id int PRIMARY KEY, balance numeric(12,2) NOT NULL CHECK (balance >= 0)); INSERT INTO acct VALUES (1, 100.00), (2, 0.00)" >/dev/null

echo "=== N07: independent sessions"
# --- dirty read: S1 changes the row and sits in its transaction; S2 must still see the old value
bg compat-s1 -c "BEGIN; UPDATE acct SET balance = 20 WHERE id = 1; SELECT pg_sleep(4); ROLLBACK; SELECT 'rolled back'"
sleep 1.5
seen=$(q -c "SELECT balance FROM acct WHERE id = 1")
[ "$seen" = "100.00" ] && pass "no dirty read: other session sees 100.00 while 20 is uncommitted" || bad "dirty read: saw $seen"

# --- the row lock blocks a second writer, and ROLLBACK releases it
t0=$(now_ms)
q -c "UPDATE acct SET balance = balance - 10 WHERE id = 1 RETURNING balance" > /tmp/n07_b.txt 2>&1 || true
waited=$(( $(now_ms) - t0 ))
out compat-s1 >/dev/null
[ "$waited" -ge 1500 ] && pass "second writer blocked on the row lock for ${waited} ms" || bad "second writer did not wait (${waited} ms)"
[ "$(tr -d '\r' < /tmp/n07_b.txt | head -1)" = "90.00" ] && pass "after ROLLBACK the waiting writer proceeds from the original value (100 -> 90)" || bad "unexpected result after rollback: $(cat /tmp/n07_b.txt)"
q -c "UPDATE acct SET balance = 100.00 WHERE id = 1" >/dev/null

# --- COMMIT also releases the lock, and the waiter sees the committed value
bg compat-s1 -c "BEGIN; UPDATE acct SET balance = balance - 30 WHERE id = 1; SELECT pg_sleep(3); COMMIT"
sleep 1
t0=$(now_ms)
r=$(q -c "UPDATE acct SET balance = balance - 5 WHERE id = 1 RETURNING balance" | head -1)
waited=$(( $(now_ms) - t0 ))
out compat-s1 >/dev/null
[ "$r" = "65.00" ] && [ "$waited" -ge 1000 ] && pass "after COMMIT the waiter sees the committed 70 and applies -5 -> 65 (waited ${waited} ms)" || bad "commit hand-over wrong: $r after ${waited} ms"
q -c "UPDATE acct SET balance = 100.00 WHERE id = 1" >/dev/null

# --- the financial race: two sessions each debit 80.00 from 100.00 with a sufficiency check, started together
q -c "CREATE TABLE ops (id serial PRIMARY KEY, who text, amount numeric(12,2))" >/dev/null
DEBIT="BEGIN; WITH d AS (UPDATE acct SET balance = balance - 80 WHERE id = 1 AND balance >= 80 RETURNING 1), c AS (UPDATE acct SET balance = balance + 80 WHERE id = 2 AND EXISTS (SELECT 1 FROM d) RETURNING 1) INSERT INTO ops (who, amount) SELECT 'WHO', 80 FROM d RETURNING 'debited'; SELECT pg_sleep(1); COMMIT"
bg compat-s1 -c "$(echo "$DEBIT" | sed 's/WHO/s1/')"
bg compat-s2 -c "$(echo "$DEBIT" | sed 's/WHO/s2/')"
r1=$(out compat-s1 | grep -c debited || true); r2=$(out compat-s2 | grep -c debited || true)
[ $((r1 + r2)) -eq 1 ] && pass "exactly one of two concurrent 80.00 debits succeeded (s1=$r1, s2=$r2)" || bad "debits succeeded: s1=$r1 s2=$r2"
[ "$(q -c "SELECT balance FROM acct WHERE id = 1")" = "20.00" ] && pass "source balance is 20.00" || bad "source balance wrong"
[ "$(q -c "SELECT balance FROM acct WHERE id = 2")" = "80.00" ] && pass "credit landed in the same transaction (destination 80.00)" || bad "destination wrong"
[ "$(q -c "SELECT sum(balance) FROM acct")" = "100.00" ] && pass "total conserved (100.00)" || bad "total changed"
[ "$(q -c "SELECT count(*) FROM ops")" = "1" ] && pass "exactly one operation record" || bad "operation records wrong"

echo "=== N08: kill -9 after a confirmed commit"
q -c "CREATE TABLE durable (id int PRIMARY KEY, v text)" >/dev/null
q -c "INSERT INTO durable SELECT g, 'committed ' || g FROM generate_series(1, 1000) g" >/dev/null    # autocommit: confirmed
# a transaction that is still open when the server dies (must NOT be visible afterwards)
bg compat-s3 -c "BEGIN; INSERT INTO durable SELECT g, 'uncommitted' FROM generate_series(2001, 2500) g; SELECT pg_sleep(60); COMMIT"
sleep 1
q -c "INSERT INTO durable VALUES (1001, 'last confirmed commit')" >/dev/null
docker kill -s KILL "$name" >/dev/null
docker rm -f compat-s3 >/dev/null 2>&1 || true
docker start "$name" >/dev/null
i=0; until q -c "SELECT 1" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 90 ] && { echo "server did not come back"; docker logs "$name" | tail -20; exit 1; }; sleep 1; done
n=$(q -c "SELECT count(*) FROM durable WHERE v NOT LIKE 'uncommitted'")
[ "$n" = "1001" ] && pass "all 1001 confirmed rows survived the SIGKILL" || bad "confirmed rows after crash: $n (expected 1001)"
[ "$(q -c "SELECT v FROM durable WHERE id = 1001")" = "last confirmed commit" ] && pass "the very last confirmed commit is present" || bad "last commit lost"
[ "$(q -c "SELECT count(*) FROM durable WHERE v = 'uncommitted'")" = "0" ] && pass "the transaction open at the kill is not visible" || bad "uncommitted rows became visible"
if docker logs "$name" 2>&1 | grep -qE "database system was not properly shut down|automatic recovery in progress|redo starts"; then pass "log shows crash recovery ran (WAL redo)"; else bad "no crash recovery in the log"; fi
[ "$(q -c "SELECT sum(balance) FROM acct")" = "100.00" ] && pass "accounts still consistent after recovery (100.00)" || bad "accounts changed by recovery"

[ "$fail" = 0 ] && echo "resilience test: PASS" || { echo "resilience test: FAIL"; exit 1; }
