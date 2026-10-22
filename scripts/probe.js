#!/usr/bin/env node
'use strict';
// Version-agnostic configure probing. For one release (or all of them) it
//   1. reads that release's real `configure --help`,
//   2. maps the feature profile and the range's extra options onto the options that EXIST in that
//      release (an option that does not exist is skipped and logged, never guessed),
//   3. detects capabilities (SCRAM, gen_random_uuid, ON CONFLICT, ...) from the release's own tree
//      and configure help, driven by capabilities.json (data; no per-version logic here).
//
//   probe.js <version> [--tree DIR] [--prefix P] [--cache DIR]
//   probe.js --all [--out FILE] [--concurrency N] [--cache DIR]      (needs network the first time)
//
// A release is read from --tree, else from cache/src/<version>, else the files the probe needs
// are fetched by locked commit SHA from the official GitHub mirror (raw files, cached).
// Exit codes: 0 ok, 1 a probe or check failed, 2 usage/network error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- pure functions (unit-tested) ----------------------------------------------------
function optionKey(flag) {
  const m = /^--(with|without|enable|disable)-([a-z0-9-]+)/.exec(flag);
  return m ? `${m[1] === 'with' || m[1] === 'without' ? 'with' : 'enable'}:${m[2]}` : null;
}

function helpOptions(text) {
  const keys = new Set();
  for (const m of text.matchAll(/--(?:with|without|enable|disable)-[A-Za-z0-9-]+/g)) keys.add(optionKey(m[0]));
  keys.delete(null);
  return keys;
}

// Which of the wanted configure flags exist in this release; the rest are skipped with a reason.
function buildArgs({ known, profile, rangeConfigure, prefix }) {
  const args = [`--prefix=${prefix}`];
  const skipped = [];
  const want = [
    ...profile.features.filter((f) => f.configureFlag).map((f) => ({ flag: f.configureFlag, source: `feature:${f.name}` })),
    ...rangeConfigure.map((flag) => ({ flag, source: 'range' })),
  ];
  for (const { flag, source } of want) {
    const k = optionKey(flag);
    if (k && known.has(k)) args.push(flag);
    else skipped.push({ flag, source, reason: 'option not present in this release' });
  }
  return { args, skipped };
}

function detectCapabilities({ known, capabilities, provider }) {
  const out = {};
  const evidence = {};
  for (const c of capabilities) {
    const p = c.probe;
    let value = false;
    let why = '';
    if (p.fileExists) {
      value = provider.exists(p.fileExists);
      why = `${p.fileExists} ${value ? 'exists' : 'absent'}`;
    } else if (p.fileContains) {
      const re = new RegExp(p.fileContains.regex);
      for (const f of p.fileContains.anyOf) {
        const text = provider.read(f);
        if (text !== null && re.test(text)) { value = true; why = `${f} matches /${p.fileContains.regex}/`; break; }
      }
      if (!value) why = `no match for /${p.fileContains.regex}/ in ${p.fileContains.anyOf.join(', ')}`;
    } else if (p.configureOption) {
      value = known.has(optionKey(p.configureOption));
      why = `configure --help ${value ? 'lists' : 'does not list'} ${p.configureOption}`;
    } else if (p.configureOptionAnyOf) {
      value = p.configureOptionAnyOf.some((o) => known.has(optionKey(o)));
      why = `configure --help ${value ? 'lists one of' : 'lists none of'} ${p.configureOptionAnyOf.join(', ')}`;
    } else {
      throw new Error(`capability ${c.id}: unknown probe type`);
    }
    out[c.id] = value;
    evidence[c.id] = why;
  }
  return { capabilities: out, evidence };
}

// Which files the capability probes will read (so a remote provider fetches only those).
function probeFiles(capabilities) {
  const files = new Set();
  for (const c of capabilities) {
    if (c.probe.fileExists) files.add(c.probe.fileExists);
    if (c.probe.fileContains) c.probe.fileContains.anyOf.forEach((f) => files.add(f));
  }
  return [...files].sort();
}

const ver = (s) => { const p = s.split('.').map(Number); return [p[0], p[1], p[2] || 0]; };
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const within = (v, from, to) => cmp(ver(from), ver(v)) <= 0 && cmp(ver(v), ver(to)) <= 0;

function configureHelp(dir) {
  const r = spawnSync('sh', ['./configure', '--help'], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`configure --help failed in ${dir}: ${r.stderr}`);
  return r.stdout;
}

class TreeProvider {
  constructor(dir) { this.dir = dir; }
  exists(rel) { return fs.existsSync(path.join(this.dir, rel)); }
  read(rel) { const f = path.join(this.dir, rel); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; }
  help() { return configureHelp(this.dir); }
}

module.exports = { optionKey, helpOptions, buildArgs, detectCapabilities, probeFiles, within, TreeProvider };

if (require.main !== module) return;

// ---- main -----------------------------------------------------------------------------
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = { version: null, tree: null, prefix: '/usr/local/pgsql', cache: path.join(root, 'cache'), all: false, out: path.join(root, 'reports', 'probe-matrix.json'), concurrency: 6 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--all') opt.all = true;
  else if (a === '--tree') opt.tree = path.resolve(args[++i] || '');
  else if (a === '--prefix') opt.prefix = args[++i];
  else if (a === '--cache') opt.cache = path.resolve(args[++i] || '');
  else if (a === '--out') opt.out = path.resolve(args[++i] || '');
  else if (a === '--concurrency') opt.concurrency = Number(args[++i]);
  else if (!a.startsWith('--') && !opt.version) opt.version = a;
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
if (!opt.all && !opt.version) { console.error('usage: probe.js <version> [--tree DIR] | --all'); process.exit(2); }

const load = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const sources = load('sources.lock.json');
const ranges = load('ranges.json').ranges;
const profile = load('feature-profile.json');
const capabilities = load('capabilities.json').capabilities;
const wanted = probeFiles(capabilities);

// Remote provider: raw files by commit SHA from the official GitHub mirror, cached on disk.
const RAW = 'https://raw.githubusercontent.com/postgres/postgres';
async function fetchRaw(commit, rel) {
  const dest = path.join(opt.cache, 'probe', commit, rel);
  const missing = `${dest}.missing`;
  if (fs.existsSync(dest) || fs.existsSync(missing)) return;
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${RAW}/${commit}/${rel}`, { signal: AbortSignal.timeout(60000) });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (r.status === 404) { fs.writeFileSync(missing, ''); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) { last = new Error(`${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`); await new Promise((res) => setTimeout(res, 800 * (i + 1))); }
  }
  throw new Error(`fetch ${rel} @ ${commit}: ${last.message}`);
}

async function providerFor(rel) {
  if (opt.tree) return { p: new TreeProvider(opt.tree), source: `tree ${opt.tree}` };
  const local = path.join(opt.cache, 'src', rel.version);
  if (fs.existsSync(path.join(local, 'configure'))) return { p: new TreeProvider(local), source: `fetched tree cache/src/${rel.version}` };
  for (const f of ['configure', ...wanted]) await fetchRaw(rel.commit, f);
  const dir = path.join(opt.cache, 'probe', rel.commit);
  return { p: new TreeProvider(dir), source: `files of commit ${rel.commit} from the GitHub mirror` };
}

async function probeOne(version) {
  const rel = sources.releases.find((r) => r.version === version);
  if (!rel) throw new Error(`version ${version} is not in sources.lock.json`);
  const range = ranges.filter((r) => within(version, r.from, r.to));
  if (range.length !== 1) throw new Error(`version ${version} is covered by ${range.length} ranges`);
  const { p, source } = await providerFor(rel);
  const known = helpOptions(p.help());
  if (known.size < 10) throw new Error(`${version}: configure --help parsed to only ${known.size} options`);
  const { args: a, skipped } = buildArgs({ known, profile, rangeConfigure: range[0].configure, prefix: opt.prefix });
  const bad = a.slice(1).filter((x) => !known.has(optionKey(x)));
  if (bad.length) throw new Error(`${version}: configure would not accept ${bad.join(' ')}`);
  const cap = detectCapabilities({ known, capabilities, provider: p });
  return { version, range: range[0].id, source, helpOptionCount: known.size, args: a, skipped, capabilities: cap.capabilities, evidence: cap.evidence };
}

(async () => {
  if (!opt.all) { console.log(JSON.stringify(await probeOne(opt.version), null, 2)); return; }

  const versions = sources.releases.map((r) => r.version);
  const results = new Array(versions.length);
  const errors = [];
  let next = 0;
  await Promise.all(Array.from({ length: opt.concurrency }, async () => {
    while (next < versions.length) {
      const i = next++;
      try { results[i] = await probeOne(versions[i]); } catch (e) { errors.push(`${versions[i]}: ${e.message}`); }
    }
  }));
  const done = results.filter(Boolean);
  const skippedAll = done.flatMap((r) => r.skipped.map((s) => ({ version: r.version, ...s })));
  const summary = {};
  for (const c of capabilities) summary[c.id] = { true: done.filter((r) => r.capabilities[c.id]).length, false: done.filter((r) => !r.capabilities[c.id]).length };
  const report = {
    note: 'Generated by scripts/probe.js --all from each release\'s configure --help and tree files; no version-conditional logic.',
    releases: versions.length, probed: done.length, failed: errors.length,
    capabilitySummary: summary,
    skippedOptionCount: skippedAll.length,
    perVersion: done.map((r) => ({ version: r.version, range: r.range, helpOptions: r.helpOptionCount, args: r.args, skipped: r.skipped.map((s) => s.flag), capabilities: r.capabilities })),
  };
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.writeFileSync(opt.out, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`probe --all: ${done.length}/${versions.length} releases probed, ${errors.length} failed, ${skippedAll.length} option skips`);
  console.log(JSON.stringify(summary));
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e.message); process.exit(2); });
