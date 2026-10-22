# Baseline PostgreSQL release

**Chosen baseline: PostgreSQL 18.6** (tag `REL_18_6`), recorded 2026-10-22 under backlog item CDB-15.

The baseline is the default version of the build scripts and the only line that must pass the
full acceptance suite. Other releases are handled through the per-version model (CDB-12).
No automatic move to another major is made: raising the baseline is a deliberate edit of
`sources.lock.json`.

## Was there a newer 18.x minor? No.

Checked on 2026-10-22, three independent sources agree that 18.6 is the newest 18.x:

| Source | Result |
| --- | --- |
| https://www.postgresql.org/support/versioning/ | current minor of 18 is 18.6 |
| https://ftp.postgresql.org/pub/source/ directory index | highest 18 directory is `v18.6/` (no `v18.5/` exists) |
| `git ls-remote --tags https://git.postgresql.org/git/postgresql.git 'refs/tags/REL_18_*'` | highest final tag is `REL_18_6` (also `_0` .. `_4`; BETA/RC tags ignored) |

## Pinned values

| Field | Value |
| --- | --- |
| Tag | `REL_18_6` (lightweight tag, no `^{}` peel line returned) |
| Full commit SHA | `724edf9bde9d356724ad384a2e196edc3c9f80f7` |
| Git remote | `https://git.postgresql.org/git/postgresql.git` |
| Archive | `https://ftp.postgresql.org/pub/source/v18.6/postgresql-18.6.tar.bz2` |
| Archive SHA-256 | `555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f` |

## Verification evidence

- **Tag to commit, two hosts agree.** `git ls-remote --tags` against the official remote
  (`git.postgresql.org`) and against the GitHub mirror (`github.com/postgres/postgres`) both
  return `724edf9bde9d356724ad384a2e196edc3c9f80f7` for `refs/tags/REL_18_6`.
- **Archive checksum, two independent routes agree.** The pinned value was first read from the
  official `postgresql-18.6.tar.bz2.sha256` file on `ftp.postgresql.org` through the agent's
  web-fetch tool (`curl` on this Windows host fails TLS certificate revocation checking,
  `CRYPT_E_REVOCATION_OFFLINE`, and that check was not disabled). On 2026-10-22 `make fetch`
  (CDB-16) then downloaded the 22,632,314-byte archive inside a container with normal TLS
  verification and computed the same SHA-256 itself, so the value is confirmed against the real
  bytes, and `git ls-remote` inside that run confirmed tag `REL_18_6` still resolves to the
  locked commit.
- The recorded values pass `scripts/validate-locks.js`.
