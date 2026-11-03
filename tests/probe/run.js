'use strict';
// Offline tests for scripts/probe.js: option mapping, skipping of absent options, capability
// detection from a fixture tree, and the CLI on a fixture tree.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const P = require(path.join(root, 'scripts', 'probe.js'));
const profile = JSON.parse(fs.readFileSync(path.join(root, 'feature-profile.json'), 'utf8'));
const capabilities = JSON.parse(fs.readFileSync(path.join(root, 'capabilities.json'), 'utf8')).capabilities;
const help18 = fs.readFileSync(path.join(root, 'tests', 'feature', 'configure-help-18.6.txt'), 'utf8');
// A help text as an older release prints it: no ICU, LZ4, ZSTD, libcurl, liburing, libnuma, ssl=LIB.
const help9 = help18.split('\n').filter((l) => !/--(?:without-icu|with-lz4|with-zstd|with-libcurl|with-liburing|with-libnuma|with-ssl|with-openssl)\b/.test(l)).join('\n');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}
const known18 = P.helpOptions(help18);
const known9 = P.helpOptions(help9);

t('real 18.6 help: the profile flags all exist, nothing is skipped', () => {
  const r = P.buildArgs({ known: known18, profile, rangeConfigure: [], prefix: '/usr/local/pgsql' });
  assert.deepStrictEqual(r.args, ['--prefix=/usr/local/pgsql', '--without-icu', '--without-readline', '--without-zlib']);
  assert.deepStrictEqual(r.skipped, []);
});

t('older help without ICU: --without-icu is skipped and logged, the rest stays', () => {
  assert.ok(!known9.has('with:icu') && known9.has('with:readline'));
  const r = P.buildArgs({ known: known9, profile, rangeConfigure: [], prefix: '/p' });
  assert.deepStrictEqual(r.args, ['--prefix=/p', '--without-readline', '--without-zlib']);
  assert.deepStrictEqual(r.skipped.map((s) => [s.flag, s.source]), [['--without-icu', 'feature:icu']]);
  assert.match(r.skipped[0].reason, /not present/);
});

t('range extra options are mapped the same way', () => {
  const r = P.buildArgs({ known: known9, profile, rangeConfigure: ['--disable-rpath', '--with-lz4'], prefix: '/p' });
  assert.ok(r.args.includes('--disable-rpath'));
  assert.ok(!r.args.includes('--with-lz4'));
  assert.ok(r.skipped.some((s) => s.flag === '--with-lz4' && s.source === 'range'));
});

t('with/without and enable/disable spellings are one option', () => {
  assert.strictEqual(P.optionKey('--with-icu'), P.optionKey('--without-icu'));
  assert.strictEqual(P.optionKey('--enable-nls'), P.optionKey('--disable-nls'));
  assert.notStrictEqual(P.optionKey('--with-nls'), P.optionKey('--enable-nls'));
  assert.strictEqual(P.optionKey('--prefix=/x'), null);
});

// Fixture tree
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
function tree(name, { files = {}, help }) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'help.txt'), help);
  fs.writeFileSync(path.join(d, 'configure'), 'if [ "$1" = "--help" ]; then cat "$(dirname "$0")/help.txt"; fi\n');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  return new P.TreeProvider(d);
}
const caps = (prov, known) => P.detectCapabilities({ known, capabilities, provider: prov });

t('capabilities of a modern-looking tree', () => {
  const prov = tree('modern', { help: help18, files: {
    'src/backend/libpq/auth-scram.c': '/* scram */',
    'src/include/catalog/pg_proc.dat': "{ oid => '3432', proname => 'gen_random_uuid' }",
    'src/backend/parser/gram.y': 'opt_on_conflict: ON CONFLICT ... MergeStmt: MERGE ... with_clause: WITH SAVEPOINT GENERATED generated_when AS IDENTITY',
    'src/include/catalog/pg_collation.h': '#define COLLPROVIDER_BUILTIN \'b\'',
    'src/backend/catalog/information_schema.sql': '-- info schema',
  } });
  const c = caps(prov, known18).capabilities;
  for (const id of ['scram', 'gen-random-uuid', 'on-conflict', 'merge', 'identity-columns', 'builtin-locale-provider', 'with-queries', 'savepoint', 'information-schema', 'icu', 'lz4', 'zstd', 'ssl']) {
    assert.strictEqual(c[id], true, id);
  }
});

t('capabilities of an old-looking tree are false where the files and options are missing', () => {
  const prov = tree('old', { help: help9, files: {
    'src/include/catalog/pg_proc.h': 'DATA(insert OID = 1 ( other_function ))',
    'src/backend/parser/gram.y': 'with_clause: WITH SAVEPOINT',
  } });
  const c = caps(prov, known9).capabilities;
  assert.strictEqual(c.scram, false);
  assert.strictEqual(c['gen-random-uuid'], false);
  assert.strictEqual(c['on-conflict'], false);
  assert.strictEqual(c.merge, false);
  assert.strictEqual(c['builtin-locale-provider'], false);
  assert.strictEqual(c.lz4, false);
  assert.strictEqual(c.icu, false);
  assert.strictEqual(c['with-queries'], true);
  assert.strictEqual(c.savepoint, true);
});

t('gen-random-uuid is found in the other catalog file spelling too', () => {
  const prov = tree('pg_proc_h', { help: help9, files: { 'src/include/catalog/pg_proc.h': 'DATA(... "gen_random_uuid" ...)' } });
  assert.strictEqual(caps(prov, known9).capabilities['gen-random-uuid'], true);
});

t('every capability reports evidence', () => {
  const r = caps(tree('ev', { help: help18 }), known18);
  assert.deepStrictEqual(Object.keys(r.evidence).sort(), capabilities.map((c) => c.id).sort());
  for (const v of Object.values(r.evidence)) assert.ok(v.length > 5);
});

t('probeFiles lists exactly the files the probes read', () => {
  assert.deepStrictEqual(P.probeFiles(capabilities), [
    'src/backend/catalog/information_schema.sql', 'src/backend/libpq/auth-scram.c', 'src/backend/parser/gram.y',
    'src/include/catalog/pg_collation.h', 'src/include/catalog/pg_proc.dat', 'src/include/catalog/pg_proc.h',
  ]);
});

t('CLI on a fixture tree prints args, skipped options and capabilities', () => {
  tree('cli', { help: help9, files: { 'src/backend/parser/gram.y': 'SAVEPOINT' } });
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'probe.js'), '10.5', '--tree', path.join(tmp, 'cli')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.version, '10.5');
  assert.strictEqual(out.range, 'pg10');
  assert.deepStrictEqual(out.args, ['--prefix=/usr/local/pgsql', '--without-readline', '--without-zlib']);
  assert.deepStrictEqual(out.skipped.map((s) => s.flag), ['--without-icu', '--disable-thread-safety']);
  assert.strictEqual(out.capabilities.savepoint, true);
});

t('CLI rejects a version that is not in the release index', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'probe.js'), '99.1', '--tree', path.join(tmp, 'cli')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /not in sources.lock.json/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall probe tests passed');
process.exit(failed ? 1 : 0);
