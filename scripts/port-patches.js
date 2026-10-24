#!/usr/bin/env node
'use strict';
// Port the patch series of one release to another (maintainer tool, tools container).
//
//   port-patches.js --from 18.6 --to 17.11 --range pg17 [--targets common,native,wasm] [--from-series series.pg17]
//   (--from-series: port from another range's series instead of the baseline one, e.g. 16 to 15 as a neighbour;
//    --rename old=new,...: files that moved, e.g. src/common/exec.c=src/port/exec.c)
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

// --rename old=new[,old=new]: files of the --from tree that live under another path in the --to tree (src/common/exec.c was src/port/exec.c)
const renames = Object.fromEntries((opt.rename || '').split(',').filter(Boolean).map((p) => p.split('=')));

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

const readSeries = (target) => fs.readFileSync(path.join(root, 'patches', target, opt['from-series'] || 'series'), 'utf8')
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
    // <patch>.skip next to the ported patches: this release does not need the patch (the file says why), so the series leaves it out
    const skip = path.join(root, 'patches', target, opt.range, `${path.basename(name)}.skip`);
    if (fs.existsSync(skip)) { report.push(`skipped  ${target}/${name} (${fs.readFileSync(skip, 'utf8').trim().split('\n')[0]})`); continue; }
    // a hand-made patch for this range (no "Ported-from" header) is kept as it is; it must apply to the target
    const mine = path.join(root, 'patches', target, opt.range, path.basename(name));
    if (fs.existsSync(mine) && !/^Ported-from:/m.test(fs.readFileSync(mine, 'utf8'))) {
      must(tryApply(B, mine, true), `the hand-made ${target}/${opt.range}/${path.basename(name)} on ${opt.to}`);
      must(tryApply(B, mine, false), `apply the hand-made ${target}/${opt.range}/${path.basename(name)}`);
      out.push(`${opt.range}/${path.basename(name)}`); report.push(`kept     ${target}/${opt.range}/${path.basename(name)} (hand-made)`);
      continue;
    }
    if (tryApply(B, file, true).status === 0) {
      must(tryApply(B, file, false), `apply ${target}/${name}`);
      out.push(name); report.push(`same     ${target}/${name}`);
      continue;
    }
    // re-make the patch for the --to tree
    const beforeB = snapshot(B, 'B-before');
    const sections = [];
    for (const fromRel of filesOf(text)) {
      const rel = renames[fromRel] || fromRel;            // a file that moved between the releases: the patch is made for the new place
      const base = path.join(beforeA, fromRel); const ours = path.join(A, fromRel); const theirs = path.join(B, rel);
      if (!fs.existsSync(base)) {                         // a new file: same content for every release
        fs.mkdirSync(path.dirname(theirs), { recursive: true });
        fs.rmSync(theirs, { force: true }); fs.copyFileSync(ours, theirs);
      } else if (!fs.existsSync(theirs)) { console.error(`port: ${rel} does not exist in ${opt.to}`); process.exit(1); }
      else {
        const resolved = path.join(resolvedDir, `${target}-${path.basename(name)}-${rel.replace(/\//g, '_')}`);
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
    const dest = path.join(root, 'patches', target, opt.range, path.basename(name));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, header + sections.join(''));
    must(tryApply(beforeB, dest, true), `the new ${target}/${opt.range}/${name} on ${opt.to}`);
    out.push(`${opt.range}/${path.basename(name)}`); report.push(`PORTED   ${target}/${name}`);
  }
  // hand-made patches of this range that no baseline patch produced (a fix only this release needs) go at the end, by name
  const rangeDir = path.join(root, 'patches', target, opt.range);
  if (fs.existsSync(rangeDir)) {
    for (const f of fs.readdirSync(rangeDir).sort()) {
      const rel = `${opt.range}/${f}`;
      if (!f.endsWith('.patch') || out.includes(rel)) continue;
      if (/^Ported-from:/m.test(fs.readFileSync(path.join(rangeDir, f), 'utf8'))) continue;   // a leftover of an earlier port
      must(tryApply(B, path.join(rangeDir, f), true), `the hand-made ${target}/${rel} on ${opt.to}`);
      must(tryApply(B, path.join(rangeDir, f), false), `apply the hand-made ${target}/${rel}`);
      out.push(rel); report.push(`added    ${target}/${rel} (hand-made, only this range)`);
    }
  }
  const seriesFile = path.join(root, 'patches', target, `series.${opt.range}`);
  const head = `# Patch series for the "${target}" target, range ${opt.range} (PostgreSQL ${opt.to.split('.')[0]}.x): one *.patch path per line, relative to this directory.\n# Made by scripts/port-patches.js from the baseline series (${opt.from}); entries in ${opt.range}/ are the patches that needed a port, the others are shared with the baseline.\n`;
  fs.writeFileSync(seriesFile, head + out.join('\n') + '\n');
}
fs.rmSync(path.join(work, 'A-before'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'B-before'), { recursive: true, force: true });
console.log(report.join('\n'));
console.log(`port: series.${opt.range} written for ${opt.targets.join(', ')}; trees left in ${path.relative(root, work)} for inspection`);
