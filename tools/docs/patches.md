# Patch policy

PostgreSQL is never committed here. Upstream is fetched at build time (`tools/dc make fetch`) and modified only by the
patches in `patches/`. Patches are plain unified diffs that apply with `patch -p1`.

## Layout

```
patches/
  18.6/
    0000-static-modules.patch
    0010-no-locale-a.patch
    0020-snowball-english-only.patch
    0100-no-shell-spawn.patch
    0110-static-libpqwalreceiver.patch
    0200-wasm-shared-memory.patch
    ...
    0900-single-binary.patch
  17.11/
  16.15/
  ...
```

* **One folder per tested version**, named after the PostgreSQL release (`18.6`, `9.6.24`). The folder holds every patch that
  version needs, in the order they are applied.
* **Four digits and a name.** `NNNN-name.patch`: the digits are the order, the name says what it is. Gaps are intended, so a
  patch can be slotted in. The same change keeps the same number in every folder (`0100-no-shell-spawn` is the shell-free
  spawn code in all of them), but a folder only holds the patches its release needs (`no-locale-a` does not exist for 9.x).
* **`Targets:` says where a patch goes.** Each patch has a header line `Targets: common`, `native` or `wasm` (comma separated):
  `common` goes into both builds, `native` only into the static image, `wasm` only into the browser build.

| Numbers | Targets | What |
| --- | --- | --- |
| `0000`-`0099` | common | modules linked into the server instead of loaded (`plpgsql`, `snowball`), no `locale -a`, English-only snowball |
| `0100`-`0199` | native | no shell: the spawn interpreter, the WAL receiver linked in |
| `0200`-`0299` | wasm | single-user Emscripten port: shared memory, semaphores, the in-page protocol, storage barrier |
| `0900` | native | **the single-binary wrapper**: `initdb`, `pg_resetwal`, `pg_controldata`, the container entrypoint and the `share/` data files linked into `postgres` (see [native.md](native.md), "One file") |

A release that has no folder of its own is served by the nearest tested folder of the same major (`scripts/resolve.js
<version> --patch-args` lists the candidates in order: nearest minor first). `patches.js apply` takes the first folder that
applies completely at fuzz 0 and fails with the first error otherwise, so a release never gets a patch that merely
"mostly" fits. The 351 releases from 9.0 to 18.x are covered this way; `scripts/check-releases.js` proves it (below) and records
the folder each release used in `reports/release-apply.json`.

## Patch header

Every patch starts with a header, before the first `---`/`diff` line:

```
Targets: native
Subject: One-line title
Purpose: Why this patch exists.
Components: Source files or subsystems touched, comma separated.
Checks: The tests or commands that prove it works.
Origin: own
```

`Origin: borrowed` additionally requires `Source-URL` (https), `Source-Commit` (full 40-hex SHA), `Source-License`, and
`Adaptation` (what changed when bringing it here), and that commit SHA must also be recorded in `THIRD_PARTY.md`. A
continuation line starts with whitespace.

## Tools (run through `tools/dc`, or the commands of `builder.sh`)

```sh
tools/dc make patches-verify                          # names, numbers, headers, attribution
tools/dc make patches-apply VERSION=18.6 TARGET=native
tools/dc make native-src VERSION=18.6                 # the same, into build/native/18.6/src
tools/dc make test-patches                            # tooling tests (fixtures live in the test, not in patches/)
```

* `apply` copies `cache/src/<version>` and patches the **copy**; the fetched tree is never changed. Its JSON report names the
  folder used, the patches applied in order and a SHA-256 over the resulting tree, so two applies can be compared.
* Fuzz is refused by default (`--fuzz 0`); offsets are allowed. A reject or fuzz above the limit fails the run and removes the
  half-patched output.
* `verify` fails on: a file or folder in `patches/` that is not a version folder, a patch not named `NNNN-name.patch`, a
  repeated number, an empty folder, an incomplete header or an unknown `Targets`, a bad `Origin`, a borrowed patch whose
  attribution is incomplete or missing from `THIRD_PARTY.md`.

## Adding a version

```sh
tools/dc make fetch VERSION=17.12
tools/dc node scripts/new-patch-folder.js --to 17.12
```

The tool first asks whether the folders that can already serve the release apply to it (native and wasm); if so it adds nothing. If not,
it puts a folder together from what the other folders of the major hold. Contexts change between minor releases (a security fix next to a
patched line is enough), so the same patch exists in several variants, one per span of releases. For every patch, in number order, the tool
tries the variants on the release at fuzz 0 and takes the first that applies. A patch that fits no variant is left out only when the lines it
removes are gone from the release (a later minor fixed the problem itself); otherwise the release needs a patch written by hand: the tool
names it, and the new folder is the nearest one with that patch edited (`patch -p1 --dry-run -i patches/17.12/0100-no-shell-spawn.patch`
in a copy of the tree shows what moved). The folder is checked with `patches.js apply` for both targets and is not kept when an existing
folder is identical. Then run the build and its tests.

Of the 351 releases, 50 have a folder of their own; the others are served by the nearest one. `check-releases` (below) proves that every
release applies, and names the ones that need a new folder.

## Every release: the proof

`scripts/check-releases.js` fetches every release one at a time (SHA-256 checked, tree and archive removed afterwards), applies the
native and the wasm patches exactly as `make native-src` / `make wasm-src` do, and writes `reports/release-apply.json` (a result
per version, resumable; `--all`, `--range pg12`, `--versions a,b`, `--recheck`). `tests/resolve/run.js` fails when a release is
missing from the report, is not `ok`, or the report names another range than `ranges.json` does.

```sh
DC_NET=1 FETCH_HTTP_FALLBACK=1 tools/dcb check node scripts/check-releases.js --range pg12 --recheck
```

It runs in the check builder (`docker/builders/check`: node, gcc, bison, flex), because applying is not enough: after the
apply, `scripts/syntax-check.sh` configures a pristine copy of the release, generates its headers, and compiles every `.c`
file the patches touch with `gcc -fsyntax-only` (the wasm patches with `-D__EMSCRIPTEN__`, so the guarded code is what gets
checked). That is what finds a patch that applies by context but uses something the release does not have (the first minors of
9.x have no `PqCommReadingMsg`).
