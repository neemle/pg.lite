#!/usr/bin/env node
'use strict';
// Patch tooling. Runs inside the tools container (needs GNU patch).
//
//   patches.js verify [--patches DIR] [--third-party FILE]
//   patches.js apply --src DIR --out DIR --target native|wasm --version X.Y [--patches DIR] [--fuzz N]
//
// Layout: patches/ is a tree of folders that cascade (scripts/patchtree.js says how): the patches of a release are collected from
// patches/, patches/<family>/, (for 9.x patches/9/<series>/,) and the span folder that holds the release, and applied in the order
// of their four-digit numbers. A patch lives at the outermost level at which it is the same for every release below.
// Every patch has a header line "Targets: common|native|wasm" (comma separated): "common" patches go into every build, "native"
// ones into the static image only, "wasm" ones into the WebAssembly build only. The last native patch (9xxx) is the wrapper that
// links the server, initdb, the entrypoint and the data files into one executable.
//
// apply copies the source tree and applies the patches of the release for the target at fuzz 0 (fuzz is refused by default).
//
// Exit codes: 0 ok, 1 verification/apply failure, 2 usage error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const pt = require('./patchtree');

const root = path.resolve(__dirname, '..');
const TARGETS = ['common', 'native', 'wasm'];
const REQUIRED = ['Subject', 'Purpose', 'Components', 'Checks', 'Origin', 'Targets'];
const BORROWED = ['Source-URL', 'Source-Commit', 'Source-License', 'Adaptation'];

function usage(msg) { if (msg) console.error(msg); console.error('usage: patches.js verify|apply [options] (see header of this file)'); process.exit(2); }

const [cmd, ...rest] = process.argv.slice(2);
const opt = { patches: path.join(root, 'patches'), thirdParty: path.join(root, 'THIRD_PARTY.md'), fuzz: 0 };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--patches') opt.patches = path.resolve(rest[++i] || usage('--patches needs a value'));
  else if (a === '--third-party') opt.thirdParty = path.resolve(rest[++i] || usage('--third-party needs a value'));
  else if (a === '--src') opt.src = path.resolve(rest[++i] || usage('--src needs a value'));
  else if (a === '--out') opt.out = path.resolve(rest[++i] || usage('--out needs a value'));
  else if (a === '--target') opt.target = rest[++i];
  else if (a === '--version') opt.version = rest[++i] || usage('--version needs a value');
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

// ---- verify: shape of the tree, names, numbers on every path, headers
function verify() {
  const errors = [];
  const thirdParty = fs.existsSync(opt.thirdParty) ? fs.readFileSync(opt.thirdParty, 'utf8') : '';
  const base = opt.patches;
  const nodes = [];   // { rel, depth, kind, children spans }
  const walk = (rel, kind, parentFamily) => {
    const dir = path.join(base, rel);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const where = rel || 'patches';
      if (e.isFile()) {
        if (!pt.PATCH_NAME.test(e.name)) errors.push(`${where}/${e.name}: a patch is named NNNN-name.patch (four digits, then lower-case words joined by hyphens)`);
        continue;
      }
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (kind === 'root') {
        if (!/^\d+$/.test(e.name)) { errors.push(`${sub}: a folder in patches/ is a PostgreSQL major version, such as 9, 10 or 18`); continue; }
        nodes.push({ rel: sub, kind: 'family' }); walk(sub, 'family', e.name);
      } else if (kind === 'family' || kind === 'series') {
        const m = pt.SPAN.exec(e.name);
        if (kind === 'family' && parentFamily === '9' && /^9\.\d+$/.test(e.name)) { nodes.push({ rel: sub, kind: 'series' }); walk(sub, 'series', parentFamily); continue; }
        if (!m) { errors.push(`${sub}: a folder here is a version (17.4) or a span of versions (17.4-17.9)`); continue; }
        const [from, to] = [m[1], m[2] || m[1]];
        if (pt.family(from) !== parentFamily || pt.family(to) !== parentFamily) errors.push(`${sub}: the span leaves the ${parentFamily} family`);
        if (pt.cmpVer(from, to) > 0) errors.push(`${sub}: the span runs backwards`);
        if (parentFamily === '9' && pt.series(from) !== pt.series(to)) errors.push(`${sub}: a span stays inside one series`);
        nodes.push({ rel: sub, kind: 'span', from, to, parent: rel });
        if (fs.readdirSync(path.join(base, sub), { withFileTypes: true }).some((x) => x.isDirectory())) errors.push(`${sub}: nothing nests inside a span`);
      }
    }
  };
  walk('', 'root', null);
  // spans of one parent do not overlap
  const byParent = new Map();
  for (const n of nodes.filter((x) => x.kind === 'span')) { if (!byParent.has(n.parent)) byParent.set(n.parent, []); byParent.get(n.parent).push(n); }
  for (const list of byParent.values()) {
    list.sort((a, b) => pt.cmpVer(a.from, b.from));
    for (let i = 1; i < list.length; i++) if (pt.cmpVer(list[i].from, list[i - 1].to) <= 0) errors.push(`${list[i].rel}: overlaps ${list[i - 1].rel}`);
  }
  // every patch: header; a number occurs once on every path (outer folder + inner folder)
  let count = 0;
  const filesOf = (rel) => pt.patchFiles(path.join(base, rel));
  const own = new Map();
  for (const rel of ['', ...nodes.map((n) => n.rel)]) {
    const names = filesOf(rel);
    own.set(rel, names);
    for (const f of names) {
      count++;
      checkHeader(`${rel || 'patches'}/${f}`, parseHeader(fs.readFileSync(path.join(base, rel, f), 'utf8')), thirdParty, errors);
    }
  }
  const numbersOn = (chain) => {
    const seen = new Map();
    for (const rel of chain) for (const f of own.get(rel) || []) {
      const n = f.slice(0, 4);
      if (seen.has(n)) errors.push(`${rel || 'patches'}/${f}: number ${n} is already used on this path by ${seen.get(n)}`);
      else seen.set(n, `${rel || 'patches'}/${f}`);
    }
  };
  for (const n of nodes) {
    const parts = n.rel.split('/');
    const chain = [''];
    for (let i = 0; i < parts.length; i++) chain.push(parts.slice(0, i + 1).join('/'));
    if (n.kind === 'span' || n.kind === 'series' || n.kind === 'family') numbersOn(chain);
  }
  if (!count) errors.push('patches/ holds no patch');
  if (errors.length) { console.error('patches verify: FAIL'); [...new Set(errors)].forEach((e) => console.error(`  - ${e}`)); process.exit(1); }
  console.log(`patches verify: PASS (${count} patch(es) in ${nodes.length + 1} folder(s))`);
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
  if (!opt.version) usage('apply needs --version');
  if (!fs.existsSync(opt.src)) { console.error(`apply: source ${opt.src} does not exist`); process.exit(1); }
  if (path.resolve(opt.out) === path.resolve(opt.src)) { console.error('apply: --out must differ from --src (the fetched tree is never patched in place)'); process.exit(1); }

  const thirdParty = fs.existsSync(opt.thirdParty) ? fs.readFileSync(opt.thirdParty, 'utf8') : '';
  const { folders, files } = pt.collect(opt.patches, opt.version);
  if (folders.length < 2) { console.error(`apply: no patch folder for PostgreSQL ${opt.version} (patches/${pt.family(opt.version)})`); process.exit(1); }
  const errors = [];
  const entries = [];
  for (const f of files) {
    const header = parseHeader(fs.readFileSync(f.file, 'utf8'));
    checkHeader(`${f.folder || 'patches'}/${f.name}`, header, thirdParty, errors);
    const targets = (header.Targets || '').split(',').map((x) => x.trim());
    if (targets.includes('common') || targets.includes(opt.target)) entries.push({ ...f, header });
  }
  if (errors.length) { console.error('apply: patches are not valid:'); errors.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }

  fs.rmSync(opt.out, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.cpSync(opt.src, opt.out, { recursive: true, preserveTimestamps: true, filter: (s) => path.basename(s) !== '.compactdb-verified' });
  const patchArgs = ['-p1', '-N', '--no-backup-if-mismatch', '-r', '-', '-F', String(opt.fuzz)];
  const applied = [];
  for (const e of entries) {
    const r = spawnSync('patch', [...patchArgs, '-i', e.file], { cwd: opt.out, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const fuzzy = /succeeded at \d+ with fuzz (\d+)/.exec(out);
    const bad = r.status !== 0 || /FAILED|rejected/i.test(out);
    if (bad || (fuzzy && Number(fuzzy[1]) > opt.fuzz)) {
      const why = fuzzy && Number(fuzzy[1]) > opt.fuzz && r.status === 0 ? `: fuzz ${fuzzy[1]} exceeds limit ${opt.fuzz}` : ` (patch exit ${r.status})`;
      console.error(`apply: FAIL at ${e.folder || 'patches'}/${e.name}${why}\n${out}`);
      fs.rmSync(opt.out, { recursive: true, force: true });
      process.exit(1);
    }
    applied.push({ patch: e.name, folder: e.folder || '.', subject: e.header.Subject });
  }
  const report = { src: opt.src, out: opt.out, target: opt.target, version: opt.version, fuzzLimit: opt.fuzz, folders: folders.map((f) => f || '.'), applied, treeSha256: treeHash(opt.out) };
  console.log(JSON.stringify(report, null, 2));
}

if (cmd === 'verify') verify();
else if (cmd === 'apply') apply();
else usage(cmd ? `unknown command ${cmd}` : 'command required');
