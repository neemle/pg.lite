// Persistence in IndexedDB with the commit barrier: crash, interrupted transaction, storage failure, interrupted
// flush and incompatible version (W04, W06, W08, W09). Real Chromium, real Worker, real IndexedDB.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { createServer } = require('./server.js');

const root = path.resolve(__dirname, '..', '..');
const version = process.env.VERSION || '18.6';
let server;

test.beforeAll(async () => {
  server = await createServer([
    ['/engine/', path.join(root, 'build', 'wasm', version, 'web')],
    ['/src/', path.join(root, 'web', 'src')],
    ['/', path.join(__dirname, 'fixtures')],
  ]);
});
test.afterAll(async () => { await server.close(); });

async function start(page) {
  await page.goto(server.url + '/');
  await page.waitForFunction(() => window.openDb);
}

// A Worker that was killed releases its Web Lock a moment later: retry while the database reports "busy".
const REOPEN = `
  const reopen = async (name) => {
    for (let i = 0; i < 100; i++) {
      try { return await window.openDb({ storage: { name } }); }
      catch (e) { if (e.code !== 'busy') throw e; await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('still busy');
  };
`;
const run = (page, body) => page.evaluate(async (src) => (new Function(`return (async () => { ${src} })()`))(), REOPEN + body);

test('a committed transaction survives killing the Worker; an unfinished one is gone (W04)', async ({ page }) => {
  await start(page);
  const out = await run(page, `
    let db = await reopen('w04');
    await db.exec('create table t (id int primary key, note text)');
    await db.transaction(async (tx) => { await tx.query("insert into t values (1, 'committed')"); });
    await db.query("insert into t values (2, 'autocommit')");
    const s = await db.connect();
    await s.query('begin');
    await s.query("insert into t values (3, 'never committed')");
    db.kill();                                                  // no close(), no commit: the tab died
    db = await reopen('w04');
    const rows = (await db.query('select id, note from t order by id')).rows;
    // and it is a working database again
    await db.query("insert into t values (4, 'after recovery')");
    const again = (await db.query('select count(*)::int as n from t')).rows[0].n;
    await db.close();
    return { rows, again };
  `);
  expect(out.rows).toEqual([{ id: 1, note: 'committed' }, { id: 2, note: 'autocommit' }]);
  expect(out.again).toBe(3);
});

test('a new database is stored before open() returns (the Worker can be killed at once)', async ({ page }) => {
  await start(page);
  const out = await run(page, `
    let db = await reopen('w04b');
    db.kill();
    db = await reopen('w04b');
    const v = (await db.query('select 1 as one')).rows[0].one;
    await db.close();
    return v;
  `);
  expect(out).toBe(1);
});

for (const mode of ['fail', 'abort']) {
  test(`a commit whose storage ${mode === 'fail' ? 'fails' : 'is interrupted while writing'} is never reported as done (W06, W08)`, async ({ page }) => {
    await start(page);
    const out = await run(page, `
      let db = await reopen('w06-${mode}');
      await db.exec('create table t (id int primary key)');
      await db.query('insert into t values (1)');
      db.injectStorageFault('${mode}');
      let error = null;
      try { await db.query('insert into t values (2)'); } catch (e) { error = { code: e.code, message: e.message }; }
      let after = null;
      try { await db.query('select 1'); } catch (e) { after = e.message; }       // the instance needs a reopen
      db.kill();
      db = await reopen('w06-${mode}');
      const rows = (await db.query('select id from t order by id')).rows.map((r) => r.id);
      await db.query('insert into t values (3)');
      const rows2 = (await db.query('select id from t order by id')).rows.map((r) => r.id);
      await db.close();
      return { error, after, rows, rows2 };
    `);
    expect(out.error).not.toBeNull();                       // the caller was told: not a success
    expect(out.error.code).toBe('persist-failed');
    expect(out.after).not.toBeNull();                       // and the instance is unusable until reopened
    expect(out.rows).toEqual([1]);                          // the previous generation, nothing of the failed commit
    expect(out.rows2).toEqual([1, 3]);
  });
}

test('a database of another release or profile is refused and left unchanged (W09)', async ({ page, context }) => {
  await start(page);
  await run(page, `
    const db = await reopen('w09');
    await db.exec('create table t (id int)');
    await db.query('insert into t values (7)');
    await db.close();
  `);
  // an engine build that says it is another PostgreSQL release
  await context.route('**/engine/manifest.json', async (route) => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, pg: '99.9' } });
  });
  const refused = await run(page, `
    try { await window.openDb({ storage: { name: 'w09' } }); return null; } catch (e) { return { code: e.code, message: e.message }; }
  `);
  expect(refused.code).toBe('incompatible');
  expect(refused.message).toContain('Nothing was changed');
  await context.unroute('**/engine/manifest.json');
  const rows = await run(page, `
    const db = await reopen('w09');
    const r = (await db.query('select id from t')).rows;
    await db.close();
    return r;
  `);
  expect(rows).toEqual([{ id: 7 }]);
});

test('a second open of the same database in the same browser is refused with "busy" (W05)', async ({ page }) => {
  await start(page);
  const out = await run(page, `
    const first = await reopen('w05');
    let code = null;
    try { await window.openDb({ storage: { name: 'w05' } }); } catch (e) { code = e.code; }
    await first.query('select 1');
    await first.close();
    return code;
  `);
  expect(out).toBe('busy');
});

test('data written in many transactions and large rows come back after reopen', async ({ page }) => {
  await start(page);
  const out = await run(page, `
    let db = await reopen('bulk');
    await db.exec('create table big (id int primary key, payload text)');
    for (let i = 0; i < 20; i++) await db.query('insert into big select g + $1, repeat(md5(g::text), 50) from generate_series(1, 50) g', [i * 100]);
    await db.query("update big set payload = payload || 'x' where id % 7 = 0");
    await db.query('delete from big where id % 11 = 0');
    const before = (await db.query('select count(*)::int as n, sum(length(payload))::bigint as len from big')).rows[0];
    db.kill();
    db = await reopen('bulk');
    const after = (await db.query('select count(*)::int as n, sum(length(payload))::bigint as len from big')).rows[0];
    await db.close();
    return { before, after };
  `);
  expect(out.after).toEqual(out.before);
  expect(out.before.n).toBeGreaterThan(800);
});
