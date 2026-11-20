<p align="center"><img src="docs/logo.svg" alt="pg.lite" width="360"></p>

# pg.lite

[![ci](https://github.com/neemle/pg.lite/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/neemle/pg.lite/actions/workflows/ci.yml)
[![Docker pulls](https://img.shields.io/docker/pulls/neemle/pg.lite?logo=docker&label=docker%20pulls)](https://hub.docker.com/r/neemle/pg.lite)
[![Docker image size](https://img.shields.io/docker/image-size/neemle/pg.lite/latest?logo=docker&label=image%20size)](https://hub.docker.com/r/neemle/pg.lite/tags)
[![Docker version](https://img.shields.io/docker/v/neemle/pg.lite?sort=semver&logo=docker&label=docker%20tag)](https://hub.docker.com/r/neemle/pg.lite/tags)
[![WebAssembly module downloads](https://img.shields.io/github/downloads/neemle/pg.lite/total?logo=github&label=wasm%20downloads)](https://github.com/neemle/pg.lite/releases)
[![Latest release](https://img.shields.io/github/v/release/neemle/pg.lite?logo=github&label=release)](https://github.com/neemle/pg.lite/releases/latest)
[![License](https://img.shields.io/github/license/neemle/pg.lite?label=license)](LICENSE)

**The real PostgreSQL, built very small, for development and nearly 95% of all apps.** pg.lite takes the official source of a PostgreSQL release, applies a small set of patches, and builds it as

* a **Docker image of 15 to 18 MB** (a little more with each newer series), or 4.7 to 7 MB with the packer (the official `postgres:16-alpine` image is about 420 MB): one static executable in a `FROM scratch` image, with no shell, no loader and no other file, and
* a **WebAssembly build** that runs PostgreSQL in the browser, in a Worker, with its data kept in IndexedDB.

It is meant for places where a full PostgreSQL install is more than you need: a CI database, a throw-away test or development database, an appliance image, an offline web app that wants real SQL. If you do not need extensions and the other extras of a full install, you get the same server in a fraction of the size.

## What it is, and what it is not

* **It is PostgreSQL.** The planner, executor, storage format, WAL and catalogs are the upstream's, untouched. A data directory written by the official image of the same release opens here and the other way round.
* **It is patches, not a fork.** This repository never contains PostgreSQL itself. The source of an exact release is downloaded at build time and checked against a pinned SHA-256, then the patches are applied.
* **It leaves out what a development database does not need.** A static executable cannot load shared objects, so there are no loadable extensions (the `plpgsql` language, the text-search stemmers of every language and every encoding conversion are built in), no `COPY ... PROGRAM`, and no shell-based `archive_command`. Pick a full PostgreSQL image if you need extensions. Backup and restore tools (`pg_dump`, `pg_restore`) are part of the `-full` images of 17 and later (below); `pg_dumpall` and `pg_basebackup` are in none.
* **It is for development and actually most apps that use postgres.** It is not hardened or tuned as a production database.
* **The two newest major versions are supported:** now 19 and 18. New features, such as the health check, are made for them, and they get the patches of every new minor release. Earlier majors are not supported: the images already published stay as they are, nothing new is added to them, and we recommend upgrading to a supported major version.

## How it is made small

* **One static executable.** The server, `initdb`, `psql`, the container entrypoint (and, from 17, the health check) and the roughly 400 data files `initdb` reads are linked into a single musl executable, with the libraries the tools share (libpq and others) once; the data files are a tar image inside it, so nothing is extracted to disk.
* **Size-first compiler flags** (`-Os`, section garbage collection) and no code that the profile does not use.
* **A packer.** With `--pack` the executable is compressed with [xsfx](https://github.com/ratushnyi-labs/xsfx), a self-extracting packer: 15.3 MB become 4.7 MB (measured on 9.0.1) and 18.2 MB become 7.0 MB (measured on 17.11), at the price of a start that is about 0.4 s slower. A release publishes both: the compressed image has the plain tags (for example `17.11`, `17`, `latest`; `9.6.24`, `9.6`, `9` for the 9.x series), the one with the plain executable the same tags with `-uncompressed`.
* **WebAssembly** is built with Emscripten from the same patched source; the browser module is TypeScript with a `pg`-compatible facade (so ORMs such as TypeORM work on it).

## Versions

A git tag is a PostgreSQL version: `v18.7` is PostgreSQL 18.7 with these patches and nothing else. Every release is built and tested as a Docker image and as a WebAssembly module before it is published.

The full table, one row per release from 9.0.0 on, with the patches that each series and release needed, is in [docs/VERSIONS.md](docs/VERSIONS.md).

✅ built and tested · 🚧 in progress · ⬜ planned. The image is for Linux: `linux/amd64` for every release, and from 9.2.5 on also `linux/arm64` (one multi-platform tag, so it runs on Apple silicon and other ARM machines too; upstream PostgreSQL has native aarch64 support from 9.2.5). Each platform is built and tested on its own runner.

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

## Docker Compose and the health check (17 and later)

The image has no shell, so the usual health check of a PostgreSQL service, `["CMD-SHELL", "pg_isready -U postgres"]`, cannot run in it: there is neither a shell nor a `pg_isready`. From PostgreSQL 17 on the executable has the check built in:

```sh
postgres --healthcheck [pg_isready options]
```

It is `pg_isready`, linked into the executable (about the size of one small object), with the defaults of the image: the user and the database of `POSTGRES_USER` and `POSTGRES_DB` (the `_FILE` forms too; `postgres` and the user name when they are not set), and the server where libpq looks for it, `PGHOST` and `PGPORT` (the socket in `/tmp` and port 5432 unless set). Options after `--healthcheck` go to `pg_isready` and win over the defaults (`-p 5433`, `-t 2`, ...). The exit status is what Docker expects: `0` when the server accepts connections, `1` in every other case (rejecting connections, for example during start-up or shutdown, no response, nothing to attempt). Docker reserves the status 2, which is why the plain `pg_isready` codes (0 to 3) are not passed on. The line it prints, for example `/tmp:5432 - accepting connections`, is kept by Docker: `docker inspect --format '{{json .State.Health}}' <container>`. The server of the first start, the one that runs the `/docker-entrypoint-initdb.d` scripts, listens on a socket inside the data directory only, so the check does not report it as healthy: the service becomes healthy when the real server is up. `postgres --pg_isready [options]` is the plain `pg_isready` with its own options and exit codes, for other uses.

Because there is no shell, the check is written in the **exec form**, `["CMD", ...]`, with the full path of the executable.

### The official PostgreSQL 18 in Compose, for comparison

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql          # from 18 on the volume is this directory; the data is in 18/docker below it
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

volumes:
  pgdata:
```

### pg.lite in Compose

```yaml
services:
  db:
    image: neemle/pg.lite:18.7
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data     # PGDATA of the image, declared as a volume
      - ./initdb:/docker-entrypoint-initdb.d:ro   # optional: *.sql files only, there is no shell for *.sh
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD", "/usr/local/pgsql/bin/postgres", "--healthcheck"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s

  app:
    image: your/app
    environment:
      DATABASE_URL: postgres://app:change-me@db:5432/app
    depends_on:
      db:
        condition: service_healthy          # start the app when the database accepts connections

volumes:
  pgdata:
```

```sh
docker compose up -d --wait      # returns when every service with a healthcheck is healthy
docker compose ps                # STATUS shows "healthy"
docker compose exec db /usr/local/pgsql/bin/postgres --healthcheck   # the check by hand: prints the line and sets the status
```

What differs from the official service above:

| | official `postgres:18` | `neemle/pg.lite:18.7` |
| --- | --- | --- |
| Health check | `["CMD-SHELL", "pg_isready -U app -d app"]` | `["CMD", "/usr/local/pgsql/bin/postgres", "--healthcheck"]` (no shell, user and database are read from the environment of the service) |
| Volume | `/var/lib/postgresql` (from 18; before 18 `/var/lib/postgresql/data`) | `/var/lib/postgresql/data` (`PGDATA` of the image) |
| Init scripts in `/docker-entrypoint-initdb.d` | `*.sql`, `*.sh`, compressed files | `*.sql` only; the others are reported and skipped |
| User of the server | `postgres` (uid 999) | uid 70; a bind-mounted data directory must belong to it |
| Extensions, `COPY ... PROGRAM` | yes | no (see [What it is](#what-it-is-and-what-it-is-not)) |
| Environment (`POSTGRES_*`, `_FILE` forms, arguments after the image name) | yes | the same |

Things to know:

* **The environment of the service is the environment of the check.** If the service sets `POSTGRES_USER` and `POSTGRES_DB`, the check uses them, so the server does not log a failed connection of an unknown role. If you start the server on another port (`command: ["-p", "5433"]` or `-c port=5433`), tell the check the same: `test: ["CMD", "/usr/local/pgsql/bin/postgres", "--healthcheck", "-p", "5433"]`.
* **`start_period`** gives the first start (the `initdb`, the init scripts) time without counting failed checks. The image does not set a `HEALTHCHECK` of its own, so a plain `docker run` shows no health status; add the `healthcheck:` of the Compose file, or `HEALTHCHECK CMD ["/usr/local/pgsql/bin/postgres", "--healthcheck"]` in a Dockerfile that builds on this image.
* **Releases before 17 do not get the health check, and will not.** Only the two newest major versions (now 19 and 18) are supported, and the patch is not backported to older ones. Upgrade to 17 or later.
* **No `psql` on the `PATH` of the image either**; it is part of the executable: `docker compose exec db /usr/local/pgsql/bin/postgres --psql -U app -d app`.

## Backup and restore: the `-full` image (17 and later)

From PostgreSQL 17 on every release also has a `-full` flavour: `18.7-full` (the executable compressed) and `18.7-uncompressed-full` (the plain executable), with the usual series tags (`18-full`, `latest-full`). It is the same server, built with zlib, and with `pg_dump` and `pg_restore` linked into the same single executable (`pg_dumpall` is not part of it: it starts `pg_dump` through a shell, which the image does not have). Measured on 17.11, that is 0.5 MB more for the plain executable (18.2 to 18.8 MB) and 0.3 MB more for the compressed one (7.0 to 7.2 MB). The image still holds one file.

The tools are started through the executable, like `psql`; they connect to a server over the network, with the usual options and `PG*` variables:

```sh
# a compressed dump (custom format) of a running container "pg" on the network "net", into ./backup (the image runs as user 70)
docker run --rm --network net --user 70 -e PGPASSWORD=change-me -v "$PWD/backup:/backup" \
  --entrypoint /usr/local/pgsql/bin/postgres neemle/pg.lite:18-full \
  --pg_dump -h pg -U postgres -Fc -f /backup/db.dump postgres

# and the restore into another database (-j N restores with N workers)
docker run --rm --network net --user 70 -e PGPASSWORD=change-me -v "$PWD/backup:/backup:ro" \
  --entrypoint /usr/local/pgsql/bin/postgres neemle/pg.lite:18-full \
  --pg_restore -h pg -U postgres -d newdb /backup/db.dump
```

The dump formats are the upstream's: plain SQL, custom (`-Fc`, compressed with zlib), directory (`-Fd`, also with `-j`) and tar. The image tests of the `-full` flavour dump a database in the custom and the directory format and restore both. The WebAssembly build has no such tools.

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
* **The tests of the image** build it from scratch and check it end to end: cold `initdb`, SQL, restart, authentication, the environment of the official image, `initdb.d` scripts, encodings and text search, the image metadata, and that the image holds one file; from 17 on also the health check, alone and as the `healthcheck:` of a Compose service that becomes healthy. The `-full` flavour is tested the same way, plus a dump and restore round trip in the custom and the directory format.
* **The tests of WebAssembly** run the engine under node, then in Chromium: the engine, persistence, offline use and the demo app. Each browser test leaves a Full HD video, step screenshots and an HTML report.
* **CI** runs the checks, the TypeScript checks (types, oxlint, vitest) and the build and tests of both products for every release the branch covers; the same files are built and tested once: merging a tested branch, tagging it, or changing only documentation reuses the earlier run (artifacts live 7 days), and a release tag publishes what that run built, the image to Docker Hub and the browser module as a GitHub release.

## Build

```sh
./builder.sh build 18.7 cli          # the one-file Docker image
./builder.sh test 18.7 cli
./builder.sh build 18.7 wasm         # node engine, browser module, demo
./builder.sh test 18.7 wasm
./builder.sh build 18.7 cli --pack   # the plain image and the one with the executable compressed
```

## License

This project is released under the [MIT License](LICENSE). The borrowed patches keep the license of their source, listed in [`tools/THIRD_PARTY.md`](tools/THIRD_PARTY.md).
