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

let module = null;
let activeStore = null;
let inbox = [];            // Uint8Array chunks waiting for the engine
let waiting = null;        // function that serves the engine's pending read

// Settings of the single-user engine in a browser. Memory is the budget that matters, and there is no
// checkpointer process: a checkpoint is taken when WAL reaches max_wal_size, so keep that small (1 MB segments).
const BASE_CONFIG = {
  shared_buffers: '16MB',
  work_mem: '4MB',
  max_wal_size: '16MB',
  min_wal_size: '4MB',
  wal_level: 'minimal',
  max_wal_senders: 0,
  max_connections: 4,
  // The engine runs on the stack JavaScript Promise Integration gives it, which is much smaller than PostgreSQL's 2 MB
  // default allows for: measured in Chromium 156, plpgsql recursion dies between 400 and 800 levels with 1 MB or more
  // and gets the regular "stack depth limit exceeded" error (54001) with 500 kB or less. Stay clearly below.
  max_stack_depth: '400kB',
  timezone: 'UTC',
  log_timezone: 'UTC',
  client_min_messages: 'notice',
  log_min_messages: 'warning',
  dynamic_shared_memory_type: 'sysv',
};

function serve() {
  if (!waiting || inbox.length === 0) return;
  const take = waiting;
  waiting = null;
  take();
}

// the engine asks for up to `max` bytes at `ptr`; resolve with how many it got (0 would mean end of input)
function pgRead(ptr, max) {
  return new Promise((resolve) => {
    const take = () => {
      const chunk = inbox[0];
      const n = Math.min(chunk.length, max);
      module.HEAPU8.set(chunk.subarray(0, n), ptr);
      if (n === chunk.length) inbox.shift(); else inbox[0] = chunk.subarray(n);
      resolve(n);
    };
    if (inbox.length > 0) take(); else waiting = take;
  });
}

function pgWrite(ptr, len) {
  const bytes = module.HEAPU8.slice(ptr, ptr + len);     // a copy: the heap may move or be overwritten
  postMessage({ type: 'data', bytes }, [bytes.buffer]);
  return len;
}

// 9.6.24 -> 906, 18.6 -> 1800: releases before 10 have a two-part major version
function releaseNumber(pg) {
  const [a, b] = String(pg).split('.').map(Number);
  return a >= 10 ? a * 100 : a * 100 + b;
}

// The settings BASE_CONFIG means, spelled the way the release takes them:
//   before 9.5   no max_wal_size/min_wal_size (checkpoint_segments, 16 MB each, is the same limit)
//   9.5 and 9.6  the two are counted in 16 MB segments and may not be below 2, so '16MB' and '4MB' are refused
//   before 9.4   no dynamic_shared_memory_type
//   before 9.1   wal_sync_method defaults to open_datasync on Linux: WAL is written with O_DSYNC and fsync/fdatasync never run, so the
//                storage barrier (which is the wrapped fsync) would never be reached at a commit; fdatasync is what 9.1 and later use
function settingsFor(pg, config) {
  const n = releaseNumber(pg);
  const settings = { ...BASE_CONFIG, ...config };
  if (n < 905) {
    delete settings.max_wal_size; delete settings.min_wal_size;
    if (!('checkpoint_segments' in settings)) settings.checkpoint_segments = 3;
  } else if (n < 1000) {
    if (!(config && 'max_wal_size' in config)) settings.max_wal_size = '32MB';
    if (!(config && 'min_wal_size' in config)) settings.min_wal_size = '32MB';
  }
  if (n < 904) delete settings.dynamic_shared_memory_type;
  if (n < 901 && !(config && 'wal_sync_method' in config)) settings.wal_sync_method = 'fdatasync';
  return settings;
}

function configText(settings) {
  return Object.entries(settings)
    .map(([k, v]) => `${k} = '${String(v).replace(/'/g, "''")}'`).join('\n') + '\n';
}

// The settings go to postgresql.auto.conf, which overrides postgresql.conf; releases before 9.4 have no such file, so
// the same text is kept at the end of postgresql.conf, replacing what an earlier start wrote.
const CONF_MARK = '# --- compact.db settings (rewritten at every start) ---\n';
function writeSettings(FS, pg, config) {
  const text = configText(settingsFor(pg, config));
  if (releaseNumber(pg) >= 904) { FS.writeFile('/pgdata/postgresql.auto.conf', text); return; }
  const file = '/pgdata/postgresql.conf';
  let conf = FS.readFile(file, { encoding: 'utf8' });
  const at = conf.indexOf(CONF_MARK);
  if (at >= 0) conf = conf.slice(0, at);
  FS.writeFile(file, conf + (conf.endsWith('\n') ? '' : '\n') + CONF_MARK + text);
}

// Exclusive ownership of a stored database: one Web Lock per name, held until this Worker is gone.
function takeLock(name) {
  return new Promise((resolve, reject) => {
    if (!self.navigator || !navigator.locks) { resolve(); return; }      // no Web Locks: no cross-tab protection
    navigator.locks.request(`compactdb:${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) { reject(Object.assign(new Error(`the database "${name}" is open in another tab or window`), { code: 'busy' })); return undefined; }
      resolve();
      return new Promise(() => {});                                       // hold the lock for the lifetime of the Worker
    });
  });
}

function removeTree(FS, dir) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`;
    if (FS.isDir(FS.stat(path).mode)) { removeTree(FS, path); FS.rmdir(path); } else FS.unlink(path);
  }
}

async function start({ engineUrl, config, storage }) {
  let store = null;
  let hadData = false;
  const manifest = await (await fetch(new URL('manifest.json', engineUrl))).json();
  try {
    if (storage) {
      await takeLock(storage.name);
      store = await IdbStore.open(storage.name, { pg: manifest.pg, profile: manifest.profile });
      hadData = (await store.readMeta()) !== null;                        // throws 'incompatible', changing nothing
    }
  } catch (error) {
    postMessage({ type: 'open-error', code: error.code || 'storage', message: String(error.message || error) });
    return;
  }
  const create = (await import(engineUrl)).default;
  module = await create({
    // postgres.wasm and postgres.data are next to postgres.mjs, wherever this Worker script itself is served from
    locateFile: (name) => new URL(name, engineUrl).href,
    pgRead, pgWrite,
    print: (text) => postMessage({ type: 'log', stream: 'stdout', text }),
    printErr: (text) => postMessage({ type: 'log', stream: 'stderr', text }),
  });
  const FS = module.FS;
  FS.mkdirTree('/pgsql/bin');
  FS.writeFile('/pgsql/bin/postgres', '', { mode: 0o755 });
  FS.chmod('/pgdata', 0o700);                              // the server refuses a data directory others can read
  const makeEmptyDirs = () => { for (const dir of manifest.emptyDirs || []) FS.mkdirTree('/pgdata' + dir, 0o700); };   // the packaged files carry no empty directories
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
    module.pgBarrier = async () => {
      try { await store.barrier(FS); return 0; } catch (error) { postMessage({ type: 'storage-error', code: error.code, message: String(error.message || error) }); return -1; }
    };
  }
  postMessage({ type: 'ready' });
  try {
    const code = await module._pg_wasm_main();             // returns when the session ends
    postMessage({ type: 'exit', code });
  } catch (error) {
    // process exit is reported as an ExitStatus exception by Emscripten
    postMessage({ type: 'exit', code: error && error.status !== undefined ? error.status : 1, error: String(error && error.message || error) });
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') start(msg).catch((error) => postMessage({ type: 'exit', code: 1, error: String(error && error.stack || error) }));
  else if (msg.type === 'write') { inbox.push(msg.bytes); serve(); }
  else if (msg.type === 'fault' && activeStore) activeStore.fault = msg.mode;             // test hook
};
