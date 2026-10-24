# Browser builder/test image: Node, Chromium and the Playwright runtime, for building the demo app and
# running the browser tests (tests/browser, W01-W09). Use it through ./dcb web <command>.
#
# The Playwright version is pinned here and in tests/browser/package.json: the image carries exactly the
# browser builds that version drives. Base pinned by tag; the digest is recorded in toolchain.lock.json by
# scripts/update-toolchain-lock.js once that learns about this builder (CDB-17).
FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends make git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 # Marker the Makefile checks so make refuses to run outside a project container.
 && touch /.compactdb-builder

ENV COMPACTDB_BUILDER=web
WORKDIR /w
