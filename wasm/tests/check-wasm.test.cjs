'use strict';
// Positive and negative tests for wasm/check-wasm.cjs (runs in the tools container).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tool = path.resolve(__dirname, '..', 'check-wasm.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wasmchk-'));
let failed = 0;

const EMPTY_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
// (module (func (export "answer") (result i32) i32.const 42)) assembled by hand
const ANSWER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0a, 0x01, 0x06, 0x61, 0x6e, 0x73, 0x77, 0x65, 0x72, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b]);

function put(dir, name, buf) { const d = path.join(tmp, dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), buf); return d; }
function run(name, args, code, text) {
  const r = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const ok = r.status === code && (!text || out.includes(text));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { failed++; console.log(`  expected exit ${code}${text ? ` with "${text}"` : ''}, got ${r.status}\n${out}`); }
}

run('a valid module with an export passes', [put('good', 'a.wasm', ANSWER)], 0, '0 imports, 1 exports');
run('an empty but valid module passes', [put('empty', 'a.wasm', EMPTY_MODULE)], 0, 'PASS');
run('a truncated module fails', [put('trunc', 'a.wasm', ANSWER.subarray(0, 30))], 1, 'FAIL');
run('a module with a bad magic fails', [put('magic', 'a.wasm', Buffer.from('not a wasm file at all'))], 1, 'magic');
run('a module with an unsupported version fails', [put('ver', 'a.wasm', Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]))], 1, 'version');
run('a module that parses but does not validate fails', [put('inval', 'a.wasm', Buffer.concat([EMPTY_MODULE, Buffer.from([0x0a, 0x02, 0x01, 0x00])]))], 1, 'FAIL');
run('a directory with no .wasm is an error, not a pass', [put('none', 'readme.txt', Buffer.from('x'))], 2, 'nothing was proven');
run('a missing path is an error', [path.join(tmp, 'nope')], 2, 'does not exist');
const mixed = put('mixed', 'good.wasm', ANSWER); put('mixed', 'bad.wasm', ANSWER.subarray(0, 12));
run('one bad module among good ones fails the run', [mixed], 1, '1 failed');

const j = path.join(tmp, 'r.json');
spawnSync(process.execPath, [tool, '--json', j, mixed], { encoding: 'utf8' });
const rep = JSON.parse(fs.readFileSync(j, 'utf8'));
const jsonOk = rep.checked === 2 && rep.failed === 1 && rep.ok === false && rep.files.some((f) => f.ok === true && f.exports === 1);
console.log(`${jsonOk ? 'PASS' : 'FAIL'} JSON result records counts, failures and exports`); if (!jsonOk) failed++;

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall wasm-check tests passed');
process.exit(failed ? 1 : 0);
