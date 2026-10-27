#!/usr/bin/env node
'use strict';
// Resolves a PostgreSQL version to its build plan from data only:
//   sources.lock.json  -> release, tag, commit, archive + checksum
//   ranges.json        -> extra configure options, compiler flags, omitted features
//   patches/<version>/ -> the patch folders (one per tested version); a release uses its own folder or the nearest one of its major
//   toolchain.lock.json-> builder images (with digests) for the range
// There is no version-specific logic in this file; every difference comes from those files.
//
//   resolve.js <version> [--allow-missing-builder]     print the plan as JSON
//   resolve.js --check-all [--allow-missing-builder]    resolve every release in the index
//   resolve.js <version> --patch-args                  only the --patch-dir options for patches.js apply
//   resolve.js <version> --write-build-args <dir>      write <dir>/range-configure and <dir>/range-cflags for the build scripts
//
// Options (for tests): --sources F --ranges F --toolchain F --patches DIR
// Exit codes: 0 ok, 2 usage, 3 version not in the release index, 4 no/overlapping range,
//             5 no builder range yet, 6 no patch folder for the major of that release.

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
  else if (a === '--patch-args') opt.patchArgs = true;
  else if (a === '--write-build-args') opt.writeBuildArgs = path.resolve(args[++i] || '');
  else if (a === '--target') opt.target = args[++i];
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

// The patch folders (patches/<version>) that can serve a release, best first: its own folder, then the other tested
// versions of the same major, nearest minor first (a newer one before an older one at the same distance).
function patchDirs(rel) {
  const dirs = fs.existsSync(opt.patches) ? fs.readdirSync(opt.patches, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const major = (v) => { const r = sources.releases.find((x) => x.version === v); return r ? r.major : null; };
  const minor = (v) => ver(v)[v.split('.')[0] === '9' ? 2 : 1];
  const same = dirs.filter((d) => major(d) === rel.major);
  const target = minor(rel.version);
  same.sort((x, y) => (Math.abs(minor(x) - target) - Math.abs(minor(y) - target)) || (minor(y) - minor(x)));
  if (same.length === 0) throw new PlanError(6, `no patch folder for PostgreSQL ${rel.major} (patches/${rel.major}.*) `);
  return same;
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

  const patchFolders = patchDirs(rel);
  return {
    version: rel.version,
    major: rel.major,
    tag: rel.tag,
    commit: rel.commit,
    archive: { url: rel.archiveUrl, sha256: rel.archiveSha256, checksumSource: rel.checksumSource },
    range: range.id,
    builders,
    patchDirs: patchFolders,
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
    if (opt.writeBuildArgs) {
      // for the build scripts, which run where there is no node: the range's extra configure options and compiler flags, one per line
      fs.mkdirSync(opt.writeBuildArgs, { recursive: true });
      fs.writeFileSync(path.join(opt.writeBuildArgs, 'range-configure'), plan.configure.filter((x) => !/^(wasm|native):/.test(x) || x.startsWith(`${opt.target}:`)).map((x) => `${x.replace(/^(wasm|native):/, '')}\n`).join(''));
      fs.writeFileSync(path.join(opt.writeBuildArgs, 'range-cflags'), plan.cflags.filter((x) => !/^(wasm|native):/.test(x) || x.startsWith(`${opt.target}:`)).map((x) => `${x.replace(/^(wasm|native):/, '')}\n`).join(''));
    } else if (opt.patchArgs) console.log(plan.patchDirs.map((d) => `--patch-dir ${d}`).join(' '));
    else console.log(JSON.stringify(plan, null, 2));
  }
} catch (e) {
  if (e instanceof PlanError) { console.error(`resolve: ${e.message}`); process.exit(e.code); }
  throw e;
}
