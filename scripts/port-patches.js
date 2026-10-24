#!/usr/bin/env node
'use strict';
// Port the patch series of one release to another (maintainer tool, tools container).
//
//   port-patches.js --from 18.6 --to 17.11 --range pg17 [--targets common,native,wasm]
//
// For every patch of the --from series, in order: when it applies to the --to tree as it is (fuzz 0) the series of
// the range simply lists the same file; when it does not, the patch is re-made by a three-way merge per file
// (base = the --from file before the patch, ours = the --from file after it, theirs = the --to file) and written as
// patches/<target>/<range>/<name>.patch, with a "Ported-from" header line. The merge result is exactly what the patch
// means for that release, and the new patch is a plain diff against the --to tree, so it applies with fuzz 0.
// A merge conflict stops the port with the file named: that patch needs a human.
//
// Output: patches/<target>/series.<range> (replaced) and the new patch files. Nothing else is touched.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = { targets: ['common', 'native', 'wasm'] };
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '');
  if (k === 'targets') opt.targets = args[i + 1].split(','); else opt[k] = args[i + 1];
}
for (const k of ['from', 'to', 'range']) if (!opt[k]) { console.error('usage: port-patches.js --from <v> --to <v> --range <name> [--targets a,b]'); process.exit(2); }

const sh = (cmd, argv, o = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const must = (r, what) => { if (r.status !== 0) { console.error(`port: ${what} failed\n${r.stdout || ''}${r.stderr || ''}`); process.exit(1); } return r; };

const work = path.join(root, 'build', 'port', `${opt.from}-to-${opt.to}`);
// hand-resolved merge results survive between runs: <target>-<patch>-<file with / as _> in this directory replaces a conflicting merge
const resolvedDir = path.join(root, 'build', 'port', `${opt.from}-to-${opt.to}-resolved`);
fs.mkdirSync(resolvedDir, { recursive: true });
const A = path.join(work, 'A');            // --from tree with the series applied step by step
const B = path.join(work, 'B');            // --to tree with the ported series applied step by step
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
must(sh('cp', ['-a', path.join(root, 'cache', 'src', opt.from), A]), 'copy from-tree');
must(sh('cp', ['-a', path.join(root, 'cache', 'src', opt.to), B]), 'copy to-tree');

const readSeries = (target) => fs.readFileSync(path.join(root, 'patches', target, 'series'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const headerOf = (text) => { const i = text.search(/^diff /m); return text.slice(0, i); };
const filesOf = (text) => [...text.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]);
const snapshot = (dir, name) => { const s = path.join(work, name); fs.rmSync(s, { recursive: true, force: true }); must(sh('cp', ['-al', dir, s]), 'snapshot'); return s; };
const tryApply = (tree, patchFile, dry) => sh('patch', ['-p1', '-F0', '-s', ...(dry ? ['--dry-run'] : []), '-d', tree, '-i', patchFile]);

const report = [];
for (const target of opt.targets) {
  const out = [];
  for (const name of readSeries(target)) {
    const file = path.join(root, 'patches', target, name);
    const text = fs.readFileSync(file, 'utf8');
    const beforeA = snapshot(A, 'A-before');
    must(tryApply(A, file, false), `${target}/${name} on ${opt.from}`);
    if (tryApply(B, file, true).status === 0) {
      must(tryApply(B, file, false), `apply ${target}/${name}`);
      out.push(name); report.push(`same     ${target}/${name}`);
      continue;
    }
    // re-make the patch for the --to tree
    const beforeB = snapshot(B, 'B-before');
    const sections = [];
    for (const rel of filesOf(text)) {
      const base = path.join(beforeA, rel); const ours = path.join(A, rel); const theirs = path.join(B, rel);
      if (!fs.existsSync(base)) {                         // a new file: same content for every release
        fs.mkdirSync(path.dirname(theirs), { recursive: true });
        fs.rmSync(theirs, { force: true }); fs.copyFileSync(ours, theirs);
      } else if (!fs.existsSync(theirs)) { console.error(`port: ${rel} does not exist in ${opt.to}`); process.exit(1); }
      else {
        const resolved = path.join(resolvedDir, `${target}-${name}-${rel.replace(/\//g, '_')}`);
        if (fs.existsSync(resolved)) {
          fs.rmSync(theirs, { force: true }); fs.copyFileSync(resolved, theirs);   // a new file: the snapshot shares the old one (hard links)
        } else {
          const merged = sh('git', ['merge-file', '-p', '--diff3', ours, base, theirs]);
          if (merged.status !== 0) {
            fs.writeFileSync(`${resolved}.conflict`, merged.stdout);
            console.error(`port: ${target}/${name}: merge conflict in ${rel} (${merged.status} hunk(s)). Resolve it: edit ${path.relative(root, resolved)}.conflict (diff3 markers: ours = ${opt.from} after the patch, base = ${opt.from} before, theirs = ${opt.to}), save the result as ${path.relative(root, resolved)}, and run again.`);
            process.exit(1);
          }
          fs.rmSync(theirs, { force: true }); fs.writeFileSync(theirs, merged.stdout);
        }
      }
      const orig = path.join(beforeB, rel);
      const d = sh('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, fs.existsSync(orig) ? orig : '/dev/null', theirs]);
      if (d.status === 1) sections.push(`diff --git a/${rel} b/${rel}\n${fs.existsSync(orig) ? '' : 'new file mode 100644\n'}${d.stdout}`);
    }
    const header = headerOf(text).replace(/\n+$/, '\n') + `Ported-from: ${opt.from} (${target}/${name}) for ${opt.to} by scripts/port-patches.js\n\n`;
    const dest = path.join(root, 'patches', target, opt.range, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, header + sections.join(''));
    must(tryApply(beforeB, dest, true), `the new ${target}/${opt.range}/${name} on ${opt.to}`);
    out.push(`${opt.range}/${name}`); report.push(`PORTED   ${target}/${name}`);
  }
  const seriesFile = path.join(root, 'patches', target, `series.${opt.range}`);
  const head = `# Patch series for the "${target}" target, range ${opt.range} (PostgreSQL ${opt.to.split('.')[0]}.x): one *.patch path per line, relative to this directory.\n# Made by scripts/port-patches.js from the baseline series (${opt.from}); entries in ${opt.range}/ are the patches that needed a port, the others are shared with the baseline.\n`;
  fs.writeFileSync(seriesFile, head + out.join('\n') + '\n');
}
fs.rmSync(path.join(work, 'A-before'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'B-before'), { recursive: true, force: true });
console.log(report.join('\n'));
console.log(`port: series.${opt.range} written for ${opt.targets.join(', ')}; trees left in ${path.relative(root, work)} for inspection`);
