#!/usr/bin/env node
'use strict';
// Does the patch series of a release range apply to every release of the range? (maintainer tool, tools container,
// network on for the downloads: DC_NET=1 tools/dc node scripts/check-releases.js ...)
//
//   check-releases.js [--all | --range pg16 | --versions 16.0,16.1] [--jobs 3] [--report reports/release-apply.json]
//                     [--recheck] [--keep] [--no-syntax]
//
// For each release: fetch and verify it (scripts/fetch.sh, so the pinned SHA-256 decides), apply the common+native and the
// common+wasm patches (the folder patches/<version> or the nearest tested one) exactly as `make native-src` / `make wasm-src` do (scripts/patches.js, fuzz 0), record
// the result, check that the files the series touches still compile (scripts/syntax-check.sh: configure and the generated
// headers on a pristine copy, then gcc -fsyntax-only on the patched files; needs gcc, so run it in the check builder:
// DC_NET=1 tools/dcb check node scripts/check-releases.js ...; --no-syntax skips this), and delete the tree and the archive again (one release at a time costs about 150 MB; --keep keeps them).
// The report maps each version to "ok" or to what failed (target, patch, files with a failed hunk). It is written after
// every release, so a stopped run continues where it was; releases already "ok" are skipped unless --recheck.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = { jobs: 3, report: path.join(root, 'reports', 'release-apply.json'), versions: null, range: null, all: false, recheck: false, keep: false, syntax: true };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--all') opt.all = true;
  else if (a === '--recheck') opt.recheck = true;
  else if (a === '--keep') opt.keep = true;
  else if (a === '--no-syntax') opt.syntax = false;
  else if (a === '--range') opt.range = args[++i];
  else if (a === '--versions') opt.versions = (args[++i] || '').split(',').filter(Boolean);
  else if (a === '--jobs') opt.jobs = Number(args[++i]);
  else if (a === '--report') opt.report = path.resolve(args[++i]);
  else { console.error(`check-releases: unknown argument ${a}`); process.exit(2); }
}
if (!opt.all && !opt.range && !opt.versions) { console.error('usage: check-releases.js --all | --range <id> | --versions a,b [--jobs N] [--report F] [--recheck] [--keep]'); process.exit(2); }

const run = (cmd, argv, o = {}) => new Promise((resolve) => {
  const p = spawn(cmd, argv, { cwd: root, ...o });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

const lock = JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json'), 'utf8'));
const report = fs.existsSync(opt.report) ? JSON.parse(fs.readFileSync(opt.report, 'utf8')) : {};
const save = () => {
  const sorted = Object.fromEntries(Object.entries(report).sort(([a], [b]) => {
    const x = a.split('.').map(Number); const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  }));
  fs.mkdirSync(path.dirname(opt.report), { recursive: true });
  fs.writeFileSync(opt.report, `${JSON.stringify(sorted, null, 1)}\n`);
};

async function planOf(version) {
  const r = await run('node', ['scripts/resolve.js', version, '--allow-missing-builder']);
  if (r.code !== 0) throw new Error(`resolve ${version}: ${r.out}`);
  return JSON.parse(r.out);
}

// what a failed apply says: the patch and, per file, the hunks that did not fit
function failure(out) {
  const m = /apply: FAIL at (\S+)/.exec(out);
  const files = [];
  let file = null;
  for (const line of out.split('\n')) {
    const f = /^patching file (\S+)/.exec(line);
    if (f) file = f[1];
    if (/FAILED|rejected/i.test(line) && file && !files.includes(file)) files.push(file);
  }
  return { patch: m ? m[1] : 'unknown', files };
}

// the files a patch touches, from its diff headers
function touchedFiles(patchFile) {
  return [...fs.readFileSync(patchFile, 'utf8').matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]).filter((f) => f.endsWith('.c'));
}

// a pristine copy, configured, with the generated headers (in-tree build)
async function configured(version, dir, extra) {
  await run('cp', ['-a', path.join(root, 'cache', 'src', version), dir]);
  const cflags = '-O0 -std=gnu17 -Wno-error=implicit-function-declaration -Wno-error=implicit-int -Wno-error=int-conversion -Wno-error=incompatible-pointer-types';
  const c = await run('sh', ['-c', `cd "${dir}" && ./configure --without-readline --without-zlib --without-icu ${extra.join(' ')} CFLAGS="${cflags}" >configure.log 2>&1`]);
  if (c.code !== 0) return `configure failed (exit ${c.code})`;
  const h = await run('sh', ['-c', `cd "${dir}" && if grep -q '^generated-headers' src/backend/Makefile; then make -C src/backend generated-headers; else make -C src/backend ../../src/include/parser/gram.h ../../src/include/catalog/schemapg.h ../../src/include/utils/fmgroids.h ../../src/include/utils/errcodes.h ../../src/include/utils/probes.h; fi >headers.log 2>&1; true`]);
  return h.code === 0 ? null : 'headers failed';
}

async function check(version) {
  const plan = await planOf(version);
  const res = { range: plan.range };
  const f = await run('sh', ['scripts/fetch.sh', version], { env: { ...process.env } });
  if (f.code !== 0) { res.fetch = `exit ${f.code}: ${f.out.trim().split('\n').slice(-2).join(' | ')}`; return res; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `chk-${version}-`));
  try {
    const series = await run('node', ['scripts/resolve.js', version, '--allow-missing-builder', '--patch-args']);
    const sargs = series.out.trim().split(/\s+/).filter(Boolean);
    let cfg = null;
    if (opt.syntax) {
      cfg = path.join(tmp, 'cfg');
      // the range's own configure options that apply to both targets (--disable-thread-safety picks the semaphores of 9.x)
      const err = await configured(version, cfg, (plan.configure || []).filter((o) => /^--/.test(o)));
      if (err) { res.syntax = err; cfg = null; }
    }
    const syntax = [];
    for (const name of ['native', 'wasm']) {
      const out = path.join(tmp, name);
      const r = await run('node', ['scripts/patches.js', 'apply', '--src', `cache/src/${version}`, '--out', out, '--target', name, ...sargs]);
      res[name] = r.code === 0 ? 'ok' : failure(r.out);
      if (r.code === 0) res[`${name}Patches`] = JSON.parse(r.out).patchDir;
      if (r.code === 0 && cfg) {
        const rep = JSON.parse(r.out);
        const files = [...new Set(rep.applied.flatMap((a) => touchedFiles(path.join(root, 'patches', rep.patchDir, a.patch))))];
        const s = await run('sh', ['scripts/syntax-check.sh', cfg, out, name, ...files]);
        if (s.code !== 0) syntax.push(`${name}: ${s.code === 3 ? 'nothing could be checked' : s.out.trim().split('\n').slice(0, 6).join(' | ')}`);
      }
      fs.rmSync(out, { recursive: true, force: true });
    }
    if (cfg) res.syntax = syntax.length ? syntax : 'ok';
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!opt.keep) {
      fs.rmSync(path.join(root, 'cache', 'src', version), { recursive: true, force: true });
      fs.rmSync(path.join(root, 'cache', 'downloads', `postgresql-${version}.tar.bz2`), { force: true });
    }
  }
  return res;
}

(async () => {
  let versions = lock.releases.map((r) => r.version);
  if (opt.versions) versions = versions.filter((v) => opt.versions.includes(v));
  if (opt.range) {
    const keep = [];
    for (const v of versions) if ((await planOf(v)).range === opt.range) keep.push(v);
    versions = keep;
  }
  const good = (r) => r && r.native === 'ok' && r.wasm === 'ok' && (!opt.syntax || r.syntax === 'ok');
  if (!opt.recheck) versions = versions.filter((v) => !good(report[v]));
  console.log(`check-releases: ${versions.length} release(s), ${opt.jobs} at a time`);
  const queue = [...versions];
  let done = 0;
  const worker = async () => {
    for (let v = queue.shift(); v; v = queue.shift()) {
      let res;
      try { res = await check(v); } catch (e) { res = { error: String(e.message || e) }; }
      report[v] = good(res) ? { range: res.range, native: 'ok', wasm: 'ok', patches: res.nativePatches === res.wasmPatches ? res.nativePatches : [res.nativePatches, res.wasmPatches], ...(opt.syntax ? { syntax: 'ok' } : {}) } : res;
      save();
      done++;
      const bad = !good(res);
      console.log(`${String(done).padStart(3)}/${versions.length} ${v.padEnd(8)} ${res.range || ''} ${bad ? `FAIL native=${JSON.stringify(res.native || res.fetch || res.error)} wasm=${JSON.stringify(res.wasm || '')} syntax=${JSON.stringify(res.syntax || '')}` : 'ok'}`);
    }
  };
  await Promise.all(Array.from({ length: opt.jobs }, worker));
  const failed = Object.entries(report).filter(([, r]) => !good(r)).map(([v]) => v);
  console.log(`check-releases: ${Object.keys(report).length} in the report, ${failed.length} do not apply${failed.length ? `: ${failed.join(' ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
