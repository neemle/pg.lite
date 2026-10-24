# Release index

`sources.lock.json` lists every **final** PostgreSQL release from 9.0.0 to the newest (351 on
2026-10-22: 9.0.0 to 18.6). It is generated, not hand-written:

```sh
./dc make release-index        # needs network; ./dc enables it for this target
./dc make test-release-index   # offline unit tests of the parsing and cross-check
```

## How it is built

1. **Git tags** from `https://git.postgresql.org/git/postgresql.git` (`git ls-remote --tags`):
   `REL9_<0-6>_<n>` and `REL_<10+>_<n>` only. Alpha, beta, RC tags and anything older than 9.0 are
   excluded; an annotated tag resolves to its commit (the peeled `^{}` line).
2. **FTP directory index** of `https://ftp.postgresql.org/pub/source/` (`vX.Y.Z/` and `vX.Y/` dirs,
   same filter).
3. **Cross-check:** the two sets must be identical; any version in only one source fails the run and
   the lock is not written. 351 = 351 on 2026-10-22.
4. **Checksums**
   - `official-sha256-file`: the official `postgresql-<v>.tar.bz2.sha256` (322 releases).
   - `computed-md5-verified`: 29 old releases (9.0.0 to 9.0.13, 9.1.0 to 9.1.9, 9.2.0 to 9.2.4) have no
     official `.sha256`. The archive is downloaded and hashed, and its md5 must equal the official
     `.md5` file (both layouts are parsed), otherwise the run fails.
   - `computed-unverified`: would be used when neither file exists. Count today: 0.
   A result already computed for the same commit is reused, so a re-run does not download again and
   the lock does not change (checked: second run produced no diff).

The run report (counts, sources, discrepancies) is `reports/release-index.json`.

## Independent checks done on 2026-10-22

- Newest release of each of the 16 majors (9.0 to 9.6 and 10 to 18) equals the table on
  https://www.postgresql.org/support/versioning/ (for example 9.0.23, 9.6.24, 12.22, 17.11, 18.6).
- The existing 18.6 entry (commit and checksum) is unchanged.
- `./dc make fetch VERSION=9.0.0` and `VERSION=10.0` downloaded, verified and extracted through the
  generated lock (checksum, and tag resolves to the locked commit).

## Limits

- Only the newest-per-major list was compared with the versioning page; the per-release completeness
  rests on git and ftp agreeing, which are both official but not independent of each other beyond
  being different hosts.
- A release without a builder range makes `validate-locks` print a warning; all 351 are covered now, and
  `--strict-coverage` turns a future gap into an error (for the release gate).
