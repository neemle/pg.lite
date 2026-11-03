# pg.lite

**The real PostgreSQL, built very small, for development and nearly 95% of all apps.** pg.lite takes the official source of a PostgreSQL release, applies a small set of patches, and builds it as

* a **Docker image of about 11 MB**, or 2.3 MB with the packer (an official Alpine PostgreSQL image is about 430 MB): one static executable in a `FROM scratch` image, with no shell, no loader and no other file, and
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
* **A packer.** With `--pack` the executable is compressed with [xsfx](https://github.com/ratushnyi-labs/xsfx), a self-extracting packer: 10.7 MB become 2.3 MB (measured on 9.0.0), at the price of a start that is about 0.4 s slower. A release publishes both: the compressed image has the plain tags (`9.0.0`, `9.0`, `9`, `latest`), the one with the plain executable the same tags with `-uncompressed`.
* **WebAssembly** is built with Emscripten from the same patched source; the browser module is TypeScript with a `pg`-compatible facade (so ORMs such as TypeORM work on it).

## Versions

A git tag is a PostgreSQL version: `v9.0.0` is PostgreSQL 9.0.0 with these patches and nothing else. The table shows what is built and tested today; it grows with every release that is brought over.

| PostgreSQL | x86-64 image (`FROM scratch`) | WebAssembly (browser) | Notes |
| --- | --- | --- | --- |
| 9.0.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The fix of the crash-safety bug of new sequences (PostgreSQL 9.0.9) is backported, because a browser database can be killed at any time. |
| 9.0.1 – 9.0.23 | ⬜ next | ⬜ next | |
| 9.1 – 9.6 | ⬜ planned | ⬜ planned | |
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
patches/     the patches to PostgreSQL; the header of each says whether it is for both products, the image or WebAssembly
scripts/     what both products share: fetching and checking the source, applying the patches (shell only)
tools/       the build containers, the list of releases and the settings of the release
```

* **Everything runs in Docker.** The host needs only `docker` and `git`; sources and build trees live in Docker volumes.
* **The tests of the image** build it from scratch and check it end to end: cold `initdb`, SQL, restart, authentication, the environment of the official image, `initdb.d` scripts, encodings and text search, the image metadata, and that the image holds one file.
* **The tests of WebAssembly** run the engine under node, then in Chromium: the engine, persistence, offline use and the demo app. Each browser test leaves a Full HD video, step screenshots and an HTML report.
* **CI** runs the checks, the TypeScript checks (types, oxlint, vitest) and the build and tests of both products for every release the branch covers; the same files are built and tested once: merging a tested branch, tagging it, or changing only documentation reuses the earlier run (artifacts live 7 days), and a release tag publishes what that run built, the image to Docker Hub and the browser module as a GitHub release.

## Build

```sh
./builder.sh build 9.0.0 cli          # the one-file Docker image
./builder.sh test 9.0.0 cli
./builder.sh build 9.0.0 wasm         # node engine, browser module, demo
./builder.sh test 9.0.0 wasm
./builder.sh build 9.0.0 cli --pack   # the plain image and the one with the executable compressed
```

## License

PostgreSQL is released under the [PostgreSQL License](LICENSE), and so is this project: the license text here is the one of the upstream project.
