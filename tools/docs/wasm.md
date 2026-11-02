# WebAssembly build and browser module

PostgreSQL itself, the same upstream release and the same SQL profile as the native image, compiled to WebAssembly
with Emscripten. It runs as the standalone ("single-user") backend in a dedicated Worker; there is no TCP listener,
no postmaster and no second process. Tags `vX.Y` build both the browser module and the Docker image of PostgreSQL X.Y
(see "Releases").

## Build

```sh
tools/dc make fetch VERSION=18.6                      # verified upstream source
tools/dc make wasm-src VERSION=18.6                   # apply patches/common + patches/wasm into build/wasm/18.6/src
tools/dcb wasm make wasm-build VERSION=18.6           # server + initdb as WebAssembly for node, then the template data directory
tools/dcb wasm make test-wasm-node VERSION=18.6       # SQL smoke test under node (no browser)
WEB=1 tools/dcb wasm make wasm-build VERSION=18.6     # the browser module: build/wasm/18.6/web/
DC_NET=1 tools/dcb web sh scripts/web-install.sh tests/browser
DC_NET=1 tools/dcb web sh scripts/web-install.sh web/demo
tools/dcb web make web-demo VERSION=18.6              # the Angular + TypeORM demo: build/wasm/18.6/demo/
tools/dcb web make test-wasm VERSION=18.6             # Chromium tests (Playwright) of the engine and the demo
tools/dc make package-wasm VERSION=18.6               # dist/compact-db-wasm-18.6.tar.gz
```

The node build comes first because the browser module is linked from a second build tree of the same sources (the
objects differ only in `PG_WASM_BROWSER`), and it packs the data files and the bootstrap data directory that the node
build made. The bootstrap data directory is made by the WebAssembly `initdb` running the WebAssembly `postgres`:
the on-disk layout of a data directory is specific to the architecture (wasm32 is not x86_64), so it cannot come from
the native build.

## Architecture

```
page                                   Worker (web/src/engine-worker.js)
 PostgresWasm (client.js)  --bytes-->   pgRead() ---> wasm: PostgresMain loop (upstream, unchanged)
   queue, transactions,    <--bytes--   pgWrite() <--- wasm: pq_flush
   SQLSTATE errors, types               IndexedDB store (idb-store.js) <--- fsync = commit barrier
```

* **Protocol through function calls.** The backend runs with its output set to "remote" and protocol 3, but the bytes do
  not go to a socket: `pq_recvbuf` asks JavaScript for the next bytes (`Module.pgRead`, a Promise) and `internal_flush`
  hands the output to `Module.pgWrite`. While the Promise is pending the WebAssembly stack is suspended (JavaScript
  Promise Integration, JSPI), so the main loop of PostgreSQL is used as it is and the Worker stays responsive. Any
  frontend that speaks the protocol works; the page API below is what applications use. (Patch `wasm/0007`.)
* **File system.** The engine's files live in the in-memory file system of the module (`/pgdata`). They are persisted
  to IndexedDB (below). `postgres.data` carries the data files (`share/`) and the bootstrap data directory, so a first
  start needs no initdb in the browser.
* **Single-user adaptations** (each is a patch with a header that says what was measured): System V shared memory as
  plain process memory (`0001`); no root check, no account database, so user name `postgres` (`0002`, `0004`);
  semaphores as counters, because the Emscripten stubs report success forever and `PGSemaphoreReset` never ended
  (`0005`); System V instead of POSIX dynamic shared memory, because an `mmap`ed shm file is written back by file
  descriptor number when unmapped, and the number had been reused for an index file (`0006`); `popen` for the
  build-time `initdb` (`0003`); no `locale -a` (`common/0003`).

## Page API

```js
import { PostgresWasm } from './lib/index.js';
const db = await PostgresWasm.open({
  workerUrl: 'worker/engine-worker.js', engineUrl: 'engine/postgres.mjs',
  storage: { name: 'mydb' },                 // omit for a memory-only database
});
const { rows, fields, rowCount, command } = await db.query('select $1::int + 1 as n', [41]);
await db.exec('create table t (id int); insert into t values (1)');     // several statements, one result each
await db.transaction(async (tx) => { await tx.query('update ...'); });  // owns the engine until it ends
const session = await db.connect();         // explicit session: raw BEGIN/COMMIT allowed; release() rolls back what is left open
await db.close();
```

* **Errors** are `PgError` with `code` (SQLSTATE), `severity`, `detail`, `hint`, `position`, `constraint`, `table`, ...
* **Types.** `bigint` and `numeric` come back as strings (exact; `{ types: { int8: 'bigint' } }` gives BigInt),
  `int2/int4/oid/float` as numbers, `bool` as boolean, `json/jsonb` parsed, `timestamp[tz]/date` as `Date` (microseconds
  are cut to milliseconds; `{ types: { rawTimestamps: true } }` keeps the text), `bytea` as `Uint8Array`, arrays of
  these as arrays, everything else as text. Parameters accept the same JavaScript types.
* **Ownership and queue.** One engine, one owner: a transaction or session owns the engine from start to end; calls from
  elsewhere wait in a FIFO queue and can never run inside it. `BEGIN`/`COMMIT`/`ROLLBACK`/savepoints through
  `db.query` are an error (`XX_OWNER`); a callback that throws rolls back; whatever a released session leaves open is
  rolled back, so the next caller starts clean.
* **node-postgres facade.** `createPgDriver(db)` returns an object with `Pool`, `Client` and `types` for libraries
  written for `pg`. A checked-out client owns the engine until `release()`, which is a pool of one connection.
  TypeORM: `new DataSource({ type: 'postgres', driver: createPgDriver(db), installExtensions: false, ... })`.

## Persistence

`storage: { name }` keeps the database in IndexedDB (`compactdb:<name>`).

* **Commit barrier.** PostgreSQL's durability contract is that `fsync` has returned when the data is stored: it fsyncs
  the WAL before a commit returns, data files at checkpoints, `pg_control` after them. In the browser build `fsync` and
  `fdatasync` call `Module.pgBarrier()` (patch `wasm/0008`), which writes everything changed since the previous barrier in
  one IndexedDB transaction with `durability: 'strict'` and resolves when the transaction has completed. A query
  that commits answers after the storage transaction finished; there is no deferred flush.
* **Consistency.** Every barrier stores all changed files together, so what is on disk is always a state the engine
  was really in, and PostgreSQL's own WAL recovery covers the time between barriers. Killing the Worker at any point
  leaves the previous or the new generation, never a mix.
* **Failure.** If the storage transaction fails (quota, storage error), `fsync` fails with EIO, PostgreSQL stops with
  PANIC, the pending call rejects with a `StorageError`-coded error and the instance is dead: reopen it. A commit that
  was not stored is never reported as done; recovery on reopen decides from what is stored.
* **One owner.** A Web Lock `compactdb:<name>` is held by the Worker; a second tab gets a `busy` error from `open()`.
* **Versions.** The stored database records storage format, PostgreSQL release and a hash of the feature profile; an
  engine of another release or profile refuses to open it (`incompatible`) and changes nothing.
* **Not covered:** data removed by the user (clearing site data, deleting the profile).

## Requirements and limits

* A browser with JavaScript Promise Integration: Chromium 137 or newer (tested with the Chromium of Playwright 1.64).
* No extensions, no `COPY` through the API, no replication, no background workers; checkpoints happen when the WAL
  reaches `max_wal_size` (16 MB here) and at close. See `docs/native.md` for the SQL profile.

## Releases

A tag is a PostgreSQL version. `git tag v18.6 && git push origin v18.6` runs `.github/workflows/release.yml`:
it checks that the tag names an upstream release this repository can build (`scripts/release-plan.js`), builds and tests
the WebAssembly module and the static image of that exact release, publishes `compact-db-wasm-18.6.tar.gz` with its
checksum as a GitHub release and the image to Docker Hub as `<DOCKERHUB_REPOSITORY>:18.6` (also `:18` when 18.6 is the newest 18.x,
`:latest` for the newest release overall). `DOCKERHUB_REPOSITORY` (variable) and `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`
(secrets) must be set; a tag build fails at once without them.

## Which releases the browser tests have run on

The 19 Chromium tests (`tools/dc make test-wasm VERSION=...`, run by `./builder.sh test <v> wasm`) are the gate for a release. Status:

| Release | Result |
| --- | --- |
| 18.6, 17.11, 16.15 | 19 of 19 |
| 12.22 | 18 of 19. **Known limit:** a runaway recursion (`f(100000)` in plpgsql) is meant to end with SQLSTATE 54001 and a running engine. On 12.22 the browser engine's native call stack is exhausted before PostgreSQL's own depth check fires (even at the smallest `max_stack_depth`, 100 kB), so the engine stops ("Maximum call stack size exceeded") instead. Fixing it needs a change in the engine, not a setting. |
| 9.6.24, 9.5.0, 9.4.0, 9.3.14, 9.2.0, 9.2.24, 9.1.24, 9.0.23 | 18 of 19, the same known limit as 12.22 |
| 9.0.0, 9.1.0 | 18 of 19 and 18 of 19: the offline demo test fails because of an **upstream bug of those two releases**, not of this build. `nextval()` does not WAL-log the first value of a new sequence (`if (log < fetch)` without `|| !seq->is_called`, fixed upstream in a later release), so after a crash in the same session the sequence hands out its first value a second time: the demo reloads the page right after its first note, inserts a second category and gets a duplicate key. 9.0.23 and 9.1.24 have the fix and pass like the rest; the releases in between were not run (the first minors of a major may or may not have it) |
| everything else | not run yet: `tools/scripts/overnight.sh --targets wasm` ([overnight.md](overnight.md)) produces the table |

What 9.x needed in the browser module (all found by running it, see the commit that added this row):

* The Worker's settings follow the release (`settingsFor()` in `demo/src/engine-worker.js`): before 9.5 there is no `max_wal_size` (`checkpoint_segments`
  instead), 9.5 and 9.6 count WAL size in 16 MB segments (`16MB` is 1, below the minimum of 2, and the engine stopped at start-up), before 9.4 there is
  no `dynamic_shared_memory_type` and no `postgresql.auto.conf` (the settings are kept at the end of `postgresql.conf`), and before 9.1 the default
  `wal_sync_method` writes WAL with `O_DSYNC` and never calls `fsync`, so the commit barrier would never run (`fdatasync` is set).
* Before 9.3 a build without spinlocks gives every LWLock and buffer header a semaphore of its own (`SpinlockSemas()`), thousands with the browser's
  16 MB of `shared_buffers`; the semaphore emulation of 9.0 to 9.2 (`0240-wasm-semaphores.patch`) had a fixed table of 256 sets and now grows.
* The demo counts finished notes with `count(case when ... end)` instead of `count(*) filter (where ...)` (FILTER is 9.4 and later).

Two things this run found and fixed, worth knowing when a release misbehaves in the browser: releases up to 14 need an empty `pg_stat_tmp`
in the data directory for crash recovery, and the Worker has to recreate the empty directories after it loads a stored database (they are
not stored); and the embedded-protocol patch has to reset `PqCommReadingMsg` in `pq_init_embedded()` on every release that has that
variable (all but 9.0.0 to 9.0.18, 9.1.0 to 9.1.14, 9.2.0 to 9.2.9, 9.3.0 to 9.3.5 and 9.4.0).
