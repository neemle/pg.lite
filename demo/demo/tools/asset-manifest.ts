// Writes asset-manifest.json into a built app directory: every file (except the service worker and the manifest
// itself) and a version = hash of all file hashes. The service worker precaches exactly this list.
//   node asset-manifest.ts <dist dir>          (Node runs TypeScript files directly)
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');

function walk(current: string, found: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(relative(dir, full).split(sep).join('/'));
  }
  return found;
}

const list = walk(dir).filter((f) => f !== 'sw.js' && f !== 'asset-manifest.json').toSorted();
const hash = createHash('sha256');
for (const f of list) hash.update(f).update(createHash('sha256').update(readFileSync(join(dir, f))).digest());
const version = hash.digest('hex').slice(0, 16);
// the root URL ("./") is a navigation target too: serve index.html for it
writeFileSync(join(dir, 'asset-manifest.json'), `${JSON.stringify({ version, files: ['./', ...list] }, null, 2)}\n`);
console.log(`asset-manifest: ${list.length} files, version ${version}`);
