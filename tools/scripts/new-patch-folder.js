#!/usr/bin/env node
'use strict';
// Starts the patch folder of a new tested version from the nearest one (tools container, network for the fetch):
//
//   tools/dc make fetch VERSION=17.12
//   tools/dc node scripts/new-patch-folder.js --from 17.11 --to 17.12
//
// Copies patches/<from> to patches/<to>, then applies the native and the wasm patches to cache/src/<to> exactly as
// `make native-src` / `make wasm-src` do (fuzz 0) and says which patch, if any, no longer fits. A patch that does not
// fit is edited by hand (the folder is plain files: `patch -p1 --dry-run` shows what moved) and the tool is run again
// with --check to see the result. When the copy applies unchanged the new folder is redundant: it is removed again,
// the release is served by the nearest folder (scripts/resolve.js <version> --patch-args lists the candidates).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const from = arg('from');
const to = arg('to');
const check = process.argv.includes('--check');
if (!to || (!from && !check)) { console.error('usage: new-patch-folder.js --from <tested version> --to <version> | --to <version> --check'); process.exit(2); }
const dst = path.join(root, 'patches', to);
if (!check) {
  if (fs.existsSync(dst)) { console.error(`new-patch-folder: patches/${to} exists already (use --check)`); process.exit(1); }
  fs.cpSync(path.join(root, 'patches', from), dst, { recursive: true });
}
let bad = 0;
for (const target of ['native', 'wasm']) {
  const r = spawnSync('node', [path.join(__dirname, 'patches.js'), 'apply', '--src', path.join(root, 'cache', 'src', to), '--out', path.join(root, 'build', 'new-patch-folder', target), '--target', target, '--patch-dir', to], { encoding: 'utf8' });
  fs.rmSync(path.join(root, 'build', 'new-patch-folder'), { recursive: true, force: true });
  if (r.status === 0) console.log(`${target}: patches/${to} applies`);
  else { bad++; console.log(`${target}: does not apply\n${(r.stderr || '').split('\n').slice(0, 12).join('\n')}`); }
}
if (!bad && !check) {
  fs.rmSync(dst, { recursive: true, force: true });
  console.log(`the copy of ${from} applies unchanged to ${to}: no folder needed, ${to} is served by the nearest tested version`);
}
process.exit(bad ? 1 : 0);
