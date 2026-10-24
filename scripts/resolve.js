#!/usr/bin/env node
'use strict';
// Resolves a PostgreSQL version to its build plan from data only:
//   sources.lock.json  -> release, tag, commit, archive + checksum
//   ranges.json        -> patch series, extra configure options, omitted features
//   toolchain.lock.json-> builder images (with digests) for the range
// There is no version-specific logic in this file; every difference comes from those files.
//
//   resolve.js <version> [--allow-missing-builder]     print the plan as JSON
//   resolve.js --check-all [--allow-missing-builder]    resolve every release in the index
//   resolve.js <version> --series-args                 only the --series options for patches.js apply
//   resolve.js <version> --write-build-args <dir>      write <dir>/range-configure and <dir>/range-cflags for the build scripts
//
// Options (for tests): --sources F --ranges F --toolchain F --patches DIR
// Exit codes: 0 ok, 2 usage, 3 version not in the release index, 4 no/overlapping range,
//             5 no builder range yet, 6 a series file is missing.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = {
  sources: path.join(root, 'sources.lock.json'),
  ranges: path.join(root, 'ranges.json'),
  toolchain: path.join(root, 'toolchain.lock.json'),
  patches: path.join(root, 'patches'),
  allowMissingBuilder: false, checkAll: false, version: null,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--allow-missing-builder') opt.allowMissingBuilder = true;
  else if (a === '--check-all') opt.checkAll = true;
  else if (a === '--series-args') opt.seriesArgs = true;
  else if (a === '--write-build-args') opt.writeBuildArgs = path.resolve(args[++i] || '');
  else if (a === '--sources' || a === '--ranges' || a === '--toolchain' || a === '--patches') opt[a.slice(2)] = path.resolve(args[++i] || '');
  else if (!a.startsWith('--') && !opt.version) opt.version = a;
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
if (!opt.checkAll && !opt.version) { console.error('usage: resolve.js <version> | --check-all'); process.exit(2); }

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sources = load(opt.sources);
const ranges = load(opt.ranges).ranges;
const toolchain = load(opt.toolchain);

const ver = (s) => { const p = s.split('.').map(Number); return [p[0], p[1], p[2] || 0]; };
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const within = (v, from, to) => cmp(ver(from), ver(v)) <= 0 && cmp(ver(v), ver(to)) <= 0;

class PlanError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function seriesEntries(target, name) {
  const file = path.join(opt.patches, target, name);
  if (!fs.existsSync(file)) throw new PlanError(6, `series file ${path.relative(root, file)} does not exist`);
  const entries = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const e of entries) {
    if (!fs.existsSync(path.join(opt.patches, target, e))) throw new PlanError(6, `${target}/${name} lists ${e}, which does not exist`);
  }
  return { target, series: name, patches: entries };
}

function resolve(version) {
  const rel = sources.releases.find((r) => r.version === version);
  if (!rel) throw new PlanError(3, `version ${version} is not in the release index (sources.lock.json); run make release-index`);

  const rhits = ranges.filter((r) => within(version, r.from, r.to));
  if (rhits.length === 0) throw new PlanError(4, `no range in ranges.json covers ${version}`);
  if (rhits.length > 1) throw new PlanError(4, `ranges ${rhits.map((r) => r.id).join(', ')} all cover ${version}`);
  const range = rhits[0];

  const thits = toolchain.ranges.filter((r) => within(version, r.from, r.to));
  let builders = null;
  if (thits.length === 1) {
    const pick = (key) => ({ key, image: toolchain.images[key].image, digest: toolchain.images[key].digest });
    builders = { native: pick(thits[0].nativeImage), wasm: pick(thits[0].wasmImage) };
  } else if (thits.length > 1) {
    throw new PlanError(4, `toolchain.lock.json ranges overlap at ${version}`);
  } else if (!opt.allowMissingBuilder) {
    throw new PlanError(5, `no builder range in toolchain.lock.json covers ${version} yet (see CDB-24); use --allow-missing-builder to resolve everything else`);
  }

  const patches = ['common', 'native', 'wasm'].map((t) => seriesEntries(t, range.patches[t]));
  return {
    version: rel.version,
    major: rel.major,
    tag: rel.tag,
    commit: rel.commit,
    archive: { url: rel.archiveUrl, sha256: rel.archiveSha256, checksumSource: rel.checksumSource },
    range: range.id,
    builders,
    patches,
    configure: range.configure,
    cflags: range.cflags || [],
    omittedFeatures: range.omittedFeatures,
  };
}

try {
  if (opt.checkAll) {
    let ok = 0, noBuilder = 0;
    for (const r of sources.releases) {
      const p = resolve(r.version);
      ok++;
      if (!p.builders) noBuilder++;
    }
    console.log(`resolve --check-all: ${ok} of ${sources.releases.length} releases resolve${noBuilder ? `; ${noBuilder} have no builder range yet (CDB-24)` : ''}`);
  } else {
    const plan = resolve(opt.version);
    // for patches.js apply: the series files of this version's range, e.g. "--series common=series.pg17 --series native=..."
    if (opt.writeBuildArgs) {
      // for the build scripts, which run where there is no node: the range's extra configure options and compiler flags, one per line
      fs.mkdirSync(opt.writeBuildArgs, { recursive: true });
      fs.writeFileSync(path.join(opt.writeBuildArgs, 'range-configure'), plan.configure.map((x) => `${x}\n`).join(''));
      fs.writeFileSync(path.join(opt.writeBuildArgs, 'range-cflags'), plan.cflags.map((x) => `${x}\n`).join(''));
    } else if (opt.seriesArgs) console.log(plan.patches.map((p) => `--series ${p.target}=${p.series}`).join(' '));
    else console.log(JSON.stringify(plan, null, 2));
  }
} catch (e) {
  if (e instanceof PlanError) { console.error(`resolve: ${e.message}`); process.exit(e.code); }
  throw e;
}
