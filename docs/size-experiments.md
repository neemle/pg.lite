# Shrinking the static server: measured experiments (PostgreSQL 18.6, musl, x86_64)

Question: how small can the static `postgres` executable get without changing what it does? Every variant below was
built from the same patched tree (`patches/native` 0001-0003), passes `scripts/native-image.sh test` (cold init, SQL, modules,
SCRAM, restart, bad PGDATA), and the three that were also run through `scripts/compat-test.sh` pass all 16 checks.

Presets are chosen with `VARIANT=<name> ./dcb musl sh -c "scripts/build-native.sh 18.6"`; the output goes to
`build/native/18.6-<name>`, the image to `compactdb-native:18.6-<name>` (`VARIANT=<name> scripts/native-image.sh image 18.6`).

## Where the 11.9 MB of the plain build were

| Section | Bytes | Is it code? |
| --- | ---: | --- |
| `.text` | 6,528,156 | yes |
| `.rodata` | 2,351,056 | constant data (tables, strings) |
| `.eh_frame` + `.eh_frame_hdr` | 1,052,540 | no: C++-style unwind tables, PostgreSQL uses `sigsetjmp`/`longjmp` instead |
| `.rela.dyn` | 570,192 | no: 23,758 relocations of a position-independent executable |
| `.dynsym` + `.dynstr` + `.gnu.hash` | 587,637 | no: all symbols exported for a dynamic loader (`--export-dynamic`) that a static server never has |
| `.data.rel.ro`, `.data`, `.bss` | 869,168 | data |

About 2.2 MB (19%) was not code at all.

## The variants

| Preset | Flags (on top of `-fno-asynchronous-unwind-tables -fno-unwind-tables -ffunction-sections -fdata-sections`) | `postgres` (stripped) | `initdb` | Image content |
| --- | --- | ---: | ---: | ---: |
| plain | `-O2`, PIE, `--export-dynamic`, no gc | 11,688,312 | 569,528 | 13,908,357 (measured) |
| `gc` | `-O2`, `-Wl,--gc-sections`, non-PIE, no `--export-dynamic` | 9,377,272 (-19.8%) | 187,672 | 11,215,461 (computed) |
| `ospie` | `-Os`, `--gc-sections`, **PIE kept**, no `--export-dynamic` | 8,329,304 (-28.7%) | 184,048 | 10,163,869 (computed) |
| `os` | `-Os`, `--gc-sections`, non-PIE, no `--export-dynamic` | **7,759,512 (-33.6%)** | 171,288 | **9,581,317 (-31.1%, measured)** |
| `oslto` | as `os` plus `-flto=auto` | 7,624,184 (-34.8%) | 171,320 | 9,446,021 (computed) |

"Image content" is the sum of the files in the image (`scripts/native-image.sh manifest`). The computed values add the measured
binary differences to the measured plain total; the method reproduces the measured `os` figure to the byte. The first three
fixes (no unwind tables, no `--export-dynamic`, non-PIE) alone cut 1.3 MB from the plain objects when only relinked.

What remains in the `os` binary: `.text` 4,890,419, `.rodata` 2,264,368, `.data.rel.ro` 485,392, `.bss` 274,192, `.data` 106,984 (8.0 MB of sections).

## Speed (indicative, one machine)

`scripts/bench.sh`: fresh container and volume, `pgbench` from a second container over TCP, scale 5, 4 clients, 10 s runs, median of 3.
Medians per pass, transactions per second; two passes (the second in the reverse order):

| Image | select-only, pass 1 / 2 | TPC-B-like, pass 1 / 2 | start to first SQL |
| --- | --- | --- | --- |
| plain | 17,929 / 16,182 | 1,490 / 1,429 | 3.1-3.4 s |
| `gc` | 16,705 / 15,910 | 1,464 / 1,363 | 3.1-3.3 s |
| `os` | 16,274 / 15,889 (third run 16,388) | 1,360 / 1,384 (1,420) | 3.1-3.2 s |
| `ospie` | 15,726 | 1,442 | 3.3 s |
| `oslto` | 15,946 / 14,911 | 1,400 / 1,413 | 3.2-3.4 s |
| official `postgres:18-alpine` | 16,111 | 1,388 | 4.6 s |

Reading it honestly: the same image varies by up to about 10% between runs on this host (Docker Desktop on Windows), and the second pass was
slower overall, so only differences larger than that mean anything. The averages of the two passes put `-Os` about 5-6% below `-O2` on
CPU-bound select-only and within noise on the write-heavy test (disk and `fsync` dominate it); LTO shows no gain in speed or meaningful size.
All of them are in the range of the official image.

## Tradeoffs of each lever

- **No unwind tables** (`-fno-asynchronous-unwind-tables -fno-unwind-tables`, -1.05 MB): no stack unwinding or `backtrace()`-style crash traces. PostgreSQL's error handling does not use them; musl has no `backtrace()` anyway.
- **No `--export-dynamic`** (-0.59 MB): nothing can `dlopen()` into a static server, so no effect.
- **`--gc-sections`**: drops unreferenced functions; the builtin function table keeps most SQL functions alive, so the saving is moderate on `postgres` and large on `initdb` (570 KB to 171-188 KB).
- **Non-PIE static** (-0.57 MB): the executable image loads at a fixed address, so it loses address-space randomization. This is a hardening reduction, which the task asks to preserve, so `ospie` exists: it costs 569,792 bytes (7.3%) and keeps PIE. Pick `os` only if that loss is acceptable.
- **`-Os`** (-1.6 MB over `-O2`): the largest single code-size lever; costs the few percent of CPU-bound speed above.
- **LTO**: only 135,328 bytes better than `os`, no speed gain, and a build that takes about five minutes longer; not worth it. It also forces the two static modules to be built without LTO because `ld -r` plus `objcopy` cannot rename symbols inside LTO bytecode.

Recommendation: `ospie` as the release candidate (28.7% smaller, hardening kept, correctness verified), `os` where ASLR does not matter and every byte does. Not chosen: `oslto`.

## What else is in the binary (not yet tried, estimates from object sizes of the `os` build, before gc)

| Subsystem | Text + data |
| --- | ---: |
| `parser` (grammar tables) | 1.18 MB |
| `utils/adt` (data types and functions) | 1.07 MB |
| `commands` | 0.66 MB |
| `snowball` (stemmers for about 25 languages) | 0.50 MB |
| `nodes`, `executor`, `catalog`, `access/transam` | 0.38, 0.32, 0.24, 0.22 MB |
| GIN, GiST, SP-GiST access methods | 63, 50, 48 KB |

So removing index access methods buys little, while keeping only the English stemmer (about 0.45 MB, needs the snowball Makefile and `snowball_create.sql` generation changed) and cutting
unused data types from `utils/adt` (geometric, network, XML-adjacent, ranges, ...) are the next real levers; each needs the dependency closure checked (CDB-10). A packer such as xsfx (measured below) would
compress the whole 7.8-8.3 MB.

## Second round: the levers beyond compiler flags (all on top of `ospie`, so PIE and its hardening are kept)

| Preset | What it adds | `postgres` (stripped) | vs `ospie` | vs plain | Image content |
| --- | --- | ---: | ---: | ---: | ---: |
| `ospie` | (round one) | 8,329,304 | | -28.7% | 10,163,869 (computed) |
| `min1` | patch 0004: only the English Snowball stemmer, stop-word list and text search configuration | 7,575,640 | -753,664 (-9.0%) | -35.2% | |
| `min2` | `-ffile-prefix-map` for the source and build directories: shorter `__FILE__` strings in error reports, and the build path no longer ends up in the binary (reproducibility) | 7,559,256 | -16,384 | -35.3% | |
| `min3` | `--without-zlib` (gzip base backups only; `pg_dump` is not in the image) | **7,514,200** | **-815,104 (-9.8%)** | **-35.7%** | **9,287,834 (387 files, -33.2%, measured)** |

`initdb` is 184,048 bytes in all three. `min3` passes every check: the native image test (now including "text search has exactly `english` and
`simple`"), the full resilience test (N07 and N08, 14 checks), and the 16-check compatibility test against `postgres:18-alpine`.
Speed for `min3` (one `pgbench` pass, same host, same noise as above): select-only 14,992 TPS, TPC-B-like 1,276 TPS, start to first SQL 3.2 s; this is
at the low end of the earlier runs but inside their spread, so no change in speed is claimed or excluded (the repeated-measurement report is CDB-10).

Cost of the second round: text search exists for English only (a text search configuration for another language, and `to_tsvector('german', ...)`,
no longer exist), and `BASE_BACKUP` cannot use gzip. Neither is in the required SQL profile. The feature profile and `docs/feature-matrix.md` say so.

### Where the floor is

The largest items left in the unstripped `min3` server are the SQL scanner and grammar tables (`yy_transition` 297 KB and 64 KB, `yytable` 248 KB,
`yycheck` 248 KB, `yypact`, `yydefact`), then `fmgr_builtins` (74 KB), the Unicode normalization tables (about 120 KB) and the GUC tables. Every SQL server needs the
parser tables. `utils/adt` (1.07 MB) is a long tail with no big target: the biggest object files are `ruleutils` 77 KB, `jsonpath_scan` 72 KB, `numeric` 56 KB,
`formatting` 43 KB, `timestamp` 42 KB, and the whole geometry code (`geo_ops`) is 29 KB. Removing types would need the dependency closure of catalogs, operators, casts and
operator classes checked for a gain of tens of kilobytes each, so that is not worth it before compression.

### Compression with xsfx (measured)

[xsfx](https://github.com/ratushnyi-labs/xsfx) v0.2.0 (static x86-64 musl executable, 517,824 bytes; the release tarball has SHA-256 `cfb0545571e2bcdded6df804333539e7af7fc2c41cf071195e95f55769d09592`)
turns an executable into a self-extracting one: `xsfx <input> <output>`. The result is a 90,152-byte stub plus the LZMA2 payload; at run time the stub decompresses
the program into an anonymous memory file (`memfd`) and executes it from there. Built with `PACK=xsfx VARIANT=min3 scripts/native-image.sh image 18.6` (image tag `compactdb-native:18.6-min3-xsfx`);
only `postgres` is packed (`initdb` shrinks by 12 KB, which is not worth a decompression at every `initdb` run, and the launcher is tiny).

| | `min3` | `min3` + xsfx |
| --- | ---: | ---: |
| `postgres` | 7,514,200 | **2,743,400 (-63.5%)** |
| image content (387 files) | 9,287,834 | **4,517,034 (-51.4%)** |
| exported image, gzip -9 (what a registry transfers, roughly) | 3,829,191 | 3,095,736 (-19.2%) |
| cost per start of `postgres` | about 0 ms | **about 330 ms** (20 starts of `postgres --version`: 6.3-6.7 s) |
| container memory after start (`docker stats`) | 30.3 MiB | 37.6 MiB (+7.3 MiB: one shared in-memory copy of the executable) |

All of it passes on the packed image: `scripts/native-image.sh test` (cold init as uid 70 in `FROM scratch`, SCRAM, modules, restart, non-empty PGDATA refusal), `scripts/native-resilience-test.sh`
(N07, N08: the `kill -9` recovery) and the 16-check compatibility test against `postgres:18-alpine` (`PACK=xsfx` is honoured by all three scripts).

What it costs, honestly:

- **Start time**: the executable is decompressed once per `exec`. PostgreSQL forks its backends (no re-exec), so a running server pays 330 ms once at start. `initdb` runs `postgres` several times (bootstrap, single-user steps), so a cold init is correspondingly longer; start-to-first-SQL stayed at about 7 s in two runs of each image, inside the noise of this host, because that figure is dominated by `initdb` work and `fsync`.
- **Memory**: the decompressed program lives in memory (`memfd`, shown as shared memory, counted once for all processes), not in the page cache of a file; a server container needs about 7.5 MB more.
- **Operations**: `ps` and `/proc/<pid>/comm` show `memfd:rsfx` instead of `postgres`, and `/proc/<pid>/exe` does not point to a file, so process-name based tools (some monitors, `pkill postgres`) will not find it. The image also loses the property that the file on disk is the program that runs; scanners see the packed blob.
- **Speed of SQL**: unchanged by construction (the same machine code runs), and not re-measured.
- **Transfer**: a registry compresses layers anyway, so the pull-size gain is 19%, not 51%.

Recommendation: ship `min3` as the default image (smallest honest unpacked build, normal process names, no start cost) and `min3-xsfx` as the "smallest at rest" variant for cases where disk
size matters more than 0.3 s and 7 MB of memory. The pre-pack estimate above (xz -9e, 2,715,852 for `os`) matched: the real payload for `min3` is 2,653,232 bytes.

Where the packer comes from: the release tarball is not committed (`/xsfx-*.tar.gz` is ignored). `scripts/native-image.sh` reads the extracted executable from the build volume at
`build/xsfx/v0.2.0/x/xsfx-x86_64-unknown-linux-musl`; to place it, extract the tarball there from inside a container (for example `./dcb musl sh -c 'mkdir -p build/xsfx/v0.2.0/x && tar -xzf xsfx-x86_64-unknown-linux-musl.tar.gz -C build/xsfx/v0.2.0/x'`, with the tarball in the repository root) and compare its SHA-256 with the value above.
