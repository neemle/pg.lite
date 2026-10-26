# compact.db

PostgreSQL, minimal: the same upstream release, built two ways.

* **Docker image.** A fully static musl `postgres` in a `FROM scratch` image: no shell, no loader, no shared object.
  See [docs/native.md](docs/native.md).
* **Browser module.** PostgreSQL compiled to WebAssembly, running in a Worker with its data in IndexedDB, with a
  JavaScript API (and a `pg`-compatible facade, so TypeORM works on it). See [docs/wasm.md](docs/wasm.md).

This repository holds scripts, Dockerfiles and patches. It never holds PostgreSQL itself: the source of an exact
release is fetched at build time and checked against the SHA-256 pinned in [sources.lock.json](sources.lock.json).

## Versions

A git tag is a PostgreSQL version: **`v18.6` is PostgreSQL 18.6**, with this repository's patches and nothing else.
Every release from `v9.0` to `v18.x` has a parallel line of drop-in replacements for the upstream releases of the same number.

| Major | Status |
| --- | --- |
| 18 | baseline, builds and passes the tests (native image, WebAssembly, browser tests) |
| 17 down to 9.0 | patch series ported from 18 ([docs/patches.md](docs/patches.md)); built and tested per release by the release workflow. 9.0 to 9.6 are one range each (they differ most). Every one of the 351 releases takes its series and the touched files compile ([reports/release-apply.json](reports/release-apply.json), `scripts/check-releases.js`); the oldest minor of every range is built and tested |

Pushing a tag `vX.Y` runs [.github/workflows/release.yml](.github/workflows/release.yml): it builds and tests that exact
release and publishes the browser module as a GitHub release (`compact-db-wasm-X.Y.tar.gz` with its checksum) and the
image to Docker Hub as `<DOCKERHUB_REPOSITORY>:X.Y` (also `:X` for the newest X.y, `:latest` for the newest release overall).
Set the repository variable `DOCKERHUB_REPOSITORY` (for example `org/postgres`) and the secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` first: a tag build fails at once without them.
"Run workflow" on the same workflow does a dry run of any version without publishing.

## Use

```sh
# the image: first start with an empty volume
docker run -d --name pg -e POSTGRES_PASSWORD=change-me -v pgdata:/var/lib/postgresql/data -p 5432:5432 <org>/postgres:18.6
```

```js
// the browser module (Chromium 137+ for JavaScript Promise Integration); files from compact-db-wasm-18.6.tar.gz
import { PostgresWasm } from './lib/index.js';
const db = await PostgresWasm.open({ workerUrl: 'worker/engine-worker.js', engineUrl: 'engine/postgres.mjs', storage: { name: 'app' } });
const { rows } = await db.query('select $1::int + 1 as n', [41]);
```

The archive also contains a built demo: an Angular app that stores notes with TypeORM in the browser database
(source in [web/demo](web/demo)).

## Build and test

Nothing runs on the host but `docker` and `git`; every target runs in a container ([docs/build.md](docs/build.md)).

```sh
./dc make selftest                              # repository checks, no network
./dc make fetch VERSION=18.6 && ./dc make wasm-src VERSION=18.6
./dcb wasm make wasm-build VERSION=18.6         # then:  WEB=1 ./dcb wasm make wasm-build VERSION=18.6
./dcb web make test-wasm VERSION=18.6           # Chromium tests of the engine, persistence and the demo
```

Release-build details: [docs/wasm.md](docs/wasm.md) (browser) and [docs/native.md](docs/native.md) (image).
How releases differ from each other is data, not code: [docs/ranges.md](docs/ranges.md).

## Licence

This repository (scripts, Dockerfiles, patches, the web module and the demo) is under the [MIT License](LICENSE).
PostgreSQL itself is under the PostgreSQL License ([licenses/postgresql](licenses/postgresql)); it is not part of this
repository, and the images and archives built from it contain PostgreSQL code under that licence. Third-party
material used here is listed in [THIRD_PARTY.md](THIRD_PARTY.md).
