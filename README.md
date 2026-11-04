# pg.lite

**The real PostgreSQL, built very small, for development and nearly 95% of all apps.** pg.lite takes the official source of a PostgreSQL release, applies a small set of patches, and builds it as

* a **Docker image of about 15 MB**, or 4.7 MB with the packer (an official Alpine PostgreSQL image is about 430 MB): one static executable in a `FROM scratch` image, with no shell, no loader and no other file, and
* a **WebAssembly build** that runs PostgreSQL in the browser, in a Worker, with its data kept in IndexedDB.

It is meant for places where a full PostgreSQL install is more than you need: a CI database, a throw-away test or development database, an appliance image, an offline web app that wants real SQL. If you do not need extensions and the other extras of a full install, you get the same server in a fraction of the size.

## What it is, and what it is not

* **It is PostgreSQL.** The planner, executor, storage format, WAL and catalogs are the upstream's, untouched. A data directory written by the official image of the same release opens here and the other way round.
* **It is patches, not a fork.** This repository never contains PostgreSQL itself. The source of an exact release is downloaded at build time and checked against a pinned SHA-256, then the patches are applied.
* **It leaves out what a development database does not need.** A static executable cannot load shared objects, so there are no loadable extensions (the `plpgsql` language, the text-search stemmers of every language and every encoding conversion are built in), no `COPY ... PROGRAM`, and no shell-based `archive_command`. Pick a full PostgreSQL image if you need extensions.
* **It is for development and actually most apps that use postgres.** It is not hardened or tuned as a production database.

## How it is made small

* **One static executable.** The server, `initdb`, `psql`, the container entrypoint and the roughly 400 data files `initdb` reads are linked into a single musl executable, with the libraries the tools share (libpq and others) once; the data files are a tar image inside it, so nothing is extracted to disk.
* **Size-first compiler flags** (`-Os`, section garbage collection) and no code that the profile does not use.
* **A packer.** With `--pack` the executable is compressed with [xsfx](https://github.com/ratushnyi-labs/xsfx), a self-extracting packer: 15.3 MB become 4.7 MB (measured on 9.0.0), at the price of a start that is about 0.4 s slower. A release publishes both: the compressed image has the plain tags (for example `9.0.1`, `9.0`, `9`, `latest`), the one with the plain executable the same tags with `-uncompressed`.
* **WebAssembly** is built with Emscripten from the same patched source; the browser module is TypeScript with a `pg`-compatible facade (so ORMs such as TypeORM work on it).

## Versions

A git tag is a PostgreSQL version: `v9.1.3` is PostgreSQL 9.1.3 with these patches and nothing else. The table shows what is built and tested today; it grows with every release that is brought over.

| PostgreSQL | x86-64 image (`FROM scratch`) | WebAssembly (browser) | Notes |
| --- | --- | --- | --- |
| 9.0.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The fix of the crash-safety bug of new sequences (PostgreSQL 9.0.9) is backported, because a browser database can be killed at any time. |
| 9.0.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.0 apply unchanged. |
| 9.0.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.0 apply unchanged. |
| 9.0.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.0 apply unchanged. |
| 9.0.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.0 apply unchanged. |
| 9.0.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The sequence backport has a second variant, because 9.0.5 added the code it builds on; the other patches apply unchanged. |
| 9.0.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.0 apply unchanged. |
| 9.0.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The sequence backport has a third variant, because 9.0.7 added the page copy in sequence redo it builds on; the other patches apply unchanged. |
| 9.0.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The browser build needs one more patch from this release on (0290): 9.0.8 no longer sets the reference point of the stack depth check in a stand-alone backend, so a runaway recursion ended the engine instead of failing with 54001. |
| 9.0.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The sequence backport is not applied any more (9.0.9 has the fix itself); the stack depth patch (0290) of 9.0.8 stays; the other patches apply unchanged. |
| 9.0.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.0.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.0.9 apply unchanged. |
| 9.1.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the object lists of three Makefiles, the protocol bytes in pqcomm.c (9.1 allocates the send buffer, which the embedded engine has to do itself) and the sequence backport (the commit of the 9.1 branch) have 9.1 variants; the other patches apply unchanged. |
| 9.1.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.0 apply unchanged. |
| 9.1.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.1 apply unchanged. |
| 9.1.3 | 🚧 in progress | 🚧 in progress | The sequence backport has a second 9.1 variant, because 9.1.3 added the page copy in sequence redo it builds on; the other patches apply unchanged. |
| 9.1.4 – 9.1.24 | ⬜ next | ⬜ next | |
| 9.2 – 9.6 | ⬜ planned | ⬜ planned | |
| 10 – 17 | ⬜ planned | ⬜ planned | |
| 18 | ⬜ planned | ⬜ planned | |

✅ built and tested · 🚧 in progress · ⬜ planned. The image is for Linux on x86-64.

## Configuration of the image

The environment of the [official `postgres` image](https://hub.docker.com/_/postgres) works, from 9.0.0 on. A small launcher at the start of the executable reads it and passes it on to `initdb` and to the server; it is used on the first start, when the data directory is empty.

| Variable | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | Password of the superuser. Required on the first start, unless `POSTGRES_HOST_AUTH_METHOD=trust`. |
| `POSTGRES_USER` | Name of the superuser. Default `postgres`. |
| `POSTGRES_DB` | Database created on the first start. Default: the value of `POSTGRES_USER`. |
| `POSTGRES_INITDB_ARGS` | More options for `initdb`, split like a shell does (quotes work). They come last, so they win over the defaults. |
| `POSTGRES_INITDB_WALDIR` | Directory of the WAL (`--xlogdir` before 10, `--waldir` from 10). |
| `POSTGRES_HOST_AUTH_METHOD` | Authentication of network connections. Default `md5` before 10 and `scram-sha-256` from 10. `trust` needs no password and prints the same warning as the official image. |
| `PGDATA` | Data directory. Default `/var/lib/postgresql/data`. |
| `POSTGRES_PASSWORD_FILE`, `POSTGRES_USER_FILE`, `POSTGRES_DB_FILE`, `POSTGRES_INITDB_ARGS_FILE` | Read the value from a file (Docker secrets). Giving both the variable and its `_FILE` is an error. |

Without a password and without `trust` the container stops with the message of the official image. The scripts of `/docker-entrypoint-initdb.d` run once after the first initialisation: `*.sql` files are run by the `psql` that is part of the executable; `*.sh` files and compressed files are reported and skipped, because the image has no shell. The default locale is `C.UTF-8` (the official image uses `en_US.utf8`); set another one with `POSTGRES_INITDB_ARGS`.

The image runs as user and group 70 (build arguments `PG_UID` and `PG_GID`), declares the data directory as a volume, exposes port 5432 and stops on `SIGINT` (a fast shutdown). It carries the OCI labels (version, commit, source, license) and the environment `PG_VERSION`, `PG_MAJOR` and `PGDATA`.

## What is in this repository

```
builder.sh   one entry point: ./builder.sh <patch|build|test> <version> <cli|wasm>
image/       the Docker image: building the static server and the image, the files that go into it, its tests
wasm/        WebAssembly: building the module, the TypeScript module (src/), the Angular demo with TypeORM (demo/), its tests
patches/     the patches to PostgreSQL; the header of each says whether it is for both products, the image or WebAssembly, and for which releases
scripts/     what both products share: fetching and checking the source, applying the patches (shell only)
tools/       the build containers, the list of releases and the settings of the release
```

* **Everything runs in Docker.** The host needs only `docker` and `git`; sources and build trees live in Docker volumes.
* **The tests of the image** build it from scratch and check it end to end: cold `initdb`, SQL, restart, authentication, the environment of the official image, `initdb.d` scripts, encodings and text search, the image metadata, and that the image holds one file.
* **The tests of WebAssembly** run the engine under node, then in Chromium: the engine, persistence, offline use and the demo app. Each browser test leaves a Full HD video, step screenshots and an HTML report.
* **CI** runs the checks, the TypeScript checks (types, oxlint, vitest) and the build and tests of both products for every release the branch covers; the same files are built and tested once: merging a tested branch, tagging it, or changing only documentation reuses the earlier run (artifacts live 7 days), and a release tag publishes what that run built, the image to Docker Hub and the browser module as a GitHub release.

## Build

```sh
./builder.sh build 9.1.3 cli          # the one-file Docker image
./builder.sh test 9.1.3 cli
./builder.sh build 9.1.3 wasm         # node engine, browser module, demo
./builder.sh test 9.1.3 wasm
./builder.sh build 9.1.3 cli --pack   # the plain image and the one with the executable compressed
```

## License

PostgreSQL is released under the [PostgreSQL License](LICENSE), and so is this project: the license text here is the one of the upstream project.
