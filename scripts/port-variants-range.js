#!/usr/bin/env node
'use strict';
// Walk a range and add the patch variants its releases need (maintainer tool, tools container, network on):
//
//   DC_NET=1 FETCH_HTTP_FALLBACK=1 ./dc node scripts/port-variants-range.js pg12 [--up] [--wasm-only]
//
// Without --up the walk goes from the newest release of the range down: every release that does not apply yet (per
// reports/release-apply.json) gets scripts/port-variants.js --from <the release just above> --to <it>. With --up it goes from
// the oldest release up and looks at every release; that is the way for ranges with optional entries ("a.patch|-" in a
// series), whose patch was written for the oldest release. --wasm-only limits the work to the wasm series.
// Mechanical merge conflicts are resolved with scripts/port-resolve.js (snowball, dfmgr, empty target side, object lists)
// and the one known hand-written rule below; the first conflict that needs a human stops the run (exit 3) with the file
// named, as port-variants.js does: resolve it and run again.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const range = process.argv[2];
if (!range || range.startsWith('--')) { console.error('usage: port-variants-range.js <range> [--up] [--wasm-only]'); process.exit(2); }
const up = process.argv.includes('--up');
const targetsArg = process.argv.includes('--wasm-only') ? ['--targets', 'wasm'] : [];
const report = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'release-apply.json'), 'utf8'));
const key = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const versions = Object.keys(report).filter((v) => report[v].range === range).sort(cmp);
if (!up) versions.reverse();
const run = (cmd, a) => spawnSync(cmd, a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const fetch = (v) => { const r = run('sh', ['scripts/fetch.sh', v]); if (r.status !== 0) throw new Error(`fetch ${v}: ${r.stdout}${r.stderr}`); };
const applies = (v) => !up && report[v].native === 'ok' && report[v].wasm === 'ok';

let prev = versions[0];
if (!up && !applies(prev)) throw new Error(`the newest release ${prev} of ${range} does not apply`);
for (const v of versions.slice(1)) {
  if (applies(v)) { prev = v; continue; }
  fetch(prev); fetch(v);
  let result;
  for (let i = 0; i < 40; i++) {
    result = run('node', ['scripts/port-variants.js', '--range', range, '--from', prev, '--to', v, ...targetsArg]);
    const m = /edit (build[^ ]*\.conflict) /.exec(`${result.stdout}${result.stderr}`);
    if (result.status === 0 || !m) break;
    const c = m[1];
    // after the security releases the receive call is preceded by "errno = 0"; older minors lack that line
    const text = fs.readFileSync(path.join(root, c), 'utf8');
    const blocks = [...text.matchAll(/^<<<<<<< [^\n]*\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm)];
    if (blocks.length === 1 && blocks[0][1].includes('wasm_embed_read') && blocks[0][1].includes('\t\terrno = 0;\n\n') && !blocks[0][3].includes('errno = 0;')) {
      fs.writeFileSync(path.join(root, c.replace(/\.conflict$/, '')), text.replace(blocks[0][0], blocks[0][1].replace('\t\terrno = 0;\n\n', '')));
      continue;
    }
    let r;
    if (/snowball/.test(c)) r = run('node', ['scripts/port-resolve.js', c]);
    else if (/dfmgr/.test(c)) r = run('node', ['scripts/port-resolve.js', c, '#ifdef PG_STATIC_MODULES']);
    else { r = run('node', ['scripts/port-resolve.js', c, '--auto']); if (r.status !== 0) r = run('node', ['scripts/port-resolve.js', c, '--objs']); }
    if (r.status !== 0) { console.log(`needs a human: ${c} (${prev} -> ${v})`); process.exit(3); }
  }
  const said = (result.stdout || '').trim().split('\n').filter((l) => /VARIANT|variants:/.test(l)).join('; ');
  console.log(`${prev} -> ${v}: ${said || (result.stderr || '').trim().split('\n')[0].slice(0, 300)}`);
  if (result.status !== 0) process.exit(1);
  fs.rmSync(path.join(root, 'cache', 'src', prev), { recursive: true, force: true });   // v stays: the next step's --from
  prev = v;
}
console.log(`port-variants-range: ${range} done`);
