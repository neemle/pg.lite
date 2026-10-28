#!/usr/bin/env node
'use strict';
// Makes sure a release is covered by the patches, adding the folder patches/<version> when it is not (tools container):
//
//   tools/dc make fetch VERSION=10.8
//   tools/dc node scripts/new-patch-folder.js --to 10.8
//
// 1. If the release already applies (native and wasm) with the folders that can serve it (scripts/resolve.js --patch-args:
//    its own, then the other tested versions of its major, nearest first), nothing is added.
// 2. Otherwise the folder is put together from what the other folders of the major already hold. Contexts change between minor
//    releases, so the same patch exists in several variants (one per span of releases); for every patch, in number order, the
//    variants are tried on the release at fuzz 0 and the first that applies is taken. A patch that fits no variant is left out only
//    when the text it removes is gone from the release (a later minor fixed the problem itself) and it removes something; otherwise
//    the release needs a patch written by hand and the tool says which.
// 3. The new folder is checked with scripts/patches.js apply for both targets. A folder identical to an existing one is not kept.
//
// Needs cache/src/<version> (tools/dc make fetch) and a folder of the same major under patches/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const patchesDir = path.join(root, 'patches');
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const to = arg('to');
if (!to) { console.error('usage: new-patch-folder.js --to <version>'); process.exit(2); }
const src = path.join(root, 'cache', 'src', to);
if (!fs.existsSync(src)) { console.error(`new-patch-folder: ${src} does not exist; run tools/dc make fetch VERSION=${to}`); process.exit(2); }

const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const patchesJs = path.join(__dirname, 'patches.js');
const resolveJs = path.join(__dirname, 'resolve.js');

// ---- 1. already covered?
const dirsOut = run('node', [resolveJs, to, '--allow-missing-builder', '--patch-args']);
if (dirsOut.status !== 0) { console.error(dirsOut.stderr || dirsOut.stdout); process.exit(2); }
const dirs = dirsOut.stdout.trim().split(/\s+/).filter((x) => x !== '--patch-dir');
const applies = (candidates, target) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npf-'));
  const r = run('node', [patchesJs, 'apply', '--src', src, '--out', path.join(tmp, 'o'), '--target', target, ...candidates.flatMap((d) => ['--patch-dir', d])]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return r.status === 0 ? JSON.parse(r.stdout).patchDir : null;
};
const nativeDir = applies(dirs, 'native');
const wasmDir = applies(dirs, 'wasm');
if (nativeDir && wasmDir) { console.log(`${to}: covered (native by ${nativeDir}, wasm by ${wasmDir})`); process.exit(0); }

// ---- 2. put a folder together
const header = (text) => {
  const h = {}; let key = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^(diff |--- |Index: |\+\+\+ )/.test(line)) break;
    const m = /^([A-Za-z][A-Za-z-]*):\s?(.*)$/.exec(line);
    if (m) { key = m[1]; h[key] = m[2]; } else if (key && /^\s+\S/.test(line)) h[key] += ` ${line.trim()}`; else if (line.trim() === '') key = null;
  }
  return h;
};
// slot "NNNN-name.patch" -> variants [{folder, file, text}] (distinct contents, nearest folder first)
const slots = new Map();
for (const d of dirs) {
  for (const f of fs.readdirSync(path.join(patchesDir, d)).sort()) {
    const file = path.join(patchesDir, d, f);
    const text = fs.readFileSync(file, 'utf8');
    if (!slots.has(f)) slots.set(f, { variants: [], folders: 0, targets: header(text).Targets.split(',').map((x) => x.trim()) });
    const s = slots.get(f);
    s.folders++;
    if (!s.variants.some((v) => v.text === text)) s.variants.push({ folder: d, file, text });
  }
}
// --pool DIR: more variants (files of an earlier layout, named <target>__<range>__NNNN-name[-rX.Y].patch, with a Targets header),
// tried after the folders' own. A folder written from them holds plain copies; the pool itself is not part of the repository.
const poolArg = arg('pool');
if (poolArg) {
  const NAMES = { 'static-modules': '0000', 'no-locale-a': '0010', 'snowball-english-only': '0020', 'no-shell-spawn': '0100', 'static-libpqwalreceiver': '0110',
    'wasm-shared-memory': '0200', 'wasm-no-root-check': '0210', 'wasm-initdb-popen': '0220', 'wasm-user-name': '0230', 'wasm-semaphores': '0240',
    'wasm-dsm-sysv': '0250', 'wasm-embedded-protocol': '0260', 'wasm-storage-barrier': '0270', 'wasm-walker-signature': '0280' };
  const plan = JSON.parse(run('node', [resolveJs, to, '--allow-missing-builder']).stdout);
  for (const f of fs.readdirSync(poolArg).sort()) {
    const parts = f.replace(/\.patch$/, '').split('__');
    if (parts.length === 3 && parts[1] !== plan.range) continue;      // another range's variant
    const slug = parts[parts.length - 1].replace(/-r\d+(\.\d+)*$/, '').replace(/-pg\d+$/, '').replace(/^\d+-/, '');
    if (!(slug in NAMES)) continue;
    const name = `${NAMES[slug]}-${slug}.patch`;
    const text = fs.readFileSync(path.join(poolArg, f), 'utf8');
    if (!slots.has(name)) slots.set(name, { variants: [], folders: 0, targets: header(text).Targets.split(',').map((x) => x.trim()) });
    const s = slots.get(name);
    if (!s.variants.some((v) => v.text === text)) s.variants.push({ folder: `pool/${f}`, file: path.join(poolArg, f), text });
  }
}

// Does the tree still contain what the patch removes? (a patch that fits no variant is left out only when it does not)
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
  return removesSomething ? '' : null;   // '' = the text is gone, null = nothing to look for (an additive patch is never skipped)
}

const chosen = new Map();   // slot -> variant, shared by both targets for the common patches
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
    if (forced === null) continue;                       // a common patch left out in the first run
    const candidates = forced === undefined ? s.variants : [forced];
    const v = candidates.find((c) => trial(c, true));
    if (v) { trial(v, false); if (!chosen.has(name)) chosen.set(name, v); continue; }
    // none fits: skip the patch only if the text it changes is gone from this release (a later minor fixed it itself)
    const left = stillNeeded(s.variants[0].text, tree);
    if (left === '') { if (s.targets.includes('common')) chosen.set(name, null); continue; }
    failures.push(left ? `${target}: ${name} fits no variant and the text it changes is still there (${left})` : `${target}: ${name} fits no variant`);
    break;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`${to}: cannot be put together from the existing patches:\n  - ${failures.join('\n  - ')}\nWrite the patch for ${to} by hand (copy the nearest folder, edit what no longer fits), see docs/patches.md.`);
  process.exit(1);
}

// ---- 3. write, compare, check
const files = new Map([...chosen].filter(([, v]) => v).map(([n, v]) => [n, v.text]));
const hashOf = (m) => crypto.createHash('sha256').update([...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, t]) => `${n}\0${t}`).join('\n')).digest('hex');
for (const d of dirs) {
  const existing = new Map(fs.readdirSync(path.join(patchesDir, d)).map((f) => [f, fs.readFileSync(path.join(patchesDir, d, f), 'utf8')]));
  if (hashOf(existing) === hashOf(files)) { console.log(`${to}: the combination is the folder ${d} already`); process.exit(0); }
}
const dst = path.join(patchesDir, to);
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const [n, t] of files) fs.writeFileSync(path.join(dst, n), t);
const n2 = applies([to], 'native');
const w2 = applies([to], 'wasm');
if (!n2 || !w2) {
  fs.rmSync(dst, { recursive: true, force: true });
  console.error(`${to}: the combination did not apply as a folder (native ${n2 ? 'ok' : 'FAIL'}, wasm ${w2 ? 'ok' : 'FAIL'}); nothing added`);
  process.exit(1);
}
console.log(`${to}: added patches/${to} (${files.size} patches)`);
