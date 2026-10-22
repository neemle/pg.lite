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

## Where the trees live

`cache/` (fetched upstream) and `build/` (patched copies, build output) are Docker named volumes
(`compactdb-cache`, `compactdb-build`) that `./dc` mounts over `/w/cache` and `/w/build`. The
fetched tree has about 7,300 files; through the Windows bind mount a single apply took over 15
minutes, on the volumes it takes about 10-20 seconds. Nothing in them is committed or visible in
the host working tree.
