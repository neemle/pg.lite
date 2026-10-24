// IndexedDB storage for the engine's file system, with a commit barrier.
//
// The engine keeps its files (data, WAL, control file) in the in-memory file system of the wasm module. This
// module mirrors them to IndexedDB. The barrier is the engine's own fsync: PostgreSQL calls fsync on the WAL before
// a commit returns, on data files at checkpoints, and on pg_control, and the browser build routes those calls to
// store.barrier() (patch wasm/0008). barrier() writes everything changed since the last barrier in ONE IndexedDB
// transaction with strict durability and resolves only when the transaction has completed. So:
//   - a commit is reported to the caller after the storage transaction finished (no deferred flush);
//   - every generation on disk is a state the engine really was in (all files together, never a mix of
//     generations), which is what WAL recovery needs: PostgreSQL's own crash recovery does the rest;
//   - if the transaction fails (quota, storage error) barrier() rejects, the engine's fsync fails, PostgreSQL
//     PANICs and the instance stops: the caller sees an error, never a success that was not stored.
//
// Layout (database "compactdb:<name>"): store "meta" {key:'format', ...}; store "files" keyed by path
// {path, kind:'file'|'dir', size, mode}; store "chunks" keyed by [path, index] -> ArrayBuffer of up to CHUNK bytes.

const CHUNK = 64 * 1024;
const FORMAT = 1;
const SKIP = [/(^|\/)postmaster\.pid$/, /(^|\/)pg_stat_tmp(\/|$)/, /(^|\/)pg_dynshmem(\/|$)/];
const skipped = (path) => SKIP.some((re) => re.test(path));

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('storage transaction aborted'));
});

export class StorageError extends Error {
  constructor(message, code) { super(message); this.name = 'StorageError'; this.code = code; }
}

export class IdbStore {
  // info: { pg: '18.6', profile: 'min3', ... } stored with the data and checked on every open
  static async open(name, info = {}) {
    const store = new IdbStore(name, info);
    store.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(`compactdb:${name}`, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta', { keyPath: 'key' });
        r.result.createObjectStore('files', { keyPath: 'path' });
        r.result.createObjectStore('chunks');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new StorageError('storage is blocked by another connection', 'busy'));
    });
    return store;
  }

  constructor(name, info) {
    this.name = name; this.info = info; this.db = null;
    this.dirty = new Map();       // path -> Set of chunk indexes, or 'all'
    this.removed = new Set();     // paths deleted since the last barrier
    this.dirs = new Set();        // directories created since the last barrier
    this.chain = Promise.resolve();
    this.failed = null;
    this.fault = null;            // test hook: 'fail' (the next barrier writes nothing) or 'abort' (it is interrupted while writing)
  }

  // null when the store holds no database yet; throws StorageError('incompatible') when it holds one this
  // build must not touch (nothing is modified in that case)
  async readMeta() {
    const meta = await req(this.db.transaction('meta').objectStore('meta').get('format'));
    if (!meta) return null;
    if (meta.format !== FORMAT || meta.pg !== this.info.pg || (this.info.profile && meta.profile !== this.info.profile)) {
      throw new StorageError(`stored database is format ${meta.format}, PostgreSQL ${meta.pg}, profile ${meta.profile}; this build is format ${FORMAT}, PostgreSQL ${this.info.pg}, profile ${this.info.profile}. Nothing was changed.`, 'incompatible');
    }
    return meta;
  }

  // Copy the stored files into the engine's file system (FS = Emscripten FS). Returns the number of files.
  async load(FS, root) {
    const tx = this.db.transaction(['files', 'chunks']);
    const files = await req(tx.objectStore('files').getAll());
    let count = 0;
    for (const f of files.filter((x) => x.kind === 'dir').sort((a, b) => a.path.length - b.path.length)) {
      FS.mkdirTree(f.path, f.mode & 0o7777);
    }
    for (const f of files.filter((x) => x.kind === 'file')) {
      const data = new Uint8Array(f.size);
      const range = IDBKeyRange.bound([f.path, 0], [f.path, Number.MAX_SAFE_INTEGER]);
      const keys = await req(tx.objectStore('chunks').getAllKeys(range));
      const values = await req(tx.objectStore('chunks').getAll(range));
      keys.forEach((k, i) => { data.set(new Uint8Array(values[i]), k[1] * CHUNK); });
      FS.writeFile(f.path, data, { mode: f.mode & 0o7777 });
      count++;
    }
    return count;
  }

  // ---- change tracking: the engine's file system calls these --------------------------------------

  markWrite(path, position, length) {
    if (skipped(path) || length <= 0) return;
    let set = this.dirty.get(path);
    if (set === 'all') return;
    if (!set) this.dirty.set(path, (set = new Set()));
    for (let c = Math.floor(position / CHUNK); c <= Math.floor((position + length - 1) / CHUNK); c++) set.add(c);
    this.removed.delete(path);
  }
  markCreate(path, isDir) { if (skipped(path)) return; this.removed.delete(path); if (isDir) this.dirs.add(path); else if (!this.dirty.has(path)) this.dirty.set(path, new Set()); }
  markTruncate(path) { if (!skipped(path)) this.dirty.set(path, 'all'); }
  markRemove(path) { if (skipped(path)) return; this.dirty.delete(path); this.dirs.delete(path); this.removed.add(path); }
  markRename(from, to) { this.markRemove(from); this.markTruncate(to); }

  // Everything changed since the last barrier, as one durable IndexedDB transaction.
  barrier(FS) {
    const run = async () => {
      if (this.failed) throw this.failed;
      if (this.dirty.size === 0 && this.removed.size === 0 && this.dirs.size === 0) return;
      const dirty = this.dirty; const removed = this.removed; const dirs = this.dirs;
      this.dirty = new Map(); this.removed = new Set(); this.dirs = new Set();
      try {
        if (this.fault === 'fail') throw new Error('injected storage failure');          // test hook: nothing is written
        const tx = this.db.transaction(['meta', 'files', 'chunks'], 'readwrite', { durability: 'strict' });
        const files = tx.objectStore('files'); const chunks = tx.objectStore('chunks');
        for (const path of removed) {
          files.delete(path);
          chunks.delete(IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]));
        }
        for (const path of dirs) files.put({ path, kind: 'dir', size: 0, mode: 0o700 });
        for (const [path, which] of dirty) {
          let stat;
          try { stat = FS.stat(path); } catch { continue; }             // gone again before the barrier
          const node = FS.lookupPath(path).node;
          const data = node.contents || new Uint8Array(0);
          const size = stat.size;
          files.put({ path, kind: 'file', size, mode: stat.mode });
          if (which === 'all') {
            chunks.delete(IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]));
            for (let c = 0; c * CHUNK < size; c++) chunks.put(data.slice(c * CHUNK, Math.min(size, (c + 1) * CHUNK)).buffer, [path, c]);
          } else {
            for (const c of which) if (c * CHUNK < size) chunks.put(data.slice(c * CHUNK, Math.min(size, (c + 1) * CHUNK)).buffer, [path, c]);
            // a shorter file than before loses its tail chunks
            chunks.delete(IDBKeyRange.bound([path, Math.ceil(size / CHUNK)], [path, Number.MAX_SAFE_INTEGER]));
          }
        }
        tx.objectStore('meta').put({ key: 'format', format: FORMAT, ...this.info, written: Date.now() });
        if (this.fault === 'abort') tx.abort();                                            // test hook: interrupted while writing
        await txDone(tx);
      } catch (error) {
        // not stored: remember, so that this and every later barrier fails and the engine stops
        this.failed = new StorageError(`could not store the database: ${error && error.message || error}`, 'persist-failed');
        throw this.failed;
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  // First open of a new database: the whole tree of the engine's file system in one transaction.
  async initialize(FS, root) {
    const walk = (dir) => {
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = `${dir}/${name}`;
        if (skipped(path)) continue;
        const st = FS.stat(path);
        if (FS.isDir(st.mode)) { this.markCreate(path, true); walk(path); } else { this.markTruncate(path); }
      }
    };
    this.markCreate(root, true);
    walk(root);
    await this.barrier(FS);
  }

  close() { this.db?.close(); this.db = null; }
}

// Hook the engine's file system (Emscripten FS) so that changes are noticed. Every wrapped function calls the
// original first and then records what happened, so behavior is unchanged. The system calls of the module reach the
// file system through these same FS functions, so nothing the engine does is missed.
export function trackChanges(FS, store, root) {
  const inRoot = (p) => typeof p === 'string' && (p === root || p.startsWith(root + '/'));
  const nodePath = (nodeOrPath) => (typeof nodeOrPath === 'string' ? nodeOrPath : FS.getPath(nodeOrPath));
  const wrap = (name, fn) => { const original = FS[name]; FS[name] = function (...a) { return fn.call(this, original, a); }; };

  wrap('write', (original, [stream, buffer, offset, length, position, canOwn]) => {
    const start = position === undefined ? stream.position : position;
    const n = original.call(FS, stream, buffer, offset, length, position, canOwn);
    const path = FS.getPath(stream.node);
    if (inRoot(path)) store.markWrite(path, start, n);
    return n;
  });
  wrap('mknod', (original, [path, mode, dev]) => { const r = original.call(FS, path, mode, dev); if (inRoot(path)) store.markCreate(path, FS.isDir(mode)); return r; });
  wrap('mkdir', (original, [path, mode]) => { const r = original.call(FS, path, mode); if (inRoot(path)) store.markCreate(path, true); return r; });
  wrap('unlink', (original, [path]) => { const r = original.call(FS, path); if (inRoot(path)) store.markRemove(path); return r; });
  wrap('rmdir', (original, [path]) => { const r = original.call(FS, path); if (inRoot(path)) store.markRemove(path); return r; });
  wrap('rename', (original, [from, to]) => { const r = original.call(FS, from, to); if (inRoot(from) || inRoot(to)) store.markRename(from, to); return r; });
  wrap('truncate', (original, [target, len]) => { const r = original.call(FS, target, len); const p = nodePath(target); if (inRoot(p)) store.markTruncate(p); return r; });
  wrap('ftruncate', (original, [fd, len]) => { const r = original.call(FS, fd, len); const p = FS.getPath(FS.getStream(fd).node); if (inRoot(p)) store.markTruncate(p); return r; });
}
