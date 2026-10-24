#!/usr/bin/env node
'use strict';
// Patch-series tooling. Runs inside the tools container (needs GNU patch).
//
//   patches.js verify [--patches DIR] [--third-party FILE]
//   patches.js apply --src DIR --out DIR [--targets common,native] [--patches DIR] [--fuzz N]
//
// Layout: <patches>/<target>/series lists patch files (relative to that directory) in order.
// Every patch starts with a header (see docs/patches.md). verify checks headers, series
// consistency and attribution; apply copies the source tree and applies the series in order,
// failing on any reject or on fuzz above the limit (default 0).
//
// Exit codes: 0 ok, 1 verification/apply failure, 2 usage error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const TARGETS = ['common', 'native', 'wasm'];
const REQUIRED = ['Subject', 'Purpose', 'Components', 'Checks', 'Origin'];
const BORROWED = ['Source-URL', 'Source-Commit', 'Source-License', 'Adaptation'];

function usage(msg) { if (msg) console.error(msg); console.error('usage: patches.js verify|apply [options] (see header of this file)'); process.exit(2); }

const [cmd, ...rest] = process.argv.slice(2);
const opt = { patches: path.join(root, 'patches'), thirdParty: path.join(root, 'THIRD_PARTY.md'), targets: ['common', 'native', 'wasm'], fuzz: 0, series: {} };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--patches') opt.patches = path.resolve(rest[++i] || usage('--patches needs a value'));
  else if (a === '--third-party') opt.thirdParty = path.resolve(rest[++i] || usage('--third-party needs a value'));
  else if (a === '--src') opt.src = path.resolve(rest[++i] || usage('--src needs a value'));
  else if (a === '--out') opt.out = path.resolve(rest[++i] || usage('--out needs a value'));
  else if (a === '--targets') opt.targets = (rest[++i] || usage('--targets needs a value')).split(',').filter(Boolean);
  else if (a === '--fuzz') opt.fuzz = Number(rest[++i]);
  else if (a === '--series') { const m = /^(common|native|wasm)=(series(\.[a-z0-9-]+)?)$/.exec(rest[++i] || ''); if (!m) usage('--series needs target=series[.name]'); opt.series[m[1]] = m[2]; }
  else usage(`unknown argument ${a}`);
}
for (const t of opt.targets) if (!TARGETS.includes(t)) usage(`unknown target ${t}; known: ${TARGETS.join(', ')}`);
if (!Number.isInteger(opt.fuzz) || opt.fuzz < 0) usage('--fuzz must be a non-negative integer');

// ---- series and headers ------------------------------------------------------------
function readSeries(target, errors, name = 'series') {
  const dir = path.join(opt.patches, target);
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) { errors.push(`${target}: series file missing (${path.relative(root, file)})`); return []; }
  const seen = new Set();
  const entries = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.includes('..') || path.isAbsolute(line) || !line.endsWith('.patch')) {
      errors.push(`${target}/${name}:${n + 1}: "${line}" must be a relative *.patch path without ".."`); return;
    }
    if (seen.has(line)) { errors.push(`${target}/${name}:${n + 1}: duplicate entry ${line}`); return; }
    seen.add(line);
    entries.push({ target, rel: line, file: path.join(dir, line) });
  });
  return entries;
}

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

function verify() {
  const errors = [];
  const thirdParty = fs.existsSync(opt.thirdParty) ? fs.readFileSync(opt.thirdParty, 'utf8') : '';
  let count = 0;
  let seriesFiles = 0;
  for (const target of TARGETS) {
    const dir = path.join(opt.patches, target);
    // Every series file of the target: "series" (the baseline) and "series.<range>" ones.
    const names = ['series'];
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^series\.[a-z0-9-]+$/.test(f)) names.push(f);
    const entries = [];
    for (const name of names) {
      seriesFiles++;
      for (const e of readSeries(target, errors, name)) {
        count++;
        entries.push(e);
        if (!fs.existsSync(e.file)) { errors.push(`${target}: series entry ${e.rel} (${name}) does not exist`); continue; }
        checkHeader(`${target}/${e.rel}`, parseHeader(fs.readFileSync(e.file, 'utf8')), thirdParty, errors);
      }
    }
    if (fs.existsSync(dir)) {
      const listed = new Set(entries.map((e) => path.normalize(e.rel)));
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
      for (const f of walk(dir)) {
        const rel = path.relative(dir, f);
        if (rel.endsWith('.patch') && !listed.has(path.normalize(rel))) errors.push(`${target}: ${rel} exists but is not in the series (orphan)`);
      }
    }
  }
  if (errors.length) { console.error('patches verify: FAIL'); errors.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }
  console.log(`patches verify: PASS (${count} patch(es) in ${seriesFiles} series file(s))`);
}

// ---- apply -------------------------------------------------------------------------
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
  if (!fs.existsSync(opt.src)) { console.error(`apply: source ${opt.src} does not exist`); process.exit(1); }
  if (path.resolve(opt.out) === path.resolve(opt.src)) { console.error('apply: --out must differ from --src (the fetched tree is never patched in place)'); process.exit(1); }

  const errors = [];
  const entries = opt.targets.flatMap((t) => readSeries(t, errors, opt.series[t] || 'series'));
  const thirdParty = fs.existsSync(opt.thirdParty) ? fs.readFileSync(opt.thirdParty, 'utf8') : '';
  for (const e of entries) {
    if (!fs.existsSync(e.file)) { errors.push(`${e.target}: series entry ${e.rel} does not exist`); continue; }
    checkHeader(`${e.target}/${e.rel}`, parseHeader(fs.readFileSync(e.file, 'utf8')), thirdParty, errors);
  }
  if (errors.length) { console.error('apply: series is not valid:'); errors.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }

  fs.rmSync(opt.out, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.cpSync(opt.src, opt.out, { recursive: true, preserveTimestamps: true, filter: (s) => path.basename(s) !== '.compactdb-verified' });

  const applied = [];
  for (const e of entries) {
    const r = spawnSync('patch', ['-p1', '-N', '--no-backup-if-mismatch', '-r', '-', '-F', String(opt.fuzz), '-i', e.file], { cwd: opt.out, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const fuzzy = /succeeded at \d+ with fuzz (\d+)/.exec(out);
    if (r.status !== 0 || /FAILED|rejected/i.test(out)) {
      console.error(`apply: FAIL at ${e.target}/${e.rel} (patch exit ${r.status})\n${out}`);
      fs.rmSync(opt.out, { recursive: true, force: true });
      process.exit(1);
    }
    if (fuzzy && Number(fuzzy[1]) > opt.fuzz) {
      console.error(`apply: FAIL at ${e.target}/${e.rel}: fuzz ${fuzzy[1]} exceeds limit ${opt.fuzz}\n${out}`);
      fs.rmSync(opt.out, { recursive: true, force: true });
      process.exit(1);
    }
    applied.push({ target: e.target, patch: e.rel, subject: parseHeader(fs.readFileSync(e.file, 'utf8')).Subject });
  }
  const report = { src: opt.src, out: opt.out, targets: opt.targets, fuzzLimit: opt.fuzz, applied, treeSha256: treeHash(opt.out) };
  console.log(JSON.stringify(report, null, 2));
}

if (cmd === 'verify') verify();
else if (cmd === 'apply') apply();
else usage(cmd ? `unknown command ${cmd}` : 'command required');
