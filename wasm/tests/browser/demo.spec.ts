// The Angular + TypeORM demo (demo/demo) on the built engine: real browser, real Worker, real IndexedDB, driven like a person
// (ui.ts: visible cursor, keystroke-level typing, a screenshot per step; the video of every test is recorded by the configuration).
// Every test is a use case of the project spec (kept in the project tracker, not in this repository) and carries its [UC-###] in the title.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { createServer } from './server';
import type { TestServer } from './server';
import { click, installCursor, open, step, submit, type } from './ui';

const root = path.resolve(__dirname, '..', '..', '..');
const version = process.env['VERSION'] ?? '18.6';
let server: TestServer;

test.beforeAll(async () => {
  server = await createServer([['/', path.join(root, 'build', 'wasm', version, 'demo')]]);
});
test.afterAll(async () => { await server.close(); });

const ready = async (page: Page) => {
  await installCursor(page);
  await open(page, `${server.url}/`);
  await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
};

async function addNote(page: Page, title: string, body?: string, category?: string) {
  await type(page, page.getByTestId('title'), title);
  if (body) await type(page, page.getByTestId('body'), body);
  if (category) await type(page, page.getByTestId('category'), category);
  await submit(page, page.getByTestId('add'));
  // the form is cleared when the note is saved: wait for that before the next input
  await expect(page.getByTestId('title')).toHaveValue('');
}

async function runSql(page: Page, sql: string) {
  await type(page, page.getByTestId('sql'), sql);
  await submit(page, page.getByTestId('run'));
}

test('[UC-001] the app starts PostgreSQL in the browser and TypeORM creates the schema', async ({ page }, info) => {
  await ready(page);
  await step(page, info, 'ready');
  await expect(page.getByTestId('version')).toContainText(`PostgreSQL ${version.split('.')[0]}.`);
  await expect(page.getByTestId('empty')).toBeVisible();
  await expect(page.getByTestId('counts')).toHaveText('0 total · 0 open · 0 done');
});

test('[UC-002] notes and categories are saved through TypeORM and survive a reload', async ({ page }, info) => {
  await ready(page);
  await addNote(page, 'Buy milk', 'two litres', 'home');
  await step(page, info, 'first-note');
  await addNote(page, 'Write report', '', 'work');
  await addNote(page, 'Call plumber', '', 'home');
  await expect(page.getByTestId('note')).toHaveCount(3);
  await expect(page.getByTestId('counts')).toHaveText('3 total · 3 open · 0 done');
  await click(page, page.getByTestId('toggle').first());           // newest first: "Call plumber"
  await expect(page.getByTestId('toggle').first()).toBeChecked();
  await expect(page.getByTestId('counts')).toHaveText('3 total · 2 open · 1 done');
  await step(page, info, 'one-done');

  await page.reload();                                              // a new Worker, the data comes back from IndexedDB
  await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
  await expect(page.getByTestId('note')).toHaveCount(3);
  await expect(page.getByTestId('note-title')).toHaveText(['Call plumber', 'Write report', 'Buy milk']);
  await expect(page.getByTestId('counts')).toHaveText('3 total · 2 open · 1 done');
  await expect(page.getByTestId('note-category')).toHaveText(['home', 'work', 'home']);
  await step(page, info, 'after-reload');

  await click(page, page.getByTestId('remove').first());
  await expect(page.getByTestId('note')).toHaveCount(2);
  await step(page, info, 'one-removed');
});

test('[UC-003] the SQL console shows exact values and SQLSTATE errors', async ({ page }, info) => {
  await ready(page);
  await addNote(page, 'one', '', 'a');
  await addNote(page, 'two', '', 'a');
  await submit(page, page.getByTestId('run'));                      // default query: notes per category
  await expect(page.getByTestId('sql-row')).toHaveText(['a2']);
  await step(page, info, 'default-query');

  await runSql(page, 'select 9223372036854775807::bigint as big, trunc((2::numeric ^ 64) + 1) as n');
  await expect(page.getByTestId('sql-row').first()).toHaveText('922337203685477580718446744073709551617');
  await step(page, info, 'exact-values');

  await runSql(page, 'select 1/0');
  await expect(page.getByTestId('sql-error')).toContainText('22012');
  await step(page, info, 'sqlstate');

  await runSql(page, 'begin');                                       // raw BEGIN outside a transaction handle is refused
  await expect(page.getByTestId('sql-error')).toContainText('only allowed through');
  await step(page, info, 'transaction-control-refused');
});

test('[UC-004] a second tab gets a clear "in use" error instead of a second engine', async ({ page, context }, info) => {
  await installCursor(context);
  await ready(page);
  const other = await context.newPage();
  await open(other, `${server.url}/`);
  await expect(other.getByTestId('error')).toContainText('another tab', { timeout: 60000 });
  await expect(other.getByTestId('status')).toHaveText('could not open the database');
  await step(other, info, 'second-tab-refused');
  // the first tab is unaffected
  await addNote(page, 'still works', '', '');
  await expect(page.getByTestId('note')).toHaveCount(1);
  await step(page, info, 'first-tab-works');
});

test('[UC-005] the app is installed for offline use, then works with the server stopped and the network off (W02, W03)', async ({ page, context }, info) => {
  await ready(page);
  // shown only after the service worker cached the complete set of files of this version
  await expect(page.getByTestId('offline')).toBeVisible({ timeout: 90000 });
  await step(page, info, 'installed-for-offline');
  await addNote(page, 'before offline', '', 'home');
  try {
    server.state.down = true;                                       // the origin server is stopped ...
    await context.setOffline(true);                                 // ... and the network is gone
    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
    await expect(page.getByTestId('note-title')).toHaveText(['before offline']);        // the stored database, offline
    await step(page, info, 'offline-reload');
    await addNote(page, 'made offline', 'no network', 'travel');                       // a new transaction, offline
    await expect(page.getByTestId('note')).toHaveCount(2);
    await page.reload();                                            // and it is stored, offline
    await expect(page.getByTestId('status')).toHaveText('ready', { timeout: 90000 });
    await expect(page.getByTestId('note-title')).toHaveText(['made offline', 'before offline']);
    await step(page, info, 'offline-note-stored');
  } finally {
    server.state.down = false;
    await context.setOffline(false);
  }
});
