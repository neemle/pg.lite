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
