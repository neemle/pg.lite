# tools

Everything that builds and checks compact.db. The repository root holds only `README.md`, `LICENSE`, `builder.sh`, `patches/` (the patches
to PostgreSQL) and `demo/` (the WebAssembly side); `builder.sh` calls into this folder, and you rarely need to.

| Path | What |
| --- | --- |
| `dc` | run any command in the tools container: `tools/dc make selftest`, `tools/dc make fetch VERSION=18.6`, `tools/dc sh` |
| `dcb` | the same inside a builder container: `tools/dcb musl ...` (static image), `wasm`, `web` (Chromium tests), `ref` (unmodified reference build), `check` |
| `Makefile` | the build steps and checks that `dc` runs (`tools/dc make help`) |
| `scripts/` | fetch and verify a release, apply patches, build (`build-native.sh`, `build-wasm.sh`), assemble the image (`native-image.sh`), tests |
| `docker/` | the builder images and what goes into the final image |
| `tests/` | repository checks, patch tooling, native, wasm and Chromium tests |
| `docs/` | how things work and what was measured |
| `sources.lock.json`, `ranges.json`, `toolchain.lock.json`, `feature-profile.json`, `schemas/` | data: every release and its SHA-256, how releases differ, pinned builder images, what is left out of the build |
| `reports/` | recorded results (does every release take its patches, sizes, image listings) |
| `licenses/`, `THIRD_PARTY.md` | licence texts and third-party attribution |

**Paths in the documentation.** Inside the containers the repository is one tree: `tools/` is `/w`, `patches/` is `/w/patches` and `demo/` is
`/w/web`. Documentation written for the containers (`scripts/...`, `docs/...`, `web/...`) uses those paths; commands that start with
`tools/dc` or `tools/dcb` are run from the repository root.

`cache/` and `build/` (fetched sources and build trees) are Docker volumes, not folders; `dist/` receives the packaged browser module; `.local/`
(git-ignored) can hold a corporate CA certificate as `corp-ca.pem`.
