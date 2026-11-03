#!/usr/bin/env node
'use strict';
// Usage: lock-get.js <sources.lock.json> [version]
// Prints shell assignments (KEY='value') for one release, defaulting to the baseline.
// Exits 3 if the version is not in the lock. The lock must already have passed
// scripts/validate-locks.js, which restricts every value to a safe character set.
const fs = require('fs');

const [file, wanted] = process.argv.slice(2);
if (!file) { console.error('usage: lock-get.js <sources.lock.json> [version]'); process.exit(2); }
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const version = wanted || doc.baseline;
const rel = doc.releases.find((r) => r.version === version);
if (!rel) {
  console.error(`lock-get: version ${version} is not in ${file}; known: ${doc.releases.map((r) => r.version).join(', ')}`);
  process.exit(3);
}
const safe = /^[A-Za-z0-9._:\/+@-]+$/;
const out = {
  VERSION: rel.version, TAG: rel.tag, COMMIT: rel.commit, GIT_URL: rel.gitUrl,
  ARCHIVE_URL: rel.archiveUrl, SHA256: rel.archiveSha256,
};
for (const [k, v] of Object.entries(out)) {
  if (!safe.test(v)) { console.error(`lock-get: unsafe characters in ${k}`); process.exit(4); }
  console.log(`${k}='${v}'`);
}
