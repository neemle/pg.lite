// Dedicated Worker that owns one PostgreSQL engine (the wasm module built with WEB=1, see docs/wasm.md).
//
// It is a plain ES module with no dependencies, served as a static asset next to postgres.mjs, so any bundler or
// no bundler at all can use it:  new Worker(new URL('engine-worker.js', base), { type: 'module' }).
//
// Messages from the page:   { type: 'init', engineUrl, config, storage }  start the engine; storage: { name } keeps the database in IndexedDB
//                           { type: 'write', bytes }               protocol bytes for the engine (Uint8Array)
// Messages to the page:     { type: 'ready' }                      engine started, waiting for the first message
//                           { type: 'data', bytes }                protocol bytes from the engine
//                           { type: 'log', stream, text }          server log line
//                           { type: 'open-error', code, message }  could not open (busy, incompatible, storage)
//                           { type: 'storage-error', code, message } a storage barrier failed; the engine stops
//                           { type: 'exit', code, error }          engine stopped
//
// The engine is the standalone ("single-user") backend; it runs on this thread and waits for the next protocol
// bytes with JavaScript Promise Integration, so the Worker stays responsive to messages while the engine idles.

import { IdbStore, trackChanges } from './idb-store.js';
import type { EmFS } from './idb-store.js';
import { configText, releaseNumber, settingsFor } from './settings.js';
import type { Settings } from './settings.js';

interface Manifest {
  /** PostgreSQL release, e.g. '18.6' */
  pg: string;
  profile?: string;
  emptyDirs?: string[];
}

interface EngineModule {
  FS: EmFS & { writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): void };
  HEAPU8: Uint8Array;
  _pg_wasm_main(): Promise<number>;
  pgBarrier?: () => Promise<number>;
}

interface EngineOptions {
  locateFile(name: string): string;
  pgRead(ptr: number, max: number): Promise<number>;
  pgWrite(ptr: number, len: number): number;
  print(text: string): void;
  printErr(text: string): void;
}

type InitMessage = { type: 'init'; engineUrl: string; config?: Settings; storage?: { name: string } | null };
type PageMessage =
  | InitMessage
  | { type: 'write'; bytes: Uint8Array }
  | { type: 'fault'; mode: 'fail' | 'abort' | null };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let module: EngineModule | null = null;
let activeStore: IdbStore | null = null;
const inbox: Uint8Array[] = [];     // chunks waiting for the engine
let waiting: (() => void) | null = null;     // serves the engine's pending read

function serve(): void {
  if (!waiting || inbox.length === 0) return;
  const take = waiting;
  waiting = null;
  take();
}

// the engine asks for up to `max` bytes at `ptr`; resolve with how many it got (0 would mean end of input)
function pgRead(ptr: number, max: number): Promise<number> {
  return new Promise((resolve) => {
    const take = (): void => {
      const chunk = inbox[0]!;
      const n = Math.min(chunk.length, max);
      module!.HEAPU8.set(chunk.subarray(0, n), ptr);
      if (n === chunk.length) inbox.shift(); else inbox[0] = chunk.subarray(n);
      resolve(n);
    };
    if (inbox.length > 0) take(); else waiting = take;
  });
}

function pgWrite(ptr: number, len: number): number {
  const bytes = module!.HEAPU8.slice(ptr, ptr + len);     // a copy: the heap may move or be overwritten
  scope.postMessage({ type: 'data', bytes }, [bytes.buffer]);
  return len;
}

// The settings go to postgresql.auto.conf, which overrides postgresql.conf; releases before 9.4 have no such file, so
// the same text is kept at the end of postgresql.conf, replacing what an earlier start wrote.
const CONF_MARK = '# --- pg.lite settings (rewritten at every start) ---\n';
function writeSettings(FS: EngineModule['FS'], pg: string, config?: Settings): void {
  const text = configText(settingsFor(pg, config));
  if (releaseNumber(pg) >= 904) { FS.writeFile('/pgdata/postgresql.auto.conf', text); return; }
  const file = '/pgdata/postgresql.conf';
  let conf = FS.readFile(file, { encoding: 'utf8' });
  const at = conf.indexOf(CONF_MARK);
  if (at >= 0) conf = conf.slice(0, at);
  FS.writeFile(file, conf + (conf.endsWith('\n') ? '' : '\n') + CONF_MARK + text);
}

// Exclusive ownership of a stored database: one Web Lock per name, held until this Worker is gone.
function takeLock(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!scope.navigator?.locks) { resolve(); return; }      // no Web Locks: no cross-tab protection
    void scope.navigator.locks.request(`pg-lite:${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) { reject(Object.assign(new Error(`the database "${name}" is open in another tab or window`), { code: 'busy' })); return undefined; }
      resolve();
      return new Promise<void>(() => { /* hold the lock for the lifetime of the Worker */ });
    });
  });
}

function removeTree(FS: EmFS, dir: string): void {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    if (FS.isDir(FS.stat(path).mode)) { removeTree(FS, path); FS.rmdir(path); } else FS.unlink(path);
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

async function start({ engineUrl, config, storage }: InitMessage): Promise<void> {
  let store: IdbStore | null = null;
  let hadData = false;
  const manifest = await (await fetch(new URL('manifest.json', engineUrl))).json() as Manifest;
  try {
    if (storage) {
      await takeLock(storage.name);
      store = await IdbStore.open(storage.name, { pg: manifest.pg, ...(manifest.profile ? { profile: manifest.profile } : {}) });
      hadData = (await store.readMeta()) !== null;                        // throws 'incompatible', changing nothing
    }
  } catch (error) {
    scope.postMessage({ type: 'open-error', code: errorCode(error) ?? 'storage', message: errorMessage(error) });
    return;
  }
  const create = ((await import(/* @vite-ignore */ engineUrl)) as { default: (options: EngineOptions) => Promise<EngineModule> }).default;
  const engine = await create({
    // postgres.wasm and postgres.data are next to postgres.mjs, wherever this Worker script itself is served from
    locateFile: (name) => new URL(name, engineUrl).href,
    pgRead, pgWrite,
    print: (text) => scope.postMessage({ type: 'log', stream: 'stdout', text }),
    printErr: (text) => scope.postMessage({ type: 'log', stream: 'stderr', text }),
  });
  module = engine;
  const FS = engine.FS as EngineModule['FS'] & { mkdirTree(path: string, mode?: number): void; chmod(path: string, mode: number): void };
  FS.mkdirTree('/pgsql/bin');
  FS.writeFile('/pgsql/bin/postgres', '', { mode: 0o755 });
  FS.chmod('/pgdata', 0o700);                              // the server refuses a data directory others can read
  const makeEmptyDirs = (): void => { for (const dir of manifest.emptyDirs ?? []) FS.mkdirTree(`/pgdata${dir}`, 0o700); };   // the packaged files carry no empty directories
  makeEmptyDirs();
  if (store) {
    if (hadData) {
      removeTree(FS, '/pgdata'); await store.load(FS, '/pgdata');                  // the stored database replaces the template
      makeEmptyDirs();                                                              // and holds no empty directories either (pg_stat_tmp: releases up to 14 need it in crash recovery)
    }
    trackChanges(FS, store, '/pgdata');
  }
  writeSettings(FS, manifest.pg, config);
  if (store && !hadData) await store.initialize(FS, '/pgdata');           // a new database is stored before open() returns
  activeStore = store;
  if (store) {
    // the engine's fsync: resolves after the storage transaction completed; -1 makes fsync fail and PostgreSQL stop
    const owned = store;
    engine.pgBarrier = async () => {
      try { await owned.barrier(FS); return 0; } catch (error) { scope.postMessage({ type: 'storage-error', code: errorCode(error), message: errorMessage(error) }); return -1; }
    };
  }
  scope.postMessage({ type: 'ready' });
  try {
    // oxlint-disable-next-line no-underscore-dangle -- the name of the Emscripten export
    const code = await engine._pg_wasm_main();             // returns when the session ends
    scope.postMessage({ type: 'exit', code });
  } catch (error) {
    // process exit is reported as an ExitStatus exception by Emscripten
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : 1;
    scope.postMessage({ type: 'exit', code: status, error: errorMessage(error) });
  }
}

scope.addEventListener('message', (event: MessageEvent<PageMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    start(msg).catch((error: unknown) => scope.postMessage({ type: 'exit', code: 1, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
  } else if (msg.type === 'write') { inbox.push(msg.bytes); serve(); }
  else if (msg.type === 'fault' && activeStore) activeStore.fault = msg.mode;             // test hook
});
