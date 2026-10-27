# Version-range model

Every difference between PostgreSQL versions is **data**, never code. Three files carry it:

| File | Says |
| --- | --- |
| `sources.lock.json` | which releases exist (351, 9.0.0 to 18.6), their tag, commit, archive and checksum |
| `ranges.json` | per version range: extra configure options, compiler flags, deliberately omitted features |
| `toolchain.lock.json` | per version range: the builder images (by digest) for the native and WASM builds |

Ranges today: `pg9-0` (9.0.0 to 9.0.99), `pg9-1`, `pg9-2`, `pg9-3`, `pg9-4`, `pg9-5`, `pg9-6`, `pg10`, `pg11`, `pg12`, `pg13`, `pg14`, `pg15`, `pg16`, `pg17`, `pg18` (the baseline). `to` is
inclusive, so `9.6.99` covers every 9.6.x. The patches are not part of the range: `make native-src` and `make wasm-src` use the folder `patches/<version>` of the
release or, when it has none, the nearest tested version of the same major (`scripts/resolve.js <version> --patch-args`,
see patches.md). A major without any patch folder cannot be built or released (`scripts/release-plan.js` says so).

## Resolve a version

```sh
tools/dc make resolve VERSION=18.6                                  # full plan as JSON
tools/dc make resolve VERSION=13.4 RESOLVE_OPTS=--allow-missing-builder
tools/dc make resolve-check                                         # every release in the index resolves
```

The plan names the release (tag, commit, archive, checksum and where the checksum came from), the
range, the builder images with digests, the patch folders that can serve it (best first), the extra
configure options and the omitted features. It is deterministic (no timestamps). Exit codes: 3 version
not in the index, 4 no or overlapping range, 5 no builder range yet, 6 no patch folder for the major of that release.

## Guarantees and how they are checked

- `validate-locks` proves `ranges.json` tiles the release index: no overlap, and each of the 351
  releases is in exactly one range (an error, always).
- Builder coverage in `toolchain.lock.json` reaches all 351 releases (9.0.0 to 18.x); `--strict-coverage` turns a gap into an
  error for the release gate.
- `tests/resolve/run.js` scans the scripts, Dockerfiles and Makefile for version-conditional logic
  (`if [ "$VERSION" -ge ...`, `case "$ver" in`, `version >= 12`) and fails if it finds any outside the
  files that parse versions generically (`release-index.js`, `validate-locks.js`, `resolve.js`).
  The detector is itself tested with positive samples.

## Adding a range or a new major

A release from a major no range covers (for example a future 19) makes `validate-locks` fail with
"covered by 0 ranges": add a range to `ranges.json`, a patch folder under `patches/`, and a builder range.
