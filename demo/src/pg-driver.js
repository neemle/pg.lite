// A small node-postgres ("pg") compatible facade over a PostgresWasm instance, so libraries written for `pg`
// (TypeORM: `new DataSource({ type: 'postgres', driver: createPgDriver(db), ... })`) run on the in-browser engine.
//
// Only what such libraries use is implemented: Pool.connect / end / query, Client.query / release / on, the
// callback and the promise forms, result objects { rows, rowCount, command, fields }. A checked-out client owns
// the engine until it is released, which is the pool of one connection the single-user engine can serve; whatever a
// released client leaves open is rolled back.

class Emitter {
  #handlers = new Map();
  on(name, fn) { (this.#handlers.get(name) || this.#handlers.set(name, []).get(name)).push(fn); return this; }
  once(name, fn) { const w = (...a) => { this.off(name, w); fn(...a); }; return this.on(name, w); }
  off(name, fn) { const l = this.#handlers.get(name); if (l) this.#handlers.set(name, l.filter((x) => x !== fn)); return this; }
  removeListener(name, fn) { return this.off(name, fn); }
  removeAllListeners(name) { this.#handlers.delete(name); return this; }
  emit(name, ...args) { for (const fn of this.#handlers.get(name) || []) fn(...args); return true; }
}

const toResult = (r) => ({
  command: r.command, rowCount: r.rowCount, oid: null, rows: r.rows,
  fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID, columnID: f.columnID })),
});

export function createPgDriver(db, { debug = false } = {}) {
  class Client extends Emitter {
    constructor(config = {}) { super(); this.config = config; this.session = null; this.released = false; this._release = null; }

    async connect(cb) {
      const run = async () => { this.session = await db.connect(); this.released = false; };
      if (cb) { run().then(() => cb(null), cb); return undefined; }
      return run();
    }

    // query(text, values?, callback?)  or  query({ text, values, rowMode }, callback?)
    query(arg, values, callback) {
      let config = typeof arg === 'string' ? { text: arg } : { ...arg };
      if (typeof values === 'function') { callback = values; values = undefined; }
      if (values !== undefined) config.values = values;
      if (typeof config.callback === 'function') callback = config.callback;
      const run = async () => {
        if (!this.session) throw new Error('Client is not connected');
        const notices = db.notices.length;
        const r = await this.session.query(config.text, config.values, { rowMode: config.rowMode });
        for (const n of db.notices.splice(notices)) this.emit('notice', { message: n.M, severity: n.S, code: n.C });
        return toResult(r);
      };
      if (callback) { run().then((r) => callback(null, r), (e) => callback(e)); return undefined; }
      return run();
    }

    async end(cb) { await this.release(); cb?.(); }
    release() { if (this._release) return this._release(); const s = this.session; this.session = null; return s ? s.release() : Promise.resolve(); }
  }

  class Pool extends Emitter {
    constructor(config = {}) { super(); this.options = config; this.ended = false; this.totalCount = 0; }

    connect(cb) {
      const run = async () => {
        if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
        const client = new Client(this.options);
        await client.connect();
        let done = false;
        const release = (err) => {
          if (done) return Promise.resolve();
          done = true;
          const s = client.session; client.session = null; client.released = true;
          return s ? s.release() : Promise.resolve();
        };
        client._release = release;
        return { client, release };
      };
      if (cb) { run().then(({ client, release }) => cb(null, client, release), (e) => cb(e)); return undefined; }
      return run().then(({ client }) => client);
    }

    async query(arg, values, callback) {
      const client = await this.connect();
      try { return await client.query(arg, values, callback); } finally { await client.release(); }
    }

    end(cb) { this.ended = true; if (cb) { cb(); return undefined; } return Promise.resolve(); }
  }

  // The few type helpers libraries probe for; the parsing itself is done by the engine facade.
  const types = { builtins: {}, setTypeParser() {}, getTypeParser: () => (s) => s };

  return { Pool, Client, types, defaults: {}, native: null };
}
