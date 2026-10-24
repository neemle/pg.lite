// PostgreSQL frontend/backend protocol 3: just the messages this module needs, no dependencies.
// The engine speaks the protocol through function calls (patch wasm/0007); there is no socket and no
// startup or authentication exchange: the first byte sent is a Query or Parse message.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(u8) { this.parts.push(u8); this.length += u8.length; return this; }
  int32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return this.bytes(b); }
  int16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return this.bytes(b); }
  byte(n) { return this.bytes(Uint8Array.of(n)); }
  cstring(s) { return this.bytes(encoder.encode(s)).byte(0); }
  done() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

// type byte + int32 length (counting itself, not the type byte) + body
function frame(type, body) {
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}

export const query = (sql) => frame('Q', new Writer().cstring(sql).done());

export const parse = (name, sql, typeOids = []) => {
  const w = new Writer().cstring(name).cstring(sql).int16(typeOids.length);
  for (const oid of typeOids) w.int32(oid);
  return frame('P', w.done());
};

// params: array of null | Uint8Array (text format bytes already encoded)
export const bind = (portal, statement, params) => {
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

export const describe = (kind, name) => frame('D', new Writer().byte(kind.charCodeAt(0)).cstring(name).done());
export const execute = (portal, maxRows = 0) => frame('E', new Writer().cstring(portal).int32(maxRows).done());
export const sync = () => frame('S', new Uint8Array(0));
export const terminate = () => frame('X', new Uint8Array(0));

export const text = (s) => encoder.encode(s);

// ---- backend messages -------------------------------------------------------------------------

// Incremental parser: push() bytes in, get an array of complete messages back.
export class MessageParser {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    if (this.buf.length === 0) this.buf = chunk;
    else {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf); joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const out = [];
    let at = 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    while (this.buf.length - at >= 5) {
      const len = view.getInt32(at + 1);
      if (this.buf.length - at < 1 + len) break;
      out.push(decodeMessage(String.fromCharCode(this.buf[at]), this.buf.subarray(at + 5, at + 1 + len)));
      at += 1 + len;
    }
    this.buf = this.buf.subarray(at);
    return out;
  }
}

function cstringAt(u8, at) {
  let end = at;
  while (u8[end] !== 0) end++;
  return [decoder.decode(u8.subarray(at, end)), end + 1];
}

function decodeFields(body) {
  const f = {};
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const code = String.fromCharCode(body[at++]);
    let value;
    [value, at] = cstringAt(body, at);
    f[code] = value;
  }
  return f;
}

function decodeMessage(type, body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  switch (type) {
    case 'Z': return { type, status: String.fromCharCode(body[0]) };            // I idle, T in transaction, E failed transaction
    case 'T': {
      const n = view.getInt16(0);
      let at = 2;
      const fields = [];
      for (let i = 0; i < n; i++) {
        let name;
        [name, at] = cstringAt(body, at);
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
      const row = new Array(n);
      for (let i = 0; i < n; i++) {
        const len = view.getInt32(at); at += 4;
        if (len < 0) row[i] = null;
        else { row[i] = body.subarray(at, at + len); at += len; }
      }
      return { type, row };
    }
    case 'C': {
      const tag = cstringAt(body, 0)[0];
      const m = /^(\w+(?: \w+)*?)(?: (\d+))?(?: (\d+))?$/.exec(tag);
      const counts = tag.match(/\d+/g);
      return { type, tag, command: m ? m[1] : tag, rowCount: counts ? Number(counts[counts.length - 1]) : null };
    }
    case 'E': case 'N': return { type, fields: decodeFields(body) };
    case 'S': { const [name, at] = cstringAt(body, 0); return { type, name, value: cstringAt(body, at)[0] }; }
    case 'K': return { type };
    case 'R': return { type, code: view.getInt32(0) };
    case 't': return { type, oids: Array.from({ length: view.getInt16(0) }, (_, i) => view.getInt32(2 + 4 * i)) };
    case '1': case '2': case '3': case 'n': case 'I': case 's': return { type };
    case 'G': case 'H': case 'W': return { type };  // COPY: not supported through this API
    default: return { type, raw: body };
  }
}

export const decodeText = (u8) => decoder.decode(u8);
