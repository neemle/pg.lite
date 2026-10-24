#!/bin/sh
# Smoke test of the WebAssembly server under node (inside the wasm builder): single-user mode on a copy of the
# template cluster that the wasm initdb made.  Not the browser test (that is W01-W09, CDB-7); it proves the
# engine itself runs the SQL profile before any browser glue is involved.
#   ./dcb wasm make test-wasm-node VERSION=18.6
set -eu
ver="${1:-18.6}"
base="/w/build/wasm/$ver"
bin="$base/install/pgsql/bin"
template="$base/template-pgdata"
[ -x "$bin/postgres" ] && [ -d "$template" ] || { echo "test-wasm-node: build first (./dcb wasm make wasm-build VERSION=$ver)" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -a "$template" "$work/pgdata"
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }

# One SQL statement per line on stdin; the server's single-user output comes back on stdout/stderr.
run() { "$bin/postgres" --single -D "$work/pgdata" -F -c exit_on_error=false postgres 2>&1; }

v=$("$bin/postgres" --version)
case "$v" in *"PostgreSQL) $ver"*|*"(PostgreSQL) $ver"*) pass "postgres --version: $v" ;; *) bad "unexpected version: $v" ;; esac

echo "--- first session: SQL profile"
out=$(run <<'EOF'
SELECT version()
SELECT 1 + 1 AS two
CREATE TABLE t (id int PRIMARY KEY, u text DEFAULT md5(random()::text), amount numeric(20,6) NOT NULL, note text)
INSERT INTO t (id, amount, note) SELECT g, g * 0.000001 + 123456789012.345678, 'row ' || g FROM generate_series(1, 1000) g
SELECT count(*), sum(amount) FROM t
CREATE VIEW v AS SELECT id, note FROM t WHERE id <= 3
SELECT string_agg(note, ',' ORDER BY id) FROM v
CREATE FUNCTION add3(a int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN a + 3; END $$
SELECT add3(4)
SELECT to_tsvector('english', 'the foxes jumped')
SELECT 9223372036854775807::bigint + 0 AS big
SELECT (2::numeric ^ 64)::numeric(40,0) + 1 AS bignum
SELECT datname FROM pg_database ORDER BY 1
SELECT current_setting('server_encoding'), current_setting('TimeZone')
SELECT 1/0
SELECT 'after the error'
CHECKPOINT
EOF
) || true
echo "$out" | grep -q "PostgreSQL ${ver%%.*}" && pass "version() answers" || bad "version() missing"
echo "$out" | grep -q '= "2"' && pass "1 + 1 = 2" || bad "arithmetic"
echo "$out" | grep -q '= "1000"' && pass "1000 rows inserted and counted" || bad "count"
echo "$out" | grep -q '123456789012346.178500' && pass "NUMERIC(20,6) keeps its digits (sum of 1000 rows)" || bad "numeric sum missing"
echo "$out" | grep -q 'row 1,row 2,row 3' && pass "view over the table" || bad "view"
echo "$out" | grep -q '= "7"' && pass "plpgsql function runs (static module)" || bad "plpgsql"
echo "$out" | grep -q "'fox':2" && pass "English text search stems 'foxes' to 'fox'" || bad "text search: $(echo "$out" | grep -i fox | head -2)"
echo "$out" | grep -q '9223372036854775807' && pass "bigint maximum is exact" || bad "bigint"
echo "$out" | grep -q '18446744073709551617' && pass "NUMERIC beyond 64 bits is exact" || bad "bignum"
echo "$out" | grep -q 'division by zero' && pass "an error is reported (SQLSTATE 22012 class: division by zero)" || bad "no error text"
echo "$out" | grep -q 'after the error' && pass "the session keeps going after an error" || bad "session died on an error"
echo "$out" | grep -q 'UTF8' && pass "server encoding UTF8" || bad "encoding"

echo "--- second session on the same directory: data persisted by the first"
out2=$(run <<'EOF'
SELECT count(*) FROM t
SELECT add3(10)
EOF
) || true
echo "$out2" | grep -q '= "1000"' && pass "rows are there after the server stopped and started again" || bad "persistence: $out2"
echo "$out2" | grep -q '= "13"' && pass "the function is there too" || bad "function persistence"

[ "$fail" = 0 ] && echo "wasm node test: PASS" || { echo "wasm node test: FAIL"; exit 1; }
