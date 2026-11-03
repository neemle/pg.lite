#!/usr/bin/env node
'use strict';
// Writes toolchain.lock.json from facts, not by hand:
//   - base image and digest come from the FROM line of docker/builders/<kind>/Dockerfile
//   - tool versions come from build/toolchain/<kind>.json (scripts/capture-toolchain.sh, run
//     inside the built builder via tools/dcb <kind> make capture-toolchain)
// Runs in the tools container (tools/dc make update-toolchain-lock). The result must pass
// scripts/validate-locks.js, which is run at the end.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const builders = [
  { key: 'musl-18', kind: 'musl', rationale: 'Alpine is musl-native: gcc, headers and archives are all musl, so -static yields a fully static ELF. Baseline (18.x) native builder.' },
  { key: 'ref-18', kind: 'ref', rationale: 'Ordinary dynamic glibc toolchain with readline, zlib and ICU: builds unmodified upstream with default options as the behavior and size reference. Not used for any version range.' },
  { key: 'wasm-18', kind: 'wasm', rationale: 'Official Emscripten SDK image (emcc, clang, wasm-ld, Binaryen, node). Baseline (18.x) WASM builder.' },
];

const images = {};
for (const b of builders) {
  const dockerfile = `docker/builders/${b.kind}/Dockerfile`;
  const text = fs.readFileSync(path.join(root, dockerfile), 'utf8');
  const from = /^FROM\s+(\S+?)@(sha256:[0-9a-f]{64})\s*$/m.exec(text);
  if (!from) { console.error(`${dockerfile}: FROM line must be "name:tag@sha256:<digest>"`); process.exit(1); }
  const capFile = path.join(root, 'build', 'toolchain', `${b.kind}.json`);
  if (!fs.existsSync(capFile)) { console.error(`missing ${capFile}; run tools/dcb ${b.kind} make capture-toolchain first`); process.exit(1); }
  const cap = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  if (cap.kind !== b.kind) { console.error(`${capFile} is for kind ${cap.kind}, expected ${b.kind}`); process.exit(1); }
  images[b.key] = { image: from[1], digest: from[2], tools: cap.tools, dockerfile, rationale: b.rationale };
}

const lock = {
  schemaVersion: 1,
  images,
  ranges: [{ from: '18.0', to: '18.99', nativeImage: 'musl-18', wasmImage: 'wasm-18' }],
};
fs.writeFileSync(path.join(root, 'toolchain.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
console.log('wrote toolchain.lock.json');

const v = spawnSync(process.execPath, [path.join(__dirname, 'validate-locks.js')], { encoding: 'utf8' });
process.stdout.write(v.stdout);
process.stderr.write(v.stderr);
process.exit(v.status);
