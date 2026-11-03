'use strict';
// Tests for scripts/feature-profile.js using the real `configure --help` output of 18.6
// (tests/feature/configure-help-18.6.txt) and mutated copies of feature-profile.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const tool = path.join(root, 'scripts', 'feature-profile.js');
const help = path.join(__dirname, 'configure-help-18.6.txt');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'feature-profile.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-'));
let failed = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));

function run(name, args, code, text, prof) {
  const a = [tool, ...args];
  if (prof) {
    const f = path.join(tmp, `${name.replace(/\W+/g, '_')}.json`);
    fs.writeFileSync(f, JSON.stringify(prof));
    a.push('--profile', f);
  }
  const r = spawnSync(process.execPath, a, { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const ok = r.status === code && (!text || out.includes(text));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { failed++; console.log(`  expected exit ${code}${text ? ` with "${text}"` : ''}, got ${r.status}\n${out}`); }
}

run('real profile passes against the real 18.6 help', ['check', '--help-file', help], 0, 'PASS');

let p = clone(profile); p.features[0].upstreamOptions = ['--with-doesnotexist'];
run('unknown upstream option fails', ['check', '--help-file', help], 1, 'does not exist', p);

p = clone(profile); p.features.find((f) => f.name === 'icu').configureFlag = '--without-icuu';
run('misspelled configureFlag fails', ['check', '--help-file', help], 1, '--without-icuu', p);

p = clone(profile); p.features = p.features.filter((f) => f.name !== 'zstd');
run('missing required item fails', ['check', '--help-file', help], 1, 'required item "zstd"', p);

p = clone(profile); delete p.features.find((f) => f.name === 'ldap').bootstrapImpact;
run('missing impact field fails', ['check', '--help-file', help], 1, 'ldap: "bootstrapImpact"', p);

p = clone(profile); p.features.find((f) => f.name === 'ldap').configureFlag = '--with-ldap';
run('excluded entry with an enabling flag fails', ['check', '--help-file', help], 1, 'turns something on', p);

const empty = path.join(tmp, 'empty.txt'); fs.writeFileSync(empty, 'nothing here\n');
run('wrong configure help input fails', ['check', '--help-file', empty], 1, 'wrong input');

// matrix: generated file must match; a stale file must be detected.
const out = path.join(tmp, 'matrix.md');
run('matrix generates', ['matrix', '--out', out], 0, 'wrote');
run('fresh matrix passes --check', ['matrix', '--check', '--out', out], 0, 'up to date');
fs.appendFileSync(out, 'stale edit\n');
run('stale matrix fails --check', ['matrix', '--check', '--out', out], 1, 'out of date');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall feature-profile tests passed');
process.exit(failed ? 1 : 0);
