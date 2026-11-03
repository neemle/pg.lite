import { describe, expect, it } from 'vitest';
import { MessageParser, bind, decodeText, parse, query, sync, text } from './protocol.js';

const enc = new TextEncoder();

function message(type: string, ...body: number[]): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}

const cstring = (s: string): number[] => [...enc.encode(s), 0];

describe('frontend messages', () => {
  it('builds a Query: type, length, text, terminator', () => {
    const q = query('select 1');
    expect(String.fromCharCode(q[0]!)).toBe('Q');
    expect(new DataView(q.buffer).getInt32(1)).toBe(4 + 'select 1'.length + 1);
    expect(decodeText(q.subarray(5, q.length - 1))).toBe('select 1');
    expect(q.at(-1)).toBe(0);
  });

  it('builds Parse, Bind and Sync with the lengths the protocol wants', () => {
    expect(parse('', 'select $1').length).toBe(1 + 4 + 1 + 'select $1'.length + 1 + 2);
    const b = bind('', '', [text('42'), null]);
    expect(String.fromCharCode(b[0]!)).toBe('B');
    expect(new DataView(b.buffer).getInt32(1)).toBe(b.length - 1);
    expect(sync()).toEqual(Uint8Array.of(83, 0, 0, 0, 4));
  });
});

describe('backend messages', () => {
  it('decodes a result set in one chunk', () => {
    const description = message('T', 0, 1, ...cstring('n'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 23, 0, 4, 255, 255, 255, 255, 0, 0);
    const row = message('D', 0, 1, 0, 0, 0, 2, 52, 50);
    const done = message('C', ...cstring('SELECT 1'));
    const ready = message('Z', 73);
    const out = new MessageParser().push(Uint8Array.from([...description, ...row, ...done, ...ready]));
    expect(out.map((m) => m.type)).toEqual(['T', 'D', 'C', 'Z']);
    const [t, d, c, z] = out;
    expect(t).toMatchObject({ fields: [{ name: 'n', dataTypeID: 23 }] });
    expect(d && 'row' in d && d.row[0] && decodeText(d.row[0])).toBe('42');
    expect(c).toMatchObject({ command: 'SELECT', rowCount: 1 });
    expect(z).toMatchObject({ status: 'I' });
  });

  it('waits for the rest of a message that arrives in pieces', () => {
    const ready = message('Z', 84);
    const parser = new MessageParser();
    expect(parser.push(ready.subarray(0, 3))).toEqual([]);
    expect(parser.push(ready.subarray(3))).toEqual([{ type: 'Z', status: 'T' }]);
  });

  it('decodes error fields by their code letters', () => {
    const body = [83, ...cstring('ERROR'), 67, ...cstring('23505'), 77, ...cstring('duplicate key'), 0];
    const [error] = new MessageParser().push(message('E', ...body));
    expect(error).toEqual({ type: 'E', fields: { S: 'ERROR', C: '23505', M: 'duplicate key' } });
  });

  it('reports the row count of INSERT, which carries an OID before it', () => {
    const [done] = new MessageParser().push(message('C', ...cstring('INSERT 0 3')));
    expect(done).toMatchObject({ command: 'INSERT', rowCount: 3 });
  });
});
