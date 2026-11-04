# pg.lite

**PostgreSQL as one static executable in a `FROM scratch` image.** The real PostgreSQL, built from the official source with a few patches: about 15 MB (about 4.7 MB compressed), no shell, no loader, no other file. It reads the environment of the [official `postgres` image](https://hub.docker.com/_/postgres), so it can replace it for development, CI and tests.

Source, build scripts and the WebAssembly build: <https://github.com/neemle/pg.lite>

## Tags

| Tag | PostgreSQL | Executable |
| --- | --- | --- |
| `9.1.13` | 9.1.13 | compressed (about 4.7 MB) |
| `9.1.12` | 9.1.12 | compressed |
| `9.1.11` | 9.1.11 | compressed |
| `9.1.10` | 9.1.10 | compressed |
| `9.1.9` | 9.1.9 | compressed |
| `9.1.8` | 9.1.8 | compressed |
| `9.1.7` | 9.1.7 | compressed |
| `9.1.6` | 9.1.6 | compressed |
| `9.1.5` | 9.1.5 | compressed |
| `9.1.4` | 9.1.4 | compressed |
| `9.1.3` | 9.1.3 | compressed |
| `9.1.2` | 9.1.2 | compressed |
| `9.1.1` | 9.1.1 | compressed |
| `9.1.0` | 9.1.0 | compressed |
| `9.0.23` | 9.0.23 | compressed |
| `9.0.22` | 9.0.22 | compressed |
| `9.0.21` | 9.0.21 | compressed |
| `9.0.20` | 9.0.20 | compressed |
| `9.0.19` | 9.0.19 | compressed |
| `9.0.18` | 9.0.18 | compressed |
| `9.0.17` | 9.0.17 | compressed |
| `9.0.16` | 9.0.16 | compressed |
| `9.0.15` | 9.0.15 | compressed |
| `9.0.14` | 9.0.14 | compressed |
| `9.0.13` | 9.0.13 | compressed |
| `9.0.12` | 9.0.12 | compressed |
| `9.0.11` | 9.0.11 | compressed |
| `9.0.10` | 9.0.10 | compressed |
| `9.0.9` | 9.0.9 | compressed |
| `9.0.8` | 9.0.8 | compressed |
| `9.0.7` | 9.0.7 | compressed |
| `9.0.6` | 9.0.6 | compressed |
| `9.0.5` | 9.0.5 | compressed |
| `9.0.4` | 9.0.4 | compressed |
| `9.0.3` | 9.0.3 | compressed |
| `9.0.2` | 9.0.2 | compressed |
| `9.0.1` | 9.0.1 | compressed |
| `9.0.0` | 9.0.0 | compressed |
| `9.0` | the newest 9.0.x built here | compressed |
| `9.1` | the newest 9.1.x built here | compressed |
| `9` | the newest 9.x built here | compressed |
| `latest` | the newest release built here | compressed |
| `9.1.13-uncompressed`, `9.1.12-uncompressed`, `9.1.11-uncompressed`, `9.1.10-uncompressed`, `9.1.9-uncompressed`, `9.1.8-uncompressed`, `9.1.7-uncompressed`, `9.1.6-uncompressed`, `9.1.5-uncompressed`, `9.1.4-uncompressed`, `9.1.3-uncompressed`, `9.1.2-uncompressed`, `9.1.1-uncompressed`, `9.1.0-uncompressed`, `9.0.23-uncompressed`, `9.0.22-uncompressed`, `9.0.21-uncompressed`, `9.0.20-uncompressed`, `9.0.19-uncompressed`, `9.0.18-uncompressed`, `9.0.17-uncompressed`, `9.0.16-uncompressed`, `9.0.15-uncompressed`, `9.0.14-uncompressed`, `9.0.13-uncompressed`, `9.0.12-uncompressed`, `9.0.11-uncompressed`, `9.0.10-uncompressed`, `9.0.9-uncompressed`, `9.0.8-uncompressed`, `9.0.7-uncompressed`, `9.0.6-uncompressed`, `9.0.5-uncompressed`, `9.0.4-uncompressed`, `9.0.3-uncompressed`, `9.0.2-uncompressed`, `9.0.1-uncompressed`, `9.0.0-uncompressed`, `9.0-uncompressed`, `9.1-uncompressed`, `9-uncompressed` | the same releases | plain (about 15 MB) |

One tag is one PostgreSQL release, nothing else. The executable of the default tags is compressed with a self-extracting packer: the image is about a third of the size and a start is about 0.4 s slower; the `-uncompressed` tags hold the same server without it. Platform: `linux/amd64`.

## Quick start

```sh
docker run -d --name pg -e POSTGRES_PASSWORD=change-me -v pgdata:/var/lib/postgresql/data -p 5432:5432 neemle/pg.lite:9.1.13
```

Arguments after the image name go to the server: `... neemle/pg.lite:9.1.13 -c max_connections=200`.

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
