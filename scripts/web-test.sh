#!/bin/sh
# Run the browser tests (Playwright + Chromium) against the built wasm module:
#   tools/dcb web make test-wasm VERSION=18.6            (needs: WEB=1 tools/dcb wasm make wasm-build VERSION=18.6)
# Extra arguments go to Playwright, e.g. --grep "transaction".
set -eu
ver="${VERSION:-18.6}"
deps="/w/build/node/tests-browser/node_modules"
[ -d "$deps/@playwright/test" ] || { echo "web-test: run  DC_NET=1 tools/dcb web sh scripts/web-install.sh tests/browser  first" >&2; exit 2; }
[ -f "/w/build/wasm/$ver/web/postgres.wasm" ] || { echo "web-test: no browser module for $ver; run  WEB=1 tools/dcb wasm make wasm-build VERSION=$ver" >&2; exit 2; }
export NODE_PATH="$deps" VERSION="$ver"
cd /w
sh /w/scripts/web-lib.sh build
exec node "$deps/@playwright/test/cli.js" test -c tests/browser/playwright.config.ts "$@"
