import { EntitySchema } from 'typeorm';

// Entities are declared with EntitySchema (no decorators): the Angular esbuild builder does not emit the decorator
// metadata TypeORM would otherwise need, and every column type is explicit anyway.

export interface Category {
  id: number;
  name: string;
  notes?: Note[];
}

export interface Note {
  id: number;
  title: string;
  body: string;
  done: boolean;
  createdAt: Date;
  category: Category | null;
}

export const CategorySchema = new EntitySchema<Category>({
  name: 'Category',
  tableName: 'category',
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    name: { type: 'text', unique: true },
  },
  relations: {
    notes: { type: 'one-to-many', target: 'Note', inverseSide: 'category' },
  },
});

export const NoteSchema = new EntitySchema<Note>({
  name: 'Note',
  tableName: 'note',
  columns: {
    id: { type: 'int', primary: true, generated: 'increment' },
    title: { type: 'text' },
    body: { type: 'text', default: '' },
    done: { type: 'boolean', default: false },
    createdAt: { type: 'timestamptz', createDate: true },
  },
  relations: {
    category: { type: 'many-to-one', target: 'Category', inverseSide: 'notes', nullable: true, onDelete: 'SET NULL', eager: true },
  },
});
