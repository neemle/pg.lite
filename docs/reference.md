# Unmodified upstream reference build

The comparison baseline for SQL behavior and for size: PostgreSQL built from the pinned,
checksum-verified release with **no patch, default `configure` options (only `--prefix`)**, on
an ordinary dynamic glibc toolchain (readline, zlib and ICU present, as upstream's default
configuration expects). It is a reference, not a product: nothing here is size-optimized.

## Build and run

```sh
./dc make fetch VERSION=18.6                  # verified source into the cache volume
./dcb ref make reference VERSION=18.6         # out-of-tree build + install + install-strip
scripts/reference.sh image 18.6               # runtime image compactdb-reference:18.6
scripts/reference.sh test 18.6                # start, SELECT 1 from an external client, wrong password, restart
scripts/reference.sh up 18.6                  # keep it running on the private network compactdb-ref-net
scripts/reference.sh psql 18.6 -- -c 'SELECT 1'
scripts/reference.sh down 18.6
```

- The server container is on a private Docker network with **no published host port**; clients
  are other containers (`scripts/reference.sh psql` starts one running `psql` from the same
  image). It initializes an empty volume on first start: UTF-8, builtin locale provider with
  `C.UTF-8`, UTC, `scram-sha-256` for network clients. The password in the script is a test value
  for a throw-away server.
- The build is **out of tree** (`cache/src/<v>` is never written to). `build-reference.sh` proves
  it by finding 0 files newer than the fetch marker, and the source it uses is only the tree that
  `make fetch` verified against the lock file.
- Parallel out-of-tree builds race on the generated header `utils/errcodes.h`, so the script runs
  `make -C src/backend generated-headers` before `make -j`. That only orders upstream's own steps;
  it changes no source.

## Size record

`reports/reference-size.json` holds the byte totals and the method (sum of regular-file apparent
sizes under the install prefix; unstripped = `make install`, stripped = `make install-strip`).
Shared libraries the executables need from the OS (libc, ICU, readline, zlib) are listed but not
counted; the static musl runtime will include its own copies, so compare with that in mind.
The raw build log is `reports/logs/reference-build.log.gz`.

## Measured on this host (PostgreSQL 18.6, gcc 12.2.0, Debian 12.15)

| Variant | postgres binary | bin | lib | share | include | total (1,654 files) |
| --- | --- | --- | --- | --- | --- | --- |
| `make install` (unstripped) | 11,235,728 B | 18,007,488 B | 6,747,230 B | 1,778,457 B | 6,267,654 B | 32,800,829 B |
| `make install-strip` | 10,141,848 B | 16,157,216 B | 6,180,206 B | 1,778,457 B | 6,267,654 B | 30,383,533 B |

The stripped `postgres` needs these shared libraries from the OS (not counted above):
`ld-linux-x86-64.so.2`, `libc`, `libm`, `libgcc_s`, `libstdc++`, `libz`, and ICU
(`libicudata/i18n/uc` 72). Its compressed log is 56 KB. The unmodified-source claim is backed by:
0 files newer than the fetch marker after the build, and `patches.js apply` over the real tree with
the (empty) series reporting `"applied": []` and the same tree hash as the pristine copy.

## Verified behavior of the reference server

`scripts/reference.sh test 18.6`: `SELECT 1` from a second container over TCP, `PostgreSQL 18.6`,
`UTF8`, `UTC`, provider `b` (builtin) with `C.UTF-8`, wrong password rejected, data written before
`docker restart` is still there.
