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

- `scripts/check-static.sh` on all 5 ELF files in the final image: no `PT_INTERP`, no `DT_NEEDED`, stripped (`postgres` 11,688,312 B,
  `initdb` 569,528 B, `pg-launcher` 51,072 B).
- `scripts/native-image.sh manifest`: 404 files, 14,226,288 bytes, no shell, no loader, no `.so` (`reports/native-image-files.txt`).
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
