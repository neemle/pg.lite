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
// Layout (database "pg.lite:<name>"): store "meta" {key:'format', ...}; store "files" keyed by path
// {path, kind:'file'|'dir', size, mode}; store "chunks" keyed by [path, index] -> ArrayBuffer of up to CHUNK bytes.

/** The parts of Emscripten's file system this module uses. */
export interface EmFS {
  mkdirTree(path: string, mode?: number): void;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): void;
  readFile(path: string, options: { encoding: 'utf8' }): string;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  chmod(path: string, mode: number): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  lookupPath(path: string): { node: { contents?: Uint8Array } };
  getPath(node: object): string;
  getStream(fd: number): { node: object };
}

export interface StoreInfo {
  /** PostgreSQL release the engine was built from, e.g. '18.6' */
  pg: string;
  /** hash of the feature profile the engine was built with */
  profile?: string;
}

interface Meta extends StoreInfo { key: 'format'; format: number; written: number }
interface FileRecord { path: string; kind: 'file' | 'dir'; size: number; mode: number }
type Dirty = Set<number> | 'all';

const CHUNK = 64 * 1024;
const FORMAT = 1;
const SKIP = [/(^|\/)postmaster\.pid$/, /(^|\/)pg_stat_tmp(\/|$)/, /(^|\/)pg_dynshmem(\/|$)/];
const skipped = (path: string): boolean => SKIP.some((re) => re.test(path));

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  r.addEventListener('success', () => resolve(r.result));
  r.addEventListener('error', () => reject(r.error));
});

const txDone = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.addEventListener('complete', () => resolve());
  tx.addEventListener('error', () => reject(tx.error));
  tx.addEventListener('abort', () => reject(tx.error ?? new Error('storage transaction aborted')));
});

export class StorageError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'StorageError'; }
}

export class IdbStore {
  /** info is stored with the data and checked on every open */
  static async open(name: string, info: StoreInfo): Promise<IdbStore> {
    const store = new IdbStore(name, info);
    store.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(`pg.lite:${name}`, 1);
      r.addEventListener('upgradeneeded', () => {
        r.result.createObjectStore('meta', { keyPath: 'key' });
        r.result.createObjectStore('files', { keyPath: 'path' });
        r.result.createObjectStore('chunks');
      });
      r.addEventListener('success', () => resolve(r.result));
      r.addEventListener('error', () => reject(r.error));
      r.addEventListener('blocked', () => reject(new StorageError('storage is blocked by another connection', 'busy')));
    });
    return store;
  }

  db: IDBDatabase | null = null;
  dirty = new Map<string, Dirty>();    // path -> chunk indexes, or 'all'
  removed = new Set<string>();         // paths deleted since the last barrier
  dirs = new Set<string>();            // directories created since the last barrier
  chain: Promise<void> = Promise.resolve();
  failed: StorageError | null = null;
  /** test hook: 'fail' (the next barrier writes nothing) or 'abort' (it is interrupted while writing) */
  fault: 'fail' | 'abort' | null = null;

  constructor(readonly name: string, readonly info: StoreInfo) {}

  private get database(): IDBDatabase {
    if (!this.db) throw new StorageError('the store is closed', 'closed');
    return this.db;
  }

  /**
   * null when the store holds no database yet; throws StorageError('incompatible') when it holds one this
   * build must not touch (nothing is modified in that case)
   */
  async readMeta(): Promise<Meta | null> {
    const meta = await req<Meta | undefined>(this.database.transaction('meta').objectStore('meta').get('format'));
    if (!meta) return null;
    if (meta.format !== FORMAT || meta.pg !== this.info.pg || (this.info.profile && meta.profile !== this.info.profile)) {
      throw new StorageError(`stored database is format ${meta.format}, PostgreSQL ${meta.pg}, profile ${meta.profile}; this build is format ${FORMAT}, PostgreSQL ${this.info.pg}, profile ${this.info.profile}. Nothing was changed.`, 'incompatible');
    }
    return meta;
  }

  /** Copy the stored files into the engine's file system. Returns the number of files. */
  async load(FS: EmFS, _root: string): Promise<number> {
    const tx = this.database.transaction(['files', 'chunks']);
    const files = await req<FileRecord[]>(tx.objectStore('files').getAll());
    let count = 0;
    for (const f of files.filter((x) => x.kind === 'dir').toSorted((a, b) => a.path.length - b.path.length)) {
      FS.mkdirTree(f.path, f.mode & 0o7777);
    }
    for (const f of files.filter((x) => x.kind === 'file')) {
      const data = new Uint8Array(f.size);
      const range = IDBKeyRange.bound([f.path, 0], [f.path, Number.MAX_SAFE_INTEGER]);
      const keys = await req<IDBValidKey[]>(tx.objectStore('chunks').getAllKeys(range));
      const values = await req<ArrayBuffer[]>(tx.objectStore('chunks').getAll(range));
      keys.forEach((k, i) => { data.set(new Uint8Array(values[i]!), (k as [string, number])[1] * CHUNK); });
      FS.writeFile(f.path, data, { mode: f.mode & 0o7777 });
      count++;
    }
    return count;
  }

  // ---- change tracking: the engine's file system calls these --------------------------------------

  markWrite(path: string, position: number, length: number): void {
    if (skipped(path) || length <= 0) return;
    let set = this.dirty.get(path);
    if (set === 'all') return;
    if (!set) this.dirty.set(path, (set = new Set<number>()));
    for (let c = Math.floor(position / CHUNK); c <= Math.floor((position + length - 1) / CHUNK); c++) set.add(c);
    this.removed.delete(path);
  }

  markCreate(path: string, isDir: boolean): void {
    if (skipped(path)) return;
    this.removed.delete(path);
    if (isDir) this.dirs.add(path);
    else if (!this.dirty.has(path)) this.dirty.set(path, new Set<number>());
  }

  markTruncate(path: string): void { if (!skipped(path)) this.dirty.set(path, 'all'); }
  markRemove(path: string): void { if (skipped(path)) return; this.dirty.delete(path); this.dirs.delete(path); this.removed.add(path); }
  markRename(from: string, to: string): void { this.markRemove(from); this.markTruncate(to); }

  /** Everything changed since the last barrier, as one durable IndexedDB transaction. */
  barrier(FS: EmFS): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.failed) throw this.failed;
      if (this.dirty.size === 0 && this.removed.size === 0 && this.dirs.size === 0) return;
      const dirty = this.dirty; const removed = this.removed; const dirs = this.dirs;
      this.dirty = new Map(); this.removed = new Set(); this.dirs = new Set();
      try {
        if (this.fault === 'fail') throw new Error('injected storage failure');          // test hook: nothing is written
        const tx = this.database.transaction(['meta', 'files', 'chunks'], 'readwrite', { durability: 'strict' });
        const files = tx.objectStore('files'); const chunks = tx.objectStore('chunks');
        for (const path of removed) {
          files.delete(path);
          chunks.delete(IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]));
        }
        for (const path of dirs) files.put({ path, kind: 'dir', size: 0, mode: 0o700 } satisfies FileRecord);
        for (const [path, which] of dirty) {
          let stat: { mode: number; size: number };
          try { stat = FS.stat(path); } catch { continue; }             // gone again before the barrier
          const node = FS.lookupPath(path).node;
          const data = node.contents ?? new Uint8Array(0);
          const size = stat.size;
          files.put({ path, kind: 'file', size, mode: stat.mode } satisfies FileRecord);
          if (which === 'all') {
            chunks.delete(IDBKeyRange.bound([path, 0], [path, Number.MAX_SAFE_INTEGER]));
            for (let c = 0; c * CHUNK < size; c++) chunks.put(data.slice(c * CHUNK, Math.min(size, (c + 1) * CHUNK)).buffer, [path, c]);
          } else {
            for (const c of which) if (c * CHUNK < size) chunks.put(data.slice(c * CHUNK, Math.min(size, (c + 1) * CHUNK)).buffer, [path, c]);
            // a shorter file than before loses its tail chunks
            chunks.delete(IDBKeyRange.bound([path, Math.ceil(size / CHUNK)], [path, Number.MAX_SAFE_INTEGER]));
          }
        }
        tx.objectStore('meta').put({ key: 'format', format: FORMAT, ...this.info, written: Date.now() } satisfies Meta);
        if (this.fault === 'abort') tx.abort();                                            // test hook: interrupted while writing
        await txDone(tx);
      } catch (error) {
        // not stored: remember, so that this and every later barrier fails and the engine stops
        this.failed = new StorageError(`could not store the database: ${error instanceof Error ? error.message : String(error)}`, 'persist-failed');
        throw this.failed;
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /** First open of a new database: the whole tree of the engine's file system in one transaction. */
  async initialize(FS: EmFS, root: string): Promise<void> {
    const walk = (dir: string): void => {
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

  close(): void { this.db?.close(); this.db = null; }
}

interface EmStream { position: number; node: object }
type Original = (...args: never[]) => unknown;

/**
 * Hook the engine's file system (Emscripten FS) so that changes are noticed. Every wrapped function calls the
 * original first and then records what happened, so behavior is unchanged. The system calls of the module reach the
 * file system through these same FS functions, so nothing the engine does is missed.
 */
export function trackChanges(FS: EmFS, store: IdbStore, root: string): void {
  const inRoot = (p: unknown): p is string => typeof p === 'string' && (p === root || p.startsWith(`${root}/`));
  const nodePath = (nodeOrPath: string | object): string => (typeof nodeOrPath === 'string' ? nodeOrPath : FS.getPath(nodeOrPath));
  const table = FS as unknown as Record<string, Original>;
  const wrap = <A extends unknown[]>(name: string, fn: (original: (...a: A) => unknown, args: A) => unknown): void => {
    const original = table[name] as unknown as (...a: A) => unknown;
    table[name] = ((...a: A) => fn((...b: A) => original.apply(FS, b), a)) as unknown as Original;
  };

  wrap<[EmStream, Uint8Array, number, number, number | undefined, boolean | undefined]>('write', (original, args) => {
    const [stream, , , , position] = args;
    const start = position === undefined ? stream.position : position;
    const n = original(...args) as number;
    const path = FS.getPath(stream.node);
    if (inRoot(path)) store.markWrite(path, start, n);
    return n;
  });
  wrap<[string, number, number | undefined]>('mknod', (original, args) => { const r = original(...args); if (inRoot(args[0])) store.markCreate(args[0], FS.isDir(args[1])); return r; });
  wrap<[string, number | undefined]>('mkdir', (original, args) => { const r = original(...args); if (inRoot(args[0])) store.markCreate(args[0], true); return r; });
  wrap<[string]>('unlink', (original, args) => { const r = original(...args); if (inRoot(args[0])) store.markRemove(args[0]); return r; });
  wrap<[string]>('rmdir', (original, args) => { const r = original(...args); if (inRoot(args[0])) store.markRemove(args[0]); return r; });
  wrap<[string, string]>('rename', (original, args) => { const r = original(...args); if (inRoot(args[0]) || inRoot(args[1])) store.markRename(args[0], args[1]); return r; });
  wrap<[string | object, number]>('truncate', (original, args) => { const r = original(...args); const p = nodePath(args[0]); if (inRoot(p)) store.markTruncate(p); return r; });
  wrap<[number, number]>('ftruncate', (original, args) => { const r = original(...args); const p = FS.getPath(FS.getStream(args[0]).node); if (inRoot(p)) store.markTruncate(p); return r; });
}
