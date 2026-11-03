# Browser builder/test image: Node, Chromium and the Playwright runtime, for building the demo app and
# running the browser tests (wasm/tests/browser, W01-W09). Use it through tools/dcb web <command>.
#
# The Playwright version is pinned here and in wasm/tests/browser/package.json: the image carries exactly the
# browser builds that version drives. Base pinned by tag.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends make git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 # Marker the Makefile checks so make refuses to run outside a project container.
 && touch /.compactdb-builder

ENV COMPACTDB_BUILDER=web
WORKDIR /w
