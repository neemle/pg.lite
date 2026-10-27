# Building and testing

**Rule: nothing runs directly on the host. The host runs only `docker` (and `git` for the repo).**
All `make` targets, scripts and tests run inside the tools container defined in
`docker/tools/Dockerfile`; `tools/dc` starts it.

## Run anything

```sh
tools/dc make selftest          # repo self-tests, no network
tools/dc make validate-locks    # validate sources/toolchain/feature lock files
tools/dc make fetch             # download the pinned PostgreSQL release (network on)
tools/dc make fetch VERSION=18.6
tools/dc sh                     # shell inside the tools container
```

- `tools/dc` builds the image `compactdb-tools:local` (cached after the first run) and mounts the
  repo at `/w`. `cache/` and `build/` are **named Docker volumes** (`compactdb-cache`,
  `compactdb-build`) mounted over `/w/cache` and `/w/build`: the fetched PostgreSQL tree has
  ~7,300 files and a bind mount makes it 20-100x slower. The host folders `cache/` and `build/`
  stay empty. Reset with `docker volume rm compactdb-cache compactdb-build`; override the
  volume names with `DC_CACHE_VOLUME` / `DC_BUILD_VOLUME`.
- The container has **no network** except for `fetch` (or `DC_NET=1 tools/dc ...`).
- `make` aborts with an explanatory error when run outside the container (it checks for the
  marker file `/.compactdb-tools` that only the tools image contains).

## Builders

`tools/dcb <name> <command>` runs a command in a builder image from `docker/builders/<name>/Dockerfile`, with the same
mounts and network rules as `tools/dc`:

| Builder | For |
| --- | --- |
| `musl` | the static native server and the scratch image (docs/native.md) |
| `wasm` | the WebAssembly server, `initdb`, and the browser module (docs/wasm.md) |
| `web` | Node and Chromium (Playwright): the Angular demo and the browser tests |
| `ref` | the unmodified upstream reference build and its `psql` |

The network is off in every container except for `fetch` and `DC_NET=1`. npm installs go into the build volume:
`DC_NET=1 tools/dcb web sh scripts/web-install.sh tests/browser` (and `web/demo`), using the committed `package-lock.json`.

### Behind a TLS-inspecting proxy

A corporate proxy that re-signs HTTPS makes downloads inside containers fail with certificate errors. Export the
proxy's root certificate (a public certificate, not a secret) to `.local/corp-ca.pem` (git-ignored); `tools/dc` then
trusts it for node and npm in every container (`NODE_EXTRA_CA_CERTS`) and passes it to image builds as an optional
BuildKit secret (`id=corpca`, never stored in an image). Certificate checking stays on. Source tarballs from
`ftp.postgresql.org` use plain http with the pinned SHA-256 as the check when you set `FETCH_HTTP_FALLBACK=1`.

## What is pinned

- `sources.lock.json`: upstream release, tag, full commit SHA, archive SHA-256. Baseline 18.6,
  see `docs/baseline.md`. Upstream is fetched into the ignored `cache/` and never committed.
- The tools image base is pinned by digest in `docker/tools/Dockerfile`. Its `apt` packages are
  not version-pinned yet (planned together with the builder images, CDB-17).

## Requirements on the host

Docker only. Developed with Docker Desktop on Windows 11 using Git Bash to launch `tools/dc`.
