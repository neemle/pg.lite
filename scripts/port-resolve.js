#!/usr/bin/env node
'use strict';
// Helper of scripts/port-patches.js: resolve the diff3 conflicts of a .conflict file by keeping the "ours" side
// (the baseline file after the patch) from the first occurrence of a marker on, up to an optional end marker, and
// save the result without the ".conflict" suffix, where port-patches.js picks it up.
//
//   port-resolve.js <file.conflict> [<keep-from marker> [<keep-until marker>]]
//
// An empty marker keeps the whole "ours" side. Anything cleverer: edit the .conflict file by hand and save it
// without the suffix. Runs in the tools container.
const fs = require('fs');

const [file, from = '', until] = process.argv.slice(2);
if (!file || !file.endsWith('.conflict')) { console.error('usage: port-resolve.js <file.conflict> [from [until]]'); process.exit(2); }
const re = /<<<<<<< [^\n]*\n([\s\S]*?)\|\|\|\|\|\|\| [^\n]*\n[\s\S]*?=======\n[\s\S]*?>>>>>>> [^\n]*\n/g;
let n = 0;
const text = fs.readFileSync(file, 'utf8').replace(re, (all, ours) => {
  n++;
  const i = ours.indexOf(from);
  if (i < 0) { console.error(`marker not found in the ours side of conflict ${n}: ${JSON.stringify(from)}`); process.exit(1); }
  let kept = ours.slice(i);
  if (until) {
    const j = kept.indexOf(until);
    if (j < 0) { console.error(`end marker not found in conflict ${n}: ${JSON.stringify(until)}`); process.exit(1); }
    kept = kept.slice(0, j);
  }
  return kept;
});
fs.writeFileSync(file.replace(/\.conflict$/, ''), text);
console.log(`resolved ${n} conflict(s) -> ${file.replace(/\.conflict$/, '')}`);
