// Page-side API of the in-browser PostgreSQL engine.
//
//   const db = await PostgresWasm.open({ workerUrl, engineUrl });
//   const { rows } = await db.query('select $1::int + 1 as n', [41]);       // [{ n: 42 }]
//   await db.transaction(async (tx) => { await tx.query('insert ...'); });  // owns the engine until it ends
//   await db.close();
//
// One engine, one owner: the engine is a single-user backend, so everything is serialized. A transaction
// (db.transaction) or a session (db.connect) owns the engine from its start to its end; calls from anywhere else
// wait in a FIFO queue and can never run inside it. BEGIN/COMMIT/ROLLBACK are accepted only through such a handle.

import * as proto from './protocol.js';
import { makeParsers, paramText } from './types.js';

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'database error');
    this.name = 'PgError';
    this.severity = fields.S;
    this.code = fields.C;               // SQLSTATE, e.g. '23505' for a unique violation
    this.detail = fields.D;
    this.hint = fields.H;
    this.position = fields.P;
    this.schema = fields.s;
    this.table = fields.t;
    this.column = fields.c;
    this.dataType = fields.d;
    this.constraint = fields.n;
  }
}

const TX_CONTROL = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(begin|start\s+transaction|commit|end|rollback|abort|prepare\s+transaction|savepoint|release|set\s+transaction)\b/i;
const FULL_TX_END = /^\s*(?:commit|end|rollback|abort|begin|start)\b(?!\s+(?:to\b|prepared))/i;

export class PostgresWasm {
  static async open(options) {
    const db = new PostgresWasm(options);
    await db.#start();
    return db;
  }

  #worker; #parsers; #pending = null; #parser = new proto.MessageParser(); #messages = [];
  #wireTail = Promise.resolve(); #ownerTail = Promise.resolve(); #closed = false; #exited = null;
  #logs = [];

  constructor(options) {
    if (!options || !options.workerUrl || !options.engineUrl) throw new TypeError('workerUrl and engineUrl are required');
    this.options = options;
    this.#parsers = makeParsers(options.types || {});
    this.notices = [];
  }

  async #start() {
    const { workerUrl, engineUrl, config, storage } = this.options;
    this.#worker = new Worker(workerUrl, { type: 'module' });
    const ready = new Promise((resolve, reject) => { this.#readyHandlers = { resolve, reject }; });
    this.#worker.onmessage = (e) => this.#onWorkerMessage(e.data);
    this.#worker.onerror = (e) => this.#fail(new Error(`engine worker error: ${e.message}`));
    this.#worker.postMessage({ type: 'init', engineUrl: new URL(engineUrl, self.location.href).href, config: config || {}, storage: storage || null });
    await ready;
    // the engine now sends its startup messages (parameter status, backend key) and ReadyForQuery
    await this.#waitReady();
  }

  #readyHandlers = null;

  #onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready': this.#readyHandlers.resolve(); break;
      case 'open-error': this.#readyHandlers.reject(Object.assign(new Error(msg.message), { code: msg.code })); this.#worker.terminate(); break;
      case 'storage-error': this.storageError = msg; this.options.onStorageError?.(msg); break;
      case 'data':
        for (const m of this.#parser.push(msg.bytes)) {
          this.#messages.push(m);
          if (m.type === 'Z' && this.#pending) { const p = this.#pending; this.#pending = null; p.resolve({ messages: this.#messages.splice(0), status: m.status }); }
        }
        break;
      case 'log': this.#logs.push(msg.text); if (this.#logs.length > 200) this.#logs.shift(); this.options.onLog?.(msg.text, msg.stream); break;
      case 'exit':
        this.#exited = msg;
        if (!this.#closed) {
          this.#fail(this.storageError
            ? Object.assign(new Error(`${this.storageError.message}; the engine stopped and the database must be reopened (committed data is whatever the last completed storage transaction held)`), { code: this.storageError.code })
            : new Error(`engine stopped (code ${msg.code}): ${msg.error || this.#logs.slice(-5).join(' | ')}`));
        }
        this.#onExit?.();
        break;
      default: break;
    }
  }

  #onExit = null;

  #fail(error) {
    this.#readyHandlers?.reject(error);
    if (this.#pending) { const p = this.#pending; this.#pending = null; p.reject(error); }
    this.#broken = error;
  }

  #broken = null;

  #waitReady() {
    return new Promise((resolve, reject) => {
      if (this.#broken) return reject(this.#broken);
      this.#pending = { resolve, reject };
    });
  }

  // one request/response exchange with the engine: send bytes, collect messages up to ReadyForQuery
  #wire(frames) {
    const run = () => {
      if (this.#broken) return Promise.reject(this.#broken);
      if (this.#exited) return Promise.reject(new Error('engine has stopped'));
      return new Promise((resolve, reject) => {
        this.#pending = { resolve, reject };
        for (const f of frames) this.#worker.postMessage({ type: 'write', bytes: f }, [f.buffer]);
      });
    };
    const result = this.#wireTail.then(run, run);
    this.#wireTail = result.catch(() => {});
    return result;
  }

  // ---- owner queue --------------------------------------------------------------------------

  // Waits for its turn, then returns a release() function. FIFO, so no caller starves.
  #acquire() {
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const ready = this.#ownerTail.then(() => release);
    this.#ownerTail = this.#ownerTail.then(() => turn);
    return ready;
  }

  // ---- queries ------------------------------------------------------------------------------

  async #execute(sql, params, options = {}) {
    const frames = (params && params.length > 0) || options.extended
      ? [proto.parse('', sql), proto.bind('', '', (params || []).map((p) => { const t = paramText(p); return t === null ? null : proto.text(t); })),
         proto.describe('P', ''), proto.execute('', 0), proto.sync()]
      : [proto.query(sql)];
    const { messages, status } = await this.#wire(frames);
    return { results: this.#collect(messages, options), status };
  }

  #collect(messages, options) {
    const results = [];
    let fields = null; let rows = []; let error = null;
    const arrays = options.rowMode === 'array';
    for (const m of messages) {
      switch (m.type) {
        case 'T': fields = m.fields; rows = []; break;
        case 'D': {
          const decoded = m.row.map((v, i) => {
            if (v === null) return null;
            const text = proto.decodeText(v);
            const parse = fields && this.#parsers(fields[i].dataTypeID);
            return parse ? parse(text) : text;
          });
          if (arrays) rows.push(decoded);
          else {
            const o = {};
            fields.forEach((f, i) => { o[f.name] = decoded[i]; });
            rows.push(o);
          }
          break;
        }
        case 'C': results.push({ command: m.command, rowCount: m.rowCount, fields: fields || [], rows }); fields = null; rows = []; break;
        case 'I': results.push({ command: '', rowCount: 0, fields: [], rows: [] }); break;
        case 'n': fields = null; break;
        case 'N': { const n = m.fields; this.notices.push(n); this.options.onNotice?.(n); break; }
        case 'E': error = error || new PgError(m.fields); break;
        default: break;
      }
    }
    if (error) throw error;
    return results;
  }

  async #guard(sql) {
    // outside a transaction handle, transaction control is an error and nothing is sent
    if (TX_CONTROL.test(sql)) {
      throw Object.assign(new Error('BEGIN/COMMIT/ROLLBACK and savepoints are only allowed through db.transaction() or db.connect()'), { code: 'XX_OWNER' });
    }
  }

  // Run one statement (or, without parameters, a string of several) as its own call.
  async query(sql, params, options) {
    await this.#guard(sql);
    const release = await this.#acquire();
    try {
      const { results, status } = await this.#execute(sql, params, options);
      if (status !== 'I') {
        await this.#execute('ROLLBACK', undefined, {}).catch(() => {});
        throw Object.assign(new Error('the statement left a transaction open; it was rolled back'), { code: 'XX_OWNER' });
      }
      return results[results.length - 1] || { command: '', rowCount: 0, fields: [], rows: [] };
    } finally { release(); }
  }

  // Several statements in one string, simple query protocol, one result per statement.
  async exec(sql, options) {
    await this.#guard(sql);
    const release = await this.#acquire();
    try {
      const { results, status } = await this.#execute(sql, undefined, options);
      if (status !== 'I') {
        await this.#execute('ROLLBACK', undefined, {}).catch(() => {});
        throw Object.assign(new Error('the statements left a transaction open; it was rolled back'), { code: 'XX_OWNER' });
      }
      return results;
    } finally { release(); }
  }

  // A session owns the engine until release(); raw BEGIN/COMMIT are allowed on it. Whatever it leaves open is
  // rolled back at release(), so the next caller starts clean.
  async connect() {
    const release = await this.#acquire();
    let open = true;
    const self = this;
    const handle = {
      async query(sql, params, options) {
        if (!open) throw new Error('session already released');
        const { results } = await self.#execute(sql, params, options);
        return results[results.length - 1] || { command: '', rowCount: 0, fields: [], rows: [] };
      },
      async exec(sql, options) {
        if (!open) throw new Error('session already released');
        return (await self.#execute(sql, undefined, options)).results;
      },
      async release() {
        if (!open) return;
        open = false;
        try {
          const { status } = await self.#wire([proto.query('')]);       // empty query: only to learn the state
          if (status !== 'I') await self.#execute('ROLLBACK', undefined, {});
        } catch { /* a broken engine is reported by the next call */ } finally { release(); }
      },
    };
    return handle;
  }

  // BEGIN ... COMMIT with the engine owned throughout; a thrown error rolls back and is rethrown.
  async transaction(fn) {
    const session = await this.connect();
    const tx = {
      query: (sql, params, options) => {
        if (FULL_TX_END.test(sql)) throw Object.assign(new Error('the transaction is controlled by db.transaction(); use savepoints inside'), { code: 'XX_OWNER' });
        return session.query(sql, params, options);
      },
    };
    try {
      await session.query('BEGIN');
      const value = await fn(tx);
      await session.query('COMMIT');
      return value;
    } catch (error) {
      try { await session.query('ROLLBACK'); } catch { /* engine gone */ }
      throw error;
    } finally { await session.release(); }
  }

  // Test hooks. kill(): stop the Worker at once, without close(): what a crashed or closed tab looks like.
  // injectStorageFault('fail' | 'abort' | null): the next storage barrier writes nothing / is interrupted while writing.
  kill() {
    this.#closed = true;
    this.#broken = new Error('engine killed');
    this.#worker.terminate();
    if (this.#pending) { const p = this.#pending; this.#pending = null; p.reject(this.#broken); }
  }

  injectStorageFault(mode) { this.#worker.postMessage({ type: 'fault', mode }); }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const release = await this.#acquire();
    try {
      if (!this.#broken && !this.#exited) {
        const done = new Promise((resolve) => { this.#onExit = resolve; });
        const f = proto.terminate();
        this.#worker.postMessage({ type: 'write', bytes: f }, [f.buffer]);
        await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      }
    } finally { this.#worker.terminate(); release(); }
  }
}
