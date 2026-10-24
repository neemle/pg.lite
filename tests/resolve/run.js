'use strict';
// Tests for scripts/resolve.js and the "no version logic outside data" rule.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const tool = path.join(root, 'scripts', 'resolve.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-'));
let failed = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const loadJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

function run(args) { return spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' }); }
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { failed++; if (detail) console.log(`  ${detail}`); }
}
function withFile(name, obj) { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; }

// --- the real data
let r = run(['18.6']);
let plan = r.status === 0 ? JSON.parse(r.stdout) : null;
check('18.6 resolves to the pg18 range with both builder digests', !!plan && plan.range === 'pg18'
  && /^sha256:[0-9a-f]{64}$/.test(plan.builders.native.digest) && /^sha256:[0-9a-f]{64}$/.test(plan.builders.wasm.digest)
  && plan.builders.native.key === 'musl-18' && plan.builders.wasm.key === 'wasm-18', r.stderr);
check('18.6 plan carries the locked commit and checksum', !!plan && plan.commit === '724edf9bde9d356724ad384a2e196edc3c9f80f7'
  && plan.archive.sha256 === '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f');
check('plan references the series files of its range', !!plan && plan.patches.map((p) => `${p.target}:${p.series}`).join(',') === 'common:series,native:series,wasm:series');
check('plan is deterministic (two runs are byte-identical)', run(['18.6']).stdout === r.stdout);

r = run(['9.0.23', '--allow-missing-builder']);
plan = r.status === 0 ? JSON.parse(r.stdout) : null;
check('9.0.23 resolves to pg9 with its own series and no builder yet', !!plan && plan.range === 'pg9' && plan.builders === null
  && plan.patches[1].series === 'series.pg9', r.stderr);
r = run(['9.0.23']);
check('9.0.23 without --allow-missing-builder fails with exit 5', r.status === 5 && r.stderr.includes('no builder range'), `${r.status} ${r.stderr}`);

for (const [v, id] of [['9.0.0', 'pg9'], ['9.0.23', 'pg9'], ['9.1.24', 'pg9-1'], ['9.2.24', 'pg9-2'], ['9.3.25', 'pg9-3'], ['9.4.26', 'pg9-4'], ['9.5.25', 'pg9-5'], ['9.6.24', 'pg9-6'], ['10.0', 'pg10'], ['11.22', 'pg11'], ['12.22', 'pg12'], ['13.23', 'pg13'], ['14.24', 'pg14'], ['15.19', 'pg15'], ['16.15', 'pg16'], ['17.11', 'pg17']]) {
  r = run([v, '--allow-missing-builder']);
  check(`${v} resolves to ${id}`, r.status === 0 && JSON.parse(r.stdout).range === id, r.stderr);
}

r = run(['99.9', '--allow-missing-builder']);
check('a version outside the index fails with exit 3', r.status === 3 && r.stderr.includes('not in the release index'), `${r.status} ${r.stderr}`);

r = run(['--check-all', '--allow-missing-builder']);
check('every release in the index resolves (builder gaps tolerated)', r.status === 0 && /351 of 351 releases resolve/.test(r.stdout), `${r.status} ${r.stdout}${r.stderr}`);

// --- mutated data
const ranges = loadJson('ranges.json');
let m = clone(ranges); m.ranges = m.ranges.filter((x) => x.id !== 'pg11');
r = run(['11.5', '--allow-missing-builder', '--ranges', withFile('gap.json', m)]);
check('an uncovered version fails with exit 4', r.status === 4 && r.stderr.includes('no range'), `${r.status} ${r.stderr}`);

m = clone(ranges); m.ranges[0].to = '10.5';
r = run(['10.1', '--allow-missing-builder', '--ranges', withFile('overlap.json', m)]);
check('overlapping ranges fail with exit 4', r.status === 4 && r.stderr.includes('all cover'), `${r.status} ${r.stderr}`);

m = clone(ranges); m.ranges.find((x) => x.id === 'pg18').patches.native = 'series.doesnotexist';
r = run(['18.6', '--ranges', withFile('missingseries.json', m)]);
check('a range naming a missing series file fails with exit 6', r.status === 6 && r.stderr.includes('does not exist'), `${r.status} ${r.stderr}`);

// validate-locks proves the model tiles the index (and catches a hole)
const vl = (rangesFile) => spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-locks.js'), '--ranges', rangesFile], { encoding: 'utf8' });
let v = vl(path.join(root, 'ranges.json'));
check('validate-locks accepts ranges.json against the 351-release index', v.status === 0 && v.stdout.includes('ranges: OK'), v.stdout + v.stderr);
m = clone(ranges); m.ranges = m.ranges.filter((x) => x.id !== 'pg11');
v = vl(withFile('hole.json', m));
check('validate-locks rejects a hole in the ranges', v.status === 1 && v.stderr.includes('covered by 0 ranges'), v.stdout + v.stderr);

// --- no version-conditional logic outside the data files
const SHELL_RES = [
  /\[\s+["']?\$\{?(?:VERSION|ver|version|MAJOR|major)\}?["']?\s+(?:-[a-z]{2}|==?|!=|<|>)\s+["']?[0-9]/,
  /\bcase\s+["']?\$\{?(?:VERSION|ver|version|MAJOR|major)\b/,
];
const JS_RES = [/\b(?:version|major|ver)\s*(?:[<>]=?|===?|!==?)\s*['"]?\d/];
const ALLOWED = new Set(['scripts/release-index.js', 'scripts/validate-locks.js', 'scripts/resolve.js']);
function findings(file, text) {
  const res = file.endsWith('.js') ? JS_RES : SHELL_RES;
  return text.split('\n').flatMap((line, i) => (res.some((re) => re.test(line)) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
}
check('detector flags a shell version conditional (negative control)', findings('x.sh', 'if [ "$VERSION" -ge 12 ]; then').length === 1);
check('detector flags a case on the version (negative control)', findings('x.sh', 'case "$ver" in').length === 1);
check('detector flags a JS version comparison (negative control)', findings('x.js', 'if (version >= 12) {').length === 1);
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => {
  const rel = `${d}/${e.name}`;
  return e.isDirectory() ? walk(rel) : [rel];
});
const files = [...walk('scripts'), ...walk('docker'), 'Makefile', 'dc', 'dcb'].filter((f) => !ALLOWED.has(f) && /(\.sh|\.js|Dockerfile|Makefile|^dc|^dcb)$/.test(f));
const bad = files.flatMap((f) => findings(f, fs.readFileSync(path.join(root, f), 'utf8')));
check(`no version-conditional logic in ${files.length} scripts/Dockerfiles outside the data files`, bad.length === 0, bad.join('\n  '));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall resolver tests passed');
process.exit(failed ? 1 : 0);
