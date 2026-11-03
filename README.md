# pg.lite

**The real PostgreSQL, built very small, for development and nearly 95% of all apps.** pg.lite takes the official PostgreSQL source of a release, applies a small set of patches, and builds it as

* a **Docker image of about 10 MB** (the official `postgres:18-alpine` is about 430 MB): one static executable in a `FROM scratch` image, with no shell, no loader and no other file, and
* a **WebAssembly build** that runs PostgreSQL in the browser, in a Worker, with its data kept in IndexedDB.

It is meant for places where a full PostgreSQL install is more than you need: a CI database, a throw-away test or development database, an appliance image, an offline web app that wants real SQL. If you do not need extensions and the other extras of a full install, you get the same server in a fraction of the size.

## What it is, and what it is not

* **It is PostgreSQL.** The planner, executor, storage format, WAL and catalogs are the upstream's, untouched. A data directory written by the official image opens here and the other way round.
* **It is patches, not a fork.** This repository never contains PostgreSQL itself. The source of an exact release is downloaded at build time and checked against a pinned SHA-256, then the patches for that release are applied.
* **It leaves out what a development database does not need.** A static executable cannot load shared objects, so there are no loadable extensions (the `plpgsql` language, the text-search stemmers of every language and every encoding conversion are built in), no `COPY ... PROGRAM`, and no shell-based `archive_command`. Pick a full PostgreSQL image if you need extensions.
* **It is for development and actually most apps that use postgres.** It is not hardened or tuned as a production database.

## How it is made small

* **One static executable.** The server, `initdb`, the container entrypoint and the roughly 400 data files `initdb` reads are linked into a single musl executable; the data files are a tar image inside it, so nothing is extracted to disk.
* **Size-first compiler flags** (`-Os`, LTO, section garbage collection) and no code that the profile does not use.
* **A packer.** With `--pack` the executable is compressed with [xsfx](https://github.com/ratushnyi-labs/xsfx), a self-extracting packer, which about halves the image again (measured: 9.5 MB of image content became 4.5 MB) at the price of a slower start (about 330 ms for each start of the server).
* **WebAssembly** is built with Emscripten from the same patched source; the browser module has a JavaScript API and a `pg`-compatible facade (so ORMs such as TypeORM work on it).

## What is in this repository

* **Build scripts.** `builder.sh <patch|build|test> <version> <cli|wasm>` downloads a release, patches it, and builds the image or the WebAssembly module. Everything runs in Docker; the host needs only `docker` and `git`.
* **Patches**, in folders that cascade by release (all releases, one major, a series, a span of minor releases), so a patch lives once and each release gets exactly the ones it needs. Releases from 9.0 to 18.x are covered.
* **Tests that show the patches are correct**: every patch is checked for its header and for applying to the release it is meant for; the image is tested end to end (cold `initdb`, SQL, restart, authentication, refusal of a bad data directory, one file in the image); the WebAssembly build is tested under node and in Chromium (engine, persistence, offline use, a demo app); and a long-running script builds and tests every release and writes a Markdown report.

## Versions

A git tag is a PostgreSQL version: `v18.6` is PostgreSQL 18.6 with these patches and nothing else. The table shows what is built and tested today; it grows with every release that is brought over.

| PostgreSQL | x86-64 image (`FROM scratch`) | WebAssembly (browser) | Notes |
| --- | --- | --- | --- |
| 9.0.0 | ✅ built and tested | ✅ built, 18 of 19 browser tests | The 19th test (offline use of the demo) fails because of a bug of the upstream 9.0.0 itself (the first value of a new sequence is not WAL-logged); it is kept as upstream has it. |
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

## Build

```sh
./builder.sh build 18.6 cli          # the one-file Docker image
./builder.sh test 18.6 cli
./builder.sh build 18.6 wasm         # node engine, browser module, demo
./builder.sh test 18.6 wasm
./builder.sh build 18.6 cli --pack   # the same image with the executable packed
```

## License

PostgreSQL is released under the [PostgreSQL License](LICENSE), and so is this project: the license text here is the one of the upstream project.
