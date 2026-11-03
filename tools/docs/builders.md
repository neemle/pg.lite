# Builder images

Two Dockerized builders for the 18.x baseline. Nothing is compiled on the host. Start a builder
with `tools/dcb <musl|wasm> <command>`; it builds the image from `docker/builders/<name>/Dockerfile`
(cached after the first run), mounts the repo at `/w` and the shared `cache/` and `build/`
volumes (see `docs/build.md`), and has no network.

| Builder | Dockerfile | Base (pinned by digest) | Produces |
| --- | --- | --- | --- |
| `musl` | `docker/builders/musl/Dockerfile` | `alpine:3.24.3` | fully static x86_64 ELF against musl |
| `wasm` | `docker/builders/wasm/Dockerfile` | `emscripten/emsdk:6.0.13` | wasm32 via Emscripten |
| `ref` | `docker/builders/ref/Dockerfile` | `debian:bookworm-slim` | unmodified upstream, dynamic glibc, for the reference build (`docs/reference.md`) |

The digests and the exact tool versions that were built are in `toolchain.lock.json`
(gcc 15.2.0 / musl 1.2.6-r3 / binutils 2.45.1 for `musl`; Emscripten 6.0.13 / clang 24.0.0 /
Binaryen 133 / node 24.19.0 for `wasm`). That file is **generated**:

```sh
tools/dcb musl make capture-toolchain     # measures versions inside the builder -> build/toolchain/musl.json
tools/dcb wasm make capture-toolchain
tools/dc  make update-toolchain-lock      # FROM digests + captured versions -> toolchain.lock.json, then validates
```

## Proof that each builder works

```sh
tools/dcb musl make builder-check
tools/dcb wasm make builder-check
```

- `musl`: gcc targets `x86_64-alpine-linux-musl`; a hello-world built with `-static` runs, has **no
  `PT_INTERP`** and **no `DT_NEEDED`** (`readelf`), loses `.symtab`/`.debug_*` when stripped and
  still runs. Negative control: the same program built dynamically *does* show `PT_INTERP` and
  `DT_NEEDED`, so the check can fail.
- `wasm`: `emcc -O2` builds a hello-world that runs under the SDK's node. Negative control: the
  same module truncated to 40 bytes is rejected.

## Known limits

- The base images are pinned by digest. The extra packages (`apk` on Alpine, `apt` on the SDK
  image) are installed from the distributions' current repositories at build time and are **not**
  version-pinned; the versions actually built are recorded by `capture-toolchain.sh`, so a
  rebuild that drifts is visible as a diff in `toolchain.lock.json`. Pinning them (or snapshot
  mirrors) is open work. The same builders compile every release from 9.0 to 18 (old sources get per-range `cflags` in `ranges.json`).
- Sizes on this host: `musl` 491 MB, `wasm` 3.49 GB (the SDK image alone is 3.48 GB), tools
  image 469 MB. First builds took about 2.5 and 3.5 minutes plus the base image download.
- The Emscripten cache inside the SDK image is writable by root only. This was exercised on
  Docker Desktop for Windows (runs as root); on a Linux host `tools/dc` passes `--user <uid>:<gid>` and
  emcc may need a writable `EM_CACHE`. Not yet tested on Linux.

## Host check (CDB-17 step 1)

Docker server 29.8.2 (linux/amd64) via Docker Desktop on Windows 11 is available and was used for
everything above.
