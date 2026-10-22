# Output checks (static ELF, WASM)

Version-agnostic scripts that prove what a build produced. Both write a machine-readable JSON result
for the support matrix (CDB-34) and exit non-zero on any failure.

## Static ELF (evidence for N01-N03)

```sh
./dcb musl make check-static DIR=build/<path> [CHECK_OPTS="--json /w/reports/static-<v>.json"]
```

`scripts/check-static.sh` runs in a builder because it needs `readelf`. For every ELF under the path:
no `PT_INTERP`, no `DT_NEEDED`, not a shared object (`*.so*`), and stripped (no `.symtab`, no
`.debug_*`; `--allow-unstripped` relaxes only this last rule). Non-ELF files are skipped and counted. A
path with **no** ELF at all is an error (exit 2): an empty check proves nothing.

## WASM load

```sh
./dc make check-wasm DIR=build/<path> [CHECK_OPTS="--json /w/reports/wasm-<v>.json"]
```

`scripts/check-wasm.js` requires, for every `*.wasm`: the header and binary version 1, that the module
validates, and that it compiles in node; it records the import and export counts. A real browser run
belongs to the browser tests (CDB-6 and CDB-7); this proves the module is well-formed and loadable by
the WebAssembly engine.

## Tests

- `./dc make test-check-wasm` (in `selftest`): valid, empty, truncated, bad magic, wrong version,
  non-validating, no-wasm directory, missing path, mixed set, JSON content.
- `./dcb musl make test-check-static`: builds real binaries in the musl builder: a static stripped one
  (passes), a dynamic one (fails with `PT_INTERP` and `DT_NEEDED`), an unstripped static one (fails;
  passes with `--allow-unstripped`), a shared object (fails), plus text-only and empty directories and
  the JSON result.
- Real-world negative control: the unmodified reference build (dynamic glibc) fails the static check on
  all 35 ELF files it installs (`PT_INTERP` and `DT_NEEDED` on every one), as it must.
