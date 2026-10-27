'use strict';
// Positive and negative tests for scripts/validate-locks.js. Mutates the valid fixtures in
// memory, writes them to a temp dir and checks exit codes and messages.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const validator = path.join(root, 'scripts', 'validate-locks.js');
const load = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'valid', n), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));

let failed = 0;
function run(name, { sources, toolchain, features, extra = [] }, expectExit, expectText) {
  const files = {};
  const a = [validator, ...extra];
  for (const [k, v] of Object.entries({ sources, toolchain, features })) {
    if (!v) continue;
    files[k] = path.join(tmp, `${name.replace(/\W+/g, '_')}.${k}.json`);
    fs.writeFileSync(files[k], JSON.stringify(v));
    a.push(`--${k}`, files[k]);
  }
  const r = spawnSync(process.execPath, a, { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const ok = r.status === expectExit && (!expectText || out.includes(expectText));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) {
    failed++;
    console.log(`  expected exit ${expectExit}${expectText ? ` with "${expectText}"` : ''}, got ${r.status}\n${out}`);
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const S = load('sources.json'), T = load('toolchain.json'), F = load('features.json');

run('valid set passes', { sources: S, toolchain: T, features: F }, 0, 'validate-locks: PASS');

let t = clone(T); delete t.images['fixture-new'].digest;
run('image without digest fails', { toolchain: t }, 1, 'missing required "digest"');

t = clone(T); t.images['fixture-new'].digest = 'latest';
run('tag instead of digest fails', { toolchain: t }, 1, 'does not match');

let s = clone(S); s.releases[0].commit = '1111111';
run('abbreviated commit SHA fails', { sources: s }, 1, 'commit');

s = clone(S); delete s.releases[0].archiveSha256;
run('missing checksum fails', { sources: s }, 1, 'missing required "archiveSha256"');

s = clone(S); s.releases[1].major = '9.6';
run('wrong major fails', { sources: s }, 1, 'expected "10"');

s = clone(S); s.baseline = '17.1';
run('baseline not in releases fails', { sources: s }, 1, 'baseline');

t = clone(T); t.ranges[1].from = '9.5.0';
run('overlapping ranges fail', { toolchain: t }, 1, 'overlap');

t = clone(T); t.ranges[1].from = '11.0';
run('gap in ranges fails with --strict-coverage (release 10.5 uncovered)', { sources: S, toolchain: t, extra: ['--strict-coverage'] }, 1, 'not covered');
run('gap in ranges is only a warning by default', { sources: S, toolchain: t }, 0, 'WARNING');

t = clone(T); t.ranges[0].nativeImage = 'nope';
run('unknown image key fails', { toolchain: t }, 1, 'unknown image');

t = clone(T); t.extra = 1;
run('unknown field fails', { toolchain: t }, 1, 'unknown field');

let f = clone(F); f.features[2].appliesFrom = '19.0'; f.features[2].appliesTo = '18.0';
run('feature range reversed fails', { features: f }, 1, 'appliesFrom > appliesTo');

f = clone(F); f.features[0].configureFlag = 'without-icu';
run('bad configure flag fails', { features: f }, 1, 'configureFlag');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall lock-validator tests passed');
process.exit(failed ? 1 : 0);
