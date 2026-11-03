#!/usr/bin/env node
'use strict';
// Feature profile tooling (run in the tools container).
//
//   feature-profile.js check  [--version V] [--help-file FILE] [--profile FILE]
//       Every configure option the profile names must exist in that release's real
//       `configure --help` (taken from cache/src/<V> unless --help-file is given), every entry
//       needs its impact fields, and the items the project requires must be present.
//   feature-profile.js matrix [--check] [--profile FILE] [--out FILE]
//       Generates docs/feature-matrix.md from the profile; with --check only compares.
//
// Exit codes: 0 ok, 1 check failed, 2 usage error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const [cmd, ...rest] = process.argv.slice(2);
const opt = { profile: path.join(root, 'feature-profile.json'), out: path.join(root, 'docs', 'feature-matrix.md'), check: false, version: null, helpFile: null };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--check') opt.check = true;
  else if (a === '--version') opt.version = rest[++i];
  else if (a === '--help-file') opt.helpFile = path.resolve(rest[++i] || '');
  else if (a === '--profile') opt.profile = path.resolve(rest[++i] || '');
  else if (a === '--out') opt.out = path.resolve(rest[++i] || '');
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}

// Items the project requires a decision for (task CDB-20 / feature matrix).
const REQUIRED = ['llvm-jit', 'icu', 'xml', 'xslt', 'plpython', 'plperl', 'pltcl', 'ldap', 'gssapi', 'pam', 'systemd',
  'readline', 'zlib', 'lz4', 'zstd', 'openssl-tls', 'plpgsql', 'snowball', 'contrib'];

const profile = JSON.parse(fs.readFileSync(opt.profile, 'utf8'));

// ---- option parsing: --with-x / --without-x are one option "with:x"; enable/disable "enable:x".
function optionKey(flag) {
  const m = /^--(with|without|enable|disable)-([a-z0-9-]+)/.exec(flag);
  if (!m) return null;
  return `${m[1] === 'with' || m[1] === 'without' ? 'with' : 'enable'}:${m[2]}`;
}
function helpOptions(text) {
  const keys = new Set();
  for (const m of text.matchAll(/--(?:with|without|enable|disable)-[A-Za-z0-9-]+/g)) {
    const k = optionKey(m[0]);
    if (k) keys.add(k);
  }
  return keys;
}

function check() {
  const errors = [];
  let help;
  if (opt.helpFile) help = fs.readFileSync(opt.helpFile, 'utf8');
  else {
    const version = opt.version || JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json'), 'utf8')).baseline;
    const dir = path.join(root, 'cache', 'src', version);
    if (!fs.existsSync(path.join(dir, 'configure'))) { console.error(`no fetched tree at ${dir}; run tools/dc make fetch VERSION=${version}`); process.exit(2); }
    const r = spawnSync('sh', ['./configure', '--help'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) { console.error(`configure --help failed: ${r.stderr}`); process.exit(2); }
    help = r.stdout;
  }
  const known = helpOptions(help);
  if (known.size < 20) errors.push(`configure --help parsed to only ${known.size} options; wrong input?`);

  const names = new Set();
  for (const f of profile.features) {
    names.add(f.name);
    const flags = [...(f.upstreamOptions || [])];
    if (f.configureFlag) flags.push(f.configureFlag);
    for (const flag of flags) {
      const k = optionKey(flag);
      if (!k || !known.has(k)) errors.push(`${f.name}: option ${flag} does not exist in this release's configure --help`);
    }
    for (const field of ['behaviorImpact', 'bootstrapImpact', 'sizeImpact']) {
      if (!f[field] || !f[field].trim()) errors.push(`${f.name}: "${field}" is missing`);
    }
    if (f.state === 'excluded' && f.configureFlag && !/^--(without|disable)-/.test(f.configureFlag)) {
      errors.push(`${f.name}: excluded but configureFlag ${f.configureFlag} turns something on`);
    }
  }
  for (const n of REQUIRED) if (!names.has(n)) errors.push(`required item "${n}" has no entry`);

  if (errors.length) { console.error('feature-profile check: FAIL'); errors.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }
  console.log(`feature-profile check: PASS (${profile.features.length} entries, ${known.size} upstream options known)`);
}

// ---- matrix ---------------------------------------------------------------------------
const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
function matrix() {
  const rows = profile.features.map((f) => {
    const flag = f.configureFlag ? `\`${f.configureFlag}\`` : 'none (default)';
    const up = (f.upstreamOptions || []).map((o) => `\`${o}\``).join(', ') || '-';
    return `| ${cell(f.name)} | ${f.state} | ${flag} | ${up} | ${cell(f.reason)} | ${cell(f.behaviorImpact)} | ${cell(f.bootstrapImpact)} | ${cell(f.sizeImpact)} |`;
  });
  const text = [
    '# Feature matrix',
    '',
    'Generated from `feature-profile.json` by `scripts/feature-profile.js matrix`; do not edit by hand.',
    'Every option named here was checked against the real `configure --help` of the pinned release',
    '(`tools/dc make feature-check`). Sizes are not measured yet: the column says so explicitly and is',
    'filled by the size/performance story (CDB-10).',
    '',
    '| Feature | State | Flag passed | Upstream option(s) | Why | Behavior impact | Bootstrap impact | Size impact |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  if (opt.check) {
    const cur = fs.existsSync(opt.out) ? fs.readFileSync(opt.out, 'utf8') : '';
    if (cur !== text) { console.error(`feature matrix ${path.relative(root, opt.out)} is out of date; run tools/dc make feature-matrix`); process.exit(1); }
    console.log('feature matrix is up to date');
  } else {
    fs.writeFileSync(opt.out, text);
    console.log(`wrote ${path.relative(root, opt.out)}`);
  }
}

if (cmd === 'check') check();
else if (cmd === 'matrix') matrix();
else { console.error('usage: feature-profile.js check|matrix [options]'); process.exit(2); }
