'use strict';
// Positive and negative tests for scripts/patches.js. Builds a tiny fake source tree and
// patch series in a temp dir; nothing here touches the real patches/ directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tool = path.resolve(__dirname, '..', '..', 'scripts', 'patches.js');
const SHA = 'a'.repeat(40);

const HELLO = '#include <stdio.h>\nint main(void)\n{\n    printf("hello\\n");\n    return 0;\n}\n';
const UTIL = 'int add(int a, int b)\n{\n    return a + b;\n}\n';

const header = (o = {}) => {
  const h = { Subject: 'fixture patch', Purpose: 'test the tooling', Components: 'hello.c', Checks: 'tests/patches/run.js', Origin: 'own', ...o };
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
  for (const t of ['common', 'native', 'wasm']) fs.mkdirSync(path.join(d, 'patches', t), { recursive: true });
  return d;
}
function put(d, target, name, body, listed = true) {
  fs.writeFileSync(path.join(d, 'patches', target, name), body);
  if (listed) fs.appendFileSync(path.join(d, 'patches', target, 'series'), `${name}\n`);
}
function baseSeries(d) {
  for (const t of ['common', 'native', 'wasm']) fs.writeFileSync(path.join(d, 'patches', t, 'series'), '# fixture\n');
}
function good() {
  const d = sandbox();
  baseSeries(d);
  put(d, 'common', '0001-greet.patch', header({ Subject: 'greet' }) + P_COMMON);
  put(d, 'native', '0001-exit.patch', header({ Subject: 'exit code' }) + P_NATIVE);
  put(d, 'wasm', '0001-util.patch', header({ Subject: 'util', Origin: 'borrowed', 'Source-URL': 'https://example.invalid/x', 'Source-Commit': SHA, 'Source-License': 'MIT', Adaptation: 'none' }) + P_WASM);
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
const applyArgs = (d, extra = []) => ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'out'), ...extra];

// --- verify
let d = good();
expect('verify passes on a complete series', run(d, ['verify']), 0, '3 patch(es)');

d = good(); fs.appendFileSync(path.join(d, 'patches', 'common', 'series'), '0099-missing.patch\n');
expect('verify fails on a series entry without a file', run(d, ['verify']), 1, 'does not exist');

d = good(); put(d, 'common', '0002-orphan.patch', header() + P_COMMON, false);
expect('verify fails on an orphan patch not in the series', run(d, ['verify']), 1, 'orphan');

d = sandbox(); baseSeries(d); put(d, 'common', '0001-x.patch', header({ Purpose: null }) + P_COMMON);
expect('verify fails on a missing Purpose', run(d, ['verify']), 1, '"Purpose" missing');

d = sandbox(); baseSeries(d); put(d, 'common', '0001-x.patch', header({ Origin: 'maybe' }) + P_COMMON);
expect('verify fails on a bad Origin value', run(d, ['verify']), 1, 'Origin must be');

d = sandbox(); baseSeries(d); put(d, 'common', '0001-x.patch', header({ Origin: 'borrowed' }) + P_COMMON);
expect('verify fails on borrowed without attribution fields', run(d, ['verify']), 1, 'borrowed patch needs "Source-URL"');

d = sandbox(); baseSeries(d); put(d, 'common', '0001-x.patch', header({ Origin: 'borrowed', 'Source-URL': 'https://e.invalid', 'Source-Commit': 'deadbeef', 'Source-License': 'MIT', Adaptation: 'n' }) + P_COMMON);
expect('verify fails on an abbreviated Source-Commit', run(d, ['verify']), 1, '40-hex');

d = sandbox(); baseSeries(d); fs.writeFileSync(path.join(d, 'THIRD_PARTY.md'), 'nothing recorded\n');
put(d, 'common', '0001-x.patch', header({ Origin: 'borrowed', 'Source-URL': 'https://e.invalid', 'Source-Commit': SHA, 'Source-License': 'MIT', Adaptation: 'n' }) + P_COMMON);
expect('verify fails when the borrowed commit is not in THIRD_PARTY.md', run(d, ['verify']), 1, 'not recorded in THIRD_PARTY.md');

d = sandbox(); baseSeries(d); fs.appendFileSync(path.join(d, 'patches', 'common', 'series'), '../evil.patch\n');
expect('verify rejects a path escaping the patches dir', run(d, ['verify']), 1, 'without ".."');

// --- apply
d = good();
const outA = expect('apply applies common+native in order', run(d, applyArgs(d, ['--targets', 'common,native'])), 0, '"treeSha256"');
const repA = JSON.parse(outA);
const hello = fs.readFileSync(path.join(d, 'out', 'hello.c'), 'utf8');
const okContent = hello.includes('hello, world') && hello.includes('return 3;');
console.log(`${okContent ? 'PASS' : 'FAIL'} patched content is as expected`); if (!okContent) failed++;
const orderOk = repA.applied.map((a) => a.target).join(',') === 'common,native';
console.log(`${orderOk ? 'PASS' : 'FAIL'} report lists patches in order`); if (!orderOk) failed++;
const srcUntouched = fs.readFileSync(path.join(d, 'src', 'hello.c'), 'utf8') === HELLO;
console.log(`${srcUntouched ? 'PASS' : 'FAIL'} source tree is not patched in place`); if (!srcUntouched) failed++;

const repB = JSON.parse(run(d, applyArgs(d, ['--targets', 'common,native'])).stdout);
const same = repA.treeSha256 === repB.treeSha256;
console.log(`${same ? 'PASS' : 'FAIL'} second apply gives an identical tree hash`); if (!same) failed++;

d = sandbox(); baseSeries(d); put(d, 'common', '0001-x.patch', header() + P_NO_MATCH);
expect('apply fails on a reject and leaves no half-patched tree', run(d, applyArgs(d)), 1, 'FAIL at common/0001-x.patch');
const cleaned = !fs.existsSync(path.join(d, 'out'));
console.log(`${cleaned ? 'PASS' : 'FAIL'} failed apply removes the output tree`); if (!cleaned) failed++;

d = sandbox(); baseSeries(d); put(d, 'common', '0001-x.patch', header() + P_BAD_CONTEXT);
expect('apply refuses fuzz by default (--fuzz 0)', run(d, applyArgs(d)), 1, 'FAIL at');
expect('apply accepts fuzz 1 when explicitly allowed', run(d, applyArgs(d, ['--fuzz', '1'])), 0, '"applied"');

d = good();
expect('apply refuses --out equal to --src', run(d, ['apply', '--src', path.join(d, 'src'), '--out', path.join(d, 'src')]), 1, 'must differ');

d = good(); fs.rmSync(path.join(d, 'patches', 'native', '0001-exit.patch'));
expect('apply refuses a series with a missing file', run(d, applyArgs(d)), 1, 'does not exist');

// --- named series (range model: series.<range>)
d = sandbox(); baseSeries(d);
put(d, 'common', '0001-greet.patch', header() + P_COMMON, false);
fs.writeFileSync(path.join(d, 'patches', 'common', 'series.alt'), '0001-greet.patch\n');
expect('verify accepts a patch that is listed only in a named series', run(d, ['verify']), 0, '1 patch(es) in 4 series file(s)');
const outAlt = run(d, applyArgs(d, ['--targets', 'common', '--series', 'common=series.alt']));
expect('apply --series common=series.alt applies the named series', outAlt, 0, '0001-greet.patch');
expect('apply of the default (empty) series applies nothing', run(d, applyArgs(d, ['--targets', 'common'])), 0, '"applied": []');
expect('apply rejects a malformed --series value', run(d, applyArgs(d, ['--series', 'common=../x'])), 2, '--series needs');
d = sandbox(); baseSeries(d);
fs.writeFileSync(path.join(d, 'patches', 'native', 'series.alt'), 'missing.patch\n');
expect('verify fails on a missing file listed in a named series', run(d, ['verify']), 1, 'series.alt');

for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall patch-tooling tests passed');
process.exit(failed ? 1 : 0);
