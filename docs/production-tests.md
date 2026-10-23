# Production-readiness tests (static image)

`scripts/native-production-test.sh` runs the very small image the way a production deployment would run it and checks that it keeps its promises under
concurrency, failure and load. Host side it only runs docker. Usage:

```bash
VARIANT=min3 scripts/native-production-test.sh 18.6               # the recommended image
VARIANT=min3 PACK=xsfx scripts/native-production-test.sh 18.6     # the same server packed with xsfx (the packed image passes the same 85 checks)
PROD_T=30 VARIANT=min3 scripts/native-production-test.sh 18.6     # longer timed phases (default 10 s)
```

Prerequisites: the image (`scripts/native-image.sh image 18.6`) and the reference image (`scripts/reference.sh image 18.6`; its `psql`, `pgbench` and
`pg_basebackup` are the clients). Workloads are in `scripts/pgbench/`.

## How the server is run

Read-only root filesystem, `/tmp` as tmpfs, all capabilities dropped, `no-new-privileges`, 512 MiB memory limit (no swap), 2 CPUs, 512 processes maximum,
the default 64 MiB `/dev/shm`, uid 70, default `max_connections` (100). Everything below runs inside those limits.

The test client is multi-threaded (`pgbench -j`), and the server is multi-process by design (one backend per connection plus background processes, I/O workers and parallel
workers), so "multithreaded" is covered on the client side and "multi-process" on the server side.

## What is checked

| ID | Check | Why it matters |
| --- | --- | --- |
| P01 | All background processes exist (checkpointer, background writer, WAL writer, autovacuum launcher, logical replication launcher, I/O workers); PID 1 is uid 70; root file system read-only, capabilities dropped | the process model of a normal server survived the static, shell-free build |
| P02 | 90 clients on 8 threads, three protocols (simple, extended, prepared), then 32 clients on a single hot row: every transaction committed exactly once, TPC-B sums agree | no lost or duplicated work under load |
| P03 | 120 clients against `max_connections=100`: clean "too many clients" refusal, server unaffected, no leftover sessions | overload behaves like a real PostgreSQL |
| P04 | 24 SERIALIZABLE clients on 20 hot accounts, with a concurrent reader asserting the total in every snapshot | SSI conflicts happen, are retried, and the invariant (balance = 1000 + credits - debits for every account) holds; exactly-once via a ledger |
| P05 | Deadlocks: a crossed pair (exactly one victim), then 16 clients locking 8 rows in random order | deadlock detection works in the shell-free server |
| P06 | Advisory locks; LISTEN/NOTIFY between sessions (rolled back NOTIFY is not delivered) | shared-memory lock and notification machinery |
| P07 | Parallel aggregate and parallel hash join launch workers; results equal the serial ones; a sort larger than `work_mem` spills to temporary files | dynamic shared memory in a 64 MiB `/dev/shm`, background workers, temp files on a read-only root |
| P08 | A 19 MB value (TOAST, compressed) and a 1 MB large object survive a restart bit-for-bit | large-value paths |
| P09 | Autovacuum and autoanalyze run by themselves | background maintenance |
| P10 | CREATE/REINDEX INDEX CONCURRENTLY, ADD COLUMN, VACUUM FULL while 8 clients write: no writer fails, invariants hold, index scan = sequential scan, no invalid index | online DDL |
| P11 | 20 clients opening a connection for every transaction (thousands of forks): no failures, no sessions, no zombie processes left; memory reported before and after | process management by PID 1, leaks |
| P12 | `statement_timeout`, `lock_timeout`, `pg_cancel_backend`, `pg_terminate_backend` | operational controls |
| P13 | One backend killed with SIGKILL: the postmaster reinitialises, the container does not restart, committed data is intact | crash isolation |
| P14 | `docker stop` (SIGINT, fast shutdown) while 16 clients write: exit status 0, orderly shutdown in the log, the next start needs no crash recovery | graceful shutdown under load |
| P15 | `kill -9` of the whole server under write load, three cycles: WAL redo each time, every account balance equals credits minus debits, indexes agree, zero checksum failures | durability and atomicity |
| P16 | `pg_basebackup` from the running primary, a second static container as hot standby: it streams, replays, shows as a streaming WAL sender, refuses writes, and accepts them after `pg_promote()` | physical replication |
| P17 | No PANIC, signal 11 or 6, shared-memory or memory errors in either log; never OOM-killed under 512 MiB | final health |

The invariant used in P04, P05, P10, P13, P14 and P15 is strict: every transfer writes one ledger row in the same transaction as the two balance updates, so after any
crash or interruption `bank.bal = 1000 + sum(ledger credits) - sum(ledger debits)` must hold for every single account, and the total must be unchanged.

## What the first runs found

- **Streaming replication did not work** (P16): a standby of the static server stopped with `could not load library "libpqwalreceiver"`, because the WAL receiver
  (and the apply workers of logical replication) load that module by name. Fixed by patch `0005-static-libpqwalreceiver.patch` and `scripts/build-native.sh`: the module is now linked into the
  server together with the libpq objects it needs and the **frontend** flavour of `src/common` and `src/port` (libpq frees memory its common functions allocate with `free()`,
  so it must not get the server's `palloc` copies, and libpq's link canary refuses a backend flavour). Everything defined inside that blob is made local, so it cannot clash with the
  server's own functions. Cost: about 229 KB of `postgres` (7,514,200 to 7,743,736 bytes, +3.0%).
- Three failures were bugs in the test, not the server, and are fixed: `pgbench` truncating its history table at every start (use `-n`), a `CASE ... 1/0` that PostgreSQL
  folds at plan time, and a query whose unused window function the planner removes (so nothing spilled).

## Not covered

External connection poolers, TLS (excluded from the profile), logical replication end to end (the module it needs is now present; a publication/subscription test is future work),
disk-full behaviour, and multi-hour soak runs (`PROD_T` lengthens the timed phases only).

## Results (this host, Docker Desktop on Windows)

| Image | Checks | Result |
| --- | ---: | --- |
| `compactdb-native:18.6-min3` | 85 | all PASS |
| `compactdb-native:18.6-min3-xsfx` | 85 | all PASS |

Both also pass the native image test, the N07/N08 resilience test and the 16-check compatibility test against `postgres:18-alpine` after the WAL receiver change.
The timed steps synchronise on the real state of the server (`pg_locks`, `pg_stat_activity`) instead of fixed sleeps, because client containers start with a jitter of a second or more.
