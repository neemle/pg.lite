// Text-format values of the protocol <-> JavaScript. The rules keep exact numbers exact:
// bigint (int8) and numeric are returned as strings unless the caller asks for bigint, never as a lossy
// Number. The defaults match the node-postgres ("pg") driver so that libraries written for it (TypeORM) work.

const OID = {
  bool: 16, bytea: 17, int8: 20, int2: 21, int4: 23, text: 25, oid: 26, json: 114, float4: 700, float8: 701,
  varchar: 1043, bpchar: 1042, date: 1082, timestamp: 1114, timestamptz: 1184, numeric: 1700, uuid: 2950, jsonb: 3802,
};
const ARRAY_OF = {
  1000: 16, 1001: 17, 1016: 20, 1005: 21, 1007: 23, 1009: 25, 1028: 26, 199: 114, 1021: 700, 1022: 701,
  1015: 1043, 1014: 1042, 1182: 1082, 1115: 1114, 1185: 1184, 1231: 1700, 2951: 2950, 3807: 3802,
};

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// "2026-10-23 17:33:12.123456+00" -> Date (microseconds are cut to milliseconds: use the text
// form, `{ rawTimestamps: true }`, when they matter)
function parseTimestamp(s, withZone) {
  if (s === 'infinity') return Infinity;
  if (s === '-infinity') return -Infinity;
  const m = /^(\d{4,})-(\d\d)-(\d\d)(?: (\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?(?:([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?)?( BC)?$/.exec(s);
  if (!m) return s;
  let year = Number(m[1]);
  if (m[12]) year = 1 - year;
  const ms = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  const parts = [year, Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), Math.floor(ms)];
  let d;
  if (withZone && m[8]) {
    const sign = m[8] === '-' ? -1 : 1;
    const offsetMs = sign * ((Number(m[9]) * 60 + Number(m[10] || 0)) * 60 + Number(m[11] || 0)) * 1000;
    d = new Date(Date.UTC(...parts) - offsetMs);
  } else {
    d = new Date(...parts);           // no zone: local time, as node-postgres does
  }
  if (year >= 0 && year < 100) d.setFullYear(year);
  return d;
}

function parseArray(text, parseElement) {
  let at = 0;
  if (text[0] === '[') at = text.indexOf('=') + 1;   // "[1:3]={...}" lower-bound decoration
  function level() {
    const out = [];
    at++;                                            // {
    while (text[at] !== '}') {
      if (text[at] === '{') out.push(level());
      else if (text[at] === '"') {
        let s = '';
        at++;
        while (text[at] !== '"') { if (text[at] === '\\') at++; s += text[at++]; }
        at++;
        out.push(parseElement(s));
      } else {
        let end = at;
        while (text[end] !== ',' && text[end] !== '}') end++;
        const raw = text.slice(at, end);
        out.push(raw === 'NULL' ? null : parseElement(raw));
        at = end;
      }
      if (text[at] === ',') at++;
    }
    at++;                                            // }
    return out;
  }
  return level();
}

export function makeParsers(options = {}) {
  const int8 = options.int8 === 'bigint' ? (s) => BigInt(s) : (s) => s;
  const scalar = {
    [OID.bool]: (s) => s === 't',
    [OID.bytea]: (s) => (s.startsWith('\\x') ? hexToBytes(s.slice(2)) : s),
    [OID.int8]: int8,
    [OID.int2]: Number, [OID.int4]: Number, [OID.oid]: Number,
    [OID.float4]: Number, [OID.float8]: Number,
    [OID.json]: (s) => JSON.parse(s), [OID.jsonb]: (s) => JSON.parse(s),
    [OID.timestamp]: options.rawTimestamps ? (s) => s : (s) => parseTimestamp(s, false),
    [OID.timestamptz]: options.rawTimestamps ? (s) => s : (s) => parseTimestamp(s, true),
    [OID.date]: options.rawTimestamps ? (s) => s : (s) => parseTimestamp(s, false),
    // numeric, text, varchar, uuid, ... stay strings
  };
  return (oid) => {
    if (scalar[oid]) return scalar[oid];
    const elem = ARRAY_OF[oid];
    if (elem !== undefined) {
      const parseElement = scalar[elem] || ((s) => s);
      return (s) => parseArray(s, parseElement);
    }
    return null;
  };
}

// ---- JavaScript -> parameter text ---------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

// local time with offset, like node-postgres, so a timestamp round trip gives the same instant
export function dateToString(d) {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const year = d.getFullYear();
  return `${year > 0 ? pad(year, 4) : pad(1 - year, 4) + ' BC'}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function arrayLiteral(a) {
  return `{${a.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayLiteral(v);
    const s = paramText(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(',')}}`;
}

export function paramText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return dateToString(v);
  if (v instanceof Uint8Array) return `\\x${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (Array.isArray(v)) return arrayLiteral(v);
  return JSON.stringify(v);
}
