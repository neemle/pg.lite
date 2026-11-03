# Third-party and borrowed material

Every borrowed change, file or idea that lands in this repository is recorded here.
Upstream PostgreSQL itself is NOT stored in this repository: it is fetched at build time
(see `releases.txt`) and its own license text is copied into the build output from the
fetched tree (see `licenses/postgresql/README.md`).

Entry fields (all required):

| Field | Meaning |
| --- | --- |
| Name | What was borrowed (patch, script, snippet, library) |
| Source URL | Exact upstream location |
| Commit SHA | Full 40-character commit the material was taken from |
| License | SPDX identifier or license name of the source |
| Adaptation | What was changed when bringing it here |
| Used in | Repo path(s) that contain or derive from it |

## Entries

| Name | Source URL | Commit SHA | License | Adaptation | Used in |
| --- | --- | --- | --- | --- | --- |
| Fix of the crash-safety bug of new or reset sequences (bug #6748) | https://github.com/postgres/postgres/commit/2d7045db0fed2be986e2fc3bc0bb0c3f44badd96 | 2d7045db0fed2be986e2fc3bc0bb0c3f44badd96 | PostgreSQL License | The 9.0 branch commit, reduced to sequence.c, applied to 9.0.0 and 9.0.1 | patches/9/9.0/0040-sequence-wal-log.patch |

Nothing else yet. PGlite (https://github.com/electric-sql/pglite and
https://github.com/electric-sql/postgres-pglite) is a planned reference for the WASM port;
any patch or code taken from it MUST be added here with the fields above before it is merged.
