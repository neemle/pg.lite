# compact.db

**PostgreSQL as a single file.** The same upstream PostgreSQL release, rebuilt so that it needs almost nothing around it:

* **A Docker image with one file in it.** `/usr/local/pgsql/bin/postgres`, a fully static musl executable, in a `FROM scratch` image: no shell,
  no dynamic loader, no shared object, no `/etc/passwd`, no second binary. The server, `initdb`, the container entrypoint
  and every data file `initdb` needs are linked into that one executable. About 10 MB, against about 430 MB for
  `postgres:18-alpine`. Details: [docs/native.md](tools/docs/native.md).
* **A browser module.** PostgreSQL compiled to WebAssembly, running in a Worker with its data in IndexedDB, with a JavaScript
  API and a `pg`-compatible facade (so TypeORM works on it). Details: [docs/wasm.md](tools/docs/wasm.md).

Both are **patches to the official source**, not a fork. This repository holds scripts, Dockerfiles and a set of patch
files; it never holds PostgreSQL itself. The source of an exact release is downloaded at build time and checked against the
SHA-256 pinned in [sources.lock.json](tools/sources.lock.json), then the patch series for that release is applied
([docs/patches.md](tools/docs/patches.md)).

## What it is for, and what it is not

It is for places where a normal PostgreSQL install is too much: a tiny container, a CI database, an appliance image, an
offline web app that wants real SQL. It is **the real PostgreSQL**: the planner, executor, storage format, WAL and catalogs
are upstream's, untouched. A cluster written by the official `postgres:18-alpine` opens in this build and the other way round
([docs/compat.md](tools/docs/compat.md)).

It is not a distribution of everything PostgreSQL can load. A static executable has no `dlopen()`, so the server has
`plpgsql`, the `snowball` English stemmer and the WAL receiver built in, and **no loadable extensions** (no PostGIS, no
`pg_stat_statements`, ...); `COPY ... PROGRAM` and shell-syntax `archive_command` are unavailable because there is no shell.
Conversions between UTF8 and other server encodings are not included. The full list is in [docs/native.md](tools/docs/native.md).

## Versions

A git tag is a PostgreSQL version: **`v18.6` is PostgreSQL 18.6**, with this repository's patches and nothing else. Every release
from 9.0 to 18.x (351 of them, `./builder.sh list`) is meant to be a drop-in replacement for the upstream release of the same
number.

| Major | Status |
| --- | --- |
| 18 | the baseline the patches are written against: builds and passes all tests (image, WebAssembly, browser) |
| 17 down to 9.0 | patches ported from 18 ([docs/patches.md](tools/docs/patches.md), [docs/ranges.md](tools/docs/ranges.md)); every release gets its patches from the cascading folders, and each one applies and the touched files compile ([reports/release-apply.json](tools/reports/release-apply.json)); the image is built and tested on 18.6, 17.11, 16.15, 14.24, 12.22, 10.23, 9.6.24, 9.2.24 and 9.0.23 |

Pushing a tag `vX.Y` runs [.github/workflows/release.yml](.github/workflows/release.yml): it builds and tests that exact release
and publishes the browser module as a GitHub release and the image to Docker Hub as `<DOCKERHUB_REPOSITORY>:X.Y` (also `:X` for
the newest X.y, `:latest` for the newest release overall). Set the repository variable `DOCKERHUB_REPOSITORY` and the secrets
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` first. "Run workflow" does a dry run of any version without publishing.

## Build

The host needs `docker` and `git`; nothing else runs on it. One script does the whole path, and it is the same on a laptop and in CI:

```sh
./builder.sh <patch|build|test> <version|latest> <cli|wasm> [options]
```

| Command | What it does |
| --- | --- |
| `patch` | downloads the upstream source of that exact release (SHA-256 checked) and applies the patches of that release to a copy of it |
| `build` | patch, then build: **cli** the static one-file server and its Docker image; **wasm** the engine, the browser module and the demo, packed as `tools/dist/compact-db-wasm-<version>.tar.gz` |
| `test` | the tests of what build made (it builds first if there is nothing yet) |

```sh
./builder.sh build 18.6 cli          # the one-file Docker image  ->  compactdb-native:18.6-min3
./builder.sh test 18.6 cli           # cold init, SQL, restart, authentication, bad data directory, one file in the image
./builder.sh build 18.6 wasm         # node engine + browser module + demo
./builder.sh test 18.6 wasm          # SQL under node, then Chromium tests of the engine, persistence, offline use and the demo
./builder.sh build latest cli        # the newest release; "latest" or a bare major (17) works in every command
./builder.sh patch 17.11 wasm        # only fetch and patch
./builder.sh list                    # every release that can be built
```

Options: `--test` (with build) tests right after, `--pack` compresses the image's executable with xsfx (about half the size, slower start), `--variant NAME` picks the compiler flavour
of the static build (default `min3`, the smallest), `--tag NAME` also tags the image. The cli tests use the unmodified upstream build of the same release as the external
client; it is built once and kept (set `CLIENT_IMAGE=postgres:18-alpine` to use an image you already have). Behind a TLS-inspecting proxy that breaks the download, set
`FETCH_HTTP_FALLBACK=1`: the pinned SHA-256 is still checked.

CI ([.github/workflows/release.yml](.github/workflows/release.yml)) runs exactly these commands for a tag: patch, build, test, then upload the archive
to the GitHub release and the image to Docker Hub.

Each step is also a `make` target run through `tools/dc` (tools container) or `tools/dcb <builder>` (musl, wasm, web, ref builders), see
[docs/build.md](tools/docs/build.md). First builds are slow (a builder image, then a full PostgreSQL build); a second build of another
release reuses the builder.

## Use

```sh
# first start: an empty volume, POSTGRES_PASSWORD set; the server runs as uid 70, the container stops on SIGINT (fast shutdown)
docker run -d --name pg -e POSTGRES_PASSWORD=change-me -v pgdata:/var/lib/postgresql/data -p 5432:5432 <org>/postgres:18.6
```

Environment: `POSTGRES_PASSWORD` (required for the first start), `POSTGRES_USER` (default `postgres`), `PGDATA`. Arguments after the
image name go to `postgres` (`... <image> -c max_connections=200`). A data directory that is not empty and not a cluster is refused
(exit 1) and left alone.

```js
// the browser module (Chromium 137+ for JavaScript Promise Integration); files from compact-db-wasm-18.6.tar.gz
import { PostgresWasm } from './lib/index.js';
const db = await PostgresWasm.open({ workerUrl: 'worker/engine-worker.js', engineUrl: 'engine/postgres.mjs', storage: { name: 'app' } });
const { rows } = await db.query('select $1::int + 1 as n', [41]);
```

The archive also contains a built demo: an Angular app that stores notes with TypeORM in the browser database (source in [web/demo](demo/demo)).

## How the one-file image works

A normal PostgreSQL install is a server, `initdb`, a few admin tools, a launcher script and a `share/` directory of data files. A
`FROM scratch` image has no shell to run the script and no loader to run dynamic programs. Four patches (in [patches/](patches), for
example [patches/18.6](patches/18.6)) make the single executable self-sufficient, each behind a build define so that without it the code is upstream's:

| Patch | Problem | Solution |
| --- | --- | --- |
| `0000-static-modules` | `dlopen()` does not exist in a static executable, but `initdb` runs `CREATE EXTENSION plpgsql` and text search needs `snowball` | `plpgsql` and `dict_snowball` are linked into `postgres` and registered in a table that the library loader consults first |
| `0100-no-shell-spawn` | `initdb` starts the server with `popen()`/`system()` and shell syntax | a small interpreter understands exactly what the callers write (words, quotes, redirections) and starts the program with `posix_spawn` |
| `0110-static-libpqwalreceiver` | streaming replication needs the WAL receiver, a loadable module | linked in too |
| **`0900-single-binary`** | `initdb` and the server read about 400 data files from `share/`; `initdb` and the entrypoint were separate programs | the `share/` tree is a tar image inside the executable, `initdb`, `pg_resetwal` and `pg_controldata` are linked in, and the executable is its own entrypoint |

How `0900-single-binary` works, in short (the patch adds one source file, `src/backend/main/embedded.c`, and two small hooks):

* **Data files.** The build installs PostgreSQL normally, packs the installed `share/` tree into a tar image and links it into
  `postgres` as read-only data. The linker redirects the C library calls the server and `initdb` make on files (`open`, `fopen`,
  `stat`, `opendir`, ... through `ld --wrap`) to a layer that answers paths below the share directory from the image and passes everything
  else through. Nothing in PostgreSQL had to change for that, and nothing is extracted to disk.
* **Programs.** `initdb`, `pg_resetwal` and `pg_controldata` are ordinary frontend programs. Their objects and the frontend libraries they
  link are combined into one object each, their `main` is renamed, and every other symbol is made local, so they cannot clash with the
  server's own functions of the same names. `postgres --initdb`, `--resetwal` and `--controldata` run them in the same file.
* **Entrypoint.** `postgres --launcher` does what the official image's shell script does: initialise `PGDATA` on the first start (the
  password goes to `initdb` through memory, never to a file), refuse a directory that is not a cluster, then carry on as the server, which
  therefore is PID 1 and receives the container's signals. The Dockerfile's entrypoint is `["/usr/local/pgsql/bin/postgres", "--launcher"]`.
* **No `/etc/passwd`.** A user id without a passwd entry gets a synthesized one, which `initdb` and the server need to learn who they run as.

The image therefore contains `/usr/local/pgsql/bin/postgres`, an empty `/tmp` (the Unix socket) and the empty data directory. `tools/scripts/native-image.sh manifest`
proves it: exactly one file, and no shell, loader or shared object.

## Layout

| Path | What is there |
| --- | --- |
| `README.md`, `LICENSE`, `builder.sh` | this file, the licence, and the one command that patches, builds and tests the image and the WebAssembly module |
| `patches/` | the patches to PostgreSQL, in folders that cascade: `patches/` holds what every release takes, `patches/12/` what the 12.x releases take, `patches/12/12.4-12.9/` what differs for those releases. A release takes the patches along its path, applied in the order of their four-digit numbers; `0900-single-binary.patch` is the wrapper that links everything into one executable ([how](tools/docs/patches.md)) |
| `demo/` | the WebAssembly side: the browser module (`src/`: Worker, IndexedDB storage, `pg` facade) and the Angular + TypeORM demo app (`demo/`) |
| `tools/` | everything that builds and checks, see [tools/README.md](tools/README.md): `scripts/`, `docker/` (builder images and what goes into the final image), `tests/`, `docs/` ([native](tools/docs/native.md), [wasm](tools/docs/wasm.md), [build](tools/docs/build.md), [patches](tools/docs/patches.md), [ranges](tools/docs/ranges.md), [compat](tools/docs/compat.md), [production tests](tools/docs/production-tests.md), [size experiments](tools/docs/size-experiments.md)), the lock files (`sources.lock.json` pins every release's SHA-256, `ranges.json` says how releases differ), and `dc`/`dcb`, which run any command in the project's containers |

## Tests

* `tools/dc make selftest`: repository checks, no network.
* `./builder.sh test <v> cli`: cold init in the scratch image as uid 70, SQL from an external client, `plpgsql`, text search, the error for an
  unknown module, wrong password rejected, data survives a restart, a bad data directory is refused, the image holds one file.
* `tools/scripts/compat-test.sh <v>`: the same data directory is opened alternately by the official image and this one ([docs/compat.md](tools/docs/compat.md)).
* `tools/scripts/native-production-test.sh <v>`: concurrency, crash recovery, replication and load, under a read-only root file system and tight limits
  ([docs/production-tests.md](tools/docs/production-tests.md)).
* `./builder.sh test <v> wasm`: SQL under node, then Chromium tests of the engine, persistence, offline use and the demo.

## Licence

This repository (scripts, Dockerfiles, patches, the web module and the demo) is under the [MIT License](LICENSE). PostgreSQL itself is under
the PostgreSQL License ([licenses/postgresql](tools/licenses/postgresql)); it is not part of this repository, and the images and archives built from
it contain PostgreSQL code under that licence. Third-party material used here is listed in [THIRD_PARTY.md](tools/THIRD_PARTY.md).
