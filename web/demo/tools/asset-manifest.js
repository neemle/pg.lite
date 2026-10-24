'use strict';
// Writes asset-manifest.json into a built app directory: every file (except the service worker and the manifest
// itself) and a version = hash of all file hashes. The service worker precaches exactly this list.
//   node asset-manifest.js <dist dir>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(process.argv[2] || '.');
const files = [];
(function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(path.relative(dir, full).split(path.sep).join('/'));
  }
})(dir);
const list = files.filter((f) => f !== 'sw.js' && f !== 'asset-manifest.json').sort();
const hash = crypto.createHash('sha256');
for (const f of list) hash.update(f).update(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest());
const version = hash.digest('hex').slice(0, 16);
// the root URL ("./") is a navigation target too: serve index.html for it
fs.writeFileSync(path.join(dir, 'asset-manifest.json'), JSON.stringify({ version, files: ['./', ...list] }, null, 2) + '\n');
console.log(`asset-manifest: ${list.length} files, version ${version}`);
