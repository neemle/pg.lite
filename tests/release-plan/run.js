'use strict';
// Tests of scripts/release-plan.js: the git tag is the PostgreSQL version, and only releases this repository can
// build (a patch series exists for their range) may be released.
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.resolve(__dirname, '..', '..', 'scripts', 'release-plan.js');
let failed = 0;
const run = (args) => spawnSync('node', [script, ...args], { encoding: 'utf8' });
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) { failed++; if (detail) console.log(`  ${detail}`); } };

let r = run(['v18.6']);
let plan = r.status === 0 ? JSON.parse(r.stdout) : {};
check('v18.6 is releasable, newest of its major and newest overall', r.status === 0 && plan.version === '18.6' && plan.major === '18' && plan.newestInMajor === true && plan.newestOverall === true, r.stderr);

r = run(['v17.11']);
plan = r.status === 0 ? JSON.parse(r.stdout) : {};
check('v17.11 uses the pg17 series and is not the newest overall', r.status === 0 && plan.range === 'pg17' && plan.newestInMajor === true && plan.newestOverall === false && plan.series.includes('wasm/series.pg17'), r.stderr);

r = run(['v17.10']);
plan = r.status === 0 ? JSON.parse(r.stdout) : {};
check('v17.10 is releasable but not the newest 17.x (it gets no major tag)', r.status === 0 && plan.newestInMajor === false, r.stderr);

r = run(['v16.15']);
check('v16.15 is releasable', r.status === 0 && JSON.parse(r.stdout).range === 'pg16', r.stderr);

r = run(['18.6']);
check('a tag without the v is refused (exit 3)', r.status === 3, `${r.status} ${r.stderr}`);

r = run(['v18.99']);
check('a version that is not an upstream release is refused (exit 3)', r.status === 3 && r.stderr.includes('not in sources.lock.json'), `${r.status} ${r.stderr}`);

r = run(['v9.0.23']);
check('a release whose range has no patch series yet is refused (exit 4)', r.status === 4 && r.stderr.includes('no'), `${r.status} ${r.stderr}`);

r = run(['--github', 'v18.6']);
check('--github prints KEY=value lines', r.status === 0 && /^version=18\.6$/m.test(r.stdout) && /^newestInMajor=true$/m.test(r.stdout), r.stdout);

r = run([]);
check('no tag is a usage error (exit 2)', r.status === 2, String(r.status));

if (failed) { console.log(`\n${failed} test(s) FAILED`); process.exit(1); }
console.log('\nall release-plan tests passed');
