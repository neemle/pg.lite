# Native build: static musl PostgreSQL in a FROM scratch image

PostgreSQL 18.6, built from the verified upstream tree plus the patches in `patches/common` and `patches/native`, linked fully statically
against musl, running from an image that contains **one file**: `/usr/local/pgsql/bin/postgres`. No shell, no dynamic loader, no shared object, no `/etc/passwd`.
The server, `initdb`, `pg_resetwal`, `pg_controldata`, the container entrypoint and the `share/` data files are all inside that executable (patch 0006, below).

## Build and run

```sh
./builder.sh build 18.6 cli                     # all of the steps below, in one command (./builder.sh test 18.6 cli tests it)

# the steps, one by one:
tools/dc make fetch VERSION=18.6                 # verified upstream source (cache volume)
tools/dc make native-src VERSION=18.6            # apply patches/common + patches/native into build/native/18.6/src
tools/dcb musl make native-build VERSION=18.6    # configure, build, link static modules, install (resumable: RESUME=1)
tools/dcb musl make test-noshell VERSION=18.6    # unit tests of the shell-free spawn code
scripts/reference.sh image 18.6              # once: the dynamic reference image supplies psql as the external client
scripts/native-image.sh image 18.6           # assemble the context (one file) and build compactdb-native:18.6 (FROM scratch)
scripts/native-image.sh test 18.6            # cold init, SQL, modules, auth, restart, bad PGDATA
scripts/native-image.sh manifest 18.6        # file list + proof: no shell, no loader, no .so
scripts/native-image.sh up 18.6              # keep a server running on the private network (POSTGRES_PASSWORD is a test value)
```

First start with an empty volume mounted at `/var/lib/postgresql/data` and `POSTGRES_PASSWORD` set; the server
runs as uid 70 and the container stops with SIGINT (fast shutdown).

## The problems a static, shell-less server has and how each is solved (patches/common, patches/native)

| Problem | Patch | Solution |
| --- | --- | --- |
| `dlopen()` does not exist in a static executable, but initdb runs `CREATE EXTENSION plpgsql` and the text search templates need `dict_snowball` | 0001 static-modules | `plpgsql` and `dict_snowball` are linked into `postgres` (object files combined with `ld -r`, entry points renamed with `objcopy`) and registered in a table that `load_external_function()`, `LOAD` and `lookup_external_function()` consult first. Any other library gets: *could not load library "x": this server is statically linked and cannot load external modules* with a hint naming the built-in modules. |
| initdb starts the server with `popen()`/`system()` and shell syntax; there is no `/bin/sh` | 0002 no-shell-spawn | a small interpreter (`src/common/noshell.c`) understands exactly what the callers write (words, quotes, backslash, `<`, `>`, `2>`, `2>&1`) and runs the program with `posix_spawn`. Pipes, `;`, `&`, `$`, backquotes, globs and subshells are refused with `EINVAL`, never run wrongly. |
| initdb imports libc collations by running `locale -a` | 0003 no-locale-a | not compiled in; the builtin collations (C, C.UTF-8, ucs_basic) are created as usual. |

| a scratch image has no second file for `initdb`, the launcher and `share/` | 0006 embedded-image | see "One file" below |

All of them are behind `PG_STATIC_MODULES` / `PG_NO_SHELL` / `PG_EMBEDDED_IMAGE` (set by `build-native.sh`), so without those defines the code is upstream's.

Build-side facts worth knowing:
- `libpq.a` is not self-contained (it expects `pg_char_to_encoding`/`pg_encoding_to_char` from the shared libpq), so frontends
  that pull libpq objects (initdb through `fe_utils`) are linked with `docker/native/libpq_static_shim.c`, plain C that forwards the two
  names to the `_private` functions in `libpgcommon.a`.
- Parallel out-of-tree builds race on generated headers, so `make -C src/backend generated-headers` runs first.
- Only `postgres`, `initdb`, `pg_resetwal`, `pg_controldata` are built statically. `psql`, `pg_dump`, `pg_ctl` are libpq clients and not
  part of the runtime; use the reference build's dynamic copies as admin tools.
- The entrypoint is `postgres --launcher` (in `embedded.c`, see "One file"): cold init if `PGDATA` is empty, refuse (exit 1, touch nothing) if it is non-empty and not a cluster, then continue as the server so it is PID 1.

## What is verified (18.6, this host)

- `scripts/check-static.sh` on every ELF file in the final image (one): no `PT_INTERP`, no `DT_NEEDED`, stripped (`postgres` 10,038,784 B with `initdb`, the
  tools and the 2.2 MB data image inside).
- `scripts/native-image.sh manifest`: one file (`/usr/local/pgsql/bin/postgres`), no shell, no loader, no `.so` (`reports/native-image-files-min3.txt`).
- `scripts/native-image.sh test`: cold init as uid 70 in the scratch image; `SELECT 1` from an external client container; `PostgreSQL 18.6 on
  x86_64-pc-linux-musl`; UTF8, UTC, builtin provider; a plpgsql function; snowball stemming (foxes -> fox); `LOAD` of an unknown library gives the
  clear error and the server keeps answering; wrong SCRAM password rejected; data survives a restart on the same volume; a non-empty,
  non-cluster `PGDATA` is refused (exit 1) with its file intact.
- `tests/native/noshell-test.c`: 25 of 25 (quotes, redirections, 2>&1, pipes in both modes, exit status, refused syntax).

## Known differences and limits (not hidden)

- `datcollate` is `C` on musl (musl has no collation locales; `setlocale(LC_COLLATE, "C.UTF-8")` reports `C`), while the glibc reference reports
  `C.UTF-8`. The database uses the builtin provider with locale `C.UTF-8` in both, so text ordering is the same; this is a catalog-value difference.
- Not loadable: conversions between UTF8 and other encodings, any extension with a shared library. Not available without a shell: `COPY ... PROGRAM`,
  `archive_command` with shell syntax.
- **Not done yet:** two concurrent sessions with row locks and isolation (N07), crash/recovery after a confirmed commit (N08), the shared SQL corpus
  on this build (N09), upstream regression and isolation suites, size/startup/memory measurements, sizes of the compressed image layer.
- Built and image-tested for 18.6, 17.11 and 16.15 (the same `native-image.sh test`; the patches of 17 and 16 are ported from 18, see
  patches.md; the one-file image has also passed that test on 14.24, 12.22, 10.23, 9.6.24, 9.2.24 and 9.0.23). The builtin locale provider exists from 17 on: the entrypoint passes it only to releases that have it
  (17 and later), 16 uses the libc provider with the same `C.UTF-8` name.

## One file (patch 0006)

The image used to hold three programs (`postgres`, `initdb`, `pg-launcher`) and about 400 data files. It now holds `/usr/local/pgsql/bin/postgres` and nothing else
(plus two empty directories: `/tmp` for the Unix socket and the data directory the volume mounts over).

| Part | How it is inside `postgres` |
| --- | --- |
| `share/` data files (`postgres.bki`, the SQL scripts `initdb` runs, `timezone/`, `timezonesets/`, `tsearch_data/`, the `plpgsql` extension files) | a ustar image of the installed `share/` tree (without `errcodes.txt`, a build-time input), linked in as read-only data. `ld --wrap` redirects `open`, `fopen`, `stat`, `lstat`, `access`, `opendir`, `readdir`, `rewinddir`, `closedir` to `src/backend/main/embedded.c`, which answers every path below the share directory the server computes (`get_share_path`) from the image, and the empty `pkglib` directory the postmaster insists on. Reads are served from an anonymous memory file (`memfd_create`); other paths go to the C library. |
| `initdb`, `pg_resetwal`, `pg_controldata` | each program's objects plus the frontend libraries it links are combined with `ld -r` into one object, `main` is renamed (`embedded_initdb_main`, ...) and all other symbols are made local, so the frontend copies of `src/common` and `src/port` cannot clash with the server's. `postgres --initdb`, `--resetwal` and `--controldata` run them. `initdb` starts the server by running the same file with `--boot` / `--single` (it finds it through `argv[0]`, so the executable must be called `postgres`). |
| entrypoint (was `pg-launcher`) | `postgres --launcher [postgres options]`: PGDATA has `PG_VERSION` → start; empty → `initdb` in a child process (password through an in-memory file, never on disk), append `listen_addresses`, UTC and the password rule to the configuration, start; neither → refuse, exit 1, touch nothing. It then continues as the server in the same process, so the server is PID 1. |
| `/etc/passwd` | `getpwuid`/`getpwuid_r` are wrapped: when the C library finds no entry for the effective user id, one is made (name `$POSTGRES_USER`, default `postgres`). |

Costs and limits, not hidden: error messages from the embedded tools are prefixed `postgres:` (they share `argv[0]`); reading a data file copies it into a
memory file (the largest is the 1 MB `postgres.bki`, read once per `initdb`); a kernel or sandbox that forbids `memfd_create` cannot run it (Docker's default
profile allows it, and the xsfx packer needs the same call); the executable must be named `postgres`, and sit in a directory of its own (releases before 13 find their own path by changing into its directory, which fails for `/postgres`), so the image puts it at `/usr/local/pgsql/bin/postgres`.

Measured for 18.6 (variant `min3`): `image/postgres` is 10,038,784 bytes; `scripts/native-image.sh manifest` reports one file and no shell, loader or shared object;
`scripts/native-image.sh test` passes (cold init as uid 70, SQL from an external client, plpgsql, text search, unknown-module error, wrong password, restart,
refused data directory).

## What else could still go

Not removed yet, with the honest estimate (none of these is tested):
- `postgres` itself is 94% of the executable bytes. Size flags (`-Os`, LTO, `--gc-sections`), dropping the exception tables, and a packer such as xsfx are the
  real levers (CDB-10); the data files total only about 1.6 MB.
- `timezonesets/` has 12 optional abbreviation sets besides `Default` (roughly 70 KB), selectable only through the `timezone_abbreviations` setting.
- `timezone/`: 341 files, 201 KB. Cutting zones would break `AT TIME ZONE` for the removed names, so it is kept.
- `initdb` and the ~1.3 MB of init-only SQL could move to a separate init image, but the task requires cold init in the same image.
