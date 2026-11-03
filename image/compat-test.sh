#!/bin/sh
# Drop-in replacement test: the static server must open, read and modify a cluster created by the
# official postgres:18-alpine image, and the official image must open the result again.
#
#   image/compat-test.sh [version]      (needs: compactdb-native:<v> and compactdb-reference:<v> images)
#
#   A  official postgres:18-alpine creates the cluster and fills it         -> fingerprint F1
#   B  static image on the SAME volume: reads (== F1), updates               -> fingerprint F2
#   C  official image again: reads (== F2), index check, updates             -> fingerprint F3
#   D  static image again: reads (== F3)
# Host side only runs docker. The password is a test value for a throw-away server on a private network.
set -eu
ver="${1:-18.6}"
official="postgres:18-alpine"
static_img="compactdb-native:$ver${VARIANT:+-$VARIANT}${PACK:+-$PACK}"
client_img="compactdb-reference:$ver"
net="compactdb-ref-net"
vol="compactdb-compat-data"
pgdata="/var/lib/postgresql/18/docker"
pw="compat-test-only"
export MSYS_NO_PATHCONV=1

docker image inspect "$static_img" >/dev/null 2>&1 || { echo "compat: build the static image first (image/image.sh image $ver)" >&2; exit 1; }
docker image inspect "$client_img" >/dev/null 2>&1 || { echo "compat: build the reference image first (image/reference.sh image $ver)" >&2; exit 1; }
docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null

fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
cleanup() { docker rm -f compat-official compat-static >/dev/null 2>&1 || true; docker volume rm "$vol" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

q() { # q <server> psql-args...
    s="$1"; shift
    docker run --rm --network "$net" -e PGPASSWORD="$pw" --entrypoint psql "$client_img" -h "compat-$s" -U postgres -v ON_ERROR_STOP=1 -At "$@"
}
wait_ready() {
    i=0
    until q "$1" -c "SELECT 1" >/dev/null 2>&1; do
        i=$((i + 1)); [ "$i" -gt 90 ] && { echo "compat: $1 did not become ready" >&2; docker logs "compat-$1" 2>&1 | tail -15 >&2; return 1; }
        sleep 1
    done
}
start_official() { docker run -d --name compat-official --network "$net" -e POSTGRES_PASSWORD="$pw" -v "$vol:/var/lib/postgresql" "$official" >/dev/null; wait_ready official; }
start_static() { docker run -d --name compat-static --network "$net" -e POSTGRES_PASSWORD="$pw" -e PGDATA="$pgdata" -v "$vol:/var/lib/postgresql" "$static_img" >/dev/null; wait_ready static; }
stop_clean() { # stop with the image's own stop signal (SIGINT = fast shutdown) and require a clean shutdown
    docker stop -t 60 "compat-$1" >/dev/null
    if docker logs "compat-$1" 2>&1 | grep -q "database system is shut down"; then pass "$1 shut down cleanly"; else bad "$1 did not log a clean shutdown"; fi
    docker rm "compat-$1" >/dev/null
}

FP="SET TIME ZONE 'UTC'; SELECT
  (SELECT count(*) FROM accounts) || '|' || (SELECT sum(balance) FROM accounts) || '|' ||
  (SELECT md5(string_agg(a::text, '~' ORDER BY id)) FROM accounts a) || '|' ||
  (SELECT count(*) FROM ledger) || '|' || (SELECT coalesce(sum(amount), 0) FROM ledger) || '|' ||
  (SELECT sum(length(payload)) FROM blobs) || '|' || (SELECT md5(string_agg(b.payload, '~' ORDER BY id)) FROM blobs b) || '|' ||
  (SELECT count(*) FROM totals WHERE n > 0)"
fingerprint() { q "$1" -c "$FP" | tail -1; }

echo "=== A: official $official creates and fills the cluster"
start_official
q official -c "SELECT version()" | head -1
q official -c "SHOW data_checksums" -c "SELECT datlocprovider::text || ' ' || datcollate || ' ' || datctype FROM pg_database WHERE datname='postgres'" -c "SHOW server_encoding"
q official >/dev/null -c "
CREATE TABLE accounts (id int PRIMARY KEY, owner text NOT NULL, balance numeric(20,2) NOT NULL CHECK (balance >= 0), uid uuid DEFAULT gen_random_uuid(), created timestamptz DEFAULT now(), note text);
CREATE INDEX accounts_owner_idx ON accounts (owner);
CREATE INDEX accounts_bal_idx ON accounts (balance);
INSERT INTO accounts (id, owner, balance, note)
  SELECT g, 'owner-' || (g % 97) || ' Київ Львів ' || g, ((g * 7 % 10000) || '.' || lpad((g % 100)::text, 2, '0'))::numeric(20,2), 'нотатка ' || g FROM generate_series(1, 5000) g;
CREATE TABLE ledger (id bigserial PRIMARY KEY, from_id int REFERENCES accounts, to_id int REFERENCES accounts, amount numeric(20,2) NOT NULL);
CREATE TABLE blobs (id int PRIMARY KEY, payload text);
INSERT INTO blobs SELECT g, repeat(md5(g::text), 4000) FROM generate_series(1, 40) g;
CREATE VIEW totals AS SELECT count(*) AS n, sum(balance) AS total FROM accounts;
CREATE FUNCTION transfer(a int, b int, amt numeric) RETURNS void LANGUAGE plpgsql AS \$\$
BEGIN
  UPDATE accounts SET balance = balance - amt WHERE id = a;
  UPDATE accounts SET balance = balance + amt WHERE id = b;
  INSERT INTO ledger (from_id, to_id, amount) VALUES (a, b, amt);
END \$\$;
SELECT transfer(g, g + 1, 1.50) FROM generate_series(1, 200) g;
CHECKPOINT;"
F1=$(fingerprint official); echo "F1=$F1"
[ -n "$F1" ] && pass "official created the data" || bad "no fingerprint from the official server"
stop_clean official

echo "=== B: static server opens the SAME volume, reads, then updates"
start_static
q static -c "SELECT version()" | head -1
q static -c "SELECT datlocprovider::text || ' ' || datcollate || ' ' || datctype FROM pg_database WHERE datname='postgres'" -c "SHOW data_checksums"
G1=$(fingerprint static); [ "$G1" = "$F1" ] && pass "static read exactly what official wrote (fingerprint equal)" || bad "static sees different data: $G1"
q static >/dev/null -c "
SELECT transfer(g, g + 2, 2.25) FROM generate_series(300, 500) g;
INSERT INTO accounts (id, owner, balance, note) SELECT g, 'static-' || g, g, 'додано статичним сервером' FROM generate_series(5001, 5500) g;
UPDATE accounts SET note = note || ' (updated by static)' WHERE id % 10 = 0;
DELETE FROM accounts WHERE id BETWEEN 4000 AND 4100 AND id NOT IN (SELECT from_id FROM ledger UNION SELECT to_id FROM ledger);
INSERT INTO blobs SELECT g, repeat(md5('static' || g), 5000) FROM generate_series(41, 60) g;
CREATE INDEX accounts_note_idx ON accounts (note);
CREATE TABLE made_by_static (id int PRIMARY KEY, v text);
INSERT INTO made_by_static SELECT g, 'row ' || g FROM generate_series(1, 1000) g;
" -c "VACUUM (ANALYZE)" -c "CHECKPOINT"
F2=$(fingerprint static); echo "F2=$F2"
[ "$F2" != "$F1" ] && pass "static changed the data" || bad "fingerprint did not change after the static updates"
stop_clean static

echo "=== C: official opens the result of the static server"
start_official
G2=$(fingerprint official); [ "$G2" = "$F2" ] && pass "official reads exactly what static wrote (fingerprint equal)" || bad "official sees different data: $G2"
[ "$(q official -c "SELECT count(*) FROM made_by_static")" = "1000" ] && pass "table created by static is readable (1000 rows)" || bad "made_by_static unreadable"
q official >/dev/null -c "CREATE EXTENSION IF NOT EXISTS amcheck"
bad_idx=$(q official -c "SELECT count(*) FROM (SELECT bt_index_check(c.oid, true) FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_am am ON am.oid = c.relam WHERE am.amname = 'btree' AND c.relpersistence = 'p') s" 2>&1 || true)
echo "btree indexes checked by amcheck: $bad_idx"
[ -n "$bad_idx" ] && [ "$bad_idx" -gt 0 ] 2>/dev/null && pass "amcheck verified every btree index (including those static wrote)" || bad "amcheck failed: $bad_idx"
q official -c "SELECT coalesce(checksum_failures, 0) FROM pg_stat_database WHERE datname = 'postgres'" | grep -qx 0 && pass "no data checksum failures" || bad "checksum failures reported"
q official >/dev/null -c "
SELECT transfer(g, g + 3, 3.10) FROM generate_series(700, 900) g;
UPDATE accounts SET balance = balance + 1 WHERE id % 50 = 0;
INSERT INTO made_by_static SELECT g, 'official ' || g FROM generate_series(1001, 1100) g;
" -c "VACUUM (ANALYZE)" -c "CHECKPOINT"
F3=$(fingerprint official); echo "F3=$F3"
[ "$F3" != "$F2" ] && pass "official updated the cluster that static had modified" || bad "no change after official updates"
stop_clean official

echo "=== D: static server reads what official wrote last"
start_static
G3=$(fingerprint static); [ "$G3" = "$F3" ] && pass "static reads the final state (fingerprint equal)" || bad "static sees different data: $G3"
[ "$(q static -c "SELECT count(*) FROM made_by_static")" = "1100" ] && pass "rows added by official after static are visible (1100)" || bad "made_by_static row count wrong"
stop_clean static

echo "=== control file written by each server (same cluster, same fields expected)"
ctl_static=$(docker run --rm -v "$vol:/var/lib/postgresql" --entrypoint /usr/local/pgsql/bin/postgres "$static_img" --controldata "$pgdata" 2>&1 | grep -E 'catalog version|block size|checksum|cluster state|Database system identifier|Maximum data alignment|Float8' | sed 's/  */ /g')
ctl_official=$(docker run --rm -v "$vol:/var/lib/postgresql" --entrypoint pg_controldata "$official" "$pgdata" 2>&1 | grep -E 'catalog version|block size|checksum|cluster state|Database system identifier|Maximum data alignment|Float8' | sed 's/  */ /g')
[ -n "$ctl_static" ] && [ "$ctl_static" = "$ctl_official" ] && pass "pg_controldata from both builds agrees" || { bad "pg_controldata differs"; echo "static:"; echo "$ctl_static"; echo "official:"; echo "$ctl_official"; }
echo "$ctl_static"

[ "$fail" = 0 ] && echo "compat test: PASS" || { echo "compat test: FAIL"; exit 1; }
