# pg.lite

**PostgreSQL as one static executable in a `FROM scratch` image.** The real PostgreSQL, built from the official source with a few patches: about 15 MB (about 4.7 MB compressed), no shell, no loader, no other file. It reads the environment of the [official `postgres` image](https://hub.docker.com/_/postgres), so it can replace it for development, CI and tests.

Source, build scripts and the WebAssembly build: <https://github.com/neemle/pg.lite>

## Tags

| Tag | What it is |
| --- | --- |
| `9.1.0` (any release number) | exactly that PostgreSQL release and nothing else; the executable is compressed (about 4.7 MB) |
| `9.1.0-uncompressed` | the same release with the plain executable (about 15 MB), a start that is about 0.4 s faster |
| `9.0`, `9.1`, `9.2` | the newest release of that series built here |
| `9` | the newest 9.x built here |
| `latest` | the newest release built here |

Every release built here has its own tag: PostgreSQL 9.0.0 to 9.0.23, 9.1.0 to 9.1.24, 9.2.0 and newer, with more series on the way. The full list is on the Tags tab; what is built and tested for each release is in the table of the [README](https://github.com/neemle/pg.lite#versions). Platform: `linux/amd64`.

## Quick start

```sh
docker run -d --name pg -e POSTGRES_PASSWORD=change-me -v pgdata:/var/lib/postgresql/data -p 5432:5432 neemle/pg.lite:9.2.0
```

Arguments after the image name go to the server: `... neemle/pg.lite:9.2.0 -c max_connections=200`.

## Environment

The first start, with an empty data directory, reads the same variables as the official image:

| Variable | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | Password of the superuser. Required unless `POSTGRES_HOST_AUTH_METHOD=trust`. |
| `POSTGRES_USER` | Name of the superuser. Default `postgres`. |
| `POSTGRES_DB` | Database to create. Default: the user name. |
| `POSTGRES_INITDB_ARGS` | More options for `initdb` (they win over the defaults). |
| `POSTGRES_INITDB_WALDIR` | Directory of the WAL. |
| `POSTGRES_HOST_AUTH_METHOD` | Authentication of network connections (`md5` before 10, `scram-sha-256` from 10, or `trust`). |
| `PGDATA` | Data directory. Default `/var/lib/postgresql/data`. |
| `POSTGRES_PASSWORD_FILE`, `POSTGRES_USER_FILE`, `POSTGRES_DB_FILE`, `POSTGRES_INITDB_ARGS_FILE` | Read the value from a file (Docker secrets). |

Scripts in `/docker-entrypoint-initdb.d` run once after the first initialisation: `*.sql` files are run by a `psql` that is part of the executable; `*.sh` and compressed files are reported and skipped (there is no shell).

## What is different from the official image

* **No loadable extensions** (a static executable cannot load shared objects), no `COPY ... PROGRAM`, no shell-based `archive_command`. The `plpgsql` language, text search for every language and every encoding conversion are built in.
* **No shell in the image**, so `docker exec ... sh` and `*.sh` init scripts do not work.
* The default locale is `C.UTF-8`; use `POSTGRES_INITDB_ARGS` for another one.
* The server runs as user and group 70, the data directory is a volume, the container stops on `SIGINT` (fast shutdown).
* Meant for development, CI and tests; it is not tuned or hardened as a production database.

The data directory is the one of the PostgreSQL release: a cluster written by the official image of the same release opens here and the other way round.

## License

PostgreSQL License, the license of PostgreSQL itself. See <https://github.com/neemle/pg.lite/blob/main/LICENSE>.
