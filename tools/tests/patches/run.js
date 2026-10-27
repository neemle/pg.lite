'use strict';
// Positive and negative tests for scripts/patches.js. Builds a tiny fake source tree and patch folders in a temp dir;
// nothing here touches the real patches/ directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
function good() {
  const d = sandbox();
  put(d, '1.0', '0000-greet.patch', header({ Subject: 'greet' }) + P_COMMON);
  put(d, '1.0', '0100-exit.patch', header({ Subject: 'exit code', Targets: 'native' }) + P_NATIVE);
  put(d, '1.0', '0200-util.patch', header({ Subject: 'util', Targets: 'wasm', ...borrowed }) + P_WASM);
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
const applyArgs = (d, target, dirs, extra = []) => ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'out'), '--target', target, ...dirs.flatMap((x) => ['--patch-dir', x]), ...extra];

// --- verify
let d = good();
expect('verify passes on a complete folder', run(d, ['verify']), 0, '3 patch(es) in 1 version folder(s)');

d = good(); put(d, '1.0', 'orphan.patch', header() + P_COMMON);
expect('verify fails on a patch not named NNNN-name.patch', run(d, ['verify']), 1, 'NNNN-name.patch');

d = good(); put(d, '1.0', '0000-again.patch', header() + P_COMMON);
expect('verify fails on a repeated number', run(d, ['verify']), 1, 'number 0000 is already used');

d = good(); put(d, 'not-a-version', '0000-x.patch', header() + P_COMMON);
expect('verify fails on a folder not named after a version', run(d, ['verify']), 1, 'named after a PostgreSQL version');

d = sandbox(); put(d, '1.0', '0000-x.patch', header({ Purpose: null }) + P_COMMON);
expect('verify fails on a missing Purpose', run(d, ['verify']), 1, '"Purpose" missing');

d = sandbox(); put(d, '1.0', '0000-x.patch', header({ Targets: null }) + P_COMMON);
expect('verify fails on a missing Targets', run(d, ['verify']), 1, '"Targets" missing');

d = sandbox(); put(d, '1.0', '0000-x.patch', header({ Targets: 'common, desktop' }) + P_COMMON);
expect('verify fails on an unknown target', run(d, ['verify']), 1, 'unknown value(s) desktop');

d = sandbox(); put(d, '1.0', '0000-x.patch', header({ Origin: 'maybe' }) + P_COMMON);
expect('verify fails on a bad Origin value', run(d, ['verify']), 1, 'Origin must be');

d = sandbox(); put(d, '1.0', '0000-x.patch', header({ Origin: 'borrowed' }) + P_COMMON);
expect('verify fails on borrowed without attribution fields', run(d, ['verify']), 1, 'borrowed patch needs "Source-URL"');

d = sandbox(); put(d, '1.0', '0000-x.patch', header({ ...borrowed, 'Source-Commit': 'deadbeef' }) + P_COMMON);
expect('verify fails on an abbreviated Source-Commit', run(d, ['verify']), 1, '40-hex');

d = sandbox(); fs.writeFileSync(path.join(d, 'THIRD_PARTY.md'), 'nothing recorded\n'); put(d, '1.0', '0000-x.patch', header(borrowed) + P_COMMON);
expect('verify fails when the borrowed commit is not in THIRD_PARTY.md', run(d, ['verify']), 1, 'not recorded in THIRD_PARTY.md');

d = sandbox(); fs.mkdirSync(path.join(d, 'patches', '1.0'));
expect('verify fails on an empty folder', run(d, ['verify']), 1, 'has no patch');

// --- apply
d = good();
const outA = expect('apply applies common+native in order', run(d, applyArgs(d, 'native', ['1.0'])), 0, '"treeSha256"');
const repA = JSON.parse(outA);
const hello = fs.readFileSync(path.join(d, 'out', 'hello.c'), 'utf8');
check('patched content is as expected', hello.includes('hello, world') && hello.includes('return 3;'));
check('native build leaves the wasm patch out', !fs.readFileSync(path.join(d, 'out', 'lib', 'util.c'), 'utf8').includes('+ 1'));
check('report lists patches in number order', repA.applied.map((a) => a.patch).join(',') === '0000-greet.patch,0100-exit.patch');
check('source tree is not patched in place', fs.readFileSync(path.join(d, 'src', 'hello.c'), 'utf8') === HELLO);
const repB = JSON.parse(run(d, applyArgs(d, 'native', ['1.0'])).stdout);
check('second apply gives an identical tree hash', repA.treeSha256 === repB.treeSha256);
const repW = JSON.parse(run(d, applyArgs(d, 'wasm', ['1.0'])).stdout);
check('wasm build takes common+wasm only', repW.applied.map((a) => a.patch).join(',') === '0000-greet.patch,0200-util.patch');

d = sandbox(); put(d, '1.0', '0000-x.patch', header() + P_NO_MATCH);
expect('apply fails on a reject and leaves no half-patched tree', run(d, applyArgs(d, 'native', ['1.0'])), 1, 'FAIL at 1.0/0000-x.patch');
check('failed apply removes the output tree', !fs.existsSync(path.join(d, 'out')));

d = sandbox(); put(d, '1.0', '0000-x.patch', header() + P_BAD_CONTEXT);
expect('apply refuses fuzz by default (--fuzz 0)', run(d, applyArgs(d, 'native', ['1.0'])), 1, 'FAIL at');
expect('apply accepts fuzz 1 when explicitly allowed', run(d, applyArgs(d, 'native', ['1.0'], ['--fuzz', '1'])), 0, '"applied"');

d = good();
expect('apply refuses --out equal to --src', run(d, ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'src'), '--target', 'native', '--patch-dir', '1.0']), 1, 'must differ');
expect('apply needs a target', run(d, ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'out'), '--patch-dir', '1.0']), 2, '--target');
expect('apply refuses a folder that does not exist', run(d, applyArgs(d, 'native', ['9.9'])), 1, 'no such patch folder');

// --- several folders: the first that applies completely wins
d = sandbox();
put(d, '1.0', '0000-greet.patch', header({ Subject: 'greet for another context' }) + P_BAD_CONTEXT);
put(d, '1.1', '0000-greet.patch', header({ Subject: 'greet' }) + P_COMMON);
let o = expect('apply moves on to the next folder when the first does not fit', run(d, applyArgs(d, 'native', ['1.0', '1.1'])), 0, '"patchDir": "1.1"');
check('the tree has the change of the folder that fit', fs.readFileSync(path.join(d, 'out', 'hello.c'), 'utf8').includes('hello, world'));
expect('the first folder that fits wins', run(d, applyArgs(d, 'native', ['1.1', '1.0'])), 0, '"patchDir": "1.1"');
put(d, '1.2', '0000-never.patch', header({ Subject: 'never fits' }) + P_NO_MATCH);
expect('apply fails when no folder fits', run(d, applyArgs(d, 'native', ['1.0', '1.2'])), 1, 'none of the 2 patch folders');

for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall patch-tooling tests passed');
process.exit(failed ? 1 : 0);
