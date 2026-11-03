// PostgreSQL frontend/backend protocol 3: just the messages this module needs, no dependencies.
// The engine speaks the protocol through function calls (patch wasm/0007); there is no socket and no
// startup or authentication exchange: the first byte sent is a Query or Parse message.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  bytes(u8: Uint8Array): this { this.parts.push(u8); this.length += u8.length; return this; }
  int32(n: number): this { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return this.bytes(b); }
  int16(n: number): this { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return this.bytes(b); }
  byte(n: number): this { return this.bytes(Uint8Array.of(n)); }
  cstring(s: string): this { return this.bytes(encoder.encode(s)).byte(0); }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

// type byte + int32 length (counting itself, not the type byte) + body
function frame(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}

export const query = (sql: string): Uint8Array => frame('Q', new Writer().cstring(sql).done());

export const parse = (name: string, sql: string, typeOids: readonly number[] = []): Uint8Array => {
  const w = new Writer().cstring(name).cstring(sql).int16(typeOids.length);
  for (const oid of typeOids) w.int32(oid);
  return frame('P', w.done());
};

/** params: null, or the text-format bytes of the parameter */
export const bind = (portal: string, statement: string, params: readonly (Uint8Array | null)[]): Uint8Array => {
  const w = new Writer().cstring(portal).cstring(statement);
  w.int16(0);                       // all parameters in text format
  w.int16(params.length);
  for (const p of params) {
    if (p === null) w.int32(-1);
    else w.int32(p.length).bytes(p);
  }
  w.int16(0);                       // all results in text format
  return frame('B', w.done());
};

export const describe = (kind: 'S' | 'P', name: string): Uint8Array => frame('D', new Writer().byte(kind.charCodeAt(0)).cstring(name).done());
export const execute = (portal: string, maxRows = 0): Uint8Array => frame('E', new Writer().cstring(portal).int32(maxRows).done());
export const sync = (): Uint8Array => frame('S', new Uint8Array(0));
export const terminate = (): Uint8Array => frame('X', new Uint8Array(0));

export const text = (s: string): Uint8Array => encoder.encode(s);

// ---- backend messages -------------------------------------------------------------------------

export interface FieldDescription {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: number;
}

/** Error and notice fields by their one-letter code (S severity, C SQLSTATE, M message, D detail, H hint, P position, ...) */
export type ErrorFields = Record<string, string>;

export type BackendMessage =
  | { type: 'Z'; status: string }                                         // ReadyForQuery: I idle, T in transaction, E failed transaction
  | { type: 'T'; fields: FieldDescription[] }                             // RowDescription
  | { type: 'D'; row: (Uint8Array | null)[] }                             // DataRow
  | { type: 'C'; tag: string; command: string; rowCount: number | null }  // CommandComplete
  | { type: 'E' | 'N'; fields: ErrorFields }                              // ErrorResponse, NoticeResponse
  | { type: 'S'; name: string; value: string }                            // ParameterStatus
  | { type: 'R'; code: number }                                           // Authentication
  | { type: 't'; oids: number[] }                                         // ParameterDescription
  | { type: '1' | '2' | '3' | 'n' | 'I' | 's' | 'K' | 'G' | 'H' | 'W' }   // simple acknowledgements; COPY is not supported through this API
  | { type: 'unknown'; code: string; raw: Uint8Array };                    // anything else (code is the type byte)

// Incremental parser: push() bytes in, get an array of complete messages back.
export class MessageParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): BackendMessage[] {
    if (this.buf.length === 0) this.buf = chunk;
    else {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf); joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const out: BackendMessage[] = [];
    let at = 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    while (this.buf.length - at >= 5) {
      const len = view.getInt32(at + 1);
      if (this.buf.length - at < 1 + len) break;
      out.push(decodeMessage(String.fromCharCode(this.buf[at]!), this.buf.subarray(at + 5, at + 1 + len)));
      at += 1 + len;
    }
    this.buf = this.buf.subarray(at);
    return out;
  }
}

function cstringAt(u8: Uint8Array, at: number): [string, number] {
  let end = at;
  while (u8[end] !== 0) end++;
  return [decoder.decode(u8.subarray(at, end)), end + 1];
}

function decodeFields(body: Uint8Array): ErrorFields {
  const f: ErrorFields = {};
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const code = String.fromCharCode(body[at++]!);
    const [value, next] = cstringAt(body, at);
    at = next;
    f[code] = value;
  }
  return f;
}

function decodeMessage(type: string, body: Uint8Array): BackendMessage {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  switch (type) {
    case 'Z': return { type, status: String.fromCharCode(body[0]!) };
    case 'T': {
      const n = view.getInt16(0);
      let at = 2;
      const fields: FieldDescription[] = [];
      for (let i = 0; i < n; i++) {
        const [name, next] = cstringAt(body, at);
        at = next;
        fields.push({
          name,
          tableID: view.getInt32(at), columnID: view.getInt16(at + 4),
          dataTypeID: view.getInt32(at + 6), dataTypeSize: view.getInt16(at + 10),
          dataTypeModifier: view.getInt32(at + 12), format: view.getInt16(at + 16),
        });
        at += 18;
      }
      return { type, fields };
    }
    case 'D': {
      const n = view.getInt16(0);
      let at = 2;
      const row: (Uint8Array | null)[] = [];
      for (let i = 0; i < n; i++) {
        const len = view.getInt32(at); at += 4;
        if (len < 0) row.push(null);
        else { row.push(body.subarray(at, at + len)); at += len; }
      }
      return { type, row };
    }
    case 'C': {
      const tag = cstringAt(body, 0)[0];
      const m = /^(\w+(?: \w+)*?)(?: (\d+))?(?: (\d+))?$/.exec(tag);
      const counts = tag.match(/\d+/g);
      return { type, tag, command: m?.[1] ?? tag, rowCount: counts ? Number(counts[counts.length - 1]) : null };
    }
    case 'E': case 'N': return { type, fields: decodeFields(body) };
    case 'S': { const [name, at] = cstringAt(body, 0); return { type, name, value: cstringAt(body, at)[0] }; }
    case 'K': return { type };
    case 'R': return { type, code: view.getInt32(0) };
    case 't': return { type, oids: Array.from({ length: view.getInt16(0) }, (_, i) => view.getInt32(2 + 4 * i)) };
    case '1': case '2': case '3': case 'n': case 'I': case 's': return { type };
    case 'G': case 'H': case 'W': return { type };  // COPY: not supported through this API
    default: return { type: 'unknown', code: type, raw: body };
  }
}

export const decodeText = (u8: Uint8Array): string => decoder.decode(u8);
