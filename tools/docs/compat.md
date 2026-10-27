# Drop-in compatibility with the official image

`scripts/compat-test.sh` proves the static server can replace `postgres:18-alpine` on an existing data
directory, in both directions. Run it with `sh scripts/compat-test.sh 18.6` (needs the static and reference
images; everything runs in containers on a private network, the password is a throw-away test value).

| Step | Server | What happens |
| --- | --- | --- |
| A | official `postgres:18-alpine` (18.6, digest `sha256:898c60cb...`) | creates the cluster (libc provider, `en_US.utf8`, data checksums on) and fills it: 5,000 accounts with numeric(20,2), uuid, timestamptz, Ukrainian text; a ledger with foreign keys; 40 large TOASTed values; a view; a plpgsql function; 200 transfers; fingerprint F1 |
| B | static, **same volume** | reads: fingerprint equals F1. Then updates: 201 transfers through the cluster's plpgsql function, 500 inserts, updates, deletes, 20 more large values, a new index, a new table with 1,000 rows, `VACUUM (ANALYZE)`, `CHECKPOINT`; fingerprint F2 |
| C | official again | reads: fingerprint equals F2; the table static created is readable; `amcheck` verifies all 173 btree indexes (including the one static created); no data checksum failures; updates and vacuums; fingerprint F3 |
| D | static again | reads: fingerprint equals F3, including rows the official server added after static |
| end | `pg_controldata` of both builds | catalog version, block sizes, checksum version, alignment, float8 passing agree; cluster state `shut down` |

Result on this host: **PASS** (all 16 checks). Every stop used the image's own stop signal (SIGINT, fast
shutdown) and both servers logged a clean shutdown.

What this shows and does not show:
- The on-disk format, WAL/control file, catalogs, TOAST, indexes and data checksums are interchangeable between the two builds.
- A cluster whose databases use the **libc** provider with a name musl does not ship locale files for (`en_US.utf8`) opens fine in the static server,
  the same way it does in the official musl image.
- The fingerprints cover tables, a view, TOAST, numeric and text data; they are not a proof for every feature.
- The official image has the contrib extensions and the static server does not: a cluster that uses an extension (pgcrypto, pg_trgm, ...) would
  not be a drop-in. The test deliberately uses core features only (amcheck is created and used only while the official server is running).
- Only a clean shutdown handover was tested; handing a crashed cluster from one build to the other (WAL replay by the other build) is not covered.
