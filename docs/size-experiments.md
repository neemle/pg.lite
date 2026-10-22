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
unused data types from `utils/adt` (geometric, network, XML-adjacent, ranges, ...) are the next real levers; each needs the dependency closure checked (CDB-10). A packer such as xsfx would
compress the whole 7.8-8.3 MB; not tried yet (see the open request in the conversation: its release host fails certificate verification here, and its command line is not known).
