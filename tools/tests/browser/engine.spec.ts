// The built WebAssembly engine, in a real Worker in Chromium, through the page API (W01 and the data-exactness W07).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { createServer } from './server';
import type { TestServer } from './server';

const root = path.resolve(__dirname, '..', '..');
const version = process.env.VERSION || '18.6';
let server: TestServer;

test.beforeAll(async () => {
  server = await createServer([
    ['/engine/', path.join(root, 'build', 'wasm', version, 'web')],
    ['/src/', path.join(root, 'build', 'node', 'web-lib')],
    ['/', path.join(__dirname, 'fixtures')],
  ]);
});
test.afterAll(async () => { await server.close(); });

// Runs `body` in the page with an open database `db`; returns what the body returns.
async function withDb(page: Page, body: string, options?: Record<string, unknown>) {
  await page.goto(server.url + '/');
  await page.waitForFunction(() => window.openDb);
  return page.evaluate(async ([src, opts]) => {
    const db = await window.openDb(opts);
    try { return await (new Function('db', `return (async () => { ${src} })()`))(db); } finally { await db.close(); }
  }, [body, options || {}]);
}

test('engine starts in a Worker and answers SQL', async ({ page }) => {
  const out = await withDb(page, `
    const v = await db.query('select version() as v');
    const sum = await db.query('select $1::int + $2::int as n', [40, 2]);
    return { version: v.rows[0].v, n: sum.rows[0].n };
  `);
  expect(out.version).toMatch(new RegExp('^PostgreSQL ' + version.split('.')[0] + '\\.'));
  expect(out.n).toBe(42);
});

test('bigint and numeric stay exact (W07)', async ({ page }) => {
  const out = await withDb(page, `
    const r = await db.query("select 9223372036854775807::bigint as big, 123456789012345678901234567890.123456789::numeric as num, trunc((2::numeric ^ 64) + 1) as p");
    return r.rows[0];
  `);
  expect(out.big).toBe('9223372036854775807');
  expect(out.num).toBe('123456789012345678901234567890.123456789');
  expect(out.p).toBe('18446744073709551617');
});

test('errors carry the SQLSTATE and the session continues', async ({ page }) => {
  const out = await withDb(page, `
    let err;
    try { await db.query('select 1/0'); } catch (e) { err = { code: e.code, message: e.message, name: e.name }; }
    const after = await db.query('select 7 as n');
    return { err, after: after.rows[0].n };
  `);
  expect(out.err.code).toBe('22012');
  expect(out.err.name).toBe('PgError');
  expect(out.after).toBe(7);
});

test('DDL, DML, text search and plpgsql work', async ({ page }) => {
  const out = await withDb(page, `
    await db.exec("create table t (id serial primary key, note text, at timestamptz default now())");
    await db.query('insert into t (note) select $1 || g from generate_series(1, 100) g', ['row ']);
    const c = await db.query('select count(*)::int as n, min(note) as first from t');
    await db.exec("create function add3(a int) returns int language plpgsql as $$ begin return a + 3; end $$");
    const f = await db.query('select add3(4) as n');
    const ts = await db.query("select to_tsvector('english', 'the foxes jumped') as v");
    return { count: c.rows[0], plpgsql: f.rows[0].n, ts: ts.rows[0].v };
  `);
  expect(out.count).toEqual({ n: 100, first: 'row 1' });
  expect(out.plpgsql).toBe(7);
  expect(out.ts).toContain("'fox'");
});

test('a transaction owns the engine; others wait and never run inside it (W05)', async ({ page }) => {
  const out = await withDb(page, `
    await db.exec('create table acct (id int primary key, bal int)');
    await db.query('insert into acct values (1, 100)');
    const order = [];
    const tx = db.transaction(async (t) => {
      order.push('tx start');
      await t.query('update acct set bal = bal - 30 where id = 1');
      await new Promise((r) => setTimeout(r, 200));              // another caller tries meanwhile
      const inside = await t.query('select bal from acct where id = 1');
      order.push('tx sees ' + inside.rows[0].bal);
      await t.query('update acct set bal = bal - 20 where id = 1');
      order.push('tx end');
    });
    await new Promise((r) => setTimeout(r, 20));
    const other = db.query('select bal from acct where id = 1').then((r) => { order.push('other sees ' + r.rows[0].bal); return r.rows[0].bal; });
    await tx;
    const seen = await other;
    return { order, seen };
  `);
  expect(out.order).toEqual(['tx start', 'tx sees 70', 'tx end', 'other sees 50']);
  expect(out.seen).toBe(50);
});

test('raw BEGIN outside a transaction handle is refused; a failed callback rolls back', async ({ page }) => {
  const out = await withDb(page, `
    await db.exec('create table r (n int)');
    let raw;
    try { await db.query('begin'); } catch (e) { raw = e.code; }
    let thrown;
    try { await db.transaction(async (t) => { await t.query('insert into r values (1)'); throw new Error('boom'); }); } catch (e) { thrown = e.message; }
    const n = await db.query('select count(*)::int as n from r');
    const ok = await db.transaction(async (t) => { await t.query('insert into r values (2)'); return 'done'; });
    const n2 = await db.query('select count(*)::int as n from r');
    return { raw, thrown, n: n.rows[0].n, ok, n2: n2.rows[0].n };
  `);
  expect(out.raw).toBe('XX_OWNER');
  expect(out.thrown).toBe('boom');
  expect(out.n).toBe(0);
  expect(out.ok).toBe('done');
  expect(out.n2).toBe(1);
});

test('runaway recursion is stopped by PostgreSQL (54001) and the engine keeps running', async ({ page }) => {
  const out = await withDb(page, `
    await db.exec("create function f(n int) returns int language plpgsql as $$ begin if n = 0 then return 0; end if; return 1 + f(n - 1); end $$");
    const ok = (await db.query('select f(100) as v')).rows[0].v;
    let err;
    try { await db.query('select f(100000)'); } catch (e) { err = e.code; }
    const alive = (await db.query('select 1 as one')).rows[0].one;
    return { ok, err, alive };
  `);
  expect(out).toEqual({ ok: 100, err: '54001', alive: 1 });
});
