# tools

The infrastructure that both products share. The repository holds two products, each in its own folder, and the parts they have in common:

| Path | What |
| --- | --- |
| `image/` | the **Docker image** product: build of the static server (`build.sh`), the image and its tests (`image.sh`), the unmodified reference build, `docker/` (the files that go into the image), `tests/` |
| `wasm/` | the **WebAssembly** product: build (`build.sh`), packaging (`package.sh`), the TypeScript module (`src/`), the Angular demo (`demo/`), `tests/` (Chromium and node) |
| `patches/` | the patches to PostgreSQL, one cascading tree for both products (`Targets:` in each header says common, native or wasm) |
| `scripts/` | shared: fetch and verify a release, apply the patches (`patches.sh`), resolve the build arguments of the version, check the locks |
| `builder.sh` | the one entry point: `./builder.sh <patch|build|test> <version> <cli|wasm>` |
| `tools/` | this folder: the containers and the data |

| Here | What |
| --- | --- |
| `dc` | run any command in the tools container: `tools/dc make selftest`, `tools/dc make fetch VERSION=18.6`, `tools/dc sh` |
| `dcb` | the same inside a builder container: `tools/dcb musl ...` (static image), `wasm`, `web` (Chromium tests), `ref` (unmodified reference build), `check` |
| `Makefile` | the build steps and checks that `dc` runs (`tools/dc make help`) |
| `docker/` | the builder images, pinned by digest |
| `sources.lock.json`, `ranges.json`, `toolchain.lock.json`, `feature-profile.json`, `schemas/` | data: the releases and their SHA-256, how releases differ, pinned builder images, what is left out of the build |
| `licenses/`, `THIRD_PARTY.md` | licence texts and third-party attribution |

**Paths inside the containers.** The repository is one tree there: `tools/` is `/w`, and `patches/`, `scripts/`, `image/` and `wasm/` are
`/w/patches`, `/w/scripts`, `/w/image` and `/w/wasm`. Commands that start with `tools/dc` or `tools/dcb` are run from the repository root.

`cache/` and `build/` (fetched sources and build trees) are Docker volumes, not folders; `dist/` receives the packaged browser module; `.local/`
(git-ignored) can hold a corporate CA certificate as `corp-ca.pem`.
