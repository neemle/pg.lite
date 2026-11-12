# pg.lite

**The real PostgreSQL, built very small, for development and nearly 95% of all apps.** pg.lite takes the official source of a PostgreSQL release, applies a small set of patches, and builds it as

* a **Docker image of 15 to 18 MB** (a little more with each newer series), or 4.7 to 7 MB with the packer (the official `postgres:16-alpine` image is about 420 MB): one static executable in a `FROM scratch` image, with no shell, no loader and no other file, and
* a **WebAssembly build** that runs PostgreSQL in the browser, in a Worker, with its data kept in IndexedDB.

It is meant for places where a full PostgreSQL install is more than you need: a CI database, a throw-away test or development database, an appliance image, an offline web app that wants real SQL. If you do not need extensions and the other extras of a full install, you get the same server in a fraction of the size.

## What it is, and what it is not

* **It is PostgreSQL.** The planner, executor, storage format, WAL and catalogs are the upstream's, untouched. A data directory written by the official image of the same release opens here and the other way round.
* **It is patches, not a fork.** This repository never contains PostgreSQL itself. The source of an exact release is downloaded at build time and checked against a pinned SHA-256, then the patches are applied.
* **It leaves out what a development database does not need.** A static executable cannot load shared objects, so there are no loadable extensions (the `plpgsql` language, the text-search stemmers of every language and every encoding conversion are built in), no `COPY ... PROGRAM`, and no shell-based `archive_command`. Pick a full PostgreSQL image if you need extensions. Backup and restore tools (`pg_dump`, `pg_restore`) are part of the `-full` images of 17 and later (below); `pg_dumpall` and `pg_basebackup` are in none.
* **It is for development and actually most apps that use postgres.** It is not hardened or tuned as a production database.

## How it is made small

* **One static executable.** The server, `initdb`, `psql`, the container entrypoint and the roughly 400 data files `initdb` reads are linked into a single musl executable, with the libraries the tools share (libpq and others) once; the data files are a tar image inside it, so nothing is extracted to disk.
* **Size-first compiler flags** (`-Os`, section garbage collection) and no code that the profile does not use.
* **A packer.** With `--pack` the executable is compressed with [xsfx](https://github.com/ratushnyi-labs/xsfx), a self-extracting packer: 15.3 MB become 4.7 MB (measured on 9.0.1) and 18.2 MB become 7.0 MB (measured on 17.11), at the price of a start that is about 0.4 s slower. A release publishes both: the compressed image has the plain tags (for example `17.11`, `17`, `latest`; `9.6.24`, `9.6`, `9` for the 9.x series), the one with the plain executable the same tags with `-uncompressed`.
* **WebAssembly** is built with Emscripten from the same patched source; the browser module is TypeScript with a `pg`-compatible facade (so ORMs such as TypeORM work on it).

## Versions

A git tag is a PostgreSQL version: `v18.6` is PostgreSQL 18.6 with these patches and nothing else. The table shows what is built and tested today; it grows with every release that is brought over.

| PostgreSQL | Image (`FROM scratch`) | WebAssembly (browser) | Notes |
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
| 9.1.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The sequence backport has a second 9.1 variant, because 9.1.3 added the page copy in sequence redo it builds on; the other patches apply unchanged. |
| 9.1.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.3 apply unchanged. |
| 9.1.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The sequence backport is not applied any more (9.1.5 has the fix itself); the other patches apply unchanged. |
| 9.1.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.5 apply unchanged. |
| 9.1.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.6 apply unchanged. |
| 9.1.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.7 apply unchanged. |
| 9.1.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.8 apply unchanged. |
| 9.1.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.9 apply unchanged. |
| 9.1.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.10 apply unchanged. |
| 9.1.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.11 apply unchanged. |
| 9.1.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.12 apply unchanged. |
| 9.1.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.13 apply unchanged. |
| 9.1.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.14 apply unchanged. |
| 9.1.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.15 apply unchanged. |
| 9.1.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.16 apply unchanged. |
| 9.1.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.17 apply unchanged. |
| 9.1.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.18 apply unchanged. |
| 9.1.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | Upstream added tar.o to the object list of src/port/Makefile, so the patch that adds noshell.o (0095) has a second 9.1 variant from this release on; the other patches apply unchanged. |
| 9.1.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.20 apply unchanged. |
| 9.1.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.21 apply unchanged. |
| 9.1.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.22 apply unchanged. |
| 9.1.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.1.23 apply unchanged. |
| 9.2.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the object lists of three Makefiles and the places in postgres.c that the embedded protocol patch changes have 9.2 variants; the other patches apply unchanged. |
| 9.2.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.0 apply unchanged. |
| 9.2.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.1 apply unchanged. |
| 9.2.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.2 apply unchanged. |
| 9.2.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.3 apply unchanged. |
| 9.2.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The first release with an arm64 image next to the amd64 one (built and tested natively on an arm64 runner). The same patches as 9.2.4 apply unchanged. |
| 9.2.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.5 apply unchanged. |
| 9.2.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.6 apply unchanged. |
| 9.2.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.7 apply unchanged. |
| 9.2.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | PostgreSQL 9.2.9 added the variable `do_check_root` to `main()`, so the root check in `main.c` (the WebAssembly build skips it; the one-file server hooks its start there) has a 9.2.9 variant; the earlier releases keep the sibling patch. |
| 9.2.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.9 apply unchanged. |
| 9.2.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.10 apply unchanged. |
| 9.2.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.11 apply unchanged. |
| 9.2.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.12 apply unchanged. |
| 9.2.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.13 apply unchanged. |
| 9.2.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | PostgreSQL 9.2.15 added `tar.o` to the object list of `src/port/Makefile`, so the patch that adds `noshell.o` there has a 9.2.15 variant; the earlier releases keep the sibling patch. |
| 9.2.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.15 apply unchanged. |
| 9.2.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.16 apply unchanged. |
| 9.2.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.17 apply unchanged. |
| 9.2.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.18 apply unchanged. |
| 9.2.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.19 apply unchanged. |
| 9.2.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.20 apply unchanged. |
| 9.2.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.21 apply unchanged. |
| 9.2.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.22 apply unchanged. |
| 9.2.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.2.23 apply unchanged. |
| 9.3.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the object lists of three Makefiles, the include hunks of initdb.c and exec.c and the places in postgres.c that the embedded protocol patch changes have 9.3 variants; the other patches apply unchanged. |
| 9.3.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.0 apply unchanged. |
| 9.3.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.1 apply unchanged. |
| 9.3.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.2 apply unchanged. |
| 9.3.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.3 apply unchanged. |
| 9.3.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.4 apply unchanged. |
| 9.3.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.5 apply unchanged. |
| 9.3.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.6 apply unchanged. |
| 9.3.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.7 apply unchanged. |
| 9.3.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.8 apply unchanged. |
| 9.3.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.9 apply unchanged. |
| 9.3.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.10 apply unchanged. |
| 9.3.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.11 apply unchanged. |
| 9.3.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.12 apply unchanged. |
| 9.3.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.13 apply unchanged. |
| 9.3.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.14 apply unchanged. |
| 9.3.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.15 apply unchanged. |
| 9.3.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.16 apply unchanged. |
| 9.3.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.17 apply unchanged. |
| 9.3.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.18 apply unchanged. |
| 9.3.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.19 apply unchanged. |
| 9.3.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.20 apply unchanged. |
| 9.3.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.21 apply unchanged. |
| 9.3.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.22 apply unchanged. |
| 9.3.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.23 apply unchanged. |
| 9.3.25 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.3.24 apply unchanged. |
| 9.4.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: exec.c moved to src/common, so the no-shell patch has a 9.4 variant; the user name of the WebAssembly build is patched in src/common/username.c and its root check in initdb.c has a 9.4 variant, as have the object list of src/port and the postgres.c hunks of the embedded protocol; the other patches apply unchanged. |
| 9.4.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.0 apply unchanged. |
| 9.4.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.1 apply unchanged. |
| 9.4.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.2 apply unchanged. |
| 9.4.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.3 apply unchanged. |
| 9.4.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.4 apply unchanged. |
| 9.4.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.5 apply unchanged. |
| 9.4.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.6 apply unchanged. |
| 9.4.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.7 apply unchanged. |
| 9.4.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.8 apply unchanged. |
| 9.4.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.9 apply unchanged. |
| 9.4.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.10 apply unchanged. |
| 9.4.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.11 apply unchanged. |
| 9.4.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.12 apply unchanged. |
| 9.4.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.13 apply unchanged. |
| 9.4.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.14 apply unchanged. |
| 9.4.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.15 apply unchanged. |
| 9.4.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.16 apply unchanged. |
| 9.4.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.17 apply unchanged. |
| 9.4.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.18 apply unchanged. |
| 9.4.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.19 apply unchanged. |
| 9.4.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.20 apply unchanged. |
| 9.4.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.21 apply unchanged. |
| 9.4.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.22 apply unchanged. |
| 9.4.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.23 apply unchanged. |
| 9.4.25 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.24 apply unchanged. |
| 9.4.26 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.4.25 apply unchanged. |
| 9.5.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the static-modules patch (dfmgr.c), the object lists of src/common and src/backend/port and the pqcomm.c hunks of the embedded protocol have 9.5 variants; the other patches apply unchanged. |
| 9.5.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.0 apply unchanged. |
| 9.5.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.1 apply unchanged. |
| 9.5.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.2 apply unchanged. |
| 9.5.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.3 apply unchanged. |
| 9.5.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.4 apply unchanged. |
| 9.5.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.5 apply unchanged. |
| 9.5.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.6 apply unchanged. |
| 9.5.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.7 apply unchanged. |
| 9.5.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.8 apply unchanged. |
| 9.5.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.9 apply unchanged. |
| 9.5.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.10 apply unchanged. |
| 9.5.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.11 apply unchanged. |
| 9.5.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.12 apply unchanged. |
| 9.5.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.13 apply unchanged. |
| 9.5.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.14 apply unchanged. |
| 9.5.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.15 apply unchanged. |
| 9.5.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.16 apply unchanged. |
| 9.5.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.17 apply unchanged. |
| 9.5.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.18 apply unchanged. |
| 9.5.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.19 apply unchanged. |
| 9.5.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.20 apply unchanged. |
| 9.5.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.21 apply unchanged. |
| 9.5.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.22 apply unchanged. |
| 9.5.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.23 apply unchanged. |
| 9.5.25 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.5.24 apply unchanged. |
| 9.6.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the object list of src/backend/port has no pg_latch.o any more, so the wasm port-objects patch has a 9.6 variant; the other patches apply unchanged. |
| 9.6.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.0 apply unchanged. |
| 9.6.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.1 apply unchanged. |
| 9.6.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.2 apply unchanged. |
| 9.6.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.3 apply unchanged. |
| 9.6.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.4 apply unchanged. |
| 9.6.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.5 apply unchanged. |
| 9.6.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.6 apply unchanged. |
| 9.6.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.7 apply unchanged. |
| 9.6.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.8 apply unchanged. |
| 9.6.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.9 apply unchanged. |
| 9.6.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.10 apply unchanged. |
| 9.6.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.11 apply unchanged. |
| 9.6.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.12 apply unchanged. |
| 9.6.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.13 apply unchanged. |
| 9.6.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.14 apply unchanged. |
| 9.6.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.15 apply unchanged. |
| 9.6.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.16 apply unchanged. |
| 9.6.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.17 apply unchanged. |
| 9.6.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.18 apply unchanged. |
| 9.6.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.19 apply unchanged. |
| 9.6.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.20 apply unchanged. |
| 9.6.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.21 apply unchanged. |
| 9.6.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.22 apply unchanged. |
| 9.6.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 9.6.23 apply unchanged. |
| 10.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: variants for 10 of the static-modules patch (dfmgr.c), the wasm port-objects and semaphore patches, the pqcomm.c hunks of the embedded protocol and (10.0 to 10.22) the shutdown walker; the other patches apply unchanged. |
| 10.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.0 apply unchanged. |
| 10.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.1 apply unchanged. |
| 10.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.2 apply unchanged. |
| 10.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.3 apply unchanged. |
| 10.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.4 apply unchanged. |
| 10.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.5 apply unchanged. |
| 10.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.6 apply unchanged. |
| 10.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.7 apply unchanged. |
| 10.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.8 apply unchanged. |
| 10.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.9 apply unchanged. |
| 10.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.10 apply unchanged. |
| 10.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.11 apply unchanged. |
| 10.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.12 apply unchanged. |
| 10.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.13 apply unchanged. |
| 10.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.14 apply unchanged. |
| 10.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.15 apply unchanged. |
| 10.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.16 apply unchanged. |
| 10.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.17 apply unchanged. |
| 10.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.18 apply unchanged. |
| 10.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.19 apply unchanged. |
| 10.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.20 apply unchanged. |
| 10.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.21 apply unchanged. |
| 10.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 10.22 apply unchanged. |
| 11.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the include hunk of the embedded protocol patch in pqcomm.c has an 11 variant; the other patches apply unchanged. |
| 11.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.0 apply unchanged. |
| 11.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.1 apply unchanged. |
| 11.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.2 apply unchanged. |
| 11.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.3 apply unchanged. |
| 11.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.4 apply unchanged. |
| 11.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.5 apply unchanged. |
| 11.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.6 apply unchanged. |
| 11.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.7 apply unchanged. |
| 11.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.8 apply unchanged. |
| 11.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.9 apply unchanged. |
| 11.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.10 apply unchanged. |
| 11.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.11 apply unchanged. |
| 11.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.12 apply unchanged. |
| 11.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.13 apply unchanged. |
| 11.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.14 apply unchanged. |
| 11.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.15 apply unchanged. |
| 11.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.16 apply unchanged. |
| 11.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.17 apply unchanged. |
| 11.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.18 apply unchanged. |
| 11.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.19 apply unchanged. |
| 11.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.20 apply unchanged. |
| 11.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 11.21 apply unchanged. |
| 12.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: variants for 12 of the static-modules patch, the object lists of src/common and src/backend/port and the root check of initdb (12.18 and 12.20 have further variants of the embedded protocol hunks); the other patches apply unchanged. |
| 12.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.0 apply unchanged. |
| 12.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.1 apply unchanged. |
| 12.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.2 apply unchanged. |
| 12.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.3 apply unchanged. |
| 12.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.4 apply unchanged. |
| 12.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.5 apply unchanged. |
| 12.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.6 apply unchanged. |
| 12.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.7 apply unchanged. |
| 12.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.8 apply unchanged. |
| 12.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.9 apply unchanged. |
| 12.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.10 apply unchanged. |
| 12.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.11 apply unchanged. |
| 12.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.12 apply unchanged. |
| 12.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.13 apply unchanged. |
| 12.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.14 apply unchanged. |
| 12.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.15 apply unchanged. |
| 12.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.16 apply unchanged. |
| 12.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.17 apply unchanged. |
| 12.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.18 apply unchanged. |
| 12.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.19 apply unchanged. |
| 12.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.20 apply unchanged. |
| 12.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 12.21 apply unchanged. |
| 13.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the object lists of the Makefiles are one object a line in 13, so the patches that add objects have 13 variants (and the static-modules patch another from 13.17); the single-binary patch and the postgres.c hunk of the embedded protocol have 13 variants too; the other patches apply unchanged. |
| 13.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.0 apply unchanged. |
| 13.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.1 apply unchanged. |
| 13.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.2 apply unchanged. |
| 13.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.3 apply unchanged. |
| 13.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.4 apply unchanged. |
| 13.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.5 apply unchanged. |
| 13.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.6 apply unchanged. |
| 13.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.7 apply unchanged. |
| 13.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.8 apply unchanged. |
| 13.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.9 apply unchanged. |
| 13.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.10 apply unchanged. |
| 13.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.11 apply unchanged. |
| 13.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.12 apply unchanged. |
| 13.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.13 apply unchanged. |
| 13.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.14 apply unchanged. |
| 13.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.15 apply unchanged. |
| 13.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.16 apply unchanged. |
| 13.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.17 apply unchanged. |
| 13.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.18 apply unchanged. |
| 13.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.19 apply unchanged. |
| 13.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.20 apply unchanged. |
| 13.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.21 apply unchanged. |
| 13.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 13.22 apply unchanged. |
| 14.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the object list of src/common, the in-memory dynamic shared memory of the WebAssembly build and the pqcomm.c hunks of the embedded protocol have 14 variants, and the shutdown walker patch applies to 14.0 to 14.5; the other patches apply unchanged. |
| 14.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.0 apply unchanged. |
| 14.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.1 apply unchanged. |
| 14.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.2 apply unchanged. |
| 14.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.3 apply unchanged. |
| 14.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.4 apply unchanged. |
| 14.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.5 apply unchanged. |
| 14.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.6 apply unchanged. |
| 14.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.7 apply unchanged. |
| 14.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.8 apply unchanged. |
| 14.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.9 apply unchanged. |
| 14.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.10 apply unchanged. |
| 14.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.11 apply unchanged. |
| 14.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.12 apply unchanged. |
| 14.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.13 apply unchanged. |
| 14.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.14 apply unchanged. |
| 14.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.15 apply unchanged. |
| 14.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.16 apply unchanged. |
| 14.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.17 apply unchanged. |
| 14.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.18 apply unchanged. |
| 14.20 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.19 apply unchanged. |
| 14.21 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.20 apply unchanged. |
| 14.22 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.21 apply unchanged. |
| 14.23 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.22 apply unchanged. |
| 14.24 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 14.23 apply unchanged. |
| 15.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: stack_base_ptr is private to postgres.c in 15, so the stack depth patch has a 15 variant that calls set_stack_base(); the static-modules patch has a 15 variant (the object list of the fmgr Makefile has no DLSUFFIX line after it); the other patches apply unchanged. |
| 15.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.0 apply unchanged. |
| 15.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.1 apply unchanged. |
| 15.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.2 apply unchanged. |
| 15.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.3 apply unchanged. |
| 15.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.4 apply unchanged. |
| 15.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.5 apply unchanged. |
| 15.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.6 apply unchanged. |
| 15.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.7 apply unchanged. |
| 15.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.8 apply unchanged. |
| 15.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.9 apply unchanged. |
| 15.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.10 apply unchanged. |
| 15.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.11 apply unchanged. |
| 15.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.12 apply unchanged. |
| 15.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.13 apply unchanged. |
| 15.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.14 apply unchanged. |
| 15.16 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.15 apply unchanged. |
| 15.17 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.16 apply unchanged. |
| 15.18 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.17 apply unchanged. |
| 15.19 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 15.18 apply unchanged. |
| 16.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the static-modules patch has a 16 variant (the link rule of src/backend/Makefile changed) and the wasm build script finds snowball_create.sql in the source tree, where 16 ships it; the other patches apply unchanged. |
| 16.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.0 apply unchanged. |
| 16.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.1 apply unchanged. |
| 16.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.2 apply unchanged. |
| 16.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.3 apply unchanged. |
| 16.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.4 apply unchanged. |
| 16.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.5 apply unchanged. |
| 16.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.6 apply unchanged. |
| 16.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.7 apply unchanged. |
| 16.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.8 apply unchanged. |
| 16.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.9 apply unchanged. |
| 16.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.10 apply unchanged. |
| 16.12 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.11 apply unchanged. |
| 16.13 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.12 apply unchanged. |
| 16.14 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.13 apply unchanged. |
| 16.15 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 16.14 apply unchanged. |
| 17.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the pqcomm.c hunks of the embedded protocol have a 17 variant (internal_flush_buffer casts the buffer); the other patches apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is ✅ built and tested. |
| 17.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.0 apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is ✅ built and tested. |
| 17.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.1 apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is ✅ built and tested. |
| 17.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.2 apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is ✅ built and tested. |
| 17.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.3 apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is ✅ built and tested. |
| 17.5 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.4 apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is ✅ built and tested. |
| 17.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.5 apply unchanged. The `-full` flavour (zlib, pg_dump, pg_restore) is 🚧 in progress. |
| 17.7 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.6 apply unchanged. |
| 17.8 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.7 apply unchanged. |
| 17.9 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.8 apply unchanged. |
| 17.10 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.9 apply unchanged. |
| 17.11 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 17.10 apply unchanged. |
| 18.0 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | A new series: the pqcomm.c hunks of the embedded protocol have an 18 variant (postmaster/postmaster.h is included in front of storage/ipc.h and the send buffer needs no cast); the other patches apply unchanged. PostgreSQL has no release 18.5. |
| 18.1 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 18.0 apply unchanged. |
| 18.2 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 18.1 apply unchanged. |
| 18.3 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 18.2 apply unchanged. |
| 18.4 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 18.3 apply unchanged. |
| 18.6 | ✅ built and tested | ✅ built and tested, 19 of 19 browser tests | The same patches as 18.4 apply unchanged. |

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

## Backup and restore: the `-full` image (17 and later)

From PostgreSQL 17 on every release also has a `-full` flavour: `18.6-full` (the executable compressed) and `18.6-uncompressed-full` (the plain executable), with the usual series tags (`18-full`, `latest-full`). It is the same server, built with zlib, and with `pg_dump` and `pg_restore` linked into the same single executable (`pg_dumpall` is not part of it: it starts `pg_dump` through a shell, which the image does not have). Measured on 17.11, that is 0.5 MB more for the plain executable (18.2 to 18.8 MB) and 0.3 MB more for the compressed one (7.0 to 7.2 MB). The image still holds one file.

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
* **The tests of the image** build it from scratch and check it end to end: cold `initdb`, SQL, restart, authentication, the environment of the official image, `initdb.d` scripts, encodings and text search, the image metadata, and that the image holds one file. The `-full` flavour is tested the same way, plus a dump and restore round trip in the custom and the directory format.
* **The tests of WebAssembly** run the engine under node, then in Chromium: the engine, persistence, offline use and the demo app. Each browser test leaves a Full HD video, step screenshots and an HTML report.
* **CI** runs the checks, the TypeScript checks (types, oxlint, vitest) and the build and tests of both products for every release the branch covers; the same files are built and tested once: merging a tested branch, tagging it, or changing only documentation reuses the earlier run (artifacts live 7 days), and a release tag publishes what that run built, the image to Docker Hub and the browser module as a GitHub release.

## Build

```sh
./builder.sh build 18.6 cli          # the one-file Docker image
./builder.sh test 18.6 cli
./builder.sh build 18.6 wasm         # node engine, browser module, demo
./builder.sh test 18.6 wasm
./builder.sh build 18.6 cli --pack   # the plain image and the one with the executable compressed
```

## License

PostgreSQL is released under the [PostgreSQL License](LICENSE), and so is this project: the license text here is the one of the upstream project.
