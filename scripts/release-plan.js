#!/usr/bin/env node
'use strict';
// Release plan for a git tag. The tag IS the PostgreSQL version: v18.6 builds PostgreSQL 18.6 and nothing else.
//
//   release-plan.js <tag>            prints JSON { tag, version, major, newestInMajor, newestOverall, series }
//                                    exit 0 ok, 2 usage, 3 the tag is not a release in sources.lock.json,
//                                    4 the version has no patch series yet (its major is not supported)
//   release-plan.js --github <tag>   the same, as KEY=value lines for $GITHUB_OUTPUT
//   --ranges <file> --patches <dir> other data for the resolver (tests)
//
// "Drop-in replacement" means: the image and the archive released from tag vX.Y.Z contain exactly upstream
// PostgreSQL X.Y.Z (checksum-pinned in sources.lock.json) plus this repository's patches, and the image tags are
// the version (18.6) and, when it is the newest release of its major, the major (18).
// Runs in the tools container.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const github = args[0] === '--github';
if (github) args.shift();
const rangesArgs = [];
for (const o of ['--ranges', '--patches']) { const i = args.indexOf(o); if (i >= 0) rangesArgs.push(...args.splice(i, 2)); }
const tag = args[0];
if (!tag) { console.error('usage: release-plan.js [--github] <tag>'); process.exit(2); }

const m = /^v(\d+(?:\.\d+){1,2})$/.exec(tag);
if (!m) { console.error(`release-plan: tag "${tag}" is not v<postgresql version> (for example v18.6)`); process.exit(3); }
const version = m[1];

const lock = JSON.parse(fs.readFileSync(path.join(root, 'sources.lock.json'), 'utf8'));
const release = lock.releases.find((r) => r.version === version);
if (!release) { console.error(`release-plan: PostgreSQL ${version} is not in sources.lock.json; the tag must name an upstream release`); process.exit(3); }

const key = (v) => v.split('.').map(Number);
const newer = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const newest = (list) => list.map((r) => r.version).reduce((a, b) => (newer(b, a) ? b : a));
const newestInMajor = newest(lock.releases.filter((r) => r.major === release.major));
const newestOverall = newest(lock.releases);

const r = spawnSync('node', [path.join(root, 'scripts', 'resolve.js'), version, '--allow-missing-builder', ...rangesArgs], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(4); }
const plan = JSON.parse(r.stdout);
const empty = plan.patches.filter((p) => p.patches.length === 0).map((p) => p.target);
if (empty.length === plan.patches.length || empty.includes('native') || empty.includes('wasm')) {
  console.error(`release-plan: PostgreSQL ${version} (range ${plan.range}) has no ${empty.join(' / ')} patch series yet, so it cannot be built. Supported majors are the ranges with series.`);
  process.exit(4);
}

const out = { tag, version, major: release.major, range: plan.range, newestInMajor: newestInMajor === version, newestOverall: newestOverall === version, series: plan.patches.map((p) => `${p.target}/${p.series}`) };
if (github) for (const [k, v] of Object.entries(out)) console.log(`${k}=${Array.isArray(v) ? v.join(',') : v}`);
else console.log(JSON.stringify(out, null, 2));
