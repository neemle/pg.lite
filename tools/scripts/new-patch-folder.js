#!/usr/bin/env node
'use strict';
// Makes sure a release is covered by the patch tree, adding what it needs when it is not (tools container):
//
//   tools/dc make fetch VERSION=17.12
//   tools/dc node scripts/new-patch-folder.js --to 17.12
//
// 1. If patches.js applies the tree to the release (native and wasm), nothing is added.
// 2. Otherwise the patch set of the release is put together from what the nearest releases of its major already take. Contexts
//    change between minor releases (a security fix next to a patched line is enough), so the same patch exists in several
//    variants, one per span of releases; for every patch, in number order, the variants are tried on the release at fuzz 0 and the
//    first that applies is taken. A patch that fits no variant is left out only when the lines it removes are gone from the release
//    (a later minor fixed the problem itself); otherwise the release needs a patch written by hand and the tool says which.
// 3. The tree is rebuilt with the new release in it (scripts/patchtree.js fold: what the new release shares with its neighbours stays
//    where it is, the span of a neighbour grows) and checked with patches.js apply for both targets before it replaces patches/.
//
// Needs cache/src/<version> (tools/dc make fetch) and releases of the same major in the tree. The release must be in sources.lock.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pt = require('./patchtree');

const root = path.resolve(__dirname, '..');
const patchesDir = path.join(root, 'patches');
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const to = arg('to');
if (!to) { console.error('usage: new-patch-folder.js --to <version> [--pool DIR]'); process.exit(2); }
const src = path.join(root, 'cache', 'src', to);
if (!fs.existsSync(src)) { console.error(`new-patch-folder: ${src} does not exist; run tools/dc make fetch VERSION=${to}`); process.exit(2); }
const lock = require(path.join(root, 'sources.lock.json')).releases.map((r) => r.version);
if (!lock.includes(to)) { console.error(`new-patch-folder: ${to} is not in sources.lock.json (tools/dc make release-index)`); process.exit(2); }

const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const patchesJs = path.join(__dirname, 'patches.js');
const applies = (dir, target) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npf-'));
  const r = run('node', [patchesJs, 'apply', '--src', src, '--out', path.join(tmp, 'o'), '--target', target, '--version', to, '--patches', dir]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return r.status === 0;
};

// ---- 1. already covered?
if (applies(patchesDir, 'native') && applies(patchesDir, 'wasm')) { console.log(`${to}: covered by the tree`); process.exit(0); }

// ---- 2. put the patch set together from the nearest releases of the major
const header = (text) => {
  const h = {}; let key = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^(diff |--- |Index: |\+\+\+ )/.test(line)) break;
    const m = /^([A-Za-z][A-Za-z-]*):\s?(.*)$/.exec(line);
    if (m) { key = m[1]; h[key] = m[2]; } else if (key && /^\s+\S/.test(line)) h[key] += ` ${line.trim()}`; else if (line.trim() === '') key = null;
  }
  return h;
};
const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npf-flat-'));
const others = lock.filter((v) => v !== to && pt.family(v) === pt.family(to));
if (!others.length) { console.error(`new-patch-folder: the tree has no release of the ${pt.family(to)} family to start from`); process.exit(2); }
pt.flatten(patchesDir, flatDir, lock.filter((v) => v !== to));
const key = (v) => { const p = v.split('.').map(Number); return p[p.length - 1]; };
others.sort((a, b) => Math.abs(key(a) - key(to)) - Math.abs(key(b) - key(to)) || key(b) - key(a));

// slot "NNNN-name.patch" -> variants [{from, file, text}] (distinct contents, nearest release first)
const slots = new Map();
for (const v of others) {
  for (const f of fs.readdirSync(path.join(flatDir, v)).sort()) {
    const file = path.join(flatDir, v, f);
    const text = fs.readFileSync(file, 'utf8');
    if (!slots.has(f)) slots.set(f, { variants: [], targets: header(text).Targets.split(',').map((x) => x.trim()) });
    const s = slots.get(f);
    if (!s.variants.some((x) => x.text === text)) s.variants.push({ from: v, file, text });
  }
}
// --pool DIR: more variants (files of an earlier layout, named <target>__<range>__NNNN-name[-rX.Y].patch, with a Targets header), tried last
const poolArg = arg('pool');
if (poolArg) {
  const NAMES = { 'static-modules': '0000', 'no-locale-a': '0010', 'snowball-english-only': '0020', 'no-shell-spawn': '0100', 'static-libpqwalreceiver': '0110',
    'wasm-shared-memory': '0200', 'wasm-no-root-check': '0210', 'wasm-initdb-popen': '0220', 'wasm-user-name': '0230', 'wasm-semaphores': '0240',
    'wasm-dsm-sysv': '0250', 'wasm-embedded-protocol': '0260', 'wasm-storage-barrier': '0270', 'wasm-walker-signature': '0280' };
  const plan = JSON.parse(run('node', [path.join(__dirname, 'resolve.js'), to, '--allow-missing-builder']).stdout);
  for (const f of fs.readdirSync(poolArg).sort()) {
    const parts = f.replace(/\.patch$/, '').split('__');
    if (parts.length === 3 && parts[1] !== plan.range) continue;
    const slug = parts[parts.length - 1].replace(/-r\d+(\.\d+)*$/, '').replace(/-pg\d+$/, '').replace(/^\d+-/, '');
    if (!(slug in NAMES)) continue;
    const name = `${NAMES[slug]}-${slug}.patch`;
    const text = fs.readFileSync(path.join(poolArg, f), 'utf8');
    if (!slots.has(name)) slots.set(name, { variants: [], targets: header(text).Targets.split(',').map((x) => x.trim()) });
    const s = slots.get(name);
    if (!s.variants.some((x) => x.text === text)) s.variants.push({ from: `pool/${f}`, file: path.join(poolArg, f), text });
  }
}

// Does the tree still contain what the patch removes? '' = gone (a patch may then be left out), null = it removes nothing (never left out)
function stillNeeded(text, tree) {
  let removesSomething = false;
  for (const section of text.split(/^diff --git /m).slice(1)) {
    const file = /^a\/\S+ b\/(\S+)/.exec(section);
    const removed = section.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim()).filter(Boolean);
    if (!file || !removed.length) continue;
    removesSomething = true;
    const full = path.join(tree, file[1]);
    if (!fs.existsSync(full)) continue;
    const lines = new Set(fs.readFileSync(full, 'utf8').split('\n').map((l) => l.trim()));
    if (removed.every((r) => lines.has(r))) return file[1];
  }
  return removesSomething ? '' : null;
}

const chosen = new Map();   // slot -> variant (null = left out); the common patches are shared by both targets
const failures = [];
for (const target of ['native', 'wasm']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npf-'));
  const tree = path.join(tmp, 'tree');
  fs.cpSync(src, tree, { recursive: true, preserveTimestamps: true });
  const trial = (v, dry) => {
    const r = run('patch', ['-p1', '-N', '--no-backup-if-mismatch', '-r', '-', '-F', '0', ...(dry ? ['--dry-run'] : []), '-i', v.file], { cwd: tree });
    return r.status === 0 && !/FAILED|rejected/i.test(`${r.stdout}${r.stderr}`) && !/with fuzz/.test(r.stdout);
  };
  for (const name of [...slots.keys()].sort()) {
    const s = slots.get(name);
    if (!s.targets.includes('common') && !s.targets.includes(target)) continue;
    const forced = s.targets.includes('common') ? chosen.get(name) : undefined;
    if (forced === null) continue;
    const candidates = forced === undefined ? s.variants : [forced];
    const v = candidates.find((c) => trial(c, true));
    if (v) { trial(v, false); if (!chosen.has(name)) chosen.set(name, v); continue; }
    const left = stillNeeded(s.variants[0].text, tree);
    if (left === '') { if (s.targets.includes('common')) chosen.set(name, null); continue; }
    failures.push(left ? `${target}: ${name} fits no variant and the text it changes is still there (${left})` : `${target}: ${name} fits no variant`);
    break;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  fs.rmSync(flatDir, { recursive: true, force: true });
  console.error(`${to}: cannot be put together from the existing patches:\n  - ${failures.join('\n  - ')}\nWrite the patch for ${to} by hand (take the nearest release's patch set, edit what no longer fits), see docs/patches.md.`);
  process.exit(1);
}

// ---- 3. fold the tree again with the new release in it, check it, replace patches/
fs.mkdirSync(path.join(flatDir, to), { recursive: true });
for (const [n, v] of chosen) if (v) fs.writeFileSync(path.join(flatDir, to, n), v.text);
const newTree = fs.mkdtempSync(path.join(os.tmpdir(), 'npf-tree-'));
pt.writeTree(pt.foldMaps(pt.readFlat(flatDir)), newTree);
if (!applies(newTree, 'native') || !applies(newTree, 'wasm')) {
  console.error(`${to}: the patch set did not apply from the rebuilt tree; patches/ unchanged`);
  process.exit(1);
}
// the other releases must come out exactly as before
let changed = 0;
for (const v of lock.filter((x) => x !== to)) {
  const a = pt.collect(patchesDir, v).files.map((f) => [f.name, fs.readFileSync(f.file, 'utf8')]);
  const b = pt.collect(newTree, v).files.map((f) => [f.name, fs.readFileSync(f.file, 'utf8')]);
  if (JSON.stringify(a) !== JSON.stringify(b)) changed++;
}
if (changed) { console.error(`${to}: rebuilding the tree would change the patches of ${changed} other release(s); patches/ unchanged`); process.exit(1); }
pt.clearDir(patchesDir);
fs.cpSync(newTree, patchesDir, { recursive: true });
fs.rmSync(newTree, { recursive: true, force: true });
fs.rmSync(flatDir, { recursive: true, force: true });
console.log(`${to}: added to the patch tree (${[...chosen.values()].filter(Boolean).length} patches)`);
