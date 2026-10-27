#!/usr/bin/env node
'use strict';
// Patch tooling. Runs inside the tools container (needs GNU patch).
//
//   patches.js verify [--patches DIR] [--third-party FILE]
//   patches.js apply --src DIR --out DIR --target native|wasm --patch-dir VERSION [--patch-dir VERSION ...]
//                    [--patches DIR] [--fuzz N]
//
// Layout: patches/<version>/NNNN-name.patch, one folder per tested PostgreSQL version. The four digits are the order the
// patches are applied in; every patch has a header line "Targets: common|native|wasm" (comma separated): "common" patches go into
// every build, "native" ones into the static image only, "wasm" ones into the WebAssembly build only. The last native patch
// (9xxx) is the wrapper that links the server, initdb, the entrypoint and the data files into one executable.
//
// apply copies the source tree and applies the folder for the target. With several --patch-dir (the exact version's folder
// first, then the nearest tested versions of the same major) the first folder that applies completely at the fuzz limit
// wins, so a release without a folder of its own uses the nearest one that fits. Fuzz is refused by default (--fuzz 0).
//
// Exit codes: 0 ok, 1 verification/apply failure, 2 usage error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const TARGETS = ['common', 'native', 'wasm'];
const REQUIRED = ['Subject', 'Purpose', 'Components', 'Checks', 'Origin', 'Targets'];
const BORROWED = ['Source-URL', 'Source-Commit', 'Source-License', 'Adaptation'];
const PATCH_NAME = /^(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.patch$/;
const VERSION_DIR = /^\d+(\.\d+){1,2}$/;

function usage(msg) { if (msg) console.error(msg); console.error('usage: patches.js verify|apply [options] (see header of this file)'); process.exit(2); }

const [cmd, ...rest] = process.argv.slice(2);
const opt = { patches: path.join(root, 'patches'), thirdParty: path.join(root, 'THIRD_PARTY.md'), fuzz: 0, dirs: [] };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--patches') opt.patches = path.resolve(rest[++i] || usage('--patches needs a value'));
  else if (a === '--third-party') opt.thirdParty = path.resolve(rest[++i] || usage('--third-party needs a value'));
  else if (a === '--src') opt.src = path.resolve(rest[++i] || usage('--src needs a value'));
  else if (a === '--out') opt.out = path.resolve(rest[++i] || usage('--out needs a value'));
  else if (a === '--target') opt.target = rest[++i];
  else if (a === '--patch-dir') opt.dirs.push(rest[++i] || usage('--patch-dir needs a value'));
  else if (a === '--fuzz') opt.fuzz = Number(rest[++i]);
  else usage(`unknown argument ${a}`);
}
if (!Number.isInteger(opt.fuzz) || opt.fuzz < 0) usage('--fuzz must be a non-negative integer');

function parseHeader(text) {
  const header = {};
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^(diff |--- |Index: |\+\+\+ )/.test(line)) break;
    const m = /^([A-Za-z][A-Za-z-]*):\s?(.*)$/.exec(line);
    if (m) { key = m[1]; header[key] = m[2]; }
    else if (key && /^\s+\S/.test(line)) header[key] += ` ${line.trim()}`;
    else if (line.trim() === '') key = null;
  }
  return header;
}

function checkHeader(label, h, thirdParty, errors) {
  for (const k of REQUIRED) if (!h[k] || !h[k].trim()) errors.push(`${label}: header field "${k}" missing or empty`);
  if (h.Targets) {
    const bad = h.Targets.split(',').map((x) => x.trim()).filter((x) => !TARGETS.includes(x));
    if (bad.length) errors.push(`${label}: Targets has unknown value(s) ${bad.join(', ')}; known: ${TARGETS.join(', ')}`);
  }
  if (h.Origin === undefined) return;
  if (h.Origin !== 'own' && h.Origin !== 'borrowed') { errors.push(`${label}: Origin must be "own" or "borrowed", got "${h.Origin}"`); return; }
  if (h.Origin === 'borrowed') {
    for (const k of BORROWED) if (!h[k] || !h[k].trim()) errors.push(`${label}: borrowed patch needs "${k}"`);
    if (h['Source-URL'] && !/^https:\/\//.test(h['Source-URL'])) errors.push(`${label}: Source-URL must be https`);
    if (h['Source-Commit'] && !/^[0-9a-f]{40}$/.test(h['Source-Commit'])) errors.push(`${label}: Source-Commit must be a full 40-hex SHA`);
    if (h['Source-Commit'] && /^[0-9a-f]{40}$/.test(h['Source-Commit']) && !thirdParty.includes(h['Source-Commit'])) {
      errors.push(`${label}: Source-Commit ${h['Source-Commit']} is not recorded in THIRD_PARTY.md`);
    }
  }
}

// The patches of one version folder, in order, each with its parsed header.
function readFolder(name, errors) {
  const dir = path.join(opt.patches, name);
  if (!fs.existsSync(dir)) { errors.push(`${name}: no such patch folder (${path.relative(root, dir)})`); return []; }
  const entries = [];
  const numbers = new Map();
  for (const f of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) { errors.push(`${name}/${f}: folders are not allowed inside a version folder`); continue; }
    const m = PATCH_NAME.exec(f);
    if (!m) { errors.push(`${name}/${f}: a patch is named NNNN-name.patch (four digits, then lower-case words joined by hyphens)`); continue; }
    if (numbers.has(m[1])) errors.push(`${name}/${f}: number ${m[1]} is already used by ${numbers.get(m[1])}`);
    numbers.set(m[1], f);
    const header = parseHeader(fs.readFileSync(full, 'utf8'));
    entries.push({ name: f, file: full, header, targets: (header.Targets || '').split(',').map((x) => x.trim()) });
  }
  return entries;
}

function verify() {
  const errors = [];
  const thirdParty = fs.existsSync(opt.thirdParty) ? fs.readFileSync(opt.thirdParty, 'utf8') : '';
  let count = 0;
  let folders = 0;
  for (const d of fs.readdirSync(opt.patches, { withFileTypes: true })) {
    if (!d.isDirectory()) { errors.push(`${d.name}: only version folders belong in patches/`); continue; }
    if (!VERSION_DIR.test(d.name)) { errors.push(`${d.name}: a folder in patches/ is named after a PostgreSQL version, e.g. 17.11 or 9.6.24`); continue; }
    folders++;
    const entries = readFolder(d.name, errors);
    if (!entries.length) errors.push(`${d.name}: the folder has no patch`);
    for (const e of entries) { count++; checkHeader(`${d.name}/${e.name}`, e.header, thirdParty, errors); }
  }
  if (errors.length) { console.error('patches verify: FAIL'); errors.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }
  console.log(`patches verify: PASS (${count} patch(es) in ${folders} version folder(s))`);
}

function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
  for (const f of walk(dir)) {
    h.update(`${path.relative(dir, f).split(path.sep).join('/')}\0`);
    h.update(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
    h.update('\n');
  }
  return h.digest('hex');
}

function apply() {
  if (!opt.src || !opt.out) usage('apply needs --src and --out');
  if (!TARGETS.includes(opt.target) || opt.target === 'common') usage('apply needs --target native or wasm');
  if (!opt.dirs.length) usage('apply needs at least one --patch-dir');
  if (!fs.existsSync(opt.src)) { console.error(`apply: source ${opt.src} does not exist`); process.exit(1); }
  if (path.resolve(opt.out) === path.resolve(opt.src)) { console.error('apply: --out must differ from --src (the fetched tree is never patched in place)'); process.exit(1); }

  const thirdParty = fs.existsSync(opt.thirdParty) ? fs.readFileSync(opt.thirdParty, 'utf8') : '';
  const patchArgs = ['-p1', '-N', '--no-backup-if-mismatch', '-r', '-', '-F', String(opt.fuzz)];
  const tryPatch = (file) => {
    const r = spawnSync('patch', [...patchArgs, '-i', file], { cwd: opt.out, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const fuzzy = /succeeded at \d+ with fuzz (\d+)/.exec(out);
    const bad = r.status !== 0 || /FAILED|rejected/i.test(out);
    return { out, status: r.status, ok: !bad && !(fuzzy && Number(fuzzy[1]) > opt.fuzz), fuzzy };
  };

  let firstFailure = null;
  for (const dirName of opt.dirs) {
    const errors = [];
    const all = readFolder(dirName, errors);
    for (const e of all) checkHeader(`${dirName}/${e.name}`, e.header, thirdParty, errors);
    if (errors.length) { console.error('apply: patch folder is not valid:'); errors.forEach((x) => console.error(`  - ${x}`)); process.exit(1); }
    const entries = all.filter((e) => e.targets.includes('common') || e.targets.includes(opt.target));

    fs.rmSync(opt.out, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(opt.out), { recursive: true });
    fs.cpSync(opt.src, opt.out, { recursive: true, preserveTimestamps: true, filter: (s) => path.basename(s) !== '.compactdb-verified' });
    const applied = [];
    let failed = null;
    for (const e of entries) {
      const r = tryPatch(e.file);
      if (!r.ok) {
        const why = r.fuzzy && Number(r.fuzzy[1]) > opt.fuzz && r.status === 0 ? `: fuzz ${r.fuzzy[1]} exceeds limit ${opt.fuzz}` : ` (patch exit ${r.status})`;
        failed = `${dirName}/${e.name}${why}\n${r.out}`;
        break;
      }
      applied.push({ patch: e.name, subject: e.header.Subject });
    }
    if (!failed) {
      const report = { src: opt.src, out: opt.out, target: opt.target, fuzzLimit: opt.fuzz, patchDir: dirName, applied, treeSha256: treeHash(opt.out) };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!firstFailure) firstFailure = failed;
  }
  fs.rmSync(opt.out, { recursive: true, force: true });
  console.error(`apply: FAIL at ${firstFailure}${opt.dirs.length > 1 ? `\napply: none of the ${opt.dirs.length} patch folders (${opt.dirs.join(', ')}) applies` : ''}`);
  process.exit(1);
}

if (cmd === 'verify') verify();
else if (cmd === 'apply') apply();
else usage(cmd ? `unknown command ${cmd}` : 'command required');
