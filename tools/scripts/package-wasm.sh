#!/bin/sh
# Package the browser module of one release as a downloadable archive (tools container):
#   tools/dc make package-wasm VERSION=18.6      ->  dist/compact-db-wasm-18.6.tar.gz  (+ .sha256, + sizes in dist/compact-db-wasm-18.6.sizes.txt)
#
# The archive is what a web project needs, with the same file names the demo uses:
#   engine/   postgres.mjs, postgres.wasm, postgres.data (data files and bootstrap data directory), manifest.json
#   worker/   engine-worker.js, idb-store.js     serve these two (and the engine/ files) as static assets
#   lib/      index.js, client.js, protocol.js, types.js, pg-driver.js     import these from your code or bundle them
#   demo/     the Angular + TypeORM demo, built (when it was built)
#   SHA256SUMS, README.txt
set -eu
ver="${VERSION:?usage: VERSION=<x.y> package-wasm.sh}"
web="/w/build/wasm/$ver/web"
[ -f "$web/postgres.wasm" ] || { echo "package-wasm: no browser module for $ver ($web)" >&2; exit 2; }
name="compact-db-wasm-$ver"
stage="/tmp/$name"
rm -rf "$stage"; mkdir -p "$stage/engine" "$stage/worker" "$stage/lib" /w/dist
cp "$web/postgres.mjs" "$web/postgres.wasm" "$web/postgres.data" "$web/manifest.json" "$stage/engine/"
for f in engine-worker idb-store; do cp "/w/web/src/$f.js" "$stage/worker/"; done
for f in index client protocol types pg-driver; do cp "/w/web/src/$f.js" "$stage/lib/"; done
[ -d "/w/build/wasm/$ver/demo" ] && cp -a "/w/build/wasm/$ver/demo" "$stage/demo"
cat > "$stage/README.txt" <<EOF
compact.db WebAssembly build of PostgreSQL $ver (single-user engine in a Worker, data in IndexedDB).

Serve engine/ and worker/ as static files from one directory (keep postgres.mjs, postgres.wasm, postgres.data and
manifest.json together; engine-worker.js and idb-store.js together), then:

  import { PostgresWasm } from './lib/index.js';
  const db = await PostgresWasm.open({
    workerUrl: 'worker/engine-worker.js', engineUrl: 'engine/postgres.mjs', storage: { name: 'mydb' } });
  const { rows } = await db.query('select \$1::int + 1 as n', [41]);
  await db.transaction(async (tx) => { await tx.query('insert ...'); });
  await db.close();

For libraries written for node-postgres (TypeORM): import { createPgDriver } from './lib/index.js' and pass
driver: createPgDriver(db) to the data source. The module needs a browser with JavaScript Promise Integration
(Chromium 137 or newer). Source, patches and documentation: the repository this archive was released from (docs/wasm.md).
EOF
(cd "$stage" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS)
tar -C /tmp -cf - "$name" | gzip -9 > "/w/dist/$name.tar.gz"
(cd /w/dist && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
{
  echo "compact.db WebAssembly build $ver: payload sizes (bytes)"
  for f in postgres.wasm postgres.data; do
    printf '%-16s raw %10s  gzip -9 %10s\n' "$f" "$(wc -c < "$web/$f")" "$(gzip -9 -c "$web/$f" | wc -c)"
  done
  printf '%-16s %10s\n' "archive (tar.gz)" "$(wc -c < "/w/dist/$name.tar.gz")"
} | tee "/w/dist/$name.sizes.txt"
echo "package-wasm: /w/dist/$name.tar.gz"
