// The Angular + TypeORM demo (web/demo) on the built engine: real browser, real Worker, real IndexedDB.
// Persistence across reload (W02, without the offline part), storage ownership between tabs (W05), exact numbers (W07).
const { test, expect } = require('@playwright/test');
const path = require('path');
const { createServer } = require('./server.js');

const root = path.resolve(__dirname, '..', '..');
const version = process.env.VERSION || '18.6';
let server;

test.beforeAll(async () => {
  server = await createServer([['/', path.join(root, 'build', 'wasm', version, 'demo')]]);
});
test.afterAll(async () => { await server.close(); });

const ready = async (page) => {
  await page.goto(server.url + '/');
  await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
};

async function addNote(page, title, body, category) {
  await page.getByTestId('title').fill(title);
  if (body) await page.getByTestId('body').fill(body);
  if (category) await page.getByTestId('category').fill(category);
  await page.getByTestId('add').click();
  // the form is cleared when the note is saved: wait for that before the next input
  await expect(page.getByTestId('title')).toHaveValue('');
}

test('the app starts PostgreSQL in the browser and TypeORM creates the schema', async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId('version')).toContainText('PostgreSQL ' + version.split('.')[0] + '.');
  await expect(page.getByTestId('empty')).toBeVisible();
  await expect(page.getByTestId('counts')).toHaveText('0 total · 0 open · 0 done');
});

test('notes and categories are saved through TypeORM and survive a reload', async ({ page }) => {
  await ready(page);
  await addNote(page, 'Buy milk', 'two litres', 'home');
  await addNote(page, 'Write report', '', 'work');
  await addNote(page, 'Call plumber', '', 'home');
  await expect(page.getByTestId('note')).toHaveCount(3);
  await expect(page.getByTestId('counts')).toHaveText('3 total · 3 open · 0 done');
  await page.getByTestId('toggle').first().check();           // newest first: "Call plumber"
  await expect(page.getByTestId('counts')).toHaveText('3 total · 2 open · 1 done');

  await page.reload();                                         // a new Worker, the data comes back from IndexedDB
  await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
  await expect(page.getByTestId('note')).toHaveCount(3);
  await expect(page.getByTestId('note-title')).toHaveText(['Call plumber', 'Write report', 'Buy milk']);
  await expect(page.getByTestId('counts')).toHaveText('3 total · 2 open · 1 done');
  await expect(page.getByTestId('note-category')).toHaveText(['home', 'work', 'home']);

  await page.getByTestId('remove').first().click();
  await expect(page.getByTestId('note')).toHaveCount(2);
});

test('the SQL console shows exact values and SQLSTATE errors', async ({ page }) => {
  await ready(page);
  await addNote(page, 'one', '', 'a');
  await addNote(page, 'two', '', 'a');
  await page.getByTestId('run').click();                       // default query: notes per category
  await expect(page.getByTestId('sql-row')).toHaveText(['a2']);

  await page.getByTestId('sql').fill("select 9223372036854775807::bigint as big, trunc((2::numeric ^ 64) + 1) as n");
  await page.getByTestId('run').click();
  await expect(page.getByTestId('sql-row').first()).toHaveText('922337203685477580718446744073709551617');

  await page.getByTestId('sql').fill('select 1/0');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('sql-error')).toContainText('22012');

  await page.getByTestId('sql').fill('begin');
  await page.getByTestId('run').click();                       // raw BEGIN outside a transaction handle is refused
  await expect(page.getByTestId('sql-error')).toContainText('only allowed through');
});

test('a second tab gets a clear "in use" error instead of a second engine', async ({ page, context }) => {
  await ready(page);
  const other = await context.newPage();
  await other.goto(server.url + '/');
  await expect(other.getByTestId('error')).toContainText('another tab', { timeout: 60000 });
  await expect(other.getByTestId('status')).toHaveText('could not open the database');
  // the first tab is unaffected
  await addNote(page, 'still works', '', '');
  await expect(page.getByTestId('note')).toHaveCount(1);
});

test('the app is installed for offline use, then works with the server stopped and the network off (W02, W03)', async ({ page, context }) => {
  await ready(page);
  // shown only after the service worker cached the complete set of files of this version
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 90000 });
  await addNote(page, 'before offline', '', 'home');
  try {
    server.state.down = true;                                   // the origin server is stopped ...
    await context.setOffline(true);                             // ... and the network is gone
    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
    await expect(page.getByTestId('note-title')).toHaveText(['before offline']);        // the stored database, offline
    await addNote(page, 'made offline', 'no network', 'travel');                       // a new transaction, offline
    await expect(page.getByTestId('note')).toHaveCount(2);
    await page.reload();                                        // and it is stored, offline
    await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
    await expect(page.getByTestId('note-title')).toHaveText(['made offline', 'before offline']);
  } finally {
    server.state.down = false;
    await context.setOffline(false);
  }
});
