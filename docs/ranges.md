# Version-range model

Every difference between PostgreSQL versions is **data**, never code. Three files carry it:

| File | Says |
| --- | --- |
| `sources.lock.json` | which releases exist (351, 9.0.0 to 18.6), their tag, commit, archive and checksum |
| `ranges.json` | per version range: patch series per target, extra configure options, deliberately omitted features |
| `toolchain.lock.json` | per version range: the builder images (by digest) for the native and WASM builds |

Ranges today: `pg9` (9.0.0 to 9.6.99), `pg10-12`, `pg13-14`, `pg15`, `pg16`, `pg17`, `pg18` (the baseline). `to` is
inclusive, so `9.6.99` covers every 9.6.x. Only `pg15` to `pg18` have patch series; a release in another
range cannot be built or released yet (`scripts/release-plan.js` says so). `make native-src` and `make wasm-src` pick
the series of the version's range (`scripts/resolve.js <version> --series-args`). The series file names (`series`, `series.pg9`, ...)
select files in `patches/<target>/`; the baseline range uses the default `series` files.

## Resolve a version

```sh
./dc make resolve VERSION=18.6                                  # full plan as JSON
./dc make resolve VERSION=13.4 RESOLVE_OPTS=--allow-missing-builder
./dc make resolve-check                                         # every release in the index resolves
```

The plan names the release (tag, commit, archive, checksum and where the checksum came from), the
range, the builder images with digests, the series files and the patches in them, the extra
configure options and the omitted features. It is deterministic (no timestamps). Exit codes: 3 version
not in the index, 4 no or overlapping range, 5 no builder range yet, 6 a series file is missing.

## Guarantees and how they are checked

- `validate-locks` proves `ranges.json` tiles the release index: no overlap, and each of the 351
  releases is in exactly one range (an error, always).
- Builder coverage in `toolchain.lock.json` is still only 18.x; the other 345 releases get a warning, and
  `--strict-coverage` turns it into an error for the release gate. CDB-24 supplies those ranges.
- `tests/resolve/run.js` scans the scripts, Dockerfiles and Makefile for version-conditional logic
  (`if [ "$VERSION" -ge ...`, `case "$ver" in`, `version >= 12`) and fails if it finds any outside the
  files that parse versions generically (`release-index.js`, `validate-locks.js`, `resolve.js`).
  The detector is itself tested with positive samples.

## Adding a range or a new major

A release from a major no range covers (for example a future 19) makes `validate-locks` fail with
"covered by 0 ranges": add a range to `ranges.json`, its series files, and a builder range.
