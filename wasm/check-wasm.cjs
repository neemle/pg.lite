#!/usr/bin/env node
'use strict';
// WASM load check: every *.wasm under the given files/directories must have the WebAssembly
// header, validate and compile in this node (the engine every browser embeds is V8-class; a real
// browser run belongs to the browser tests). Imports and exports are listed so the matrix can show them.
//
//   check-wasm.cjs [--json FILE] PATH...
// Exit 0 only if every module passes; 1 if one fails; 2 on usage error or when no module was found.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let json = null;
const paths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') json = args[++i];
  else if (args[i].startsWith('--')) { console.error(`unknown option ${args[i]}`); process.exit(2); }
  else paths.push(args[i]);
}
if (!paths.length) { console.error('usage: check-wasm.cjs [--json FILE] PATH...'); process.exit(2); }

const walk = (p) => {
  if (!fs.existsSync(p)) { console.error(`check-wasm: ${p} does not exist`); process.exit(2); }
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [p];
  return fs.readdirSync(p).sort().flatMap((n) => walk(path.join(p, n)));
};
const files = paths.flatMap(walk).filter((f) => f.endsWith('.wasm'));

const rows = [];
let failed = 0;
(async () => {
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const row = { path: f, bytes: buf.length, ok: false };
    try {
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x0061736d) throw new Error('missing \\0asm magic');
      if (buf.readUInt32LE(4) !== 1) throw new Error(`unsupported binary version ${buf.readUInt32LE(4)}`);
      if (!WebAssembly.validate(buf)) throw new Error('module does not validate');
      const mod = await WebAssembly.compile(buf);
      row.imports = WebAssembly.Module.imports(mod).length;
      row.exports = WebAssembly.Module.exports(mod).length;
      row.ok = true;
      console.log(`PASS ${f} (${buf.length} bytes, ${row.imports} imports, ${row.exports} exports)`);
    } catch (e) {
      row.error = e.message;
      failed++;
      console.log(`FAIL ${f}: ${e.message}`);
    }
    rows.push(row);
  }
  console.log(`check-wasm: ${files.length} module(s) checked, ${failed} failed`);
  if (json) fs.writeFileSync(json, `${JSON.stringify({ checked: files.length, failed, ok: failed === 0 && files.length > 0, files: rows }, null, 2)}\n`);
  if (!files.length) { console.error('check-wasm: no .wasm files found - nothing was proven'); process.exit(2); }
  process.exit(failed ? 1 : 0);
})();
