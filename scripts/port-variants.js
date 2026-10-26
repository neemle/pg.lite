#!/usr/bin/env node
'use strict';
// Add the patch variants one more minor release needs (maintainer tool, tools container).
//
//   port-variants.js --range pg12 --from 12.22 --to 12.14 [--targets common,native,wasm]
//
// The series of a range (series.<range>) lists, per line, a patch or alternatives ("a.patch|b.patch") written for different
// contexts; patches.js applies the first alternative that fits. --from is a release of the range the series already applies
// to completely, --to one it does not. For every series line, in order: when an alternative applies to the --to tree (fuzz 0)
// nothing changes; when none does, the patch is re-made by a three-way merge per file (base = the --from file before the
// patch, ours = the --from file after it, theirs = the --to file), written as patches/<target>/<range>/<name>-r<to>.patch with
// a "Ported-from" header line, and appended to that line as one more alternative. Existing alternatives stay where they are,
// so releases that applied before apply exactly as before.
//
// A merge conflict stops the run with the file named: edit build/port/<from>-to-<to>-resolved/<patch>-<file>.conflict,
// save the result without the .conflict suffix, run again (same as port-patches.js; port-resolve.js can do the mechanical cases).
// Walk a range from its newest release down (--from the release just above --to), so each step is a small difference.

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
for (const k of ['from', 'to', 'range']) if (!opt[k]) { console.error('usage: port-variants.js --range <id> --from <v> --to <v> [--targets a,b]'); process.exit(2); }

const sh = (cmd, argv, o = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const must = (r, what) => { if (r.status !== 0) { console.error(`variants: ${what} failed\n${r.stdout || ''}${r.stderr || ''}`); process.exit(1); } return r; };

const work = path.join(root, 'build', 'port', `${opt.from}-to-${opt.to}`);
const resolvedDir = path.join(root, 'build', 'port', `${opt.from}-to-${opt.to}-resolved`);
fs.mkdirSync(resolvedDir, { recursive: true });
const A = path.join(work, 'A');
const B = path.join(work, 'B');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
must(sh('cp', ['-a', path.join(root, 'cache', 'src', opt.from), A]), 'copy the --from tree');
must(sh('cp', ['-a', path.join(root, 'cache', 'src', opt.to), B]), 'copy the --to tree');

const headerOf = (text) => text.slice(0, text.search(/^diff /m));
const filesOf = (text) => [...text.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]);
const snapshot = (dir, name) => { const s = path.join(work, name); fs.rmSync(s, { recursive: true, force: true }); must(sh('cp', ['-al', dir, s]), 'snapshot'); return s; };
const tryApply = (tree, patchFile, dry) => sh('patch', ['-p1', '-F0', '-s', ...(dry ? ['--dry-run'] : []), '-d', tree, '-i', patchFile]);
const firstThatApplies = (tree, alts) => alts.find((a) => tryApply(tree, a.file, true).status === 0);

// Does the tree still contain what the patch removes? (same test as scripts/patches.js uses for optional entries)
function stillNeeded(patchFile, tree) {
  for (const section of fs.readFileSync(patchFile, 'utf8').split(/^diff --git /m).slice(1)) {
    const file = /^a\/\S+ b\/(\S+)/.exec(section);
    const removed = section.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim()).filter(Boolean);
    if (!file || !removed.length) continue;
    const full = path.join(tree, file[1]);
    if (!fs.existsSync(full)) continue;
    const lines = new Set(fs.readFileSync(full, 'utf8').split('\n').map((l) => l.trim()));
    if (removed.every((r) => lines.has(r))) return true;
  }
  return false;
}

const range = JSON.parse(fs.readFileSync(path.join(root, 'ranges.json'), 'utf8')).ranges.find((r) => r.id === opt.range);
if (!range) { console.error(`variants: no range ${opt.range} in ranges.json`); process.exit(1); }

const report = [];
for (const target of opt.targets) {
  const seriesFile = path.join(root, 'patches', target, range.patches[target]);
  const lines = fs.readFileSync(seriesFile, 'utf8').split(/\r?\n/);
  let changed = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((x) => x.trim());
    const optional = parts.length > 1 && parts[parts.length - 1] === '-';   // "a.patch|-": nothing where the change is not needed
    const alts = (optional ? parts.slice(0, -1) : parts).map((rel) => ({ rel, file: path.join(root, 'patches', target, rel) }));
    const beforeA = snapshot(A, 'A-before');
    const onA = firstThatApplies(A, alts);
    if (!onA) {
      // an optional entry that --from does not need: --to must not need it either (walk such ranges upwards from the
      // release the patch was written for)
      if (optional && !stillNeeded(alts[0].file, A)) {
        if (stillNeeded(alts[0].file, B)) { console.error(`variants: ${target}/${alts[0].rel} is not needed in ${opt.from} but is in ${opt.to}; walk this range upwards`); process.exit(1); }
        report.push(`skipped  ${target}/${alts[0].rel} (not needed in ${opt.from} and ${opt.to})`);
        continue;
      }
      console.error(`variants: ${target}/${alts[0].rel}: no alternative applies to ${opt.from}; the --from release must apply completely`); process.exit(1);
    }
    must(tryApply(A, onA.file, false), `apply ${target}/${onA.rel} to ${opt.from}`);
    const onB = firstThatApplies(B, alts);
    if (onB) {
      must(tryApply(B, onB.file, false), `apply ${target}/${onB.rel} to ${opt.to}`);
      report.push(`fits     ${target}/${onB.rel}`);
      continue;
    }
    if (optional && !stillNeeded(onA.file, B)) { report.push(`skipped  ${target}/${alts[0].rel} (not needed in ${opt.to})`); continue; }
    // no alternative fits: make one for the --to tree out of the one that fit the --from tree
    const text = fs.readFileSync(onA.file, 'utf8');
    const beforeB = snapshot(B, 'B-before');
    const sections = [];
    for (const rel of filesOf(text)) {
      const base = path.join(beforeA, rel); const ours = path.join(A, rel); const theirs = path.join(B, rel);
      if (!fs.existsSync(base)) {                          // a new file: the same content for every release
        fs.mkdirSync(path.dirname(theirs), { recursive: true });
        fs.rmSync(theirs, { force: true }); fs.copyFileSync(ours, theirs);
      } else if (!fs.existsSync(theirs)) { console.error(`variants: ${rel} does not exist in ${opt.to}`); process.exit(1); }
      else {
        const resolved = path.join(resolvedDir, `${target}-${path.basename(onA.rel)}-${rel.replace(/\//g, '_')}`);
        if (fs.existsSync(resolved)) {
          fs.rmSync(theirs, { force: true }); fs.copyFileSync(resolved, theirs);
        } else {
          const merged = sh('git', ['merge-file', '-p', '--diff3', ours, base, theirs]);
          if (merged.status !== 0) {
            fs.writeFileSync(`${resolved}.conflict`, merged.stdout);
            console.error(`port: ${target}/${onA.rel}: merge conflict in ${rel} (${merged.status} hunk(s)). Resolve it: edit ${path.relative(root, resolved)}.conflict (diff3 markers: ours = ${opt.from} after the patch, base = ${opt.from} before, theirs = ${opt.to}), save the result as ${path.relative(root, resolved)}, and run again.`);
            process.exit(1);
          }
          fs.rmSync(theirs, { force: true }); fs.writeFileSync(theirs, merged.stdout);
        }
      }
      const orig = path.join(beforeB, rel);
      const d = sh('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, fs.existsSync(orig) ? orig : '/dev/null', theirs]);
      if (d.status === 1) sections.push(`diff --git a/${rel} b/${rel}\n${fs.existsSync(orig) ? '' : 'new file mode 100644\n'}${d.stdout}`);
    }
    const header = headerOf(text).replace(/^Ported-from:[^\n]*\n/m, '').replace(/\n+$/, '\n') + `Ported-from: ${opt.from} (${target}/${onA.rel}) for ${opt.to} by scripts/port-variants.js\n\n`;
    const stem = path.basename(alts[0].rel, '.patch').replace(/-r\d+(\.\d+)*$/, '');
    const destRel = `${opt.range}/${stem}-r${opt.to}.patch`;
    const dest = path.join(root, 'patches', target, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, header + sections.join(''));
    must(tryApply(beforeB, dest, true), `the new ${target}/${destRel} on ${opt.to}`);
    if (!alts.some((a) => a.rel === destRel)) lines[li] = `${alts.map((a) => a.rel).concat(destRel, optional ? ['-'] : []).join('|')}`;
    changed = true;
    report.push(`VARIANT  ${target}/${destRel}`);
  }
  if (changed) fs.writeFileSync(seriesFile, lines.join('\n'));
}
fs.rmSync(path.join(work, 'A-before'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'B-before'), { recursive: true, force: true });
console.log(report.join('\n'));
console.log(`variants: ${opt.range} series extended for ${opt.to} (${opt.targets.join(', ')})`);
