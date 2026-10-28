# Patch policy

PostgreSQL is never committed here. Upstream is fetched at build time (`tools/dc make fetch`) and modified only by the patches in
`patches/`. Patches are plain unified diffs that apply with `patch -p1`.

## Layout: folders that cascade

```
patches/
  0000-static-modules.patch            ... what every release takes
  9/                                   ... what every 9.x release takes
    0900-single-binary.patch
    9.6/                               ... what every 9.6.x release takes
      9.6.0-9.6.8/                     ... what 9.6.0 to 9.6.8 take on top
        0250-wasm-dsm-sysv.patch
      9.6.9/
  12/                                  ... what every 12.x release takes
    12.0-12.3/
    12.4-12.9/
    12.10/
  18/
```

* **The patches of a release are collected on its way down**: `patches/`, then its family folder (`9`, `10`, ... `18`), for 9.x its series
  folder (`9.6`), and the span folder that holds it (`12.4-12.9`; a single release is just `12.10`). `scripts/patchtree.js path 12.5`
  prints the folders.
* **No duplication.** A patch lives at the outermost level at which it is the same for every release below. A folder therefore holds what
  differs from the one above it: contexts change between minor releases (a security fix next to a patched line is enough), so the same
  patch exists in a few variants, and each variant is in the span of releases it fits. A number occurs once on a path.
* **Four digits and a name.** `NNNN-name.patch`: the digits are the order in which the collected patches are applied, the name says what
  it is. The same change keeps the same number everywhere (`0100-no-shell-spawn` is the shell-free spawn code in every variant).
  Gaps are intended, so a patch can be slotted in.
* **`Targets:` says where a patch goes.** Each patch has a header line `Targets: common`, `native` or `wasm` (comma separated): `common`
  goes into both builds, `native` only into the static image, `wasm` only into the browser build.

| Numbers | Targets | What |
| --- | --- | --- |
| `0000`-`0099` | common | modules linked into the server instead of loaded (`plpgsql`, `snowball`), no `locale -a`, English-only snowball |
| `0100`-`0199` | native | no shell: the spawn interpreter, the WAL receiver linked in |
| `0200`-`0299` | wasm | single-user Emscripten port: shared memory, semaphores, the in-page protocol, storage barrier |
| `0900` | native | **the single-binary wrapper**: `initdb`, `pg_resetwal`, `pg_controldata`, the container entrypoint and the `share/` data files linked into `postgres` (see [native.md](native.md), "One file") |

All 351 releases from 9.0 to 18.x are covered, and `scripts/check-releases.js` proves that each applies and compiles (below). The
tree has 278 patch files for 351 releases; one folder per release would be 4,744.

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
tools/dc make patches-verify                          # shape of the tree, names, numbers, headers, attribution
tools/dc make patches-apply VERSION=18.6 TARGET=native
tools/dc make native-src VERSION=18.6                 # the same, into build/native/18.6/src
tools/dc make test-patches                            # tooling tests (fixtures live in the test, not in patches/)
tools/dc node scripts/patchtree.js path 12.5          # the folders a release takes
```

* `apply` copies `cache/src/<version>` and patches the **copy**; the fetched tree is never changed. Its JSON report names the folders
  used, the patches applied in order and a SHA-256 over the resulting tree, so two applies can be compared.
* Fuzz is refused by default (`--fuzz 0`); offsets are allowed. A reject or fuzz above the limit fails the run and removes the
  half-patched output.
* `verify` fails on: a folder that is not a major version (`9`, `18`), a series or span with a bad name (a span is `A-B` inside one
  family, and 9.x spans inside one series), overlapping or backwards spans, a patch not named `NNNN-name.patch`, a number used twice on
  a path, an incomplete header or an unknown `Targets`, a bad `Origin`, a borrowed patch whose attribution is incomplete or missing from
  `THIRD_PARTY.md`.
* `patchtree.js flatten <dir>` writes every release's patches as `<dir>/<version>/` (handy to compare two releases), and
  `patchtree.js fold <flatdir> <patches>` is the inverse: it rebuilds the tree from such folders, moving each patch to the outermost
  level it belongs to and merging neighbouring releases that take the same patches into spans.

## Adding a version

```sh
tools/dc make fetch VERSION=17.12
tools/dc node scripts/new-patch-folder.js --to 17.12
```

The release must be in `sources.lock.json`. The tool first asks whether the tree already applies to it (native and wasm); if so it adds
nothing. If not, it puts the patch set together from what the nearest releases of the major take: for every patch, in number order, it
tries the variants on the release at fuzz 0 and takes the first that applies. A patch that fits no variant is left out only when the
lines it removes are gone from the release (a later minor fixed the problem itself); otherwise the release needs a patch written by hand,
the tool names it, and the way to start is to take the nearest release's patches (`patchtree.js flatten`), edit what no longer fits
(`patch -p1 --dry-run -i ...` in a copy of the tree shows what moved), and `fold` it back. The tool then rebuilds the tree with the new
release in it, checks both targets, checks that no other release's patches changed, and replaces `patches/`. Then run the build and its tests.

## Every release: the proof

`scripts/check-releases.js` fetches every release one at a time (SHA-256 checked, tree and archive removed afterwards), applies the
native and the wasm patches exactly as `make native-src` / `make wasm-src` do, and writes `reports/release-apply.json` (a result
per version, with the folders it took; resumable; `--all`, `--range pg12`, `--versions a,b`, `--recheck`). `tests/resolve/run.js` fails
when a release is missing from the report, is not `ok`, or the report names another range than `ranges.json` does.

```sh
DC_NET=1 FETCH_HTTP_FALLBACK=1 tools/dcb check node scripts/check-releases.js --range pg12 --recheck
```

It runs in the check builder (`docker/builders/check`: node, gcc, bison, flex), because applying is not enough: after the
apply, `scripts/syntax-check.sh` configures a pristine copy of the release, generates its headers, and compiles every `.c`
file the patches touch with `gcc -fsyntax-only` (the wasm patches with `-D__EMSCRIPTEN__`, so the guarded code is what gets
checked). That is what finds a patch that applies by context but uses something the release does not have (the first minors of
9.x have no `PqCommReadingMsg`).
