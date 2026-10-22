# Building and testing

**Rule: nothing runs directly on the host. The host runs only `docker` (and `git` for the repo).**
All `make` targets, scripts and tests run inside the tools container defined in
`docker/tools/Dockerfile`; `./dc` starts it.

## Run anything

```sh
./dc make selftest          # repo self-tests, no network
./dc make validate-locks    # validate sources/toolchain/feature lock files
./dc make fetch             # download the pinned PostgreSQL release (network on)
./dc make fetch VERSION=18.6
./dc sh                     # shell inside the tools container
```

- `./dc` builds the image `compactdb-tools:local` (cached after the first run) and mounts the
  repo at `/w`.
- The container has **no network** except for `fetch` (or `DC_NET=1 ./dc ...`).
- `make` aborts with an explanatory error when run outside the container (it checks for the
  marker file `/.compactdb-tools` that only the tools image contains).
- Targets owned by backlog items that have not landed yet exit with status 2 and name the owner,
  for example `./dc make native` -> `NOT IMPLEMENTED (owned by CDB-3 ...)`.

## What is pinned

- `sources.lock.json`: upstream release, tag, full commit SHA, archive SHA-256. Baseline 18.6,
  see `docs/baseline.md`. Upstream is fetched into the ignored `cache/` and never committed.
- The tools image base is pinned by digest in `docker/tools/Dockerfile`. Its `apt` packages are
  not version-pinned yet (planned together with the builder images, CDB-17).

## Requirements on the host

Docker only. Developed with Docker Desktop on Windows 11 using Git Bash to launch `./dc`.
