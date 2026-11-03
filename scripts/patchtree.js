#!/usr/bin/env node
'use strict';
// The patch tree: patches/ holds folders that cascade. The patches of a release are collected from the outermost folder to the
// innermost one on its way down, and applied in the order of their four-digit numbers:
//
//   patches/                      patches every release takes
//   patches/<family>/             ... every release of the family (9, 10, 11, ... 18)
//   patches/9/<series>/           ... every release of the series (9.0 ... 9.6; only the 9.x family has series)
//   patches/<family>/<A>-<B>/     ... the releases from A to B (a span; a single release is just <A>)
//
// A patch lives at the outermost level at which it is the same for every release below (no duplication), so a folder holds what
// differs from the one above it. A number occurs once on a path. Tool for the layout:
//
//   patchtree.js path <version>                     the folders a release takes, outermost first
//   patchtree.js flatten <dir>                      write patches for every release as <dir>/<version>/NNNN-name.patch
//   patchtree.js fold <flatdir> <patches>           rebuild the tree <patches> from such per-release folders (the inverse)
//
// As a module: collect(patchesDir, version) -> { folders, files }.
const fs = require('fs');
const path = require('path');

const PATCH_NAME = /^(\d{4})-[a-z0-9]+(-[a-z0-9]+)*\.patch$/;
const SPAN = /^(\d+(?:\.\d+){1,2})(?:-(\d+(?:\.\d+){1,2}))?$/;
const verTuple = (v) => { const p = v.split('.').map(Number); return [p[0], p[1] || 0, p[2] || 0]; };
const cmpVer = (a, b) => { const x = verTuple(a); const y = verTuple(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
const family = (v) => v.split('.')[0];
const series = (v) => (family(v) === '9' ? v.split('.').slice(0, 2).join('.') : null);

const subdirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort() : []);
const patchFiles = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isFile()).map((x) => x.name).sort() : []);

// the span folder of `dir` that holds `version` ('' when none does)
function spanFor(dir, version) {
  for (const name of subdirs(dir)) {
    const m = SPAN.exec(name);
    if (!m) continue;
    const from = m[1];
    const to = m[2] || m[1];
    if (cmpVer(from, version) <= 0 && cmpVer(version, to) <= 0) return name;
  }
  return '';
}

// The folders (relative to patches/, '' = patches/ itself) a release takes, outermost first.
function folders(patchesDir, version) {
  const out = [''];
  const fam = family(version);
  if (!subdirs(patchesDir).includes(fam)) return out;
  out.push(fam);
  let at = fam;
  const ser = series(version);
  if (ser) {
    if (!subdirs(path.join(patchesDir, fam)).includes(ser)) return out;
    at = `${fam}/${ser}`;
    out.push(at);
  }
  const span = spanFor(path.join(patchesDir, at), version);
  if (span) out.push(`${at}/${span}`);
  return out;
}

// { folders, files: [{ name, file }] } with the files in application order (by number)
function collect(patchesDir, version) {
  const fl = folders(patchesDir, version);
  const files = [];
  for (const f of fl) for (const name of patchFiles(path.join(patchesDir, f))) files.push({ name, file: path.join(patchesDir, f, name), folder: f });
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { folders: fl, files };
}

// ---- flatten and fold
function releasesOf(patchesDir) {   // every release the tree gives a patch set: the versions inside its span names, resolved by the caller
  return { patchesDir };
}

function flatten(patchesDir, outDir, versions) {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const v of versions) {
    const { files } = collect(patchesDir, v);
    fs.mkdirSync(path.join(outDir, v), { recursive: true });
    for (const f of files) fs.copyFileSync(f.file, path.join(outDir, v, f.name));
  }
}

// flat: Map version -> Map name -> text. Returns the tree as Map relativeFolder -> Map name -> text.
function foldMaps(flat) {
  const versions = [...flat.keys()].sort(cmpVer);
  const tree = new Map();
  const put = (folder, name, text) => { if (!tree.has(folder)) tree.set(folder, new Map()); tree.get(folder).set(name, text); };
  const remaining = new Map(versions.map((v) => [v, new Map(flat.get(v))]));

  // move to `folder` every remaining patch that is the same for all `set` releases (and present in all of them)
  const hoist = (folder, set) => {
    const first = remaining.get(set[0]);
    for (const [name, text] of [...first]) {
      if (set.every((v) => remaining.get(v).get(name) === text)) {
        put(folder, name, text);
        for (const v of set) remaining.get(v).delete(name);
      }
    }
  };
  // the span folders of a set of releases (ordered): maximal runs with the same remaining patches
  const spans = (base, set) => {
    const sig = (v) => JSON.stringify([...remaining.get(v)].sort(([a], [b]) => (a < b ? -1 : 1)));
    let i = 0;
    while (i < set.length) {
      let j = i;
      while (j + 1 < set.length && sig(set[j + 1]) === sig(set[i])) j++;
      if (remaining.get(set[i]).size > 0) {
        const name = i === j ? set[i] : `${set[i]}-${set[j]}`;
        for (const [n, t] of remaining.get(set[i])) put(`${base}/${name}`, n, t);
      }
      i = j + 1;
    }
  };

  hoist('', versions);
  for (const fam of [...new Set(versions.map(family))]) {
    const inFam = versions.filter((v) => family(v) === fam);
    hoist(fam, inFam);
    if (fam === '9') {
      for (const ser of [...new Set(inFam.map(series))]) {
        const inSer = inFam.filter((v) => series(v) === ser);
        hoist(`${fam}/${ser}`, inSer);
        spans(`${fam}/${ser}`, inSer);
      }
    } else spans(fam, inFam);
  }
  return tree;
}

function readFlat(flatDir) {
  const flat = new Map();
  for (const v of fs.readdirSync(flatDir)) {
    const m = new Map();
    for (const f of fs.readdirSync(path.join(flatDir, v)).sort()) m.set(f, fs.readFileSync(path.join(flatDir, v, f), 'utf8'));
    flat.set(v, m);
  }
  return flat;
}

// empties a directory without removing it (patches/ is a mount point inside the containers)
function clearDir(d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(d)) fs.rmSync(path.join(d, e), { recursive: true, force: true });
}

function writeTree(tree, patchesDir) {
  clearDir(patchesDir);
  for (const [folder, files] of tree) {
    const d = path.join(patchesDir, folder);
    fs.mkdirSync(d, { recursive: true });
    for (const [n, t] of files) fs.writeFileSync(path.join(d, n), t);
  }
}

module.exports = { clearDir, PATCH_NAME, SPAN, cmpVer, family, series, subdirs, patchFiles, folders, collect, flatten, foldMaps, readFlat, writeTree, releasesOf };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  const patchesDir = path.join(root, 'patches');
  if (cmd === 'path' && a) {
    console.log(folders(patchesDir, a).map((f) => `patches/${f}`.replace(/\/$/, '')).join('\n'));
  } else if (cmd === 'flatten' && a) {
    const versions = require(path.join(root, 'sources.lock.json')).releases.map((r) => r.version);
    flatten(patchesDir, path.resolve(a), versions);
  } else if (cmd === 'fold' && a && b) {
    writeTree(foldMaps(readFlat(path.resolve(a))), path.resolve(b));
  } else {
    console.error('usage: patchtree.js path <version> | flatten <dir> | fold <flatdir> <patches>');
    process.exit(2);
  }
}
