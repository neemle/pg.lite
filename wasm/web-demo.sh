#!/bin/sh
# The Angular + TypeORM demo (wasm/demo) on the built browser module, in the web builder:
#   tools/dcb web make web-demo VERSION=18.6            build it  (needs: WEB=1 tools/dcb wasm make wasm-build VERSION=18.6)
#   tools/dcb web sh wasm/web-demo.sh test           unit tests of the app (vitest, through ng test)
#   tools/dcb web sh wasm/web-demo.sh lint           oxlint
# The app is built in a copy under the build volume (fast node_modules, nothing generated lands in the repo):
#   page-side library  compiled from wasm/src (wasm/web-lib.sh build): {index,client,protocol,types,pg-driver}.js + .d.ts  -> src/lib/pgwasm   (bundled by Angular)
#   Worker + engine    {engine-worker,idb-store,settings}.js, postgres.{mjs,wasm,data}, manifest.json -> public/pgwasm
#   service worker     service-worker/sw.ts compiled to public/sw.js
# Result: build/wasm/<version>/demo/  (static files; serve them with any HTTP server).
set -eu
mode="${1:-build}"
ver="${VERSION:-18.6}"
work=/w/build/node/web-demo
engine="/w/build/wasm/$ver/web"
if [ "$mode" = build ] && [ ! -f "$engine/postgres.wasm" ]; then
    echo "web-demo: no browser module for $ver; run  WEB=1 tools/dcb wasm make wasm-build VERSION=$ver" >&2
    exit 2
fi
if [ ! -d "$work/node_modules/@angular/build" ]; then
    echo "web-demo: installing dependencies (needs the network: run with DC_NET=1)"
    sh /w/wasm/web-install.sh wasm/demo
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
cp -a /w/wasm/demo/src /w/wasm/demo/public "$work/"
for f in angular.json tsconfig.json tsconfig.app.json tsconfig.spec.json package.json .oxlintrc.json; do cp "/w/wasm/demo/$f" "$work/"; done
mkdir -p "$work/src/lib/pgwasm" "$work/public/pgwasm"
lib=/w/build/node/web-lib
sh /w/wasm/web-lib.sh build
for f in index client protocol types pg-driver; do cp "$lib/$f.js" "$lib/$f.d.ts" "$work/src/lib/pgwasm/"; done
for f in engine-worker idb-store settings; do cp "$lib/$f.js" "$work/public/pgwasm/"; done
# the service worker is TypeScript too: compiled with the same TypeScript 7 as the module
/w/build/node/web/node_modules/.bin/tsc --target ES2023 --module ESNext --lib ES2023,WebWorker --strict --types "" --skipLibCheck \
    --rootDir /w/wasm/demo/service-worker --outDir "$work/public" /w/wasm/demo/service-worker/sw.ts
cd "$work"
case "$mode" in
    lint)
        node_modules/.bin/oxlint src/app src/main.ts
        exit 0 ;;
    test)
        node node_modules/@angular/cli/bin/ng.js test --watch=false
        exit 0 ;;
    build) ;;
    *) echo "web-demo: unknown mode '$mode'" >&2; exit 2 ;;
esac
cp "$engine/postgres.mjs" "$engine/postgres.wasm" "$engine/postgres.data" "$engine/manifest.json" "$work/public/pgwasm/"
node node_modules/@angular/cli/bin/ng.js build
node /w/wasm/demo/tools/asset-manifest.ts dist/demo/browser     # the file list and version the service worker precaches
rm -rf "/w/build/wasm/$ver/demo"
cp -a dist/demo/browser "/w/build/wasm/$ver/demo"
echo "web-demo: built /w/build/wasm/$ver/demo"
du -sk "/w/build/wasm/$ver/demo" | sed 's/^/  KB: /'
