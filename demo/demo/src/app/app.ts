import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DatabaseService, SqlResult } from './db.service';
import { Note } from './entities';

@Component({
  selector: 'app-root',
  imports: [DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly db = inject(DatabaseService);
  protected readonly sqlResults = signal<SqlResult[]>([]);
  protected readonly sqlError = signal('');
  protected readonly busy = signal(false);
  protected readonly offlineReady = signal(false);

  ngOnInit(): void {
    void this.db.start();
    // "ready for offline use" only once the service worker has cached the complete set of files of this version:
    // `ready` resolves when a worker is active, and sw.js installs only after cache.addAll() fetched every file
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => navigator.serviceWorker.ready)
        .then(() => this.offlineReady.set(true))
        .catch((e) => console.warn('offline support is not available', e));
    }
  }

  protected async add(title: HTMLInputElement, body: HTMLTextAreaElement, category: HTMLInputElement): Promise<void> {
    if (!title.value.trim()) return;
    await this.guard(() => this.db.addNote(title.value.trim(), body.value, category.value));
    title.value = ''; body.value = ''; category.value = '';
    title.focus();
  }

  protected toggle(note: Note): Promise<void> { return this.guard(() => this.db.toggle(note)); }
  protected remove(note: Note): Promise<void> { return this.guard(() => this.db.remove(note)); }

  protected async runSql(sql: string): Promise<void> {
    this.sqlError.set('');
    this.busy.set(true);
    try {
      this.sqlResults.set(await this.db.run(sql));
    } catch (e) {
      this.sqlResults.set([]);
      const err = e as { code?: string; message?: string };
      this.sqlError.set(`${err.code ? err.code + ': ' : ''}${err.message ?? e}`);
    } finally { this.busy.set(false); }
  }

  protected cell(value: unknown): string {
    if (value === null) return 'NULL';
    if (value instanceof Date) return value.toISOString();
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try { await work(); } finally { this.busy.set(false); }
  }
}
