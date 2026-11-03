// A small node-postgres ("pg") compatible facade over a PostgresWasm instance, so libraries written for `pg`
// (TypeORM: `new DataSource({ type: 'postgres', driver: createPgDriver(db), ... })`) run on the in-browser engine.
//
// Only what such libraries use is implemented: Pool.connect / end / query, Client.query / release / on, the
// callback and the promise forms, result objects { rows, rowCount, command, fields }. A checked-out client owns
// the engine until it is released, which is the pool of one connection the single-user engine can serve; whatever a
// released client leaves open is rolled back.

import type { PostgresWasm, QueryResult, Row, Session } from './client.js';

type Handler = (...args: never[]) => void;
type Callback<T> = (error: Error | null, value?: T) => void;

class Emitter {
  readonly #handlers = new Map<string, Handler[]>();

  on(name: string, fn: Handler): this {
    const list = this.#handlers.get(name) ?? [];
    list.push(fn);
    this.#handlers.set(name, list);
    return this;
  }

  once(name: string, fn: Handler): this {
    const wrapper = ((...a: never[]) => { this.off(name, wrapper); fn(...a); }) as Handler;
    return this.on(name, wrapper);
  }

  off(name: string, fn: Handler): this {
    const list = this.#handlers.get(name);
    if (list) this.#handlers.set(name, list.filter((x) => x !== fn));
    return this;
  }

  removeListener(name: string, fn: Handler): this { return this.off(name, fn); }
  removeAllListeners(name: string): this { this.#handlers.delete(name); return this; }

  emit(name: string, ...args: unknown[]): boolean {
    for (const fn of this.#handlers.get(name) ?? []) (fn as (...a: unknown[]) => void)(...args);
    return true;
  }
}

export interface PgResult {
  command: string;
  rowCount: number | null;
  oid: null;
  rows: Row[];
  fields: { name: string; dataTypeID: number; tableID: number; columnID: number }[];
}

export interface PgQueryConfig {
  text: string;
  values?: readonly unknown[];
  rowMode?: 'array';
  callback?: Callback<PgResult>;
}

const toResult = (r: QueryResult): PgResult => ({
  command: r.command, rowCount: r.rowCount, oid: null, rows: r.rows,
  fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID, columnID: f.columnID })),
});

export interface PgDriver {
  Pool: new (config?: object) => PgPool;
  Client: new (config?: object) => PgClient;
  types: { builtins: Record<string, never>; setTypeParser(): void; getTypeParser(): (s: string) => string };
  defaults: Record<string, never>;
  native: null;
}

export interface PgClient extends Emitter {
  session: Session | null;
  released: boolean;
  connect(cb?: Callback<void>): Promise<void> | undefined;
  query(arg: string | PgQueryConfig, values?: readonly unknown[] | Callback<PgResult>, callback?: Callback<PgResult>): Promise<PgResult> | undefined;
  end(cb?: () => void): Promise<void>;
  release(): Promise<void>;
}

export interface PgPool extends Emitter {
  ended: boolean;
  totalCount: number;
  connect(cb?: (error: Error | null, client?: PgClient, release?: () => Promise<void>) => void): Promise<PgClient> | undefined;
  query(arg: string | PgQueryConfig, values?: readonly unknown[] | Callback<PgResult>, callback?: Callback<PgResult>): Promise<PgResult | undefined>;
  end(cb?: () => void): Promise<void> | undefined;
}

export function createPgDriver(db: PostgresWasm, _options: { debug?: boolean } = {}): PgDriver {
  class Client extends Emitter implements PgClient {
    session: Session | null = null;
    released = false;
    releaseHandle: (() => Promise<void>) | null = null;

    constructor(readonly config: object = {}) { super(); }

    connect(cb?: Callback<void>): Promise<void> | undefined {
      const run = async (): Promise<void> => { this.session = await db.connect(); this.released = false; };
      if (cb) { run().then(() => cb(null), cb); return undefined; }
      return run();
    }

    // query(text, values?, callback?)  or  query({ text, values, rowMode }, callback?)
    query(arg: string | PgQueryConfig, values?: readonly unknown[] | Callback<PgResult>, callback?: Callback<PgResult>): Promise<PgResult> | undefined {
      const config: PgQueryConfig = typeof arg === 'string' ? { text: arg } : { ...arg };
      if (typeof values === 'function') { callback = values; values = undefined; }
      if (values !== undefined) config.values = values;
      if (typeof config.callback === 'function') callback = config.callback;
      const run = async (): Promise<PgResult> => {
        if (!this.session) throw new Error('Client is not connected');
        const notices = db.notices.length;
        const r = await this.session.query(config.text, config.values, config.rowMode ? { rowMode: config.rowMode } : undefined);
        for (const n of db.notices.splice(notices)) this.emit('notice', { message: n['M'], severity: n['S'], code: n['C'] });
        return toResult(r);
      };
      if (callback) {
        const cb = callback;
        run().then((r) => cb(null, r), (e: Error) => cb(e));
        return undefined;
      }
      return run();
    }

    async end(cb?: () => void): Promise<void> { await this.release(); cb?.(); }

    release(): Promise<void> {
      if (this.releaseHandle) return this.releaseHandle();
      const s = this.session;
      this.session = null;
      return s ? s.release() : Promise.resolve();
    }
  }

  class Pool extends Emitter implements PgPool {
    ended = false;
    totalCount = 0;

    constructor(readonly options: object = {}) { super(); }

    connect(cb?: (error: Error | null, client?: PgClient, release?: () => Promise<void>) => void): Promise<PgClient> | undefined {
      const run = async (): Promise<{ client: Client; release: () => Promise<void> }> => {
        if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
        const client = new Client(this.options);
        await client.connect();
        let done = false;
        const release = (): Promise<void> => {
          if (done) return Promise.resolve();
          done = true;
          const s = client.session;
          client.session = null;
          client.released = true;
          return s ? s.release() : Promise.resolve();
        };
        client.releaseHandle = release;
        return { client, release };
      };
      if (cb) { run().then(({ client, release }) => cb(null, client, release), (e: Error) => cb(e)); return undefined; }
      return run().then(({ client }) => client);
    }

    async query(arg: string | PgQueryConfig, values?: readonly unknown[] | Callback<PgResult>, callback?: Callback<PgResult>): Promise<PgResult | undefined> {
      const client = await this.connect();
      if (!client) return undefined;
      try { return await client.query(arg, values, callback); } finally { await client.release(); }
    }

    end(cb?: () => void): Promise<void> | undefined {
      this.ended = true;
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    }
  }

  // The few type helpers libraries probe for; the parsing itself is done by the engine facade.
  const types = { builtins: {}, setTypeParser() { /* the engine parses */ }, getTypeParser: () => (s: string) => s };

  return { Pool, Client, types, defaults: {}, native: null };
}
