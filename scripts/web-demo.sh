#!/bin/sh
# Build the Angular + TypeORM demo (web/demo) against the built browser module, in the web builder:
#   ./dcb web make web-demo VERSION=18.6          (needs: WEB=1 ./dcb wasm make wasm-build VERSION=18.6)
# The app is built in a copy under the build volume (fast node_modules, nothing generated lands in the repo):
#   page-side library  web/src/{index,client,protocol,types,pg-driver}.js  -> src/lib/pgwasm   (bundled by Angular)
#   Worker + engine    web/src/{engine-worker,idb-store}.js, postgres.{mjs,wasm,data}, manifest.json -> public/pgwasm
# Result: build/wasm/<version>/demo/  (static files; serve them with any HTTP server).
set -eu
ver="${VERSION:-18.6}"
work=/w/build/node/web-demo
engine="/w/build/wasm/$ver/web"
[ -f "$engine/postgres.wasm" ] || { echo "web-demo: no browser module for $ver; run  WEB=1 ./dcb wasm make wasm-build VERSION=$ver" >&2; exit 2; }
if [ ! -d "$work/node_modules/@angular/build" ]; then
    echo "web-demo: installing dependencies (needs the network: run with DC_NET=1)"
    sh /w/scripts/web-install.sh web/demo
fi
# TypeORM ships its PostgreSQL driver in the browser build but disables it through the "browser" field of its
# package.json (it expects node's "pg"). The driver is plain JavaScript over the module given as `driver`, which is
# exactly what createPgDriver() provides, so the one mapping that disables it is lifted in this build copy.
(cd "$work" && node -e '
const fs = require("fs");
const f = "node_modules/typeorm/package.json";
const p = JSON.parse(fs.readFileSync(f, "utf8"));
delete p.browser["./browser/driver/postgres/PostgresDriver.js"];
fs.writeFileSync(f, JSON.stringify(p, null, 2));
')
rm -rf "$work/src" "$work/public" "$work/dist"
cp -a /w/web/demo/src /w/web/demo/public "$work/" 2>/dev/null || cp -a /w/web/demo/src "$work/"
cp /w/web/demo/angular.json /w/web/demo/tsconfig.json /w/web/demo/tsconfig.app.json /w/web/demo/package.json "$work/"
mkdir -p "$work/src/lib/pgwasm" "$work/public/pgwasm"
for f in index client protocol types pg-driver; do cp "/w/web/src/$f.js" "$work/src/lib/pgwasm/"; done
for f in engine-worker idb-store; do cp "/w/web/src/$f.js" "$work/public/pgwasm/"; done
cp "$engine/postgres.mjs" "$engine/postgres.wasm" "$engine/postgres.data" "$engine/manifest.json" "$work/public/pgwasm/"
cd "$work"
node node_modules/@angular/cli/bin/ng.js build
node /w/web/demo/tools/asset-manifest.js dist/demo/browser     # the file list and version the service worker precaches
rm -rf "/w/build/wasm/$ver/demo"
cp -a dist/demo/browser "/w/build/wasm/$ver/demo"
echo "web-demo: built /w/build/wasm/$ver/demo"
du -sk "/w/build/wasm/$ver/demo" | sed 's/^/  KB: /'
