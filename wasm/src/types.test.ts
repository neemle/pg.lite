import { describe, expect, it } from 'vitest';
import { makeParsers, paramText } from './types.js';

const OID = { bool: 16, bytea: 17, int8: 20, int4: 23, jsonb: 3802, numeric: 1700, timestamptz: 1184, int4Array: 1007, textArray: 1009 };

describe('values from the server', () => {
  const parsers = makeParsers();
  const parse = (oid: number, text: string): unknown => parsers(oid)?.(text);

  it('keeps bigint and numeric exact as strings', () => {
    expect(parse(OID.int8, '9223372036854775807')).toBe('9223372036854775807');
    expect(parsers(OID.numeric)).toBeNull();
  });

  it('returns BigInt for int8 when asked', () => {
    expect(makeParsers({ int8: 'bigint' })(OID.int8)?.('9223372036854775807')).toBe(9223372036854775807n);
  });

  it('parses booleans, numbers, json and bytea', () => {
    expect(parse(OID.bool, 't')).toBe(true);
    expect(parse(OID.bool, 'f')).toBe(false);
    expect(parse(OID.int4, '42')).toBe(42);
    expect(parse(OID.jsonb, '{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(parse(OID.bytea, '\\x0aff')).toEqual(Uint8Array.of(10, 255));
  });

  it('parses a timestamp with a zone to the right instant, cutting microseconds to milliseconds', () => {
    expect(parse(OID.timestamptz, '2026-10-23 17:33:12.123456+02')).toEqual(new Date(Date.UTC(2026, 9, 23, 15, 33, 12, 123)));
  });

  it('keeps the text of timestamps when asked', () => {
    expect(makeParsers({ rawTimestamps: true })(OID.timestamptz)?.('2026-10-23 17:33:12+00')).toBe('2026-10-23 17:33:12+00');
  });

  it('parses arrays with NULL, quotes and nesting', () => {
    expect(parse(OID.int4Array, '{1,NULL,3}')).toEqual([1, null, 3]);
    expect(parse(OID.textArray, '{"a,b","say \\"hi\\"",c}')).toEqual(['a,b', 'say "hi"', 'c']);
    expect(parse(OID.int4Array, '{{1,2},{3,4}}')).toEqual([[1, 2], [3, 4]]);
  });
});

describe('parameters to the server', () => {
  it('turns JavaScript values into text', () => {
    expect(paramText(null)).toBeNull();
    expect(paramText(undefined)).toBeNull();
    expect(paramText('x')).toBe('x');
    expect(paramText(12)).toBe('12');
    expect(paramText(12n)).toBe('12');
    expect(paramText(true)).toBe('true');
    expect(paramText(Uint8Array.of(1, 171))).toBe('\\x01ab');
    expect(paramText({ a: 1 })).toBe('{"a":1}');
  });

  it('writes arrays as array literals with quoted elements', () => {
    expect(paramText([1, null, 'a"b'])).toBe('{"1",NULL,"a\\"b"}');
  });

  it('writes a Date with the local offset so the instant survives a round trip', () => {
    const text = paramText(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)));
    expect(typeof text).toBe('string');
    expect(new Date(text as string).getTime()).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
  });
});
