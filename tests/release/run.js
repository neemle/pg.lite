'use strict';
// Offline unit tests for the pure parts of scripts/release-index.js.
const assert = require('assert');
const path = require('path');
const R = require(path.resolve(__dirname, '..', '..', 'scripts', 'release-index.js'));

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.message}`); }
}

t('final tags parse to versions and majors', () => {
  assert.deepStrictEqual(R.parseTag('REL9_0_0'), { version: '9.0.0', major: '9.0' });
  assert.deepStrictEqual(R.parseTag('REL9_6_24'), { version: '9.6.24', major: '9.6' });
  assert.deepStrictEqual(R.parseTag('REL_10_0'), { version: '10.0', major: '10' });
  assert.deepStrictEqual(R.parseTag('REL_18_6'), { version: '18.6', major: '18' });
});

t('pre-releases, old majors and other refs are rejected', () => {
  for (const tag of ['REL_18_BETA1', 'REL_18_RC1', 'REL9_0_BETA1', 'REL9_0_ALPHA1', 'REL8_4_22', 'REL9_7_0', 'REL_9_6_1', 'REL_10_BETA2', 'v18.0', 'REL_18_6_rc']) {
    assert.strictEqual(R.parseTag(tag), null, tag);
  }
});

const LS = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/REL9_0_0',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/REL9_0_1',
  'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/REL9_0_1^{}',
  'dddddddddddddddddddddddddddddddddddddddd\trefs/tags/REL_18_6',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/REL_18_BETA1',
  'ffffffffffffffffffffffffffffffffffffffff\trefs/tags/REL8_4_1',
].join('\n');

t('ls-remote parsing keeps final releases and prefers the peeled commit', () => {
  const m = R.parseLsRemote(LS);
  assert.deepStrictEqual([...m.keys()].sort(), ['18.6', '9.0.0', '9.0.1']);
  assert.strictEqual(m.get('9.0.0').commit, 'a'.repeat(40));
  assert.strictEqual(m.get('9.0.1').commit, 'c'.repeat(40), 'annotated tag must resolve to the commit, not the tag object');
  assert.strictEqual(m.get('18.6').tag, 'REL_18_6');
});

t('ftp index parsing keeps final dirs >= 9.0 only', () => {
  const html = ['v1.08/', 'v6.0/', 'v8.4.22/', 'v9.0.0/', 'v9.6.24/', 'v9.6/', 'v10.0/', 'v18.6/', 'v18.0beta1/', 'v18.6.1/', 'v10.0.1/']
    .map((d) => `<a href="${d}">${d}</a>`).join('\n');
  assert.deepStrictEqual([...R.parseFtpIndex(html)].sort(R.cmpVersion), ['9.0.0', '9.6.24', '10.0', '18.6']);
});

t('cross-check reports versions present in only one source', () => {
  const git = R.parseLsRemote(LS);
  const r = R.crossCheck(git, new Set(['9.0.0', '18.6', '9.0.2']));
  assert.deepStrictEqual(r.versions, ['9.0.0', '18.6']);
  assert.deepStrictEqual(r.onlyGit, ['9.0.1']);
  assert.deepStrictEqual(r.onlyFtp, ['9.0.2']);
});

t('version ordering is numeric, not lexical', () => {
  const v = ['10.0', '9.6.24', '9.0.10', '9.0.2', '18.6', '12.22'].sort(R.cmpVersion);
  assert.deepStrictEqual(v, ['9.0.2', '9.0.10', '9.6.24', '10.0', '12.22', '18.6']);
});

const SHA = '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f';
t('sha256 file parsing accepts the official layout and rejects other files', () => {
  assert.strictEqual(R.parseSha256File(`${SHA}  postgresql-18.6.tar.bz2\n`, '18.6'), SHA);
  assert.strictEqual(R.parseSha256File(`"${SHA}  postgresql-18.6.tar.bz2"`, '18.6'), SHA);
  assert.strictEqual(R.parseSha256File(`${SHA}  postgresql-18.5.tar.bz2\n`, '18.6'), null);
  assert.strictEqual(R.parseSha256File('<html>404</html>', '18.6'), null);
});

t('md5 file parsing accepts both official layouts', () => {
  const md5 = '14c2122cc322e69ab2ab702ed7714bbe';
  assert.strictEqual(R.parseMd5File(`MD5 (postgresql-9.0.0.tar.bz2) = ${md5}\n`, '9.0.0'), md5);
  assert.strictEqual(R.parseMd5File(`${md5}  postgresql-9.0.0.tar.bz2\n`, '9.0.0'), md5);
  assert.strictEqual(R.parseMd5File(`${md5}  postgresql-9.0.1.tar.bz2\n`, '9.0.0'), null);
});

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall release-index tests passed');
process.exit(failed ? 1 : 0);
