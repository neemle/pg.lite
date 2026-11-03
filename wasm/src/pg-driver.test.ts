import { describe, expect, it } from 'vitest';
import type { PostgresWasm, QueryResult, Session } from './client.js';
import { createPgDriver } from './pg-driver.js';

const result = (rows: Record<string, unknown>[]): QueryResult => ({
  command: 'SELECT', rowCount: rows.length, rows,
  fields: [{ name: 'n', tableID: 0, columnID: 0, dataTypeID: 23, dataTypeSize: 4, dataTypeModifier: -1, format: 0 }],
});

function fakeDb(): { db: PostgresWasm; log: string[] } {
  const log: string[] = [];
  const db = {
    notices: [],
    connect: (): Promise<Session> => {
      log.push('connect');
      return Promise.resolve({
        query: (sql: string) => { log.push(`query ${sql}`); return Promise.resolve(result([{ n: 42 }])); },
        exec: () => Promise.resolve([]),
        release: () => { log.push('release'); return Promise.resolve(); },
      });
    },
  } as unknown as PostgresWasm;
  return { db, log };
}

describe('node-postgres facade', () => {
  it('Pool.query runs on a checked-out client and releases it', async () => {
    const { db, log } = fakeDb();
    const { Pool } = createPgDriver(db);
    const r = await new Pool().query('select 42 as n');
    expect(r?.rows).toEqual([{ n: 42 }]);
    expect(r?.fields[0]).toMatchObject({ name: 'n', dataTypeID: 23 });
    expect(log).toEqual(['connect', 'query select 42 as n', 'release']);
  });

  it('Client.query supports the callback form', async () => {
    const { db } = fakeDb();
    const { Client } = createPgDriver(db);
    const client = new Client();
    await client.connect();
    const rows = await new Promise<unknown>((resolve, reject) => {
      client.query('select 1', (error, value) => (error ? reject(error) : resolve(value?.rows)));
    });
    expect(rows).toEqual([{ n: 42 }]);
  });

  it('a query on a client that is not connected fails', async () => {
    const { Client } = createPgDriver(fakeDb().db);
    await expect(new Client().query('select 1')).rejects.toThrow('not connected');
  });

  it('a pool that has ended refuses new clients', async () => {
    const { Pool } = createPgDriver(fakeDb().db);
    const pool = new Pool();
    await pool.end();
    await expect(pool.connect()).rejects.toThrow('after calling end');
  });
});
