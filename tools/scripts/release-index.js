#!/usr/bin/env node
'use strict';
// Builds the release list (every FINAL PostgreSQL release from 9.0.0 to the newest) from two
// official sources and writes it to sources.lock.json:
//   1. git tags on git.postgresql.org (tag -> full commit SHA)
//   2. the directory index of ftp.postgresql.org/pub/source (archive location)
// and cross-checks them. Checksums come from the official <archive>.sha256 files; a release
// without one is reported (never silently trusted). Runs in the tools container WITH network:
//   tools/dc make release-index            (network is enabled for this target)
//   node scripts/release-index.js [--offline-fixtures DIR]  (tests)
//
// Exit codes: 0 ok, 1 inconsistency / missing data, 2 usage or network error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_URL = 'https://git.postgresql.org/git/postgresql.git';
const FTP_INDEX = 'https://ftp.postgresql.org/pub/source/';
const FTP_BASE = 'https://ftp.postgresql.org/pub/source';

// ---- pure functions (unit-tested) ----------------------------------------------------
// Final release tags only: REL9_<0-6>_<n> and REL_<10+>_<n>; betas, RCs, alphas and anything
// older than 9.0 never match.
function parseTag(tag) {
  let m = /^REL9_([0-6])_(\d+)$/.exec(tag);
  if (m) return { version: `9.${m[1]}.${m[2]}`, major: `9.${m[1]}` };
  m = /^REL_(\d+)_(\d+)$/.exec(tag);
  if (m && Number(m[1]) >= 10) return { version: `${m[1]}.${m[2]}`, major: m[1] };
  return null;
}

// `git ls-remote --tags` output -> Map(version -> {tag, commit}); peeled (^{}) lines win
// because an annotated tag object is not the commit.
function parseLsRemote(text) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40})\trefs\/tags\/(\S+?)(\^\{\})?$/.exec(line);
    if (!m) continue;
    (m[3] ? peeled : direct).set(m[2], m[1]);
  }
  const out = new Map();
  for (const [tag, sha] of direct) {
    const p = parseTag(tag);
    if (!p) continue;
    out.set(p.version, { tag, commit: peeled.get(tag) || sha, major: p.major });
  }
  return out;
}

// FTP index HTML -> Set of versions that are final releases >= 9.0.
function parseFtpIndex(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="v(\d+\.\d+(?:\.\d+)?)\/"/g)) {
    const v = m[1];
    const [a, b] = v.split('.').map(Number);
    const parts = v.split('.').length;
    if (a === 9 && b <= 6 && parts === 3) out.add(v);
    else if (a >= 10 && parts === 2) out.add(v);
  }
  return out;
}

function parseSha256File(text, version) {
  const m = new RegExp(`^([0-9a-f]{64})\\s+\\*?postgresql-${version.replace(/\./g, '\\.')}\\.tar\\.bz2\\s*$`, 'm').exec(text.replace(/^"|"$/g, ''));
  return m ? m[1] : null;
}

// Official .md5 files come in two layouts: "MD5 (file) = hash" and "hash  file".
function parseMd5File(text, version) {
  const f = `postgresql-${version.replace(/\./g, '\\.')}\\.tar\\.bz2`;
  let m = new RegExp(`^MD5 \\(${f}\\) = ([0-9a-f]{32})\\s*$`, 'm').exec(text);
  if (m) return m[1];
  m = new RegExp(`^([0-9a-f]{32})\\s+\\*?${f}\\s*$`, 'm').exec(text);
  return m ? m[1] : null;
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Cross-check git against ftp. Returns { versions: sorted list present in both, onlyGit, onlyFtp }.
function crossCheck(gitMap, ftpSet) {
  const onlyGit = [...gitMap.keys()].filter((v) => !ftpSet.has(v)).sort(cmpVersion);
  const onlyFtp = [...ftpSet].filter((v) => !gitMap.has(v)).sort(cmpVersion);
  const versions = [...gitMap.keys()].filter((v) => ftpSet.has(v)).sort(cmpVersion);
  return { versions, onlyGit, onlyFtp };
}

module.exports = { parseTag, parseLsRemote, parseFtpIndex, parseSha256File, parseMd5File, cmpVersion, crossCheck };

if (require.main !== module) return;

// ---- main (network) -------------------------------------------------------------------
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = { lock: path.join(root, 'sources.lock.json'), report: path.join(root, 'reports', 'release-index.json') };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lock') opt.lock = path.resolve(args[++i]);
  else if (args[i] === '--report') opt.report = path.resolve(args[++i]);
  else { console.error(`unknown argument ${args[i]}`); process.exit(2); }
}

async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 500 * (i + 1))); }
  }
  throw new Error(`GET ${url} failed: ${last.message}`);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Download an archive and hash it (sha256 + md5) without keeping it.
async function hashArchive(url) {
  const crypto = require('crypto');
  const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  const sha = crypto.createHash('sha256');
  const md5 = crypto.createHash('md5');
  let bytes = 0;
  for await (const chunk of r.body) { sha.update(chunk); md5.update(chunk); bytes += chunk.length; }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes };
}

(async () => {
  const gitRun = spawnSync('git', ['ls-remote', '--tags', GIT_URL], { encoding: 'utf8' });
  if (gitRun.status !== 0) { console.error(`git ls-remote failed: ${gitRun.stderr}`); process.exit(2); }
  const gitMap = parseLsRemote(gitRun.stdout);
  const ftpSet = parseFtpIndex(await get(FTP_INDEX));
  const { versions, onlyGit, onlyFtp } = crossCheck(gitMap, ftpSet);
  console.log(`git tags: ${gitMap.size} final releases >= 9.0; ftp dirs: ${ftpSet.size}; in both: ${versions.length}`);
  if (onlyGit.length || onlyFtp.length) {
    console.error(`DISCREPANCY between the two official sources:\n  only in git: ${onlyGit.join(', ') || '-'}\n  only on ftp: ${onlyFtp.join(', ') || '-'}`);
  }

  const old = fs.existsSync(opt.lock) ? JSON.parse(fs.readFileSync(opt.lock, 'utf8')) : { baseline: '18.6', releases: [] };
  const oldBy = new Map((old.releases || []).map((r) => [r.version, r]));

  // 1. official sha256 files
  const sums = await pool(versions, 8, async (v) => {
    const text = await get(`${FTP_BASE}/v${v}/postgresql-${v}.tar.bz2.sha256`);
    return { v, sha: text ? parseSha256File(text, v) : null };
  });
  const checksum = new Map();
  for (const s of sums) if (s.sha) checksum.set(s.v, { sha: s.sha, source: 'official-sha256-file' });

  // 2. no official sha256: reuse an earlier computed result for the same commit, otherwise
  //    download the archive, hash it, and compare with the official .md5 when one exists.
  const noSha = versions.filter((v) => !checksum.has(v));
  const computedNow = [];
  const problems = [];
  await pool(noSha, 4, async (v) => {
    const prev = oldBy.get(v);
    if (prev && prev.commit === gitMap.get(v).commit && prev.checksumSource !== 'official-sha256-file' && /^[0-9a-f]{64}$/.test(prev.archiveSha256)) {
      checksum.set(v, { sha: prev.archiveSha256, source: prev.checksumSource });
      return;
    }
    const md5Text = await get(`${FTP_BASE}/v${v}/postgresql-${v}.tar.bz2.md5`);
    const officialMd5 = md5Text ? parseMd5File(md5Text, v) : null;
    const h = await hashArchive(`${FTP_BASE}/v${v}/postgresql-${v}.tar.bz2`);
    if (officialMd5 && officialMd5 !== h.md5) { problems.push(`${v}: archive md5 ${h.md5} differs from the official .md5 ${officialMd5}`); return; }
    checksum.set(v, { sha: h.sha256, source: officialMd5 ? 'computed-md5-verified' : 'computed-unverified' });
    computedNow.push(v);
    console.log(`computed ${v}: ${h.bytes} bytes, ${officialMd5 ? 'official md5 matches' : 'NO official md5'}`);
  });
  for (const p of problems) console.error(`PROBLEM ${p}`);

  const releases = versions.filter((v) => checksum.has(v)).map((v) => ({
    version: v,
    major: gitMap.get(v).major,
    tag: gitMap.get(v).tag,
    commit: gitMap.get(v).commit,
    gitUrl: GIT_URL,
    archiveUrl: `${FTP_BASE}/v${v}/postgresql-${v}.tar.bz2`,
    archiveSha256: checksum.get(v).sha,
    checksumSource: checksum.get(v).source,
  }));
  const bySource = (s) => releases.filter((r) => r.checksumSource === s).map((r) => r.version);

  const report = {
    generated: new Date().toISOString().slice(0, 10),
    sources: [GIT_URL, FTP_INDEX],
    counts: {
      gitFinalTags: gitMap.size, ftpDirs: ftpSet.size, inBoth: versions.length, written: releases.length,
      officialSha256: bySource('official-sha256-file').length,
      computedMd5Verified: bySource('computed-md5-verified').length,
      computedUnverified: bySource('computed-unverified').length,
    },
    first: versions[0], last: versions[versions.length - 1],
    onlyInGit: onlyGit, onlyOnFtp: onlyFtp,
    computedMd5Verified: bySource('computed-md5-verified'),
    computedUnverified: bySource('computed-unverified'),
    problems,
  };
  fs.mkdirSync(path.dirname(opt.report), { recursive: true });
  fs.writeFileSync(opt.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.counts), `first=${report.first} last=${report.last}`);

  const bad = onlyGit.length || onlyFtp.length || problems.length || releases.length !== versions.length;
  if (bad) { console.error('release-index: FAIL - lock file NOT written'); process.exit(1); }
  fs.writeFileSync(opt.lock, `${JSON.stringify({ schemaVersion: 1, baseline: old.baseline, releases }, null, 2)}\n`);
  console.log(`release-index: wrote ${path.relative(root, opt.lock)} (${releases.length} releases)`);
})().catch((e) => { console.error(e.message); process.exit(2); });
