# Patch policy

PostgreSQL is never committed here. Upstream is fetched at build time (`./dc make fetch`) and
modified only by the ordered patch series in this repository. Patches are plain unified diffs
that apply with `patch -p1`.

## Layout

```
patches/
  common/series   patches every target needs (SQL logic, planner, storage semantics stay upstream)
  native/series   static musl server, shell-free initdb, static module registration
  wasm/series     single-user Emscripten port
```

A `series` file lists patch paths, one per line, relative to its directory; `#` starts a comment.
Order matters. A native build applies `common` then `native`; a WASM build applies `common`
then `wasm`. Per-version or per-range subdirectories are allowed (for example
`native/18/0001-...patch`), they are just paths in the series.

## Patch header

Every patch starts with a header, before the first `---`/`diff` line:

```
Subject: One-line title
Purpose: Why this patch exists.
Components: Source files or subsystems touched, comma separated.
Checks: The tests or commands that prove it works.
Origin: own
```

`Origin: borrowed` additionally requires `Source-URL` (https), `Source-Commit` (full 40-hex SHA),
`Source-License`, and `Adaptation` (what changed when bringing it here), and that commit SHA must
also be recorded in `THIRD_PARTY.md`. A continuation line starts with whitespace.

## Tools (run through `./dc`)

```sh
./dc make patches-verify        # headers, series consistency, attribution, orphan files
./dc make patches-apply VERSION=18.6 TARGETS=common,native
./dc make test-patches          # tooling tests (fixtures live in the test, not in patches/)
```

- `apply` copies `cache/src/<version>` to `build/<version>/src` and patches the **copy**; the
  fetched tree is never changed. Output is a JSON report: the patches applied in order and a
  SHA-256 over the resulting tree, so two applies can be compared.
- Fuzz is refused by default (`--fuzz 0`); offsets are allowed. A reject or fuzz above the
  limit fails the run and removes the half-patched output.
- `verify` fails on: missing/duplicate/escaping series entries, a series entry without a file, a
  `.patch` file that is not in its series, an incomplete header, a bad `Origin`, or a borrowed
  patch whose attribution is incomplete or missing from `THIRD_PARTY.md`.

## Other releases: porting the baseline series

The series in `patches/<target>/series` are written for the baseline release (18.x). A release range of another
major (`pg17`, `pg16`, ...) has its own `series.<range>` files. Most patches apply to the neighbouring majors as they
are, and those are simply listed again; the few whose context differs get a version of their own in
`patches/<target>/<range>/`. `scripts/port-patches.js` makes them:

```sh
./dc node scripts/port-patches.js --from 18.6 --to 17.11 --range pg17
```

For every patch in order, it applies the patch to the baseline tree and, when it also applies to the target tree
with fuzz 0, lists the same file. Otherwise it merges per file (three-way: the baseline before the patch, after the
patch, and the target file) and writes the merge result as a plain diff against the target, with a `Ported-from`
header line. A conflict stops the run and writes `build/port/<from>-to-<to>-resolved/<patch>-<file>.conflict`; edit
it, save it without the `.conflict` suffix and run again, and the resolution is used. The result is a normal series:
`./dc make patches-verify` and `./dc make native-src VERSION=17.11` (fuzz 0) check it, the release builds test it.
`--rename old=new` follows files that moved between releases (`src/common/exec.c` was `src/port/exec.c` before 9.4). Porting from the neighbouring major (`--from-series series.pg16`, with that release as `--from`) usually conflicts less
than porting from 18; `scripts/port-resolve.js --auto` resolves the mechanical conflicts. Two things steer a port by
hand: a patch in `patches/<target>/<range>/` **without** a `Ported-from` line is hand-made and kept as it is (it must
apply), and one that no baseline patch produced is appended at the end of the series; `<patch>.skip` next to the ported
patches (its first line says why) leaves that baseline patch out of the range. Examples: `pg9-6/0005` (adds System V
semaphore emulation, because 9.x selects them on Linux), `pg9-6/0009` (a plan walker with the signature WebAssembly
requires; 9.6 only), `pg9-6/0003-no-locale-a.patch.skip`. Per range, `ranges.json` also carries `configure`, `cflags`
(compiler flags old sources need under gcc 15) and `wasm:` / `native:` prefixes for options of one target only.
Port against the newest minor of the major; the older minors are covered by alternatives (next section).

## Every minor release: alternatives

Contexts change between minor releases (a security fix next to a patched line is enough), so one patch file rarely
applies to every minor of a major. A line of a series may therefore list **alternatives**, separated by `|`:

```
pg12/0007-wasm-embedded-protocol.patch|pg12/0007-wasm-embedded-protocol-r12.14.patch|pg12/0007-wasm-embedded-protocol-r12.3.patch
```

`scripts/patches.js apply` takes the first alternative that applies at fuzz 0 (a trial with `patch --dry-run`, then the
real apply) and fails with "none of the N alternatives applies" otherwise. The first alternative is the one for the
newest minor, so a release that applied before applies exactly as before. The alternative `-r<x.y>` was made for release
x.y; it usually fits a span of releases around it.

`scripts/port-variants.js` adds them: `port-variants.js --range pg12 --from 12.22 --to 12.14` takes a release of the range
that the series applies to completely (`--from`) and one it does not (`--to`), and for every series line that has no fitting
alternative merges the patch (three-way, like `port-patches.js`) into a new `-r<to>` file and appends it to the line. Walk a
range from its newest release down, always from the release just above, so each step is a small difference; merge conflicts
stop the run the same way (resolve, save without `.conflict`, run again).

`scripts/check-releases.js` is the proof: it fetches every release one at a time (SHA-256 checked, tree and archive removed
afterwards), applies the native and the wasm series of its range, and writes `reports/release-apply.json` (a result per version,
resumable; `--all`, `--range pg12`, `--versions a,b`, `--recheck`). `tests/resolve/run.js` fails when a release is missing
from the report, is not `ok`, or the report names another range than `ranges.json` does. After a series or range change:

```sh
DC_NET=1 FETCH_HTTP_FALLBACK=1 ./dcb check node scripts/check-releases.js --range pg12 --recheck
```

It runs in the check builder (`docker/builders/check`: node, gcc, bison, flex), because applying is not enough: after the
apply, `scripts/syntax-check.sh` configures a pristine copy of the release, generates its headers, and compiles every `.c`
file the series touches with `gcc -fsyntax-only` (the wasm series with `-D__EMSCRIPTEN__`, so its guarded code is what gets
checked). That is what finds a patch that applies by context but uses something the release does not have (the first minors of
9.x have no `PqCommReadingMsg`).

**Optional entries.** A line ending in `|-` is optional: `pg12/0009-wasm-walker-signature.patch|-`. If no alternative
applies, nothing is applied, but only when the text the patch removes is no longer in the tree (a later minor fixed the problem
itself). If that text is still there, apply fails: an optional patch is never skipped by accident. Walk such a range upwards
from the release the patch was written for, so every release is looked at.

`scripts/port-variants-range.js` does the walk (`DC_NET=1 FETCH_HTTP_FALLBACK=1 ./dc node scripts/port-variants-range.js pg12`,
with `--up` for ranges with optional entries and `--wasm-only` to leave the other targets alone): per release it runs
`port-variants.js` from the neighbour, resolves the mechanical merge conflicts, and stops at the first one that needs a person.
A new minor release (a new entry in `sources.lock.json`) that breaks a patch shows up in the check first; run the walk for its
range and the check again.

## Applying is not building

The oldest minor of every range is also built and tested (native image test, wasm node test), and these builds found what
applying cannot: patches that apply but whose code does not compile or traps in WebAssembly, and toolchain differences between
minors. They are handled by feature detection in the build scripts, not by version checks: `scripts/build-wasm.sh` configures
`--disable-spinlocks` where `s_lock.h` has no generic gcc section (the first minors of 10 to 15), and defines `WAIT_USE_POLL`
where `latch.c` includes `<sys/signalfd.h>` unguarded and Emscripten has no such header (14.0); the walker patch above covers
a call through a function pointer of another signature, which traps in WebAssembly; `ranges.json` gives 13 to 17 `-std=gnu17`
like the older ranges (their first minors have prototypes that C23 rejects); `scripts/build-reference.sh` moves a static
`copy_file_range()` of pg_rewind out of the way (`scripts/reference-compat.h`).

## Where the trees live

`cache/` (fetched upstream) and `build/` (patched copies, build output) are Docker named volumes
(`compactdb-cache`, `compactdb-build`) that `./dc` mounts over `/w/cache` and `/w/build`. The
fetched tree has about 7,300 files; through the Windows bind mount a single apply took over 15
minutes, on the volumes it takes about 10-20 seconds. Nothing in them is committed or visible in
the host working tree.
