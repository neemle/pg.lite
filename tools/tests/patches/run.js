'use strict';
// Positive and negative tests for scripts/patches.js and scripts/patchtree.js. Builds a tiny fake source tree and a small patch tree
// in a temp dir; nothing here touches the real patches/ directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pt = require('../../scripts/patchtree');

const tool = path.resolve(__dirname, '..', '..', 'scripts', 'patches.js');
const SHA = 'a'.repeat(40);

const HELLO = '#include <stdio.h>\nint main(void)\n{\n    printf("hello\\n");\n    return 0;\n}\n';
const UTIL = 'int add(int a, int b)\n{\n    return a + b;\n}\n';

const header = (o = {}) => {
  const h = { Subject: 'fixture patch', Purpose: 'test the tooling', Components: 'hello.c', Checks: 'tests/patches/run.js', Origin: 'own', Targets: 'common', ...o };
  return `${Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`;
};
const P_COMMON = `--- a/hello.c\n+++ b/hello.c\n@@ -1,6 +1,6 @@\n #include <stdio.h>\n int main(void)\n {\n-    printf("hello\\n");\n+    printf("hello, world\\n");\n     return 0;\n }\n`;
const P_NATIVE = `--- a/hello.c\n+++ b/hello.c\n@@ -2,5 +2,5 @@\n int main(void)\n {\n     printf("hello, world\\n");\n-    return 0;\n+    return 3;\n }\n`;
const P_WASM = `--- a/lib/util.c\n+++ b/lib/util.c\n@@ -1,4 +1,4 @@\n int add(int a, int b)\n {\n-    return a + b;\n+    return a + b + 1;\n }\n`;
const P_BAD_CONTEXT = `--- a/hello.c\n+++ b/hello.c\n@@ -1,6 +1,6 @@\n #include <stdlib.h>\n int main(void)\n {\n-    printf("hello\\n");\n+    printf("hi\\n");\n     return 0;\n }\n`;
const P_NO_MATCH = `--- a/hello.c\n+++ b/hello.c\n@@ -1,3 +1,3 @@\n-nothing like this\n+something\n x\n y\n`;

let failed = 0;
const tmps = [];
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'patches-'));
  tmps.push(d);
  fs.mkdirSync(path.join(d, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'hello.c'), HELLO);
  fs.writeFileSync(path.join(d, 'src', 'lib', 'util.c'), UTIL);
  fs.writeFileSync(path.join(d, 'THIRD_PARTY.md'), `fixture attribution: ${SHA}\n`);
  fs.mkdirSync(path.join(d, 'patches'), { recursive: true });
  return d;
}
function put(d, folder, name, body) {
  fs.mkdirSync(path.join(d, 'patches', folder), { recursive: true });
  fs.writeFileSync(path.join(d, 'patches', folder, name), body);
}
const borrowed = { Origin: 'borrowed', 'Source-URL': 'https://example.invalid/x', 'Source-Commit': SHA, 'Source-License': 'MIT', Adaptation: 'none' };
// patches/ (all), patches/1 (family), patches/1/1.0-1.5 (a span of releases)
function good() {
  const d = sandbox();
  put(d, '', '0000-greet.patch', header({ Subject: 'greet' }) + P_COMMON);
  put(d, '1', '0100-exit.patch', header({ Subject: 'exit code', Targets: 'native' }) + P_NATIVE);
  put(d, '1/1.0-1.5', '0200-util.patch', header({ Subject: 'util', Targets: 'wasm', ...borrowed }) + P_WASM);
  return d;
}
function run(d, args) {
  return spawnSync(process.execPath, [tool, ...args, '--patches', path.join(d, 'patches'), '--third-party', path.join(d, 'THIRD_PARTY.md')], { encoding: 'utf8' });
}
function expect(name, r, code, text) {
  const out = `${r.stdout}${r.stderr}`;
  const ok = r.status === code && (!text || out.includes(text));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { failed++; console.log(`  expected exit ${code}${text ? ` and "${text}"` : ''}, got ${r.status}\n${out}`); }
  return out;
}
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };
const applyArgs = (d, target, version, extra = []) => ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'out'), '--target', target, '--version', version, ...extra];

// --- tree arithmetic
let d = good();
check('a release takes patches/, its family and its span, outermost first', pt.folders(path.join(d, 'patches'), '1.3').join('|') === '|1|1/1.0-1.5');
check('a release outside every span takes the folders above', pt.folders(path.join(d, 'patches'), '1.9').join('|') === '|1');
check('a release of a family without a folder takes patches/ only', pt.folders(path.join(d, 'patches'), '7.1').join('|') === '');
check('the patches are collected in number order across folders', pt.collect(path.join(d, 'patches'), '1.3').files.map((f) => f.name).join(',') === '0000-greet.patch,0100-exit.patch,0200-util.patch');
check('the 9.x family has a series level', (() => { const x = sandbox(); put(x, '9/9.6/9.6.0-9.6.9', '0000-a.patch', header() + P_COMMON); return pt.folders(path.join(x, 'patches'), '9.6.4').join('|') === '|9|9/9.6|9/9.6/9.6.0-9.6.9'; })());

// --- fold is the inverse of collect, and shares what is the same
{
  const flat = new Map([
    ['1.0', new Map([['0000-a.patch', 'A1'], ['0100-b.patch', 'B1']])],
    ['1.1', new Map([['0000-a.patch', 'A1'], ['0100-b.patch', 'B1']])],
    ['1.2', new Map([['0000-a.patch', 'A1'], ['0100-b.patch', 'B2']])],
    ['2.0', new Map([['0000-a.patch', 'A1']])],
  ]);
  const tree = pt.foldMaps(flat);
  check('fold puts a patch that every release takes into patches/', tree.get('')?.get('0000-a.patch') === 'A1' && !tree.get('1')?.has('0000-a.patch'));
  check('fold makes a span of the releases that take the same variant', tree.get('1/1.0-1.1')?.get('0100-b.patch') === 'B1' && tree.get('1/1.2')?.get('0100-b.patch') === 'B2');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'patches-fold-')); tmps.push(out);
  pt.writeTree(tree, out);
  const same = [...flat].every(([v, m]) => JSON.stringify(pt.collect(out, v).files.map((f) => [f.name, fs.readFileSync(f.file, 'utf8')])) === JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1))));
  check('collecting from the folded tree gives every release its patches again', same);
}

// --- verify
d = good();
expect('verify passes on a complete tree', run(d, ['verify']), 0, '3 patch(es) in 3 folder(s)');

d = good(); put(d, '1', 'orphan.patch', header() + P_COMMON);
expect('verify fails on a patch not named NNNN-name.patch', run(d, ['verify']), 1, 'NNNN-name.patch');

d = good(); put(d, '1/1.0-1.5', '0000-again.patch', header() + P_COMMON);
expect('verify fails on a number used twice on one path', run(d, ['verify']), 1, 'number 0000 is already used on this path');

d = good(); put(d, 'not-a-version', '0000-x.patch', header() + P_COMMON);
expect('verify fails on a folder that is not a major version', run(d, ['verify']), 1, 'major version');

d = good(); put(d, '1/1.3-1.8', '0300-x.patch', header() + P_COMMON);
expect('verify fails on overlapping spans', run(d, ['verify']), 1, 'overlaps');

d = good(); put(d, '1/2.0-2.1', '0300-x.patch', header() + P_COMMON);
expect('verify fails on a span that leaves its family', run(d, ['verify']), 1, 'leaves the 1 family');

d = good(); put(d, '1/1.5-1.1', '0300-x.patch', header() + P_COMMON);
expect('verify fails on a span that runs backwards', run(d, ['verify']), 1, 'runs backwards');

d = sandbox(); put(d, '', '0000-x.patch', header({ Purpose: null }) + P_COMMON);
expect('verify fails on a missing Purpose', run(d, ['verify']), 1, '"Purpose" missing');

d = sandbox(); put(d, '', '0000-x.patch', header({ Targets: null }) + P_COMMON);
expect('verify fails on a missing Targets', run(d, ['verify']), 1, '"Targets" missing');

d = sandbox(); put(d, '', '0000-x.patch', header({ Targets: 'common, desktop' }) + P_COMMON);
expect('verify fails on an unknown target', run(d, ['verify']), 1, 'unknown value(s) desktop');

d = sandbox(); put(d, '', '0000-x.patch', header({ Origin: 'maybe' }) + P_COMMON);
expect('verify fails on a bad Origin value', run(d, ['verify']), 1, 'Origin must be');

d = sandbox(); put(d, '', '0000-x.patch', header({ Origin: 'borrowed' }) + P_COMMON);
expect('verify fails on borrowed without attribution fields', run(d, ['verify']), 1, 'borrowed patch needs "Source-URL"');

d = sandbox(); put(d, '', '0000-x.patch', header({ ...borrowed, 'Source-Commit': 'deadbeef' }) + P_COMMON);
expect('verify fails on an abbreviated Source-Commit', run(d, ['verify']), 1, '40-hex');

d = sandbox(); fs.writeFileSync(path.join(d, 'THIRD_PARTY.md'), 'nothing recorded\n'); put(d, '', '0000-x.patch', header(borrowed) + P_COMMON);
expect('verify fails when the borrowed commit is not in THIRD_PARTY.md', run(d, ['verify']), 1, 'not recorded in THIRD_PARTY.md');

d = sandbox();
expect('verify fails on a tree without patches', run(d, ['verify']), 1, 'holds no patch');

// --- apply
d = good();
const outA = expect('apply applies the patches of a release for the image', run(d, applyArgs(d, 'native', '1.3')), 0, '"treeSha256"');
const repA = JSON.parse(outA);
const hello = fs.readFileSync(path.join(d, 'out', 'hello.c'), 'utf8');
check('patched content is as expected', hello.includes('hello, world') && hello.includes('return 3;'));
check('the image build leaves the wasm patch out', !fs.readFileSync(path.join(d, 'out', 'lib', 'util.c'), 'utf8').includes('+ 1'));
check('report lists patches in number order with their folders', repA.applied.map((a) => `${a.folder}:${a.patch}`).join(',') === '.:0000-greet.patch,1:0100-exit.patch' && repA.folders.join('|') === '.|1|1/1.0-1.5');
check('source tree is not patched in place', fs.readFileSync(path.join(d, 'src', 'hello.c'), 'utf8') === HELLO);
const repB = JSON.parse(run(d, applyArgs(d, 'native', '1.3')).stdout);
check('second apply gives an identical tree hash', repA.treeSha256 === repB.treeSha256);
const repW = JSON.parse(run(d, applyArgs(d, 'wasm', '1.3')).stdout);
check('the wasm build takes common+wasm only', repW.applied.map((a) => a.patch).join(',') === '0000-greet.patch,0200-util.patch');
const repOut = JSON.parse(run(d, applyArgs(d, 'wasm', '1.9')).stdout);
check('a release outside the span does not take the span patch', repOut.applied.map((a) => a.patch).join(',') === '0000-greet.patch');

d = sandbox(); put(d, '1', '0000-x.patch', header() + P_NO_MATCH);
expect('apply fails on a reject and leaves no half-patched tree', run(d, applyArgs(d, 'native', '1.0')), 1, 'FAIL at 1/0000-x.patch');
check('failed apply removes the output tree', !fs.existsSync(path.join(d, 'out')));

d = sandbox(); put(d, '1', '0000-x.patch', header() + P_BAD_CONTEXT);
expect('apply refuses fuzz by default (--fuzz 0)', run(d, applyArgs(d, 'native', '1.0')), 1, 'FAIL at');
expect('apply accepts fuzz 1 when explicitly allowed', run(d, applyArgs(d, 'native', '1.0', ['--fuzz', '1'])), 0, '"applied"');

d = good();
expect('apply refuses --out equal to --src', run(d, ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'src'), '--target', 'native', '--version', '1.3']), 1, 'must differ');
expect('apply needs a target', run(d, ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'out'), '--version', '1.3']), 2, '--target');
expect('apply needs a version', run(d, ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'out'), '--target', 'native']), 2, '--version');
expect('apply refuses a family without a folder', run(d, applyArgs(d, 'native', '7.1')), 1, 'no patch folder');

for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall patch-tooling tests passed');
process.exit(failed ? 1 : 0);
