#!/bin/sh
# The browser module (TypeScript in web/src), in the web builder:
#   tools/dcb web sh scripts/web-lib.sh typecheck | lint | test | build
# The project is copied to the build volume, where its node_modules (TypeScript 7, oxlint, vitest) live, so nothing
# generated lands in the repository. `build` compiles to plain ES modules in /w/build/node/web-lib:
#   index, client, protocol, types, pg-driver (+ .d.ts)     the page-side library
#   engine-worker, idb-store, settings                      the Worker
set -eu
step="${1:?usage: web-lib.sh typecheck|lint|test|build}"
work=/w/build/node/web
if [ ! -d "$work/node_modules/typescript" ]; then
    echo "web-lib: installing dependencies (needs the network: run with DC_NET=1)"
    sh /w/scripts/web-install.sh web
fi
rm -rf "$work/src"
cp -a /w/web/src "$work/src"
for f in tsconfig.base.json tsconfig.lib.json tsconfig.worker.json .oxlintrc.json vitest.config.ts; do cp "/w/web/$f" "$work/$f"; done
cd "$work"
tsc=node_modules/.bin/tsc
case "$step" in
    typecheck)
        "$tsc" -p tsconfig.lib.json --noEmit
        "$tsc" -p tsconfig.worker.json --noEmit
        echo "web-lib: types ok" ;;
    lint)
        node_modules/.bin/oxlint src ;;
    test)
        node_modules/.bin/vitest run ;;
    build)
        out=/w/build/node/web-lib
        rm -rf "$out"
        "$tsc" -p tsconfig.lib.json --outDir "$out"
        "$tsc" -p tsconfig.worker.json --outDir "$out"
        echo "web-lib: built $out" ;;
    *) echo "web-lib: unknown step '$step'" >&2; exit 2 ;;
esac
