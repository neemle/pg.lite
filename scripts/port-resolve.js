#!/usr/bin/env node
'use strict';
// Helper of scripts/port-patches.js: resolve the diff3 conflicts of a .conflict file and save the result without the
// ".conflict" suffix, where port-patches.js picks it up.
//
//   port-resolve.js <file.conflict> [<keep-from marker> [<keep-until marker>]]
//       keep the "ours" side (the baseline file after the patch) from the first occurrence of the marker on, up to
//       the optional end marker; an empty marker keeps the whole "ours" side
//   port-resolve.js <file.conflict> --objs
//       the target side is a one-line object list (OBJS = a.o b.o ...) and the patch adds object files to the multi-line
//       list of the baseline: the same object files are inserted into the target's line (before a trailing $(...) entry)
//   port-resolve.js <file.conflict> --auto
//       every conflict whose target side ("theirs") is empty, that is where the target release simply lacks the
//       neighbouring lines, becomes the lines the patch adds (ours without the baseline lines); any other conflict
//       stops with exit code 3 and nothing is written
//
// Anything cleverer: edit the .conflict file by hand and save it without the suffix. Runs in the tools container.
const fs = require('fs');

const [file, from = '', until] = process.argv.slice(2);
const auto = from === '--auto';
const objsMode = from === '--objs';
// --with <file>: every conflict is replaced by the text of that file (for a conflict that needs a hand-written result)
const withText = from === '--with' ? fs.readFileSync(until, 'utf8').replace(/\n$/, '') : null;
if (!file || !file.endsWith('.conflict')) { console.error('usage: port-resolve.js <file.conflict> [from [until] | --auto]'); process.exit(2); }

const NL = String.fromCharCode(10);
const lines = fs.readFileSync(file, 'utf8').split(NL);
const out = [];
let n = 0;
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('<<<<<<< ')) { out.push(lines[i]); continue; }
  const ours = []; const base = []; const theirs = [];
  let side = ours;
  for (i++; i < lines.length && !lines[i].startsWith('>>>>>>> '); i++) {
    if (lines[i].startsWith('||||||| ')) side = base;
    else if (lines[i] === '=======') side = theirs;
    else side.push(lines[i]);
  }
  n++;
  if (objsMode) {
    const BS = String.fromCharCode(92);
    const tokens = (ls) => ls.join(' ').split(/\s+/).filter((t) => t.endsWith('.o') && !t.includes('$'));
    const have = new Set(tokens(base));
    const added = tokens(ours).filter((t) => !have.has(t));
    const k = theirs.findIndex((l) => l.startsWith('OBJS'));
    if (k < 0 || added.length === 0) { console.error(`conflict ${n}: not an object list; resolve it by hand`); process.exit(3); }
    let line = theirs[k];
    let cont = '';
    if (line.trimEnd().endsWith(BS)) { cont = ' ' + BS; line = line.trimEnd().slice(0, -1).trimEnd(); }
    const at = line.indexOf(' $(');   // before the first $(...) entry
    line = at >= 0 ? line.slice(0, at) + ' ' + added.join(' ') + line.slice(at) : line + ' ' + added.join(' ');
    theirs[k] = line + cont;
    out.push(...theirs);
    continue;
  }
  if (withText !== null) { out.push(...withText.split(NL)); continue; }
  if (auto) {
    if (theirs.length !== 0) { console.error(`conflict ${n}: the target side is not empty; resolve it by hand`); process.exit(3); }
    const left = new Map();
    for (const l of base) left.set(l, (left.get(l) || 0) + 1);
    for (const l of ours) { const c = left.get(l) || 0; if (c > 0) left.set(l, c - 1); else out.push(l); }
  } else {
    const text = ours.join(NL) + NL;
    const at = text.indexOf(from);
    if (at < 0) { console.error(`marker not found in the ours side of conflict ${n}: ${JSON.stringify(from)}`); process.exit(1); }
    let kept = text.slice(at);
    if (until) {
      const j = kept.indexOf(until);
      if (j < 0) { console.error(`end marker not found in conflict ${n}: ${JSON.stringify(until)}`); process.exit(1); }
      kept = kept.slice(0, j);
    }
    out.push(...kept.replace(/\n$/, '').split(NL));
  }
}
fs.writeFileSync(file.replace(/\.conflict$/, ''), out.join(NL));
console.log(`resolved ${n} conflict(s) -> ${file.replace(/\.conflict$/, '')}`);
