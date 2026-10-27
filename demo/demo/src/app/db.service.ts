import { Injectable, signal } from '@angular/core';
import { DataSource } from 'typeorm';
import { PostgresWasm, createPgDriver } from '../lib/pgwasm/index.js';
import { Category, CategorySchema, Note, NoteSchema } from './entities';

export interface SqlResult {
  command: string;
  rowCount: number | null;
  columns: string[];
  rows: unknown[][];
}

/**
 * Owns the in-browser PostgreSQL engine and the TypeORM DataSource on top of it.
 *
 * The engine runs in a Worker and keeps its files in IndexedDB (database "notes-demo"), so notes survive a reload
 * and a closed browser. TypeORM talks to it through the node-postgres compatible driver the module provides:
 * `driver: createPgDriver(engine)`; TypeORM needs nothing else.
 */
@Injectable({ providedIn: 'root' })
export class DatabaseService {
  readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  readonly error = signal('');
  readonly serverVersion = signal('');
  readonly notes = signal<Note[]>([]);
  readonly categories = signal<Category[]>([]);
  readonly counts = signal({ total: 0, open: 0, done: 0 });

  private engine!: PostgresWasm;
  private dataSource!: DataSource;

  async start(): Promise<void> {
    try {
      this.engine = await PostgresWasm.open({
        workerUrl: 'pgwasm/engine-worker.js',
        engineUrl: 'pgwasm/postgres.mjs',
        storage: { name: 'notes-demo' },
      });
      this.dataSource = new DataSource({
        type: 'postgres',
        driver: createPgDriver(this.engine),
        entities: [CategorySchema, NoteSchema],
        synchronize: true,            // the demo owns its schema; real apps would use migrations
        installExtensions: false,     // no extensions in the minimal engine
        logging: false,
      });
      await this.dataSource.initialize();
      const v = await this.engine.query('select version() as v');
      this.serverVersion.set(String(v.rows[0]['v']));
      await this.refresh();
      this.status.set('ready');
    } catch (e) {
      console.error('database start failed', e);
      this.error.set(e instanceof Error ? e.message : String(e));
      this.status.set('error');
    }
  }

  async refresh(): Promise<void> {
    this.notes.set(await this.dataSource.getRepository<Note>(NoteSchema).find({ order: { id: 'DESC' } }));
    this.categories.set(await this.dataSource.getRepository<Category>(CategorySchema).find({ order: { name: 'ASC' } }));
    const row = await this.dataSource.getRepository<Note>(NoteSchema).createQueryBuilder('n')
      .select('count(*)', 'total')
      .addSelect('count(*) filter (where n.done)', 'done')
      .getRawOne<{ total: string; done: string }>();
    const total = Number(row?.total ?? 0);
    const done = Number(row?.done ?? 0);
    this.counts.set({ total, done, open: total - done });
  }

  /** One transaction: the category is found or created, then the note saved. Nothing else runs in between. */
  async addNote(title: string, body: string, categoryName: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const categories = manager.getRepository<Category>(CategorySchema);
      const notes = manager.getRepository<Note>(NoteSchema);
      let category: Category | null = null;
      const name = categoryName.trim();
      if (name) {
        category = await categories.findOneBy({ name });
        category ??= await categories.save({ name });
      }
      await notes.save({ title, body, category });
    });
    await this.refresh();
  }

  async toggle(note: Note): Promise<void> {
    await this.dataSource.getRepository<Note>(NoteSchema).update(note.id, { done: !note.done });
    await this.refresh();
  }

  async remove(note: Note): Promise<void> {
    await this.dataSource.getRepository<Note>(NoteSchema).delete(note.id);
    await this.refresh();
  }

  /** Raw SQL through the engine API: values come back exact (bigint and numeric as strings). */
  async run(sql: string): Promise<SqlResult[]> {
    const results = await this.engine.exec(sql, { rowMode: 'array' });
    await this.refresh();
    return results.map((r: { command: string; rowCount: number | null; fields: { name: string }[]; rows: unknown[][] }) => ({
      command: r.command,
      rowCount: r.rowCount,
      columns: r.fields.map((f) => f.name),
      rows: r.rows,
    }));
  }
}
