import { describe, expect, it } from 'vitest';
import { CategorySchema, NoteSchema } from './entities';

describe('entities', () => {
  it('map notes and categories to tables with a one-to-many relation', () => {
    expect(CategorySchema.options.tableName).toBe('category');
    expect(NoteSchema.options.tableName).toBe('note');
    expect(CategorySchema.options.relations?.['notes']?.type).toBe('one-to-many');
    expect(NoteSchema.options.relations?.['category']?.type).toBe('many-to-one');
  });

  it('give every note a generated key and a creation time', () => {
    const columns = NoteSchema.options.columns;
    expect(columns['id']?.primary).toBe(true);
    expect(columns['id']?.generated).toBe('increment');
    expect(columns['createdAt']?.createDate).toBe(true);
  });

  it('keep category names unique', () => {
    expect(CategorySchema.options.columns['name']?.unique).toBe(true);
  });
});
