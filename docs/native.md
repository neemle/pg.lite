# Native build: static musl PostgreSQL in a FROM scratch image

PostgreSQL 18.6, built from the verified upstream tree plus three patches, linked fully statically
against musl, running from an image that contains no shell, no dynamic loader and no shared object.

## Build and run

```sh
./dc make fetch VERSION=18.6                 # verified upstream source (cache volume)
./dc make native-src VERSION=18.6            # apply patches/common + patches/native into build/native/18.6/src
./dcb musl make native-build VERSION=18.6    # configure, build, link static modules, install (resumable: RESUME=1)
./dcb musl make test-noshell VERSION=18.6    # unit tests of the shell-free spawn code
scripts/reference.sh image 18.6              # once: the dynamic reference image supplies psql as the external client
scripts/native-image.sh image 18.6           # assemble the context and build compactdb-native:18.6 (FROM scratch)
scripts/native-image.sh test 18.6            # cold init, SQL, modules, auth, restart, bad PGDATA
scripts/native-image.sh manifest 18.6        # file list + proof: no shell, no loader, no .so
scripts/native-image.sh up 18.6              # keep a server running on the private network (POSTGRES_PASSWORD is a test value)
```

First start with an empty volume mounted at `/var/lib/postgresql/data` and `POSTGRES_PASSWORD` set; the server
runs as uid 70 and the container stops with SIGINT (fast shutdown).

## The three problems a static server has and how each is solved (patches/native)

| Problem | Patch | Solution |
| --- | --- | --- |
| `dlopen()` does not exist in a static executable, but initdb runs `CREATE EXTENSION plpgsql` and the text search templates need `dict_snowball` | 0001 static-modules | `plpgsql` and `dict_snowball` are linked into `postgres` (object files combined with `ld -r`, entry points renamed with `objcopy`) and registered in a table that `load_external_function()`, `LOAD` and `lookup_external_function()` consult first. Any other library gets: *could not load library "x": this server is statically linked and cannot load external modules* with a hint naming the built-in modules. |
| initdb starts the server with `popen()`/`system()` and shell syntax; there is no `/bin/sh` | 0002 no-shell-spawn | a small interpreter (`src/common/noshell.c`) understands exactly what the callers write (words, quotes, backslash, `<`, `>`, `2>`, `2>&1`) and runs the program with `posix_spawn`. Pipes, `;`, `&`, `$`, backquotes, globs and subshells are refused with `EINVAL`, never run wrongly. |
| initdb imports libc collations by running `locale -a` | 0003 no-locale-a | not compiled in; the builtin collations (C, C.UTF-8, ucs_basic) are created as usual. |

All three are behind `PG_STATIC_MODULES` / `PG_NO_SHELL` (set by `build-native.sh`), so without those defines the code is upstream's.

Build-side facts worth knowing:
- `libpq.a` is not self-contained (it expects `pg_char_to_encoding`/`pg_encoding_to_char` from the shared libpq), so frontends
  that pull libpq objects (initdb through `fe_utils`) are linked with `docker/native/libpq_static_shim.c`, plain C that forwards the two
  names to the `_private` functions in `libpgcommon.a`.
- Parallel out-of-tree builds race on generated headers, so `make -C src/backend generated-headers` runs first.
- Only `postgres`, `initdb`, `pg_resetwal`, `pg_controldata` are built statically. `psql`, `pg_dump`, `pg_ctl` are libpq clients and not
  part of the runtime; use the reference build's dynamic copies as admin tools.
- The launcher (`docker/native/launcher.c`, static, 51 KB) is the entrypoint: cold init if `PGDATA` is empty, refuse (exit 1, touch nothing) if
  it is non-empty and not a cluster, then `exec` the server so it is PID 1.

## What is verified (18.6, this host)

- `scripts/check-static.sh` on every ELF file in the final image (3 since the slimming below; 5 before it, same files plus the two optional tools): no `PT_INTERP`, no `DT_NEEDED`, stripped (`postgres` 11,688,312 B,
  `initdb` 569,528 B, `pg-launcher` 51,072 B).
- `scripts/native-image.sh manifest`: 401 files, 13,908,357 bytes, no shell, no loader, no `.so` (`reports/native-image-files.txt`).
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
- Built and tested for 18.6 only; the 13-17 backport and older majors are separate items.

## What is in the image, why, and what can still go

Three programs are required, everything else is data for them:

| Program | Why it is there |
| --- | --- |
| `postgres` (11.7 MB) | the server. The postmaster, client backends, autovacuum, checkpointer, WAL writer and the rest are `fork()`s of this one file on Linux (no helper executables), so one binary covers every server role. |
| `initdb` (0.57 MB) | cold init on the first start, in the same image and without a shell (the requirement). Needed only until the cluster exists. |
| `pg-launcher` (51 KB) | the entrypoint that replaces the shell script of the official image: init if `PGDATA` is empty, refuse if it is not a cluster, then `exec` the server as PID 1. |

`pg_resetwal` and `pg_controldata` (284 KB together) are recovery and diagnostic tools, not needed to run the server. They were in the first
image by habit and are now removed; `WITH_TOOLS=1 scripts/native-image.sh image` builds `compactdb-native:18.6-tools` with them (the compatibility
test uses that variant for its control-file comparison). `errcodes.txt` (33 KB) is a build-time input that nothing reads at run time and is removed
too. Tested: the full native test and the 16-check compatibility test pass on the slim image (401 files, 13,908,357 bytes, 317,931 bytes less).

Files `initdb` opens from `share` (so they must stay for cold init): `postgres.bki`, `pg_hba.conf.sample`, `pg_ident.conf.sample`,
`postgresql.conf.sample`, `snowball_create.sql`, `information_schema.sql`, `sql_features.txt`, `system_constraints.sql`, `system_functions.sql`,
`system_views.sql`, plus `extension/plpgsql*` for `CREATE EXTENSION plpgsql`, `timezone/`, `timezonesets/` and `tsearch_data/`.

Not removed yet, with the honest estimate (none of these is tested):
- `postgres` itself is 94% of the executable bytes. Size flags (`-Os`, LTO, `--gc-sections`), dropping the exception tables, and a packer such as xsfx are the
  real levers (CDB-10); the data files total only about 1.6 MB.
- `timezonesets/` has 12 optional abbreviation sets besides `Default` (roughly 70 KB), selectable only through the `timezone_abbreviations` setting.
- `timezone/`: 341 files, 201 KB. Cutting zones would break `AT TIME ZONE` for the removed names, so it is kept.
- `initdb` and the ~1.3 MB of init-only SQL could move to a separate init image, but the task requires cold init in the same image.
