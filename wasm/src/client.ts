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
import type { BackendMessage, ErrorFields, FieldDescription } from './protocol.js';
import { makeParsers, paramText } from './types.js';
import type { TypeOptions } from './types.js';

export interface StorageOptions {
  /** the database is kept in IndexedDB under this name; leave `storage` out for a memory-only database */
  name: string;
}

export interface PostgresWasmOptions {
  /** URL of engine-worker.js */
  workerUrl: string;
  /** URL of postgres.mjs, next to postgres.wasm, postgres.data and manifest.json */
  engineUrl: string;
  /** server settings applied at every start (see the Worker) */
  config?: Record<string, string | number>;
  storage?: StorageOptions;
  types?: TypeOptions;
  onLog?: (text: string, stream: string) => void;
  onNotice?: (notice: ErrorFields) => void;
  onStorageError?: (error: StorageErrorMessage) => void;
}

export interface StorageErrorMessage { type: 'storage-error'; code: string; message: string }

export interface QueryOptions {
  /** 'array' returns each row as an array instead of an object */
  rowMode?: 'array';
  /** use the extended protocol even without parameters */
  extended?: boolean;
}

export type Row = Record<string, unknown> | unknown[];

/** rowMode: 'array' gives each row as an array */
export type ArrayMode = QueryOptions & { rowMode: 'array' };

export interface QueryResult<R extends Row = Record<string, unknown>> {
  command: string;
  rowCount: number | null;
  fields: FieldDescription[];
  rows: R[];
}

export interface Session {
  query(sql: string, params: readonly unknown[] | undefined, options: ArrayMode): Promise<QueryResult<unknown[]>>;
  query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult>;
  exec(sql: string, options: ArrayMode): Promise<QueryResult<unknown[]>[]>;
  exec(sql: string, options?: QueryOptions): Promise<QueryResult[]>;
  release(): Promise<void>;
}

export interface Transaction {
  query(sql: string, params: readonly unknown[] | undefined, options: ArrayMode): Promise<QueryResult<unknown[]>>;
  query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult>;
}

export class PgError extends Error {
  readonly severity: string | undefined;
  /** SQLSTATE, e.g. '23505' for a unique violation */
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly position: string | undefined;
  readonly schema: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly dataType: string | undefined;
  readonly constraint: string | undefined;

  constructor(fields: ErrorFields) {
    super(fields['M'] ?? 'database error');
    this.name = 'PgError';
    this.severity = fields['S'];
    this.code = fields['C'];
    this.detail = fields['D'];
    this.hint = fields['H'];
    this.position = fields['P'];
    this.schema = fields['s'];
    this.table = fields['t'];
    this.column = fields['c'];
    this.dataType = fields['d'];
    this.constraint = fields['n'];
  }
}

const TX_CONTROL = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(begin|start\s+transaction|commit|end|rollback|abort|prepare\s+transaction|savepoint|release|set\s+transaction)\b/i;
const FULL_TX_END = /^\s*(?:commit|end|rollback|abort|begin|start)\b(?!\s+(?:to\b|prepared))/i;

const EMPTY: QueryResult<Row> = { command: '', rowCount: 0, fields: [], rows: [] };

interface Pending { resolve: (value: { messages: BackendMessage[]; status: string }) => void; reject: (error: Error) => void }

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'open-error'; code: string; message: string }
  | StorageErrorMessage
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'log'; stream: string; text: string }
  | { type: 'exit'; code: number; error?: string };

export class PostgresWasm {
  static async open(options: PostgresWasmOptions): Promise<PostgresWasm> {
    const db = new PostgresWasm(options);
    await db.#start();
    return db;
  }

  readonly options: PostgresWasmOptions;
  readonly notices: ErrorFields[] = [];
  storageError: StorageErrorMessage | null = null;

  #worker!: Worker;
  readonly #parsers: ReturnType<typeof makeParsers>;
  #pending: Pending | null = null;
  readonly #parser = new proto.MessageParser();
  readonly #messages: BackendMessage[] = [];
  #wireTail: Promise<unknown> = Promise.resolve();
  #ownerTail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #exited: { code: number; error?: string } | null = null;
  readonly #logs: string[] = [];
  #readyHandlers: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #onExit: (() => void) | null = null;
  #broken: Error | null = null;

  constructor(options: PostgresWasmOptions) {
    if (!options?.workerUrl || !options.engineUrl) throw new TypeError('workerUrl and engineUrl are required');
    this.options = options;
    this.#parsers = makeParsers(options.types ?? {});
  }

  async #start(): Promise<void> {
    const { workerUrl, engineUrl, config, storage } = this.options;
    this.#worker = new Worker(workerUrl, { type: 'module' });
    const ready = new Promise<void>((resolve, reject) => { this.#readyHandlers = { resolve, reject }; });
    this.#worker.addEventListener('message', (e: MessageEvent<WorkerMessage>) => this.#onWorkerMessage(e.data));
    this.#worker.addEventListener('error', (e) => this.#fail(new Error(`engine worker error: ${e.message}`)));
    this.#worker.postMessage({ type: 'init', engineUrl: new URL(engineUrl, self.location.href).href, config: config ?? {}, storage: storage ?? null });
    await ready;
    // the engine now sends its startup messages (parameter status, backend key) and ReadyForQuery
    await this.#waitReady();
  }

  #onWorkerMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case 'ready': this.#readyHandlers?.resolve(); break;
      case 'open-error':
        this.#readyHandlers?.reject(Object.assign(new Error(msg.message), { code: msg.code }));
        this.#worker.terminate();
        break;
      case 'storage-error': this.storageError = msg; this.options.onStorageError?.(msg); break;
      case 'data':
        for (const m of this.#parser.push(msg.bytes)) {
          this.#messages.push(m);
          if (m.type === 'Z' && this.#pending) {
            const p = this.#pending;
            this.#pending = null;
            p.resolve({ messages: this.#messages.splice(0), status: m.status });
          }
        }
        break;
      case 'log':
        this.#logs.push(msg.text);
        if (this.#logs.length > 200) this.#logs.shift();
        this.options.onLog?.(msg.text, msg.stream);
        break;
      case 'exit':
        this.#exited = msg;
        if (!this.#closed) {
          this.#fail(this.storageError
            ? Object.assign(new Error(`${this.storageError.message}; the engine stopped and the database must be reopened (committed data is whatever the last completed storage transaction held)`), { code: this.storageError.code })
            : new Error(`engine stopped (code ${msg.code}): ${msg.error ?? this.#logs.slice(-5).join(' | ')}`));
        }
        this.#onExit?.();
        break;
      default: break;
    }
  }

  #fail(error: Error): void {
    this.#readyHandlers?.reject(error);
    if (this.#pending) { const p = this.#pending; this.#pending = null; p.reject(error); }
    this.#broken = error;
  }

  #waitReady(): Promise<{ messages: BackendMessage[]; status: string }> {
    return new Promise((resolve, reject) => {
      if (this.#broken) { reject(this.#broken); return; }
      this.#pending = { resolve, reject };
    });
  }

  // one request/response exchange with the engine: send bytes, collect messages up to ReadyForQuery
  #wire(frames: Uint8Array[]): Promise<{ messages: BackendMessage[]; status: string }> {
    const run = (): Promise<{ messages: BackendMessage[]; status: string }> => {
      if (this.#broken) return Promise.reject(this.#broken);
      if (this.#exited) return Promise.reject(new Error('engine has stopped'));
      return new Promise((resolve, reject) => {
        this.#pending = { resolve, reject };
        for (const f of frames) this.#worker.postMessage({ type: 'write', bytes: f }, [f.buffer]);
      });
    };
    const result = this.#wireTail.then(run, run);
    this.#wireTail = result.catch(() => undefined);
    return result;
  }

  // ---- owner queue --------------------------------------------------------------------------

  // Waits for its turn, then returns a release() function. FIFO, so no caller starves.
  #acquire(): Promise<() => void> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const ready = this.#ownerTail.then(() => release);
    this.#ownerTail = this.#ownerTail.then(() => turn);
    return ready;
  }

  // ---- queries ------------------------------------------------------------------------------

  async #execute(sql: string, params?: readonly unknown[], options: QueryOptions = {}): Promise<{ results: QueryResult<Row>[]; status: string }> {
    const frames = (params && params.length > 0) || options.extended
      ? [proto.parse('', sql), proto.bind('', '', (params ?? []).map((p) => { const t = paramText(p); return t === null ? null : proto.text(t); })),
         proto.describe('P', ''), proto.execute('', 0), proto.sync()]
      : [proto.query(sql)];
    const { messages, status } = await this.#wire(frames);
    return { results: this.#collect(messages, options), status };
  }

  #collect(messages: BackendMessage[], options: QueryOptions): QueryResult<Row>[] {
    const results: QueryResult<Row>[] = [];
    let fields: FieldDescription[] | null = null;
    let rows: Row[] = [];
    let error: PgError | null = null;
    const arrays = options.rowMode === 'array';
    for (const m of messages) {
      switch (m.type) {
        case 'T': fields = m.fields; rows = []; break;
        case 'D': {
          const described = fields;
          const decoded = m.row.map((v, i) => {
            if (v === null) return null;
            const text = proto.decodeText(v);
            const parse = described ? this.#parsers(described[i]!.dataTypeID) : null;
            return parse ? parse(text) : text;
          });
          if (arrays) rows.push(decoded);
          else {
            const o: Record<string, unknown> = {};
            described?.forEach((f, i) => { o[f.name] = decoded[i]; });
            rows.push(o);
          }
          break;
        }
        case 'C': results.push({ command: m.command, rowCount: m.rowCount, fields: fields ?? [], rows }); fields = null; rows = []; break;
        case 'I': results.push({ command: '', rowCount: 0, fields: [], rows: [] }); break;
        case 'n': fields = null; break;
        case 'N': this.notices.push(m.fields); this.options.onNotice?.(m.fields); break;
        case 'E': error ??= new PgError(m.fields); break;
        default: break;
      }
    }
    if (error) throw error;
    return results;
  }

  #guard(sql: string): void {
    // outside a transaction handle, transaction control is an error and nothing is sent
    if (TX_CONTROL.test(sql)) {
      throw Object.assign(new Error('BEGIN/COMMIT/ROLLBACK and savepoints are only allowed through db.transaction() or db.connect()'), { code: 'XX_OWNER' });
    }
  }

  /** Run one statement (or, without parameters, a string of several) as its own call; the result of the last one. */
  query(sql: string, params: readonly unknown[] | undefined, options: ArrayMode): Promise<QueryResult<unknown[]>>;
  query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult>;
  async query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<QueryResult<Row>> {
    this.#guard(sql);
    const release = await this.#acquire();
    try {
      const { results, status } = await this.#execute(sql, params, options);
      if (status !== 'I') {
        await this.#execute('ROLLBACK').catch(() => undefined);
        throw Object.assign(new Error('the statement left a transaction open; it was rolled back'), { code: 'XX_OWNER' });
      }
      return results[results.length - 1] ?? EMPTY;
    } finally { release(); }
  }

  /** Several statements in one string, simple query protocol, one result per statement. */
  exec(sql: string, options: ArrayMode): Promise<QueryResult<unknown[]>[]>;
  exec(sql: string, options?: QueryOptions): Promise<QueryResult[]>;
  async exec(sql: string, options?: QueryOptions): Promise<QueryResult<Row>[]> {
    this.#guard(sql);
    const release = await this.#acquire();
    try {
      const { results, status } = await this.#execute(sql, undefined, options);
      if (status !== 'I') {
        await this.#execute('ROLLBACK').catch(() => undefined);
        throw Object.assign(new Error('the statements left a transaction open; it was rolled back'), { code: 'XX_OWNER' });
      }
      return results;
    } finally { release(); }
  }

  /**
   * A session owns the engine until release(); raw BEGIN/COMMIT are allowed on it. Whatever it leaves open is
   * rolled back at release(), so the next caller starts clean.
   */
  async connect(): Promise<Session> {
    const release = await this.#acquire();
    let open = true;
    const execute = (sql: string, params?: readonly unknown[], options?: QueryOptions) => this.#execute(sql, params, options);
    const wire = (frames: Uint8Array[]) => this.#wire(frames);
    const session = {
      async query(sql: string, params?: readonly unknown[], options?: QueryOptions) {
        if (!open) throw new Error('session already released');
        const { results } = await execute(sql, params, options);
        return results[results.length - 1] ?? EMPTY;
      },
      async exec(sql: string, options?: QueryOptions) {
        if (!open) throw new Error('session already released');
        return (await execute(sql, undefined, options)).results;
      },
      async release() {
        if (!open) return;
        open = false;
        try {
          const { status } = await wire([proto.query('')]);       // empty query: only to learn the state
          if (status !== 'I') await execute('ROLLBACK');
        } catch { /* a broken engine is reported by the next call */ } finally { release(); }
      },
    };
    return session as Session;
  }

  /** BEGIN ... COMMIT with the engine owned throughout; a thrown error rolls back and is rethrown. */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const session = await this.connect();
    const tx = {
      query: (sql: string, params?: readonly unknown[], options?: QueryOptions) => {
        if (FULL_TX_END.test(sql)) throw Object.assign(new Error('the transaction is controlled by db.transaction(); use savepoints inside'), { code: 'XX_OWNER' });
        return session.query(sql, params, options);
      },
    } as Transaction;
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
  kill(): void {
    this.#closed = true;
    this.#broken = new Error('engine killed');
    this.#worker.terminate();
    if (this.#pending) { const p = this.#pending; this.#pending = null; p.reject(this.#broken); }
  }

  injectStorageFault(mode: 'fail' | 'abort' | null): void { this.#worker.postMessage({ type: 'fault', mode }); }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const release = await this.#acquire();
    try {
      if (!this.#broken && !this.#exited) {
        const done = new Promise<void>((resolve) => { this.#onExit = resolve; });
        const f = proto.terminate();
        this.#worker.postMessage({ type: 'write', bytes: f }, [f.buffer]);
        await Promise.race([done, new Promise<void>((r) => setTimeout(r, 5000))]);
      }
    } finally { this.#worker.terminate(); release(); }
  }
}
